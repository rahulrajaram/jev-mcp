/**
 * Pure helpers for jev-mcp. No network, no process state, no I/O.
 *
 * Everything here is deterministic so the edge cases that matter — a caller
 * whose own option is named "none", duplicate question ids, a malformed
 * timeout — are unit-testable without touching the API.
 */

import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "@typesafe-ai/sdk";
import type { EntryType } from "@typesafe-ai/sdk";

// ── Limits ──────────────────────────────────────────────────────────────────

/**
 * A Choice question accepts up to 255 options. This is a documented API limit,
 * not a local guess: docs.typesafe.ai/cookbooks/semantic_find.
 */
export const MAX_CHOICE_OPTIONS = 255;

/**
 * Jev's request budget in tokens, shared by the state and all questions. The
 * docs put it at "around 32,000 tokens, roughly 150,000 characters of English"
 * (docs.typesafe.ai/primitives), and the OpenRouter catalog lists a 32,000
 * context window. Reported by jev_models so a caller can size a call before
 * building it. Approximate on purpose: a measured probe showed terse,
 * repetitive text costing about 2 characters per token, where English prose
 * runs nearer 4, so a character count is only a proxy.
 */
export const CONTEXT_TOKENS = 32_000;

/**
 * A Score question accepts up to 10 levels. This is a documented API limit
 * (docs.typesafe.ai/primitives/score, "up to 10"), confirmed on the wire: 11
 * levels returns HTTP 400, "Too many score levels. Must have at most 10
 * levels." Enforcing it locally keeps a request that the API would always
 * reject from costing a round trip.
 */
export const MAX_SCORE_LEVELS = 10;

/**
 * Local safety caps, not API limits. They bound cost and latency for a single
 * call so a malformed loop cannot run up a bill. All three are configurable.
 *
 * The state default tracks Jev's context budget: the request's tokens are
 * shared between `state` and the questions, around 32,000 tokens — roughly
 * 150,000 characters of English text (docs.typesafe.ai/primitives, "Ask
 * multiple questions together"). A state past the budget fails at the API,
 * so the local default sits just under it. The API remains the real enforcer;
 * raise the cap only if your state packs tighter than English prose.
 */
export const DEFAULT_MAX_QUESTIONS = 64;
export const DEFAULT_MAX_STATE_CHARS = 150_000;
export const DEFAULT_TIMEOUT_MS = 15_000;

// ── Environment parsing ─────────────────────────────────────────────────────

export interface ParsedNumber {
  value: number;
  /** Set when the raw value was present but unusable, so the caller can warn. */
  warning?: string;
}

/**
 * Read a positive integer from an environment value.
 *
 * `Number("abc")` is `NaN`, and passing `NaN` as a timeout silently disables
 * it. Anything not a finite positive number falls back and reports why.
 */
export function readPositiveInt(raw: string | undefined, fallback: number, label: string): ParsedNumber {
  if (raw === undefined || raw.trim() === "") return { value: fallback };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { value: fallback, warning: `${label} must be a positive number; got ${JSON.stringify(raw)}. Using ${fallback}.` };
  }
  return { value: Math.floor(parsed) };
}

// ── Choice option handling ──────────────────────────────────────────────────

/**
 * Pick a key for the "none of these" escape hatch that does not collide with a
 * caller's own option.
 *
 * Blindly writing `criteria.none` overwrites an option the caller named "none",
 * destroying its meaning and its probability. That is silent and unrecoverable,
 * so we step aside instead.
 */
export function resolveNoneKey(existing: readonly string[]): string {
  const taken = new Set(existing);
  if (!taken.has("none")) return "none";
  if (!taken.has("none_of_these")) return "none_of_these";
  let n = 2;
  while (taken.has(`none_of_these_${n}`)) n += 1;
  return `none_of_these_${n}`;
}

export interface BuiltCriteria {
  criteria: Record<string, EntryType>;
  /** The key that carries the "nothing fits" meaning, or null when not added. */
  noneKey: string | null;
}

/**
 * Build Choice criteria from caller options, optionally adding a no-match
 * outcome under a key guaranteed not to clash.
 *
 * @throws when the option set is empty or exceeds the API's 255-option limit.
 */
