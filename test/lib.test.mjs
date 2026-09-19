// Unit tests for the pure helpers. No network, no child process.

import assert from "node:assert/strict";
import test from "node:test";
import { APIError } from "@typesafe-ai/sdk";
import {
  assertStateWithinLimit,
  assertUniqueIds,
  backoffDelayMs,
  buildChoiceCriteria,
  describeError,
  gateConfidence,
  gateProbability,
  MalformedResponseError,
  MAX_CHOICE_OPTIONS,
  MAX_SCORE_LEVELS,
  parseRetryAfterSeconds,
  ProviderHttpError,
  ProviderNetworkError,
  ProviderTimeoutError,
  readPositiveInt,
  resolveNoneKey,
  resolveProvider,
  stateSize,
  validateChoiceAnswer,
  validateNoulAnswer,
  validateScoreAnswer,
} from "../dist/lib.js";

test("readPositiveInt falls back loudly instead of yielding NaN", () => {
  assert.deepEqual(readPositiveInt(undefined, 15000, "T"), { value: 15000 });
  assert.deepEqual(readPositiveInt("  ", 15000, "T"), { value: 15000 });
  assert.equal(readPositiveInt("500", 15000, "T").value, 500);
  assert.equal(readPositiveInt("12.7", 15000, "T").value, 12);

  for (const bad of ["abc", "0", "-5", "NaN"]) {
    const parsed = readPositiveInt(bad, 15000, "T");
    assert.equal(parsed.value, 15000, `${bad} should fall back`);
    assert.ok(parsed.warning, `${bad} should warn`);
  }
});

test("resolveNoneKey steps aside when the caller already uses the name", () => {
  assert.equal(resolveNoneKey([]), "none");
  assert.equal(resolveNoneKey(["a", "b"]), "none");
  assert.equal(resolveNoneKey(["none"]), "none_of_these");
  assert.equal(resolveNoneKey(["none", "none_of_these"]), "none_of_these_2");
});

test("buildChoiceCriteria never overwrites a caller's own option", () => {
  const callerMeaning = "The request was already handled; no action needed.";
  const { criteria, noneKey } = buildChoiceCriteria({ none: callerMeaning, escalate: "Send to a human" }, true);

  assert.equal(criteria.none, callerMeaning, "the caller's option must survive verbatim");
  assert.equal(noneKey, "none_of_these");
  assert.equal(criteria.none_of_these, "None of the other options fits.");
});

test("buildChoiceCriteria reports the no-match key it used", () => {
  const { criteria, noneKey } = buildChoiceCriteria({ a: "d", b: "d" }, true);
  assert.equal(noneKey, "none");
  assert.deepEqual(Object.keys(criteria).sort(), ["a", "b", "none"]);

  const off = buildChoiceCriteria({ a: "d", b: "d" }, false);
  assert.equal(off.noneKey, null);
  assert.deepEqual(Object.keys(off.criteria).sort(), ["a", "b"]);
});

test("buildChoiceCriteria rejects empty, single-outcome, and oversized option sets", () => {
  assert.throws(() => buildChoiceCriteria({}, true), /at least one option/);
  assert.throws(() => buildChoiceCriteria({ only: "d" }, false), /at least two outcomes/);

  const tooMany = Object.fromEntries(Array.from({ length: MAX_CHOICE_OPTIONS + 1 }, (_, i) => [`o${i}`, null]));
  assert.throws(() => buildChoiceCriteria(tooMany, false), /at most 255 options/);

  const exactlyAtLimit = Object.fromEntries(Array.from({ length: MAX_CHOICE_OPTIONS }, (_, i) => [`o${i}`, null]));
  assert.doesNotThrow(() => buildChoiceCriteria(exactlyAtLimit, false));
});

test("assertUniqueIds names the duplicates rather than dropping questions", () => {
  assert.doesNotThrow(() => assertUniqueIds(["a", "b", "c"]));
  assert.throws(() => assertUniqueIds(["a", "b", "a"]), /Duplicate question ids: "a"/);
});

test("state size is measured, and oversized state is rejected not truncated", () => {
  assert.equal(stateSize("abcde"), 5);
  assert.equal(stateSize({ a: 1 }), JSON.stringify({ a: 1 }).length);

  assert.doesNotThrow(() => assertStateWithinLimit("abc", 10));
  assert.throws(() => assertStateWithinLimit("a".repeat(20), 10), /above the 10 limit/);
});

test("gateConfidence maps confidence onto an action", () => {
  assert.equal(gateConfidence(0.95, 0.8, 0.5), "act");
  assert.equal(gateConfidence(0.8, 0.8, 0.5), "act");
  assert.equal(gateConfidence(0.6, 0.8, 0.5), "review");
  assert.equal(gateConfidence(0.2, 0.8, 0.5), "abstain");
  assert.equal(gateConfidence(null, 0.8, 0.5), "abstain");
  assert.equal(gateConfidence(undefined, 0.8, 0.5), "abstain");
});

