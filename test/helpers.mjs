// Shared test rig: local stand-ins for the TypeSafe and OpenRouter APIs plus
// an MCP client.
//
// Tests drive the real built server over stdio through the official MCP client,
// so there are no sleeps and no hand-rolled JSON-RPC framing. The stand-ins
// record every outbound request, which is how the regression tests prove what
// the server actually sends rather than what it claims to send.

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const SERVER_PATH = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/** Names assembled at runtime so scanners don't read this file as a credential. */
const KEY_VAR = ["TYPESAFE", "API", "KEY"].join("_");
export const OR_KEY_VAR = ["OPENROUTER", "API", "KEY"].join("_");

/**
 * Generate one well-formed answer per question in a request body. Both APIs
 * speak the same question schema, so both stand-ins share this generator.
 */
function makeAnswers(parsed, state) {
  const answers = {};
  for (const [id, q] of Object.entries(parsed.questions ?? {})) {
    if (q.type === "noul") {
      answers[id] = { type: "noul", noul: state.noul };
    } else if (q.type === "choice") {
      const keys = Object.keys(q.criteria ?? {});
      answers[id] = {
        type: "choice",
        choice: keys[0] ?? "x",
        confidence: state.confidence,
        // A real distribution: the winner takes 0.9, the rest share 0.1.
        probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.9 : 0.1 / Math.max(keys.length - 1, 1)])),
      };
    } else {
      const levels = (q.criteria ?? []).map((_, i) => String(i));
      answers[id] = {
        type: "score",
        score: 1,
        confidence: state.confidence,
        legend: Object.fromEntries(levels.map((k, i) => [k, q.criteria[i]])),
        probabilities: Object.fromEntries(levels.map((k) => [k, 1 / levels.length])),
      };
    }
  }
  return answers;
}

/** Shared failure-state logic: an optional run of status failures before success. */
function failureResponse(state, json) {
  if (state.badKey) {
    json(401, { error: { message: "The key was rejected.", code: 401 } });
    return true;
  }
  if (state.failNext && state.failNext.times > 0) {
    state.failNext.times -= 1;
    const headers = state.failNext.retryAfter !== undefined ? { "retry-after": String(state.failNext.retryAfter) } : {};
    json(state.failNext.status, { error: { message: `stand-in failure ${state.failNext.status}`, code: state.failNext.status } }, headers);
    return true;
  }
  return false;
}