export function buildChoiceCriteria(
  options: Record<string, EntryType>,
  addNone: boolean,
  label = "options",
): BuiltCriteria {
  const keys = Object.keys(options);
  if (keys.length === 0) {
    throw new Error(`${label} must contain at least one option. Jev selects among options you supply; it cannot invent one.`);
  }

  const criteria: Record<string, EntryType> = { ...options };
  let noneKey: string | null = null;
  if (addNone) {
    noneKey = resolveNoneKey(keys);
    criteria[noneKey] = "None of the other options fits.";
  }

  const total = Object.keys(criteria).length;
  if (total > MAX_CHOICE_OPTIONS) {
    throw new Error(
      `A Choice question accepts at most ${MAX_CHOICE_OPTIONS} options; received ${total}. ` +
        "For a larger set, search in two passes: one question picks a window, a second ranks within it.",
    );
  }
  if (total < 2) {
    throw new Error(`${label} must leave at least two outcomes. Supply another option, or leave the no-match outcome enabled.`);
  }
  return { criteria, noneKey };
}

/** Reject duplicate question ids rather than letting a later one shadow an earlier one. */
export function assertUniqueIds(ids: readonly string[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  if (duplicates.size > 0) {
    throw new Error(
      `Duplicate question ids: ${[...duplicates].map((d) => JSON.stringify(d)).join(", ")}. ` +
        "Answers are keyed by id, so a repeat would silently drop every earlier question sharing it.",
    );
  }
}

// ── Size guards ─────────────────────────────────────────────────────────────

/** Serialized size of the state, used to bound cost before a request goes out. */
export function stateSize(state: unknown): number {
  return typeof state === "string" ? state.length : JSON.stringify(state ?? null).length;
}

/**
 * Reject oversized state instead of truncating it.
 *
 * Truncation silently changes the material the judgment rests on, which turns a
 * size problem into a wrong answer. Failing loudly keeps the caller in control.
 */
export function assertStateWithinLimit(state: unknown, maxChars: number): void {
  const size = stateSize(state);
  if (size > maxChars) {
    throw new Error(
      `State is ${size} characters (~${Math.round(size / 4)} tokens of English), above the ${maxChars} limit. ` +
        "Jev's request budget is about 32,000 tokens shared by the state and every question, so filter in code first and send only the fields the questions need: the paragraph, the diff hunk, the record — not the whole file, log, or transcript. " +
        "Raise JEV_MAX_STATE_CHARS only if your state packs tighter than English prose; the API rejects a genuine overflow with max_tokens_exceeded either way.",
    );
  }
}

// ── Confidence gating ───────────────────────────────────────────────────────

export type Gate = "act" | "review" | "abstain";

/**
 * Turn a Choice/Score confidence into a recommended action.
 *
 * Thresholds are starting points to calibrate on your own data, never universal
 * rules. Confidence describes how concentrated the distribution is; it is not a
 * statement that the answer is correct or that acting is safe.
 */
export function gateConfidence(confidence: number | null | undefined, actAbove: number, reviewAbove: number): Gate {
  if (typeof confidence !== "number" || Number.isNaN(confidence)) return "abstain";
  if (confidence >= actAbove) return "act";
  if (confidence >= reviewAbove) return "review";
  return "abstain";
}

export type Verdict = "yes" | "no" | "uncertain";

/**
 * Turn a Noul probability into a verdict.
 *
 * A Noul has no confidence value. A probability near 0.5 means yes and no are
 * close to equally likely, not that the answer is "medium", so the middle band
 * is reported as uncertain rather than rounded to the nearer side.
 */
export function gateProbability(probability: number, yesAtOrAbove: number, noAtOrBelow: number): Verdict {
  if (probability >= yesAtOrAbove) return "yes";
  if (probability <= noAtOrBelow) return "no";
  return "uncertain";
}

// ── Provider selection ─────────────────────────────────────────────────────

export type ProviderName = "typesafe" | "openrouter";

export interface ResolvedProvider {
  provider: ProviderName;
  /** Set when JEV_PROVIDER carried an unusable value and auto-detection was used. */
  warning?: string;
}

/**
 * Decide which API serves the tools.
 *
 * An explicit JEV_PROVIDER wins. Without one, prefer the TypeSafe API when any
 * of its key sources exists (the SDK carries retries and request ids), then
 * OpenRouter when its key exists, and otherwise default to TypeSafe so a
 * missing key produces the familiar error. An unusable explicit value warns
 * and falls through to the same order rather than guessing a provider silently.
 */
export function resolveProvider(
  explicit: string | undefined,
  typesafeKeyPresent: boolean,
  openrouterKeyPresent: boolean,
): ResolvedProvider {
  if (explicit !== undefined && explicit.trim() !== "") {
    const value = explicit.trim().toLowerCase();
    if (value === "typesafe" || value === "openrouter") return { provider: value };
    return {
      provider: autoProvider(typesafeKeyPresent, openrouterKeyPresent),
      warning: `JEV_PROVIDER must be "typesafe" or "openrouter"; got ${JSON.stringify(explicit)}. Using auto-detection.`,
    };
  }
  return { provider: autoProvider(typesafeKeyPresent, openrouterKeyPresent) };
}

function autoProvider(typesafeKeyPresent: boolean, openrouterKeyPresent: boolean): ProviderName {
  if (typesafeKeyPresent) return "typesafe";
  if (openrouterKeyPresent) return "openrouter";
  return "typesafe";
}

// ── Retry helpers (pure, so the policy is unit-testable) ─────────────────────

/**
 * Parse a Retry-After header carrying seconds. Capped at 30s so a header from
 * a throttling provider cannot stall an MCP call indefinitely; negative,
 * fractional, or date-form values fall back to exponential backoff.
 */
export function parseRetryAfterSeconds(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.min(30, Math.floor(parsed));
}

/** Delay before retry N (0-based): 500ms, 1s, 2s, … capped at 8s. */
export function backoffDelayMs(attempt: number, baseMs = 500, capMs = 8_000): number {
  return Math.min(capMs, baseMs * 2 ** attempt);
}

// ── Errors raised by the OpenRouter provider ────────────────────────────────

/**
 * An HTTP failure from the OpenRouter API, carrying what describeError needs.
 * The body's `error.message` is extracted when present, since that is where
 * OpenRouter nests the provider's own validation detail.
 */
export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId?: string,
    readonly retryAfterSeconds?: number | null,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

/** The per-attempt timeout (AbortSignal.timeout) fired before a response. */
export class ProviderTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderTimeoutError";
  }
}

