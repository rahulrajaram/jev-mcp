#!/usr/bin/env node
/**
 * jev-mcp — MCP server exposing TypeSafe Jev as typed judgment tools.
 *
 * Jev is a System One model: it returns a typed answer plus a calibrated
 * probability distribution, never prose. These tools surface that faithfully.
 *
 * Rules that shape the whole surface:
 *
 *  1. The caller owns the option set. Every selecting tool requires options
 *     supplied by the caller, so the model can pick the wrong one but can never
 *     invent one. A selector cannot choose a candidate the enumerator dropped.
 *  2. Probabilities are always returned, never just the label.
 *  3. The API key comes from the environment only, never a tool argument.
 *  4. Nothing is silently dropped, overwritten, or truncated. A request that
 *     cannot be honoured exactly fails with a reason.
 *  5. Nothing but JSON-RPC is ever written to stdout.
 *  6. Every answer is checked against the question that was sent. A choice
 *     that was never offered, or a distribution that does not cover the
 *     offered options, is an error rather than a result.
 *
 * The same five tools are served by either of two APIs: TypeSafe's own (via
 * @typesafe-ai/sdk) or OpenRouter's Decisions API, which routes to the same
 * Jev models behind the same question schema. JEV_PROVIDER pins one;
 * otherwise the server uses the API whose key it can find.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import type { EntryType, Question, ScoreCriteria } from "@typesafe-ai/sdk";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  assertRequestWithinLimit,
  assertUniqueIds,
  backoffDelayMs,
  buildChoiceCriteria,
  CONTEXT_TOKENS,
  DEFAULT_MAX_QUESTIONS,
  DEFAULT_MAX_STATE_CHARS,
  DEFAULT_TIMEOUT_MS,
  describeError,
  gateConfidence,
  gateProbability,
  MalformedResponseError,
  MAX_CHOICE_OPTIONS,
  MAX_SCORE_LEVELS,
  parseRetryAfterMs,
  ProviderHttpError,
  ProviderNetworkError,
  ProviderTimeoutError,
  readPositiveInt,
  resolveProvider,
  validateChoiceAnswer,
  validateNoulAnswer,
  validateScoreAnswer,
} from "./lib.js";

// Read from package.json so the advertised version and the OpenRouter
// attribution cannot drift from the release. OpenRouter surfaces the title
// and referer on its app rankings, so the server identifies itself on every
// call.
const { VERSION, APP_TITLE, HTTP_REFERER } = (() => {
  const fallback = { version: "0.0.0", name: "jev-mcp", homepage: "https://github.com/rashedInt32/jev-mcp" };
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Partial<typeof fallback>;
    return {
      VERSION: typeof pkg.version === "string" && pkg.version ? pkg.version : fallback.version,
      APP_TITLE: typeof pkg.name === "string" && pkg.name ? pkg.name : fallback.name,
      HTTP_REFERER: typeof pkg.homepage === "string" && pkg.homepage ? pkg.homepage : fallback.homepage,
    };
  } catch {
    return { VERSION: fallback.version, APP_TITLE: fallback.name, HTTP_REFERER: fallback.homepage };
  }
})();

// ── Configuration ───────────────────────────────────────────────────────────

/**
 * Every log line goes to stderr.
 *
 * The TypeSafe SDK's default logger uses `console.info` and `console.debug`,
 * which write to stdout. On a stdio transport stdout carries JSON-RPC, so a
 * single verbose log line corrupts the stream and kills the connection.
 * Routing all four levels to stderr makes any TYPESAFE_LOG_LEVEL safe.
 */
const stderrLogger = {
  debug: (message: string, ...args: unknown[]) => console.error("[typesafe-sdk]", message, ...args),
  info: (message: string, ...args: unknown[]) => console.error("[typesafe-sdk]", message, ...args),
  warn: (message: string, ...args: unknown[]) => console.error("[typesafe-sdk]", message, ...args),
  error: (message: string, ...args: unknown[]) => console.error("[typesafe-sdk]", message, ...args),
};

const timeout = readPositiveInt(process.env.JEV_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, "JEV_TIMEOUT_MS");
const maxQuestions = readPositiveInt(process.env.JEV_MAX_QUESTIONS, DEFAULT_MAX_QUESTIONS, "JEV_MAX_QUESTIONS");
const maxStateChars = readPositiveInt(process.env.JEV_MAX_STATE_CHARS, DEFAULT_MAX_STATE_CHARS, "JEV_MAX_STATE_CHARS");
for (const setting of [timeout, maxQuestions, maxStateChars]) {
  if (setting.warning) console.error(`[jev-mcp] ${setting.warning}`);
}