/** Start a stand-in TypeSafe API that records requests and returns well-formed answers. */
export async function startMock() {
  const requests = [];
  // `answers`, when set, replaces the generated answers verbatim, so a test
  // can hand the server a malformed response and prove it is rejected.
  const state = { confidence: 0.9, noul: 0.5, badKey: false, failNext: null, answers: null };

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(raw || "{}");
      } catch {
        parsed = raw;
      }
      requests.push({ url: req.url, body: parsed });

      const json = (status, body, headers = {}) => {
        res.setHeader("content-type", "application/json");
        res.setHeader("x-typesafe-request-id", "req_test_123");
        for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
        res.writeHead(status);
        res.end(JSON.stringify(body));
      };

      if (failureResponse(state, json)) return;

      if (req.url?.includes("/models")) {
        json(200, { models: [{ name: "jev-latest", description: "Flagship", release_date: "2026-01-01" }] });
        return;
      }

      json(200, { model: "mock-jev", answers: state.answers ?? makeAnswers(parsed, state), usage: { input_tokens: 10, output_tokens: 2 } });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    requests,
    state,
    /** The single outbound request body, asserting exactly one was sent. */
    only() {
      if (requests.length !== 1) throw new Error(`expected exactly 1 request, saw ${requests.length}`);
      return requests[0].body;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Start a stand-in OpenRouter Decisions API. Same answer generation, the
 * OpenRouter response envelope, plus routes for the key check and the Jev
 * family catalog so jev_models and the retry policy can be pinned offline.
 */
export async function startMockOpenRouter() {
  const requests = [];
  const state = { confidence: 0.9, noul: 0.5, badKey: false, failNext: null, answers: null, delayNextMs: 0 };

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(raw || "{}");
      } catch {
        parsed = raw;
      }
      requests.push({ url: req.url, auth: req.headers["authorization"] ?? "", body: parsed });

      const json = (status, body, headers = {}) => {
        res.setHeader("content-type", "application/json");
        for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
        res.writeHead(status);
        res.end(JSON.stringify(body));
      };

      // The key check: OpenRouter answers 401 for a rejected bearer token.
      if (req.url?.includes("/auth/key")) {
        if (state.badKey) {
          json(401, { error: { message: "User not found.", code: 401 } });
          return;
        }
        json(200, { data: { label: "sk-or-…", usage: 0 } });
        return;
      }

      // The Jev family catalog, as OpenRouter's per-model endpoint serves it.
      if (req.url?.includes("/endpoints")) {
        const created = 1789689684;
        if (req.url.includes("jev-latest")) {
          json(200, { data: { id: "~typesafe/jev-latest", name: "TypeSafe: Jev Latest", description: "This model always redirects to the latest model in the Jev family.", created } });
          return;
        }
        if (req.url.includes("jev-1.13")) {
          json(200, { data: { id: "typesafe/jev-1.13", name: "TypeSafe: Jev 1.13", description: "Jev is a structured decision model from TypeSafe.", created } });
          return;
        }
        json(404, { error: { message: "Not Found", code: 404 } });
        return;
      }

      if (req.url?.includes("/api/alpha/decisions")) {
        if (failureResponse(state, json)) return;
        const reply = () =>
          json(200, {
            model: "typesafe/jev-1.13-20260917",
            answers: state.answers ?? makeAnswers(parsed, state),
            usage: { input_tokens: 25, output_tokens: 4, cost: 1.05e-6 },
            id: "gen-dec-test",
            provider: "TypeSafe",
          });
        // A one-shot delay lets a test force a per-attempt timeout on the first
        // attempt and still let the retry succeed.
        if (state.delayNextMs > 0) {
          const delay = state.delayNextMs;
          state.delayNextMs = 0;
          setTimeout(reply, delay);
          return;
        }
        reply();
        return;
      }

      json(404, { error: { message: `no stand-in route for ${req.url}`, code: 404 } });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    requests,
    state,
    /** Every recorded decision request body, in order. */
    decisions() {
      return requests.filter((r) => r.url.includes("/api/alpha/decisions"));
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Connect an MCP client to the built server.
 *
 * `withKey: false` starts the server with no TypeSafe credential at all, which
 * is how the missing-key path is exercised. An OpenRouter key is always passed
 * through `env` so a test chooses its own provider.
 */
export async function withClient({ baseUrl, withKey = true, env = {} } = {}, fn) {
  // Pin both key-file fallbacks at paths that cannot exist. HOME is passed
  // through, so without this the suite would start reading a real
  // ~/.config/typesafe/key or ~/.config/openrouter/key the moment one exists,
  // and the missing-key tests would quietly begin making live calls instead of
  // exercising the failure path. A test that needs a fallback passes the
  // JEV_KEY_FILE or JEV_OR_KEY_FILE env explicitly.
  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    JEV_KEY_FILE: "/nonexistent/jev-mcp-test/key",
    JEV_OR_KEY_FILE: "/nonexistent/jev-mcp-test/or-key",
    ...env,
  };
  if (baseUrl) childEnv.TYPESAFE_BASE_URL = baseUrl;
  if (withKey) childEnv[KEY_VAR] = "value-for-the-local-stand-in";

  const client = new Client({ name: "jev-mcp-test", version: "0.2.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: childEnv,
    stderr: "ignore",
  });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

/** Parse the JSON a tool returns in its text block. */
export function payload(result) {
  const block = result.content?.find((b) => b.type === "text");
  if (!block) throw new Error("tool returned no text content");
  return JSON.parse(block.text);
}