/** fetch failed before a response arrived: DNS, connection, TLS. */
export class ProviderNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderNetworkError";
  }
}

// ── Error reporting ─────────────────────────────────────────────────────────

export type ErrorKind =
  | "no_api_key"
  | "authentication"
  | "insufficient_credits"
  | "permission_denied"
  | "invalid_request"
  | "not_found"
  | "rate_limit"
  | "server_error"
  | "timeout"
  | "connection"
  | "cancelled"
  | "invalid_arguments"
  | "malformed_response"
  | "unknown";

export interface DescribedError {
  kind: ErrorKind;
  message: string;
  /** True when the same request may succeed later. The SDK already retried. */
  retryable: boolean;
  status?: number;
  /** TypeSafe request id, the thing support needs to trace a failure. */
  requestId?: string;
  /** What the caller should actually do next. */
  hint?: string;
}

/**
 * Classify a failure so a caller can branch on it.
 *
 * Flattening every failure to a string makes a missing key, a malformed
 * question, and a rate limit indistinguishable, so callers retry things that
 * will never succeed and give up on things that would.
 */
export function describeError(error: unknown): DescribedError {
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof ProviderHttpError) {
    const base = { message, status: error.status, requestId: error.requestId };
    if (error.status === 401) {
      return { ...base, kind: "authentication", retryable: false, hint: "The API key was rejected. Check the key for the active provider (TYPESAFE_API_KEY or OPENROUTER_API_KEY) in the server's environment." };
    }
    if (error.status === 402) {
      return {
        ...base,
        kind: "insufficient_credits",
        retryable: false,
        hint: "The provider account cannot afford this request, so retrying it unchanged will fail the same way. Add credits (openrouter.ai/settings/credits on the OpenRouter path) or send a smaller state. A full-budget Jev request costs well under a cent, so this usually means a shared account balance is exhausted rather than Jev being expensive.",
      };
    }
    if (error.status === 403) {
      return { ...base, kind: "permission_denied", retryable: false, hint: "The key is valid but lacks access to this model or account." };
    }
    if (error.status === 404) {
      return { ...base, kind: "not_found", retryable: false, hint: "Check the model id in JEV_MODEL. On OpenRouter the Jev ids are typesafe/jev-1.13 and the ~typesafe/jev-latest alias." };
    }
    if (error.status === 408) {
      return { ...base, kind: "timeout", retryable: true, hint: "The provider reported a request timeout. Retry, shorten the state, or raise JEV_TIMEOUT_MS." };
    }
    if (error.status === 429) {
      return { ...base, kind: "rate_limit", retryable: true, hint: "Rate limited after this server's own retries. Back off before trying again." };
    }
    if (error.status === 400 || error.status === 422) {
      return { ...base, kind: "invalid_request", retryable: false, hint: "The request failed validation. The message names the offending field." };
    }
    return { ...base, kind: "server_error", retryable: error.status >= 500, hint: "The provider returned an error. Retry if it persists." };
  }
  if (error instanceof ProviderTimeoutError) {
    return { kind: "timeout", message, retryable: true, hint: "Shorten the state or raise JEV_TIMEOUT_MS." };
  }
  if (error instanceof ProviderNetworkError) {
    return { kind: "connection", message, retryable: true, hint: "Check network access to openrouter.ai." };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { kind: "cancelled", message, retryable: false, hint: "The client cancelled the request." };
  }
  if (error instanceof MalformedResponseError) {
    return {
      kind: "malformed_response",
      message,
      retryable: true,
      hint: "The API returned an answer that does not match the question sent. Nothing here should be acted on. Retry once; if it persists, report it with the model id.",
    };
  }
  if (error instanceof APIUserAbortError) {
    return { kind: "cancelled", message, retryable: false, hint: "The client cancelled the request." };
  }
  if (error instanceof APITimeoutError) {
    return {
      kind: "timeout",
      message,
      retryable: true,
      hint: "Shorten the state or raise JEV_TIMEOUT_MS.",
    };
  }
  if (error instanceof APIConnectionError) {
    return { kind: "connection", message, retryable: true, hint: "Check network access to api.typesafe.ai." };
  }

  if (error instanceof APIError) {
    const base = { message, status: error.status, requestId: error.requestId };
    if (error instanceof AuthenticationError) {
      return { ...base, kind: "authentication", retryable: false, hint: "The API key was rejected. Check TYPESAFE_API_KEY in the server's environment." };
    }
    if (error instanceof PermissionDeniedError) {
      return { ...base, kind: "permission_denied", retryable: false, hint: "The key is valid but lacks access to this model or account." };
    }
    if (error instanceof RateLimitError) {
      return { ...base, kind: "rate_limit", retryable: true, hint: "Rate limited after the SDK's own retries. Back off before trying again." };
    }
    if (error instanceof UnprocessableEntityError || error instanceof BadRequestError) {
      return { ...base, kind: "invalid_request", retryable: false, hint: "The request failed validation. The message names the offending field." };
    }
    if (error instanceof NotFoundError) {
      return { ...base, kind: "not_found", retryable: false, hint: "Check the model id in JEV_MODEL." };
    }
    return { ...base, kind: "server_error", retryable: error.status >= 500, hint: "TypeSafe returned an error. Retry if it persists." };
  }

  if (/^No API key/i.test(message)) {
    return {
      kind: "no_api_key",
      message,
      retryable: false,
      hint: "Set the key for the active provider (TYPESAFE_API_KEY, or OPENROUTER_API_KEY when JEV_PROVIDER=openrouter) in the environment of the MCP client, not as a tool argument. Many clients filter the environment, so a key file or an explicit env entry when registering the server is more reliable.",
    };
  }

  return { kind: "invalid_arguments", message, retryable: false };
}