// ── Provider and key resolution ─────────────────────────────────────────────

/**
 * Fallback source for the key.
 *
 * An MCP server is spawned with the client's own environment, not your shell's,
 * so anything exported from `~/.zshenv` never arrives. Confirmed on the wire: a
 * PreToolUse hook under the same client received `JEV_GUARD`, which is injected
 * through settings `env`, but not `TYPESAFE_API_KEY`, which lives only in the
 * shell profile.
 *
 * A 0600 file reaches every spawn path while keeping the secret out of
 * `~/.claude.json`, out of argv, and out of any repository. Both providers get
 * the same mechanism, because the env-stripping trap applies to either key.
 */
const KEY_FILE = process.env.JEV_KEY_FILE ?? join(homedir(), ".config", "typesafe", "key");
const OR_KEY_FILE = process.env.JEV_OR_KEY_FILE ?? join(homedir(), ".config", "openrouter", "key");
const OR_BASE_URL = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai").replace(/\/+$/, "");

function readKeyFile(file: string): string | undefined {
  try {
    const contents = readFileSync(file, "utf8").trim();
    return contents.length > 0 ? contents : undefined;
  } catch {
    return undefined;
  }
}

const typesafeKeyPresent = Boolean(process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY ?? readKeyFile(KEY_FILE));
const openrouterKeyPresent = Boolean(process.env.OPENROUTER_API_KEY ?? readKeyFile(OR_KEY_FILE));
const resolvedProvider = resolveProvider(process.env.JEV_PROVIDER, typesafeKeyPresent, openrouterKeyPresent);
if (resolvedProvider.warning) console.error(`[jev-mcp] ${resolvedProvider.warning}`);
const PROVIDER = resolvedProvider.provider;

/** Model ids differ per provider, so the default tracks the active one. */
const MODEL = process.env.JEV_MODEL ?? (PROVIDER === "openrouter" ? "~typesafe/jev-latest" : "jev-latest");

// ── Shared schema pieces ────────────────────────────────────────────────────

/**
 * State accepted by Jev: plain text, or structured data for records and logs.
 *
 * `any` rather than `unknown` on purpose: the SDK constrains state to JsonValue
 * and `unknown` members are not assignable to it. The JSON Schema is identical.
 */
const StateSchema = z
  .union([z.string(), z.record(z.any()), z.array(z.any())])
  .describe(
    "The content to evaluate: a plain string for text, or an object/array for structured data such as a record, a diff, or a chat log. " +
      "Jev's entire request budget is about 32,000 tokens, shared by this state and every question, which is roughly 150,000 characters of English but varies with content — terse or repetitive text costs more tokens per character. " +
      "Filter in code and send only the fields the question needs. This server rejects an oversized state rather than truncating it, because truncation silently changes the material the judgment rests on.",
  );

/** Instructions accept JSON structure, which helps when a question has parts. */
const InstructionSchema = z
  .union([z.string().min(1), z.record(z.any()), z.array(z.any())])
  .describe("The judgment to make. A string, or an object/array when the question has several labelled parts. This is the only instruction Jev sees, so state it in full.");

/** Option and level descriptions accept the same JSON structure. */
const DescriptionSchema = z.union([z.string(), z.record(z.any()), z.array(z.any()), z.null()]);

const UsageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cost: z.number().optional().describe("What the call cost in US dollars, when the provider reports it. OpenRouter does; the TypeSafe API bills by input token and reports no per-call cost."),
});
const LatencySchema = z.number().describe("Wall-clock milliseconds for the API round trip, for your own calibration logs.");
const GateSchema = z.enum(["act", "review", "abstain"]);
/** Which API served the answer; the shape is identical either way. */
const ProviderSchema = z.enum(["typesafe", "openrouter"]);

const ActAbove = z
  .number()
  .min(0)
  .max(1)
  .optional()
  .describe("Confidence at or above which the answer is marked 'act'. Default 0.8. Calibrate on your own data and the cost of being wrong.");
const ReviewAbove = z
  .number()
  .min(0)
  .max(1)
  .optional()
  .describe("Confidence at or above which the answer is marked 'review' rather than 'abstain'. Default 0.5.");

// ── Providers ────────────────────────────────────────────────────────────────

/**
 * One judgment over a state, in the shape both providers accept and return.
 *
 * `answers` is `any` on purpose. Each entry is checked against the question
 * that was sent (validateChoiceAnswer and friends) before any field is read,
 * and the SDK's per-question generics cannot survive a provider-agnostic
 * surface. The validation, not the type, is the safety net.
 */