test("gateProbability keeps the middle band uncertain instead of rounding", () => {
  assert.equal(gateProbability(0.9, 0.7, 0.3), "yes");
  assert.equal(gateProbability(0.7, 0.7, 0.3), "yes");
  assert.equal(gateProbability(0.51, 0.7, 0.3), "uncertain", "0.51 is a coin flip, not a yes");
  assert.equal(gateProbability(0.3, 0.7, 0.3), "no");
  assert.equal(gateProbability(0.05, 0.7, 0.3), "no");
});

test("describeError separates failures a caller should treat differently", () => {
  const missing = describeError(new Error("No API key. Set TYPESAFE_API_KEY in the environment."));
  assert.equal(missing.kind, "no_api_key");
  assert.equal(missing.retryable, false);

  const headers = new Headers({ "x-typesafe-request-id": "req_abc" });
  const rateLimited = describeError(APIError.fromResponse(429, {}, headers));
  assert.equal(rateLimited.kind, "rate_limit");
  assert.equal(rateLimited.retryable, true);
  assert.equal(rateLimited.status, 429);
  assert.equal(rateLimited.requestId, "req_abc");

  const unauthorized = describeError(APIError.fromResponse(401, {}, new Headers()));
  assert.equal(unauthorized.kind, "authentication");
  assert.equal(unauthorized.retryable, false, "a bad key never succeeds on retry");

  const malformed = describeError(APIError.fromResponse(422, {}, new Headers()));
  assert.equal(malformed.kind, "invalid_request");
  assert.equal(malformed.retryable, false);

  const overloaded = describeError(APIError.fromResponse(529, {}, new Headers()));
  assert.equal(overloaded.kind, "server_error");
  assert.equal(overloaded.retryable, true);
});

// ── Answer validation ───────────────────────────────────────────────────────

const KEYS = ["a", "b", "none"];
const goodChoice = { type: "choice", choice: "a", confidence: 0.8, probabilities: { a: 0.8, b: 0.15, none: 0.05 } };

test("validateChoiceAnswer accepts a well-formed answer", () => {
  assert.doesNotThrow(() => validateChoiceAnswer(goodChoice, KEYS, "q"));
});

test("validateChoiceAnswer rejects a choice that was never offered", () => {
  const answer = { ...goodChoice, choice: "c", probabilities: { a: 0.8, b: 0.15, none: 0.05 } };
  assert.throws(() => validateChoiceAnswer(answer, KEYS, "q"), MalformedResponseError);
});

test("validateChoiceAnswer rejects a distribution over the wrong options", () => {
  const missing = { ...goodChoice, probabilities: { a: 0.9, b: 0.1 } };
  assert.throws(() => validateChoiceAnswer(missing, KEYS, "q"), /offered/);
  const extra = { ...goodChoice, probabilities: { a: 0.8, b: 0.1, none: 0.05, c: 0.05 } };
  assert.throws(() => validateChoiceAnswer(extra, KEYS, "q"), /offered/);
});

test("validateChoiceAnswer rejects probabilities that do not sum to one", () => {
  const answer = { ...goodChoice, probabilities: { a: 0.9, b: 0.9, none: 0.1 } };
  assert.throws(() => validateChoiceAnswer(answer, KEYS, "q"), /summing/);
});

test("validateChoiceAnswer rejects a choice that is not the most probable option", () => {
  const answer = { ...goodChoice, choice: "b" };
  assert.throws(() => validateChoiceAnswer(answer, KEYS, "q"), /highest probability/);
});

test("validateChoiceAnswer rejects NaN, out-of-range, and missing values", () => {
  assert.throws(() => validateChoiceAnswer({ ...goodChoice, confidence: NaN }, KEYS, "q"), MalformedResponseError);
  assert.throws(() => validateChoiceAnswer({ ...goodChoice, probabilities: { a: 1.5, b: -0.4, none: -0.1 } }, KEYS, "q"), MalformedResponseError);
  assert.throws(() => validateChoiceAnswer(undefined, KEYS, "q"), /No answer/);
  assert.throws(() => validateChoiceAnswer("a", KEYS, "q"), /No answer/);
});

test("validateScoreAnswer checks the legend and distribution against the levels sent", () => {
  const good = { type: "score", score: 1.2, confidence: 0.7, legend: { 0: "low", 1: "mid", 2: "high" }, probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 } };
  assert.doesNotThrow(() => validateScoreAnswer(good, 3, "r"));
  assert.throws(() => validateScoreAnswer(good, 4, "r"), /legend of 3 levels/);
  assert.throws(() => validateScoreAnswer({ ...good, score: Infinity }, 3, "r"), /finite score/);
  assert.throws(() => validateScoreAnswer({ ...good, probabilities: { 0: 0.5, 1: 0.5 } }, 3, "r"), /offered/);
});