// ── Answer validation ───────────────────────────────────────────────────────

/**
 * Thrown when the API returns an answer that does not match the question that
 * was sent. Nothing downstream should act on such an answer.
 */
export class MalformedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedResponseError";
  }
}

/** Probabilities may drift a little in serialization; more than this is a bug. */
export const PROBABILITY_SUM_TOLERANCE = 0.02;

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function sameKeySet(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const set = new Set(expected);
  return actual.every((key) => set.has(key));
}

/** A finite distribution over exactly the expected keys that sums to about one. */
function checkDistribution(probabilities: unknown, expectedKeys: readonly string[], label: string): Record<string, number> {
  if (typeof probabilities !== "object" || probabilities === null || Array.isArray(probabilities)) {
    throw new MalformedResponseError(`Answer '${label}' has no probabilities object.`);
  }
  const dist = probabilities as Record<string, unknown>;
  if (!sameKeySet(Object.keys(dist), expectedKeys)) {
    throw new MalformedResponseError(
      `Answer '${label}' has probabilities for ${JSON.stringify(Object.keys(dist))}, but the question offered ${JSON.stringify(expectedKeys)}.`,
    );
  }
  let sum = 0;
  for (const [key, value] of Object.entries(dist)) {
    if (!isUnitInterval(value)) throw new MalformedResponseError(`Answer '${label}' has a probability outside [0, 1] for '${key}'.`);
    sum += value;
  }
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
    throw new MalformedResponseError(`Answer '${label}' has probabilities summing to ${sum.toFixed(3)}, not 1.`);
  }
  return dist as Record<string, number>;
}