interface JudgmentCall {
  state: unknown;
  model: string;
  questions: Record<string, Question>;
}

interface JudgmentResult {
  model: string;
  answers: Record<string, any>;
  usage: { input_tokens: number; output_tokens: number; cost?: number };
}

interface JudgmentProvider {
  readonly name: "typesafe" | "openrouter";
  systemOne(call: JudgmentCall, options?: { signal?: AbortSignal }): Promise<JudgmentResult>;
  listModels(options?: { signal?: AbortSignal }): Promise<{ name: string; description: string; release_date: string }[]>;
}

/** The TypeSafe API through the SDK: retries, request ids, models.list. */
class TypeSafeProvider implements JudgmentProvider {
  readonly name = "typesafe" as const;
  private client: TypeSafeClient;

  constructor(apiKey: string) {
    this.client = new TypeSafeClient({ apiKey, timeout: timeout.value, logger: stderrLogger });
  }

  async systemOne({ state, model, questions }: JudgmentCall, { signal }: { signal?: AbortSignal } = {}): Promise<JudgmentResult> {
    const result = await this.client.systemOne({ state: state as EntryType, model, questions }, { signal });
    return {
      model: result.model,
      answers: result.answers as Record<string, any>,
      usage: { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens },
    };
  }

  async listModels({ signal }: { signal?: AbortSignal } = {}) {
    return this.client.models.list({ signal });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Statuses worth another attempt. Mirrors the TypeSafe SDK exactly — 408, 429
 * and the whole 500-599 range — so the same question has the same failure
 * profile on either route.
 */
const MAX_ATTEMPTS = 3;

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * OpenRouter's Decisions API. The question and answer shapes are the ones the
 * TypeSafe API defines; OpenRouter routes them to the same Jev models under
 * ids like typesafe/jev-1.13 and the ~typesafe/jev-latest alias, so a caller
 * sees the same typed answers either way. This client reimplements what the
 * TypeSafe SDK contributes on the other path: bounded retries that honour
 * Retry-After, per-attempt timeouts, and errors that carry an HTTP status so
 * callers can branch on them.
 */
class OpenRouterProvider implements JudgmentProvider {
  readonly name = "openrouter" as const;

  constructor(private apiKey: string) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "X-Title": APP_TITLE,
      "HTTP-Referer": HTTP_REFERER,
    };
  }

  /**
   * One request with retries. A retriable failure consumes an attempt and waits
   * for Retry-After when the provider asked for one, otherwise for capped
   * exponential backoff. A per-attempt timeout is retried too: the SDK retries
   * its own timeouts (`apiTimeoutError: true`), so not retrying here would give
   * the same question a different failure profile on this route.
   */
  private async request(path: string, init: RequestInit & { signal?: AbortSignal }): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      const timeoutSignal = AbortSignal.timeout(timeout.value);
      const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
      let response: Response;
      try {
        response = await fetch(`${OR_BASE_URL}${path}`, { ...init, signal });
      } catch (error) {
        // A caller abort is not a failure; let describeError see it.
        if (error instanceof Error && (error.name === "AbortError" || init.signal?.aborted)) throw error;
        const retriesLeft = attempt < MAX_ATTEMPTS && !init.signal?.aborted;
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        if (retriesLeft) {
          await sleep(backoffDelayMs(attempt - 1));
          continue;
        }
        if (timedOut) {
          throw new ProviderTimeoutError(`OpenRouter did not answer within ${timeout.value}ms, after ${attempt} attempts.`);
        }
        throw new ProviderNetworkError(`Could not reach ${OR_BASE_URL}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.ok || !isRetryableStatus(response.status) || attempt >= MAX_ATTEMPTS || init.signal?.aborted) {
        return response;
      }
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after-ms"), response.headers.get("retry-after"));
      await sleep(retryAfterMs ?? backoffDelayMs(attempt - 1));
    }
  }

  async systemOne({ state, model, questions }: JudgmentCall, { signal }: { signal?: AbortSignal } = {}): Promise<JudgmentResult> {
    const response = await this.request("/api/alpha/decisions", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model, questions, state }),
      signal,
    });
    if (!response.ok) throw await this.httpError(response);

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new MalformedResponseError(`OpenRouter returned HTTP ${response.status} with a body that is not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = body as { model?: unknown; answers?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown; cost?: unknown } };
    if (typeof parsed.answers !== "object" || parsed.answers === null || Array.isArray(parsed.answers)) {
      throw new MalformedResponseError("OpenRouter returned no answers object.");
    }
    if (typeof parsed.model !== "string") throw new MalformedResponseError("OpenRouter returned no model id.");
    if (typeof parsed.usage?.input_tokens !== "number" || typeof parsed.usage?.output_tokens !== "number") {
      throw new MalformedResponseError("OpenRouter returned no token usage.");
    }
    const cost = typeof parsed.usage.cost === "number" ? parsed.usage.cost : undefined;
    return {
      model: parsed.model,
      answers: parsed.answers as Record<string, any>,
      usage: { input_tokens: parsed.usage.input_tokens, output_tokens: parsed.usage.output_tokens, cost },
    };
  }