test("validateNoulAnswer requires one probability in [0, 1]", () => {
  assert.doesNotThrow(() => validateNoulAnswer({ type: "noul", noul: 0.42 }, "c"));
  for (const bad of [{ noul: 1.2 }, { noul: NaN }, { noul: "0.4" }, {}, undefined]) {
    assert.throws(() => validateNoulAnswer(bad, "c"), MalformedResponseError);
  }
});

test("describeError classifies a malformed response as retryable and never actionable", () => {
  const described = describeError(new MalformedResponseError("bad"));
  assert.equal(described.kind, "malformed_response");
  assert.equal(described.retryable, true);
  assert.match(described.hint, /should be acted on/i);
});

// ── Provider selection and retries ─────────────────────────────────────

test("the score level cap matches the API limit, not a local guess", () => {
  // Wire-confirmed: 11 levels returns 400 "Too many score levels. Must have
  // at most 10 levels." Enforcing the real limit saves the round trip.
  assert.equal(MAX_SCORE_LEVELS, 10);
});

test("resolveProvider honours an explicit choice and warns on an unusable one", () => {
  assert.deepEqual(resolveProvider("typesafe", true, true), { provider: "typesafe" });
  assert.deepEqual(resolveProvider("  OpenRouter ", false, false), { provider: "openrouter" });

  const warned = resolveProvider("nonsense", true, false);
  assert.equal(warned.provider, "typesafe", "an unusable value falls back to auto-detection");
  assert.match(warned.warning, /JEV_PROVIDER/);
});

test("resolveProvider auto-detects from the keys present, preferring TypeSafe", () => {
  assert.equal(resolveProvider(undefined, true, true).provider, "typesafe", "both keys: the SDK path wins");
  assert.equal(resolveProvider(undefined, true, false).provider, "typesafe");
  assert.equal(resolveProvider(undefined, false, true).provider, "openrouter");
  assert.equal(resolveProvider("", false, true).provider, "openrouter", "whitespace is treated as unset");
  assert.equal(resolveProvider(undefined, false, false).provider, "typesafe", "no keys: keep the familiar missing-key error");
});

test("parseRetryAfterSeconds accepts bounded seconds and rejects the rest", () => {
  assert.equal(parseRetryAfterSeconds("5"), 5);
  assert.equal(parseRetryAfterSeconds("0"), 0);
  assert.equal(parseRetryAfterSeconds(null), null);
  assert.equal(parseRetryAfterSeconds(undefined), null);
  assert.equal(parseRetryAfterSeconds("soon"), null);
  assert.equal(parseRetryAfterSeconds("-1"), null);
  assert.equal(parseRetryAfterSeconds("2.9"), 2);
  assert.equal(parseRetryAfterSeconds("120"), 30, "a header cannot stall an MCP call indefinitely");
});

test("backoffDelayMs grows exponentially and caps", () => {
  assert.equal(backoffDelayMs(0), 500);
  assert.equal(backoffDelayMs(1), 1000);
  assert.equal(backoffDelayMs(2), 2000);
  assert.equal(backoffDelayMs(5), 8000);
});

test("describeError classifies provider HTTP errors a caller can branch on", () => {
  const cases = [
    [401, "authentication", false],
    [403, "permission_denied", false],
    [404, "not_found", false],
    [408, "timeout", true],
    [429, "rate_limit", true],
    [400, "invalid_request", false],
    [422, "invalid_request", false],
    [500, "server_error", true],
    [529, "server_error", true],
  ];
  for (const [status, kind, retryable] of cases) {
    const described = describeError(new ProviderHttpError(`HTTP ${status}`, status, "req_or_1"));
    assert.equal(described.kind, kind, `${status} should map to ${kind}`);
    assert.equal(described.retryable, retryable, `${status} retryable should be ${retryable}`);
    assert.equal(described.status, status);
    assert.equal(described.requestId, "req_or_1");
  }
});

test("describeError maps provider transport failures to their kinds", () => {
  assert.equal(describeError(new ProviderTimeoutError("slow")).kind, "timeout");
  assert.equal(describeError(new ProviderTimeoutError("slow")).retryable, true);
  assert.equal(describeError(new ProviderNetworkError("down")).kind, "connection");

  const abort = new Error("This operation was aborted");
  abort.name = "AbortError";
  const cancelled = describeError(abort);
  assert.equal(cancelled.kind, "cancelled");
  assert.equal(cancelled.retryable, false);
});