function asRecord(answer: unknown, label: string): Record<string, unknown> {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
    throw new MalformedResponseError(`No answer came back for '${label}'.`);
  }
  return answer as Record<string, unknown>;
}

/**
 * Check a Choice answer against the options that were sent.
 *
 * The selected option must be one that was offered, the distribution must
 * cover exactly those options, and the selection must carry the highest
 * probability. Any of these failing means the answer cannot be trusted, and a
 * caller acting on `choice` alone would execute something never offered.
 */
export function validateChoiceAnswer(answer: unknown, expectedKeys: readonly string[], label: string): void {
  const a = asRecord(answer, label);
  if (typeof a.choice !== "string" || !expectedKeys.includes(a.choice)) {
    throw new MalformedResponseError(`Answer '${label}' chose ${JSON.stringify(a.choice)}, which was not among the offered options.`);
  }
  if (!isUnitInterval(a.confidence)) throw new MalformedResponseError(`Answer '${label}' has no confidence in [0, 1].`);
  const dist = checkDistribution(a.probabilities, expectedKeys, label);
  const top = Math.max(...Object.values(dist));
  if ((dist[a.choice] ?? -1) < top - 1e-6) {
    throw new MalformedResponseError(`Answer '${label}' chose '${a.choice}' but a different option carries the highest probability.`);
  }
}

/**
 * Check a Score answer against the number of levels that were sent.
 *
 * The legend and the distribution must both describe exactly the levels
 * offered, and the score itself must be a finite number.
 */
export function validateScoreAnswer(answer: unknown, levelCount: number, label: string): void {
  const a = asRecord(answer, label);
  if (typeof a.score !== "number" || !Number.isFinite(a.score)) {
    throw new MalformedResponseError(`Answer '${label}' has no finite score.`);
  }
  if (!isUnitInterval(a.confidence)) throw new MalformedResponseError(`Answer '${label}' has no confidence in [0, 1].`);
  if (typeof a.legend !== "object" || a.legend === null || Array.isArray(a.legend)) {
    throw new MalformedResponseError(`Answer '${label}' has no legend.`);
  }
  const legendKeys = Object.keys(a.legend as Record<string, unknown>);
  if (legendKeys.length !== levelCount) {
    throw new MalformedResponseError(`Answer '${label}' has a legend of ${legendKeys.length} levels; the question sent ${levelCount}.`);
  }
  checkDistribution(a.probabilities, legendKeys, label);
}

/** Check a Noul answer: one finite probability in [0, 1]. */
export function validateNoulAnswer(answer: unknown, label: string): void {
  const a = asRecord(answer, label);
  if (!isUnitInterval(a.noul)) throw new MalformedResponseError(`Answer '${label}' has no probability in [0, 1].`);
}