  async listModels({ signal }: { signal?: AbortSignal } = {}) {
    // A cheap authenticated call proves the key before anything is listed,
    // because the catalog reads below succeed without one.
    const authCheck = await this.request("/api/v1/auth/key", { method: "GET", headers: this.headers(), signal });
    if (!authCheck.ok) throw await this.httpError(authCheck);

    // OpenRouter's models list does not include decisions models, so the Jev
    // family is enumerated from its known catalog entries. A miss here means
    // the family moved on; the active model in JEV_MODEL is unaffected.
    const slugs = ["~typesafe/jev-latest", "typesafe/jev-1.13"];
    const models: { name: string; description: string; release_date: string }[] = [];
    for (const slug of slugs) {
      const path = `/api/v1/models/${slug.split("/").map(encodeURIComponent).join("/")}/endpoints`;
      const response = await this.request(path, { method: "GET", headers: this.headers(), signal });
      if (!response.ok) continue;
      const body = (await response.json()) as { data?: { id?: unknown; description?: unknown; created?: unknown } };
      const data = body.data;
      if (typeof data?.id !== "string" || typeof data.description !== "string" || typeof data.created !== "number") continue;
      models.push({
        name: data.id,
        description: data.description,
        release_date: new Date(data.created * 1000).toISOString().slice(0, 10),
      });
    }
    if (models.length === 0) {
      throw new ProviderHttpError("No Jev models were found in the OpenRouter catalog.", 404);
    }
    return models;
  }

  /**
   * Build the typed error describeError can classify, extracting OpenRouter's
   * nested detail: its error bodies are {error: {message, code}}.
   */
  private async httpError(response: Response): Promise<ProviderHttpError> {
    const text = await response.text().catch(() => "");
    let message = text.length > 0 ? text.slice(0, 500) : `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === "string") message = parsed.error.message;
    } catch {
      // keep the raw text
    }
    return new ProviderHttpError(
      message,
      response.status,
      response.headers.get("x-or-request-id") ?? undefined,
      parseRetryAfterMs(response.headers.get("retry-after-ms"), response.headers.get("retry-after")),
    );
  }
}

let provider: JudgmentProvider | undefined;

/**
 * Built lazily: a missing key should produce one clear tool error rather than
 * stop the server from starting. The message names the key sources of the
 * active provider, since that is the credential the operator must supply.
 */
function getProvider(): JudgmentProvider {
  if (provider) return provider;
  if (PROVIDER === "openrouter") {
    const apiKey = process.env.OPENROUTER_API_KEY ?? readKeyFile(OR_KEY_FILE);
    if (!apiKey) {
      throw new Error(
        `No API key. Set OPENROUTER_API_KEY in the environment of the MCP client, or create ${OR_KEY_FILE} with mode 0600. Never pass it as a tool argument.`,
      );
    }
    provider = new OpenRouterProvider(apiKey);
  } else {
    const apiKey = process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY ?? readKeyFile(KEY_FILE);
    if (!apiKey) {
      throw new Error(
        `No API key. Set TYPESAFE_API_KEY in the environment of the MCP client, or create ${KEY_FILE} with mode 0600. Never pass it as a tool argument.`,
      );
    }
    provider = new TypeSafeProvider(apiKey);
  }
  return provider;
}

// ── Result helpers ──────────────────────────────────────────────────────────

/**
 * Tool results carry both a text block and structured content: the text keeps
 * older clients working, the structured payload is validated against the tool's
 * output schema so a caller gets typed data instead of a JSON string to parse.
 */
function ok<T extends Record<string, unknown>>(payload: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function fail(error: unknown) {
  const described = describeError(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: described }, null, 2) }],
  };
}

/**
 * Reject a threshold pair whose bands are inverted.
 *
 * `act` is a stricter reading of the same confidence than `review`, so an
 * act_above below review_above makes the review band unreachable while the
 * response still reports both thresholds as if they applied. The check tool
 * already guards its own pair; the selecting tools must too, or a caller
 * silently receives verdicts produced with one band ignored.
 */
function assertGateOrder(actAbove: number, reviewAbove: number): void {
  if (actAbove < reviewAbove) {
    throw new Error(
      `act_above (${actAbove}) must not be below review_above (${reviewAbove}): the review band would be unreachable. Raise act_above or lower review_above.`,
    );
  }
}

const server = new McpServer({ name: "jev", version: VERSION });

// ── Scope guidance shared by every judgment tool ────────────────────────────

/**
 * Appended to each judgment tool's description so an agent that never opens the
 * skill still learns the three-way test from the tool listing itself: answer it
 * yourself, call these tools, or write SDK code.
 *
 * Keep this terse — it ships in every tools/list response — but do not trim the
 * exclusions; they are the part agents get wrong. A number and a label look
 * rigorous, which is exactly why a one-off judgment that an ordinary argued
 * answer would serve better must not reach for them.
 */
const SCOPE_GUIDE =
  "WHEN TO USE: the same semantic judgment repeats across many items (triaging many files, ranking many candidates, checking each claim against its source, scoring each requirement against a diff), or you specifically need a calibrated probability to threshold a decision on. " +
  "WHEN NOT TO USE: (1) a one-off judgment you can reason out yourself in conversation — an ordinary answer carries an argument the user can push back on, and Jev returns a number and a label, which is weaker in dialogue; do not reach for a tool to look rigorous; " +
  "(2) anything a deterministic check, query, or measurement can decide — run that instead; a probability cannot improve on ground truth and only adds anchoring; " +
  "(3) arithmetic, counting, or date comparison — Jev has no scratchpad and fails these confidently; compute in code and pass the result in as a fact; " +
  "(4) logic that must run inside the user's application — that belongs in SDK code under test, not in a tool call. " +
  "Always report the answer WITH its confidence and what you did about it; treat review/uncertain as 'look at the evidence yourself', never as a soft yes.";

// ── classify: one of a defined set ─────────────────────────────────────────

server.registerTool(
  "jev_classify",
  {
    title: "Classify into one of your options",
    description:
      "Pick exactly one option from a set you define. Returns the chosen option, the probability of every option, a confidence value, and a recommended action gated on confidence. " +
      "Use when the answer is one of a fixed set. The options must be supplied by you: Jev selects among them and cannot invent a new one. Up to 255 options. " +
      SCOPE_GUIDE,
    inputSchema: {
      state: StateSchema,
      question: InstructionSchema,
      options: z
        .record(DescriptionSchema)
        .describe("Map of option name to a description that separates it from the others. Both the name and the description are sent to the model, so keep names short and distinct. A description may be an object or array when structure clarifies it, or null to leave it undescribed."),
      add_none: z
        .boolean()
        .optional()
        .describe("Add a no-match option meaning none of yours fits. Defaults to true. Turn off only when one option must always apply. If you already use the name 'none', the added option takes a different key and it is reported back as none_option."),
      act_above: ActAbove,
      review_above: ReviewAbove,
    },
    outputSchema: {
      choice: z.string(),
      confidence: z.number(),
      probabilities: z.record(z.number()),
      none_option: z.string().nullable().describe("The key carrying the no-match meaning, or null when none was added."),
      action: GateSchema,
      thresholds: z.object({ act_above: z.number(), review_above: z.number() }),
      model: z.string(),
      provider: ProviderSchema,
      usage: UsageSchema,
      latency_ms: LatencySchema,
    },
  },
  async ({ state, question, options, add_none, act_above, review_above }, extra) => {
    try {
      const actAbove = act_above ?? 0.8;
      const reviewAbove = review_above ?? 0.5;
      assertGateOrder(actAbove, reviewAbove);
      const { criteria, noneKey } = buildChoiceCriteria(options as Record<string, EntryType>, add_none !== false);

      const questions = { classify: choice(question, criteria) };
      assertRequestWithinLimit(state, questions, maxStateChars.value);

      const p = getProvider();
      const started = performance.now();
      const result = await p.systemOne(
        { state, model: MODEL, questions },
        { signal: extra.signal },
      );
      const latency_ms = Math.round(performance.now() - started);
      const answer = result.answers.classify;
      validateChoiceAnswer(answer, Object.keys(criteria), "classify");
      return ok({
        choice: answer.choice,
        confidence: answer.confidence,
        probabilities: answer.probabilities,
        none_option: noneKey,
        action: gateConfidence(answer.confidence, actAbove, reviewAbove),
        thresholds: { act_above: actAbove, review_above: reviewAbove },
        model: result.model,
        provider: p.name,
        usage: result.usage,
        latency_ms,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

// ── score: a position on an ordered scale ──────────────────────────────────

server.registerTool(
  "jev_score",
  {
    title: "Rate on an ordered scale",
    description:
      "Rate the state along an ordered scale you define. Returns a probability-weighted score that can land between levels, the distribution, confidence, and a recommended action. " +
      "Use for degree or severity, not for picking a category. " +
      SCOPE_GUIDE,
    inputSchema: {
      state: StateSchema,
      question: InstructionSchema,
      levels: z
        .array(DescriptionSchema)
        .min(2)
        .describe("Ordered level descriptions, lowest first. At least two. Each level must describe a concrete situation and stand on its own."),
      act_above: ActAbove,
      review_above: ReviewAbove,
    },
    outputSchema: {
      score: z.number(),
      confidence: z.number(),
      probabilities: z.record(z.number()),
      legend: z.record(z.any()),
      action: GateSchema,
      thresholds: z.object({ act_above: z.number(), review_above: z.number() }),
      model: z.string(),
      provider: ProviderSchema,
      usage: UsageSchema,
      latency_ms: LatencySchema,
    },
  },
  async ({ state, question, levels, act_above, review_above }, extra) => {
    try {
      if (levels.length > MAX_SCORE_LEVELS) {
        throw new Error(`levels must contain at most ${MAX_SCORE_LEVELS} entries; received ${levels.length}. A Score question accepts up to 10 levels; this is an API limit.`);
      }
      const actAbove = act_above ?? 0.8;
      const reviewAbove = review_above ?? 0.5;
      assertGateOrder(actAbove, reviewAbove);

      // zod already enforces two or more levels; the SDK types that as a tuple.
      const questions = { rating: score(question, levels as unknown as ScoreCriteria) };
      assertRequestWithinLimit(state, questions, maxStateChars.value);

      const p = getProvider();
      const started = performance.now();
      const result = await p.systemOne(
        { state, model: MODEL, questions },
        { signal: extra.signal },
      );
      const latency_ms = Math.round(performance.now() - started);
      const answer = result.answers.rating;
      validateScoreAnswer(answer, levels.length, "rating");
      return ok({
        score: answer.score,
        confidence: answer.confidence,
        probabilities: answer.probabilities,
        legend: answer.legend,
        action: gateConfidence(answer.confidence, actAbove, reviewAbove),
        thresholds: { act_above: actAbove, review_above: reviewAbove },
        model: result.model,
        provider: p.name,
        usage: result.usage,
        latency_ms,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

// ── check: probability that a condition holds ──────────────────────────────

server.registerTool(
  "jev_check",
  {
    title: "Yes/no with a probability",
    description:
      "Ask a yes/no question. Returns the probability that the answer is yes, from 0 to 1, plus a verdict. There is no separate confidence: a value near 0.5 means yes and no are close to equally likely, not that the answer is 'medium'. " +
      "Use one check per label when several labels may apply at once. " +
      SCOPE_GUIDE,
    inputSchema: {
      state: StateSchema,
      question: InstructionSchema,
      yes_means: DescriptionSchema.optional().describe("What a yes means. Sharpens the judgment."),
      no_means: DescriptionSchema.optional().describe("What a no means."),
      yes_at_or_above: z.number().min(0).max(1).optional().describe("Probability at or above which the verdict is 'yes'. Default 0.7."),
      no_at_or_below: z.number().min(0).max(1).optional().describe("Probability at or below which the verdict is 'no'. Default 0.3. Between the two the verdict is 'uncertain'."),
    },
    outputSchema: {
      probability_yes: z.number(),
      verdict: z.enum(["yes", "no", "uncertain"]),
      thresholds: z.object({ yes_at_or_above: z.number(), no_at_or_below: z.number() }),
      model: z.string(),
      provider: ProviderSchema,
      usage: UsageSchema,
      latency_ms: LatencySchema,
    },
  },
  async ({ state, question, yes_means, no_means, yes_at_or_above, no_at_or_below }, extra) => {
    try {
      const yesAt = yes_at_or_above ?? 0.7;
      const noAt = no_at_or_below ?? 0.3;
      if (noAt > yesAt) throw new Error("no_at_or_below must not exceed yes_at_or_above.");

      const criteria =
        yes_means !== undefined || no_means !== undefined
          ? { true: yes_means ?? null, false: no_means ?? null }
          : undefined;

      const questions = { check: criteria ? noul(question, criteria) : noul(question) };
      assertRequestWithinLimit(state, questions, maxStateChars.value);

      const p = getProvider();
      const started = performance.now();
      const result = await p.systemOne(
        { state, model: MODEL, questions },
        { signal: extra.signal },
      );
      const latency_ms = Math.round(performance.now() - started);
      validateNoulAnswer(result.answers.check, "check");
      const probability = result.answers.check.noul;
      return ok({
        probability_yes: probability,
        verdict: gateProbability(probability, yesAt, noAt),
        thresholds: { yes_at_or_above: yesAt, no_at_or_below: noAt },
        model: result.model,
        provider: p.name,
        usage: result.usage,
        latency_ms,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

// ── ask: many questions about one state, in a single request ───────────────

server.registerTool(
  "jev_ask",
  {
    title: "Ask many questions about one state",
    description:
      "Ask several independent questions about the same state in ONE request. Jev prefills the state once and scores every question in a single forward pass, so extra questions add almost no latency. " +
      "Questions share the request's ~32,000-token budget with the state, so filter the state before adding questions rather than growing the call. " +
      "Prefer this over repeated single-question calls: on a document-dominated workload it is dramatically cheaper and faster with no change in answers. " +
      "Questions cannot see each other's answers, so state any speculative premise explicitly and let your own logic decide which answers apply. " +
      "One state, one subject: do not batch questions about unrelated subjects. " +
      SCOPE_GUIDE,
    inputSchema: {
      state: StateSchema,
      questions: z
        .array(
          z.object({
            id: z.string().min(1).describe("Your key for this question. Returned alongside the answer. Never sent to the model, so put the full meaning in the question itself. Must be unique within the call."),
            type: z.enum(["classify", "score", "check"]),
            question: InstructionSchema,
            options: z.record(DescriptionSchema).optional().describe("Required for type 'classify'."),
            add_none: z.boolean().optional().describe("For 'classify': add a no-match option. Defaults to true."),
            levels: z.array(DescriptionSchema).min(2).optional().describe("Required for type 'score'."),
            yes_means: DescriptionSchema.optional().describe("For 'check': what a yes means."),
            no_means: DescriptionSchema.optional().describe("For 'check': what a no means."),
          }),
        )
        .min(1),
      act_above: ActAbove,
      review_above: ReviewAbove,
    },
    outputSchema: {
      answers: z.record(z.any()).describe("Keyed by your question ids. Choice and Score answers also carry an 'action' gated on confidence."),
      none_options: z.record(z.string().nullable()).describe("For each 'classify' question, the key carrying the no-match meaning, or null."),
      model: z.string(),
      provider: ProviderSchema,
      usage: UsageSchema,
      latency_ms: LatencySchema,
    },
  },
  async ({ state, questions, act_above, review_above }, extra) => {
    try {
      if (questions.length > maxQuestions.value) {
        throw new Error(`questions must contain at most ${maxQuestions.value} entries; received ${questions.length}. Raise JEV_MAX_QUESTIONS if that limit is wrong for your workload.`);
      }
      assertUniqueIds(questions.map((q) => q.id));
      const actAbove = act_above ?? 0.8;
      const reviewAbove = review_above ?? 0.5;
      assertGateOrder(actAbove, reviewAbove);

      // Null-prototype maps on purpose. A caller id of "__proto__" assigned to a
      // plain object literal sets the prototype instead of creating a property,
      // so the question vanished from the request and from the answer check
      // without a word. On a null-prototype object every id is an ordinary key.
      const built: Record<string, Question> = Object.create(null);
      const noneOptions: Record<string, string | null> = Object.create(null);
      // What each answer must be checked against once it comes back.
      const expected: Record<string, { type: "classify"; keys: string[] } | { type: "score"; levels: number } | { type: "check" }> = Object.create(null);

      for (const q of questions) {
        if (q.type === "classify") {
          if (!q.options) throw new Error(`Question '${q.id}' is type 'classify' and needs options.`);
          const { criteria, noneKey } = buildChoiceCriteria(q.options as Record<string, EntryType>, q.add_none !== false, `options for '${q.id}'`);
          built[q.id] = choice(q.question, criteria);
          noneOptions[q.id] = noneKey;
          expected[q.id] = { type: "classify", keys: Object.keys(criteria) };
        } else if (q.type === "score") {
          if (!q.levels) throw new Error(`Question '${q.id}' is type 'score' and needs levels.`);
          if (q.levels.length > MAX_SCORE_LEVELS) {
            throw new Error(`levels for '${q.id}' must contain at most ${MAX_SCORE_LEVELS} entries. A Score question accepts up to 10 levels; this is an API limit.`);
          }
          built[q.id] = score(q.question, q.levels as unknown as ScoreCriteria);
          expected[q.id] = { type: "score", levels: q.levels.length };
        } else {
          const criteria =
            q.yes_means !== undefined || q.no_means !== undefined
              ? { true: q.yes_means ?? null, false: q.no_means ?? null }
              : undefined;
          built[q.id] = criteria ? noul(q.question, criteria) : noul(q.question);
          expected[q.id] = { type: "check" };
        }
      }

      assertRequestWithinLimit(state, built, maxStateChars.value);

      const p = getProvider();
      const started = performance.now();
      const result = await p.systemOne({ state, model: MODEL, questions: built }, { signal: extra.signal });
      const latency_ms = Math.round(performance.now() - started);

      // Every question sent must come back well-formed. A missing answer is an
      // error, not a silently absent key, so a caller never acts on a partial set.
      const raw = result.answers as unknown as Record<string, Record<string, unknown>>;
      const answers: Record<string, unknown> = Object.create(null);
      for (const [id, want] of Object.entries(expected)) {
        const answer = raw[id];
        if (want.type === "classify") validateChoiceAnswer(answer, want.keys, id);
        else if (want.type === "score") validateScoreAnswer(answer, want.levels, id);
        else validateNoulAnswer(answer, id);
        // The validators have established the shape; narrow once here.
        const a = answer as Record<string, unknown>;
        // Attach the confidence gate where the primitive has a confidence to
        // gate on, never because a stray numeric field happened to be present:
        // a Noul has no confidence, so gating one would invent a meaning.
        answers[id] =
          want.type === "check"
            ? // A Noul has no confidence, so return only the validated pair
              // rather than forwarding any stray field the provider added.
              { type: "noul", noul: a.noul as number }
            : {
                ...a,
                action: gateConfidence(typeof a.confidence === "number" ? a.confidence : undefined, actAbove, reviewAbove),
              };
      }

      return ok({ answers, none_options: noneOptions, model: result.model, provider: p.name, usage: result.usage, latency_ms });
    } catch (error) {
      return fail(error);
    }
  },
);

// ── models: what this key can actually use ─────────────────────────────────

server.registerTool(
  "jev_models",
  {
    title: "List available models and the effective limits",
    description:
      "List the models this API key can use, with their release dates, and report the limits this server enforces (context budget, largest state, questions per call, options per Choice, levels per Score). " +
      "Use it to confirm the key works, to find a model id for JEV_MODEL before assuming one exists, and to size a large call before building it.",
    inputSchema: {},
    outputSchema: {
      active_model: z.string().describe("The model these tools send requests to."),
      models: z.array(z.object({ name: z.string(), description: z.string(), release_date: z.string() })),
      provider: ProviderSchema,
      limits: z.object({
        context_tokens: z.number().describe("Jev's request budget in tokens, shared by the state and every question. Approximate: the real ratio depends on content."),
        max_state_chars: z.number().describe("Largest request text accepted in characters, counting the state plus every question (JEV_MAX_STATE_CHARS)."),
        max_questions: z.number().describe("Questions allowed in one jev_ask call (JEV_MAX_QUESTIONS)."),
        max_choice_options: z.number().describe("Options allowed per Choice question."),
        max_score_levels: z.number().describe("Levels allowed per Score question."),
      }),
    },
  },
  async (_args, extra) => {
    try {
      const p = getProvider();
      const models = await p.listModels({ signal: extra.signal });
      return ok({
        active_model: MODEL,
        models,
        provider: p.name,
        limits: {
          context_tokens: CONTEXT_TOKENS,
          max_state_chars: maxStateChars.value,
          max_questions: maxQuestions.value,
          max_choice_options: MAX_CHOICE_OPTIONS,
          max_score_levels: MAX_SCORE_LEVELS,
        },
      });
    } catch (error) {
      return fail(error);
    }
  },
);

// ── Boot ────────────────────────────────────────────────────────────────────

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`[jev-mcp] ready — version ${VERSION}, provider ${PROVIDER}, model ${MODEL}`);
}

main().catch((error) => {
  console.error("[jev-mcp] failed to start:", error);
  process.exit(1);
});
