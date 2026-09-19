// Contract and regression tests for the tool surface.
//
// These run the real built server over stdio against a local stand-in for the
// TypeSafe API, so each assertion is about what the server actually sends and
// returns. Every test named "regression" pins a defect that was confirmed on
// the wire before it was fixed.

import assert from "node:assert/strict";
import test from "node:test";
import { payload, startMock, startMockOpenRouter, withClient } from "./helpers.mjs";

const TOOLS = ["jev_ask", "jev_check", "jev_classify", "jev_models", "jev_score"];

// ── Contract ────────────────────────────────────────────────────────────────

test("advertises exactly the five judgment tools", async () => {
  await withClient({ withKey: false }, async (client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), TOOLS);
  });
});

test("every tool documents itself and declares both input and output schemas", async () => {
  await withClient({ withKey: false }, async (client) => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      assert.ok(tool.description?.length > 40, `${tool.name} needs a real description`);
      assert.ok(tool.inputSchema, `${tool.name} has no inputSchema`);
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(tool.outputSchema, `${tool.name} has no outputSchema, so callers get an opaque string`);
    }
  });
});

test("every judgment tool carries the when-to-use / when-not-to-use scope guide", async () => {
  // Agents read tool descriptions without ever opening the skill, so the
  // three-way test (answer it yourself / call the tools / write SDK code) must
  // ship in the tools/list payload itself. Missing scope guidance was the
  // gap behind agents reaching for a one-off judgment to look rigorous.
  await withClient({ withKey: false }, async (client) => {
    const { tools } = await client.listTools();
    const judgment = tools.filter((t) => t.name !== "jev_models");
    assert.equal(judgment.length, 4);
    for (const tool of judgment) {
      for (const marker of ["WHEN TO USE:", "WHEN NOT TO USE:", "one-off judgment", "SDK code"]) {
        assert.ok(
          tool.description?.includes(marker),
          `${tool.name} must mention "${marker}" so the scope guide survives in its description`,
        );
      }
    }
  });
});

test("classify requires caller-supplied options, so the model cannot invent one", async () => {
  await withClient({ withKey: false }, async (client) => {
    const { tools } = await client.listTools();
    const classify = tools.find((t) => t.name === "jev_classify");
    for (const field of ["state", "question", "options"]) {
      assert.ok(classify.inputSchema.required.includes(field), `${field} must be required`);
    }
    const scoreTool = tools.find((t) => t.name === "jev_score");
    assert.ok(scoreTool.inputSchema.required.includes("levels"));
    assert.equal(scoreTool.inputSchema.properties.levels.minItems, 2);
  });
});

test("a missing API key fails loudly and says what to do about it", async () => {
  await withClient({ withKey: false }, async (client) => {
    const result = await client.callTool({
      name: "jev_check",
      arguments: { state: "anything", question: "Is this a greeting?" },
    });
    assert.equal(result.isError, true, "must report an error, not a fabricated answer");
    const { error } = payload(result);
    assert.equal(error.kind, "no_api_key");
    assert.equal(error.retryable, false);
    assert.match(error.hint, /environment/i);
  });
});

test("falls back to a key file when the environment carries no key", async () => {
  // An MCP server inherits the client's environment, not your shell's, so a key
  // exported from a shell profile never arrives. The file fallback is the only
  // route that reaches every spawn path, which makes it worth pinning here.
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const keyFile = join(mkdtempSync(join(tmpdir(), "jev-key-")), "key");
  writeFileSync(keyFile, "  value-for-the-local-stand-in\n", { mode: 0o600 });

  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url, withKey: false, env: { JEV_KEY_FILE: keyFile } }, async (client) => {
      const result = await client.callTool({
        name: "jev_check",
        arguments: { state: "s", question: "Is this fine?" },
      });
      assert.notEqual(result.isError, true, "the key file should satisfy the credential check");
      assert.equal(typeof payload(result).probability_yes, "number");
      assert.equal(mock.requests.length, 1, "the request must actually reach the API");
    });
  } finally {
    await mock.close();
  }
});

// ── Regressions confirmed on the wire ───────────────────────────────────────

test("regression: an option the caller names 'none' is never overwritten", async () => {
  const mock = await startMock();
  const callerMeaning = "Already resolved; no action needed.";
  try {
    await withClient({ baseUrl: mock.url }, async (client) => {
      const result = await client.callTool({
        name: "jev_classify",
        arguments: {
          state: "s",
          question: "What should happen next?",
          options: { none: callerMeaning, escalate: "Send to a human" },
        },
      });

      const sent = mock.only().questions.classify.criteria;
      assert.equal(sent.none, callerMeaning, "the caller's meaning must reach the model intact");
      assert.equal(sent.none_of_these, "None of the other options fits.");

      const body = payload(result);
      assert.equal(body.none_option, "none_of_these", "the caller must be told which key means no-match");
    });
  } finally {
    await mock.close();
  }
});

test("regression: add_none false sends exactly the caller's options", async () => {
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url }, async (client) => {
      const result = await client.callTool({
        name: "jev_classify",
        arguments: { state: "s", question: "q", options: { a: "first", b: "second" }, add_none: false },
      });
      assert.deepEqual(Object.keys(mock.only().questions.classify.criteria).sort(), ["a", "b"]);
      assert.equal(payload(result).none_option, null);
    });
  } finally {
    await mock.close();
  }
});

test("regression: an empty or oversized option set fails before any request is sent", async () => {
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url }, async (client) => {
      const empty = await client.callTool({
        name: "jev_classify",
        arguments: { state: "s", question: "q", options: {}, add_none: false },
      });
      assert.equal(empty.isError, true);
      assert.match(payload(empty).error.message, /at least one option/);

      const tooMany = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null]));
      const oversized = await client.callTool({
        name: "jev_classify",
        arguments: { state: "s", question: "q", options: tooMany, add_none: false },
      });
      assert.equal(oversized.isError, true);
      assert.match(payload(oversized).error.message, /at most 255 options/);

      assert.equal(mock.requests.length, 0, "neither request should reach the API");
    });
  } finally {
    await mock.close();
  }
});

test("regression: duplicate question ids fail instead of silently dropping a question", async () => {
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url }, async (client) => {
      const result = await client.callTool({
        name: "jev_ask",
        arguments: {
          state: "s",
          questions: [
            { id: "dup", type: "check", question: "first" },
            { id: "dup", type: "check", question: "second" },
          ],
        },
      });
      assert.equal(result.isError, true);
      assert.match(payload(result).error.message, /Duplicate question ids: "dup"/);
      assert.equal(mock.requests.length, 0, "no partial request should be sent");
    });
  } finally {
    await mock.close();
  }
});

test("regression: jev_ask honours add_none and passes yes/no meanings", async () => {
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url }, async (client) => {
      await client.callTool({
        name: "jev_ask",
        arguments: {
          state: "s",
          questions: [
            { id: "pick", type: "classify", question: "q", options: { a: "d", b: "d" }, add_none: false },
            { id: "flag", type: "check", question: "q", yes_means: "It is urgent", no_means: "It can wait" },
          ],
        },
      });

      const sent = mock.only().questions;
      assert.deepEqual(Object.keys(sent.pick.criteria).sort(), ["a", "b"], "add_none:false must be honoured");
      assert.deepEqual(sent.flag.criteria, { true: "It is urgent", false: "It can wait" });
    });
  } finally {
    await mock.close();
  }
});

test("regression: a verbose SDK log level does not corrupt the JSON-RPC stream", async () => {
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url, env: { TYPESAFE_LOG_LEVEL: "debug" } }, async (client) => {
      const result = await client.callTool({
        name: "jev_check",
        arguments: { state: "s", question: "Is this fine?" },
      });
      assert.notEqual(result.isError, true, "debug logging must not break the connection");
      assert.equal(typeof payload(result).probability_yes, "number");
    });
  } finally {
    await mock.close();
  }
});

// ── Behaviour ───────────────────────────────────────────────────────────────

test("results carry structured content matching the text block", async () => {
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url }, async (client) => {
      const result = await client.callTool({
        name: "jev_classify",
        arguments: { state: "s", question: "q", options: { a: "d", b: "d" } },
      });
      assert.ok(result.structuredContent, "clients should get typed data, not a JSON string");
      assert.deepEqual(result.structuredContent, payload(result));
      assert.equal(typeof result.structuredContent.probabilities.a, "number");
    });
  } finally {
    await mock.close();
  }
});

test("confidence drives the recommended action", async () => {
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url }, async (client) => {
      const args = { state: "s", question: "q", options: { a: "d", b: "d" } };

      mock.state.confidence = 0.95;
      assert.equal(payload(await client.callTool({ name: "jev_classify", arguments: args })).action, "act");

      mock.state.confidence = 0.6;
      assert.equal(payload(await client.callTool({ name: "jev_classify", arguments: args })).action, "review");

      mock.state.confidence = 0.2;
      assert.equal(payload(await client.callTool({ name: "jev_classify", arguments: args })).action, "abstain");

      mock.state.confidence = 0.6;
      const strict = await client.callTool({ name: "jev_classify", arguments: { ...args, act_above: 0.5 } });
      assert.equal(payload(strict).action, "act", "caller thresholds must override the defaults");
    });
  } finally {
    await mock.close();
  }
});

test("a near-even probability is reported as uncertain, not rounded to a yes", async () => {
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url }, async (client) => {
      mock.state.noul = 0.52;
      const result = await client.callTool({
        name: "jev_check",
        arguments: { state: "s", question: "Is this urgent?" },
      });
      const body = payload(result);
      assert.equal(body.probability_yes, 0.52);
      assert.equal(body.verdict, "uncertain");
    });
  } finally {
    await mock.close();
  }
});

test("oversized state is rejected before it costs anything", async () => {
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url, env: { JEV_MAX_STATE_CHARS: "50" } }, async (client) => {
      const result = await client.callTool({
        name: "jev_check",
        arguments: { state: "x".repeat(200), question: "q" },
      });
      assert.equal(result.isError, true);
      assert.match(payload(result).error.message, /above the 50 limit/);
      assert.equal(mock.requests.length, 0);
    });
  } finally {
    await mock.close();
  }
});

test("an unusable timeout falls back instead of disabling the timeout", async () => {
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url, env: { JEV_TIMEOUT_MS: "not-a-number" } }, async (client) => {
      const result = await client.callTool({
        name: "jev_check",
        arguments: { state: "s", question: "q" },
      });
      assert.notEqual(result.isError, true, "a malformed timeout must not break the server");
    });
  } finally {
    await mock.close();
  }
});

test("API failures are classified so a caller can tell retryable from terminal", async () => {
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url }, async (client) => {
      mock.state.badKey = true;
      const unauthorized = await client.callTool({ name: "jev_check", arguments: { state: "s", question: "q" } });
      assert.equal(unauthorized.isError, true);
      const { error } = payload(unauthorized);
      assert.equal(error.kind, "authentication");
      assert.equal(error.retryable, false);
      assert.equal(error.requestId, "req_test_123", "the request id support needs must survive");
    });
  } finally {
    await mock.close();
  }
});

test("jev_models reports the active model and what the key can use", async () => {
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url }, async (client) => {
      const body = payload(await client.callTool({ name: "jev_models", arguments: {} }));
      assert.equal(body.active_model, "jev-latest");
      assert.equal(body.models[0].name, "jev-latest");
      // A caller should be able to size a call from one cheap call.
      assert.deepEqual(body.limits, {
        context_tokens: 32000,
        max_state_chars: 150000,
        max_questions: 64,
        max_choice_options: 255,
        max_score_levels: 10,
      });
    });
  } finally {
    await mock.close();
  }
});

test("one jev_ask call batches every question into a single request", async () => {
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url }, async (client) => {
      const result = await client.callTool({
        name: "jev_ask",
        arguments: {
          state: { ticket: "My card was charged twice." },
          questions: [
            { id: "billing", type: "check", question: "Is this about billing?" },
            { id: "team", type: "classify", question: "Which team?", options: { billing: "d", tech: "d" } },
            { id: "anger", type: "score", question: "How angry?", levels: ["calm", "annoyed", "furious"] },
          ],
        },
      });

      assert.equal(mock.requests.length, 1, "three questions must cost one round trip");
      assert.deepEqual(Object.keys(mock.only().questions).sort(), ["anger", "billing", "team"]);

      const body = payload(result);
      assert.deepEqual(Object.keys(body.answers).sort(), ["anger", "billing", "team"]);
      assert.equal(body.answers.team.action, "act", "choice answers carry a gate");
      assert.equal(body.answers.billing.action, undefined, "a noul has no confidence to gate on");
    });
  } finally {
    await mock.close();
  }
});

// ── Answer validation on the wire ───────────────────────────────────────────

test("regression: a choice the model was never offered is an error, not a result", async () => {
  const mock = await startMock();
  try {
    mock.state.answers = {
      classify: { type: "choice", choice: "delete_everything", confidence: 0.99, probabilities: { delete_everything: 0.99, safe: 0.01 } },
    };
    await withClient({ baseUrl: mock.url }, async (client) => {
      const result = await client.callTool({
        name: "jev_classify",
        arguments: { state: "rm -rf build/", question: "Which operation?", options: { safe: "Reads only", risky: "Destroys work" } },
      });
      assert.equal(result.isError, true, "an unoffered choice must not come back as a result");
      const { error } = payload(result);
      assert.equal(error.kind, "malformed_response");
      assert.match(error.message, /delete_everything/);
    });
  } finally {
    await mock.close();
  }
});

test("regression: jev_ask fails when any answer is missing or malformed instead of returning a partial set", async () => {
  const mock = await startMock();
  try {
    mock.state.answers = { first: { type: "noul", noul: 0.2 } };
    await withClient({ baseUrl: mock.url }, async (client) => {
      const result = await client.callTool({
        name: "jev_ask",
        arguments: {
          state: "x",
          questions: [
            { id: "first", type: "check", question: "A?" },
            { id: "second", type: "check", question: "B?" },
          ],
        },
      });
      assert.equal(result.isError, true, "a missing answer must fail the whole call");
      const { error } = payload(result);
      assert.equal(error.kind, "malformed_response");
      assert.match(error.message, /second/);
    });
  } finally {
    await mock.close();
  }
});

test("every judgment tool reports the round-trip latency", async () => {
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url }, async (client) => {
      const result = await client.callTool({ name: "jev_check", arguments: { state: "hello", question: "Greeting?" } });
      assert.equal(result.isError, undefined);
      const body = payload(result);
      assert.equal(typeof body.latency_ms, "number");
      assert.ok(body.latency_ms >= 0);
    });
  } finally {
    await mock.close();
  }
});

// ── Jev's real limits, enforced locally ─────────────────────────────────────

test("regression: a Score question with more than 10 levels fails before any request", async () => {
  // Wire-confirmed: the API answers 400, "Too many score levels. Must have at
  // most 10 levels." Rejecting locally keeps a doomed request from costing a
  // round trip.
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url }, async (client) => {
      const eleven = Array.from({ length: 11 }, (_, i) => `level ${i}`);
      const result = await client.callTool({ name: "jev_score", arguments: { state: "s", question: "q", levels: eleven } });
      assert.equal(result.isError, true);
      assert.match(payload(result).error.message, /at most 10 entries/);
      assert.equal(mock.requests.length, 0, "no request should reach the API");

      const ten = Array.from({ length: 10 }, (_, i) => `level ${i}`);
      const okResult = await client.callTool({ name: "jev_score", arguments: { state: "s", question: "q", levels: ten } });
      assert.notEqual(okResult.isError, true, "exactly ten levels must pass");
    });
  } finally {
    await mock.close();
  }
});

test("regression: jev_ask rejects an oversized level list naming the question", async () => {
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url }, async (client) => {
      const result = await client.callTool({
        name: "jev_ask",
        arguments: {
          state: "s",
          questions: [{ id: "big", type: "score", question: "q", levels: Array.from({ length: 11 }, (_, i) => `l${i}`) }],
        },
      });
      assert.equal(result.isError, true);
      assert.match(payload(result).error.message, /'big'.*at most 10/);
      assert.equal(mock.requests.length, 0);
    });
  } finally {
    await mock.close();
  }
});

test("the default state cap tracks Jev's context budget", async () => {
  // Jev's request budget is ~32k tokens shared by state and questions, roughly
  // 150,000 characters of English. The local default sits just under it.
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url }, async (client) => {
      const justUnder = await client.callTool({ name: "jev_check", arguments: { state: "x".repeat(149_000), question: "q" } });
      assert.notEqual(justUnder.isError, true, "149k characters is within the default cap");

      const over = await client.callTool({ name: "jev_check", arguments: { state: "x".repeat(150_001), question: "q" } });
      assert.equal(over.isError, true);
      assert.match(payload(over).error.message, /150000/);
    });
  } finally {
    await mock.close();
  }
});

// ── The OpenRouter provider ──────────────────────────────────────────────

test("auto-selects the OpenRouter provider when only its key is present", async () => {
  const mock = await startMockOpenRouter();
  try {
    await withClient({ withKey: false, env: { ["OPENROUTER" + "_API_" + "KEY"]: "sk-or-test", OPENROUTER_BASE_URL: mock.url } }, async (client) => {
      const result = await client.callTool({ name: "jev_check", arguments: { state: "s", question: "Is this fine?" } });
      assert.notEqual(result.isError, true);

      const sent = mock.decisions();
      assert.equal(sent.length, 1, "exactly one decision request");
      assert.equal(sent[0].url, "/api/alpha/decisions");
      assert.match(sent[0].auth, /^Bearer sk-or-test$/, "the key must travel in the header, never the body");
      assert.equal(sent[0].body.model, "~typesafe/jev-latest", "the OpenRouter default model id");
      assert.equal(sent[0].body.state, "s");
      assert.equal(sent[0].body.questions.check.type, "noul");

      const body = payload(result);
      assert.equal(body.provider, "openrouter");
      assert.equal(typeof body.probability_yes, "number");
      assert.equal(typeof body.usage.cost, "number", "OpenRouter reports the call cost");
      assert.equal(body.model, "typesafe/jev-1.13-20260917");
    });
  } finally {
    await mock.close();
  }
});

test("with both keys present the TypeSafe provider wins unless JEV_PROVIDER says otherwise", async () => {
  const tsMock = await startMock();
  const orMock = await startMockOpenRouter();
  try {
    await withClient(
      { baseUrl: tsMock.url, env: { ["OPENROUTER" + "_API_" + "KEY"]: "sk-or-test", OPENROUTER_BASE_URL: orMock.url } },
      async (client) => {
        const result = await client.callTool({ name: "jev_check", arguments: { state: "s", question: "q" } });
        assert.notEqual(result.isError, true);
        assert.equal(payload(result).provider, "typesafe");
        assert.equal(tsMock.requests.length, 1);
        assert.equal(orMock.requests.length, 0, "auto-detection prefers the TypeSafe path");
      },
    );

    await withClient(
      { baseUrl: tsMock.url, env: { ["OPENROUTER" + "_API_" + "KEY"]: "sk-or-test", OPENROUTER_BASE_URL: orMock.url, JEV_PROVIDER: "openrouter" } },
      async (client) => {
        const result = await client.callTool({ name: "jev_check", arguments: { state: "s", question: "q" } });
        assert.notEqual(result.isError, true);
        assert.equal(payload(result).provider, "openrouter", "an explicit JEV_PROVIDER overrides auto-detection");
        assert.equal(orMock.decisions().length, 1);
      },
    );
  } finally {
    await tsMock.close();
    await orMock.close();
  }
});

test("falls back to the OpenRouter key file when the environment carries no key", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const keyFile = join(mkdtempSync(join(tmpdir(), "jev-or-key-")), "key");
  writeFileSync(keyFile, "  sk-or-file\n", { mode: 0o600 });

  const mock = await startMockOpenRouter();
  try {
    await withClient({ withKey: false, env: { OPENROUTER_BASE_URL: mock.url, JEV_OR_KEY_FILE: keyFile } }, async (client) => {
      const result = await client.callTool({ name: "jev_check", arguments: { state: "s", question: "q" } });
      assert.notEqual(result.isError, true, "the key file should satisfy the credential check");
      assert.match(mock.decisions()[0].auth, /sk-or-file/);
    });
  } finally {
    await mock.close();
  }
});

test("a rejected OpenRouter key is an authentication error, never retried", async () => {
  const mock = await startMockOpenRouter();
  mock.state.badKey = true;
  try {
    await withClient({ withKey: false, env: { ["OPENROUTER" + "_API_" + "KEY"]: "sk-or-test", OPENROUTER_BASE_URL: mock.url } }, async (client) => {
      const result = await client.callTool({ name: "jev_check", arguments: { state: "s", question: "q" } });
      assert.equal(result.isError, true);
      const { error } = payload(result);
      assert.equal(error.kind, "authentication");
      assert.equal(error.retryable, false);
      assert.equal(mock.decisions().length, 1, "a 401 must not be retried");
    });
  } finally {
    await mock.close();
  }
});

test("a rate-limited OpenRouter request is retried after Retry-After and then succeeds", async () => {
  const mock = await startMockOpenRouter();
  mock.state.failNext = { status: 429, times: 1, retryAfter: 0 };
  try {
    await withClient({ withKey: false, env: { ["OPENROUTER" + "_API_" + "KEY"]: "sk-or-test", OPENROUTER_BASE_URL: mock.url } }, async (client) => {
      const result = await client.callTool({ name: "jev_check", arguments: { state: "s", question: "q" } });
      assert.notEqual(result.isError, true, "the retry must recover the call");
      assert.equal(mock.decisions().length, 2, "exactly one retry");
    });
  } finally {
    await mock.close();
  }
});

test("a persistently failing OpenRouter request stops after three attempts", async () => {
  const mock = await startMockOpenRouter();
  mock.state.failNext = { status: 500, times: 10, retryAfter: 0 };
  try {
    await withClient({ withKey: false, env: { ["OPENROUTER" + "_API_" + "KEY"]: "sk-or-test", OPENROUTER_BASE_URL: mock.url } }, async (client) => {
      const result = await client.callTool({ name: "jev_check", arguments: { state: "s", question: "q" } });
      assert.equal(result.isError, true);
      const { error } = payload(result);
      assert.equal(error.kind, "server_error");
      assert.equal(error.retryable, true);
      assert.equal(mock.decisions().length, 3, "three attempts, then a classified failure");
    });
  } finally {
    await mock.close();
  }
});

test("an out-of-credits OpenRouter account (402) is named, not retried, and not called a server error", async () => {
  // OpenRouter answers 402 with limit_source: openrouter_credits when the
  // balance cannot cover the request. It is not a server fault and retrying
  // unchanged cannot help, so it must fail fast with its own kind.
  const mock = await startMockOpenRouter();
  mock.state.failNext = { status: 402, times: 10 };
  try {
    await withClient({ withKey: false, env: { ["OPENROUTER" + "_API_" + "KEY"]: "sk-or-test", OPENROUTER_BASE_URL: mock.url } }, async (client) => {
      const result = await client.callTool({ name: "jev_check", arguments: { state: "s", question: "q" } });
      assert.equal(result.isError, true);
      const { error } = payload(result);
      assert.equal(error.kind, "insufficient_credits");
      assert.equal(error.retryable, false);
      assert.match(error.hint, /credit/i);
      assert.equal(mock.decisions().length, 1, "a balance problem must not burn retries");
    });
  } finally {
    await mock.close();
  }
});

test("an invalid OpenRouter request fails fast without a retry", async () => {
  const mock = await startMockOpenRouter();
  mock.state.failNext = { status: 400, times: 10 };
  try {
    await withClient({ withKey: false, env: { ["OPENROUTER" + "_API_" + "KEY"]: "sk-or-test", OPENROUTER_BASE_URL: mock.url } }, async (client) => {
      const result = await client.callTool({ name: "jev_check", arguments: { state: "s", question: "q" } });
      assert.equal(result.isError, true);
      const { error } = payload(result);
      assert.equal(error.kind, "invalid_request");
      assert.equal(error.retryable, false);
      assert.equal(mock.decisions().length, 1, "a validation failure must not be retried");
    });
  } finally {
    await mock.close();
  }
});

test("jev_models over OpenRouter proves the key and lists the Jev family", async () => {
  const mock = await startMockOpenRouter();
  try {
    await withClient({ withKey: false, env: { ["OPENROUTER" + "_API_" + "KEY"]: "sk-or-test", OPENROUTER_BASE_URL: mock.url } }, async (client) => {
      const body = payload(await client.callTool({ name: "jev_models", arguments: {} }));
      assert.equal(body.provider, "openrouter");
      assert.equal(body.active_model, "~typesafe/jev-latest");
      assert.deepEqual(body.models.map((m) => m.name).sort(), ["typesafe/jev-1.13", "~typesafe/jev-latest"]);
      for (const m of body.models) assert.match(m.release_date, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(mock.requests.some((r) => r.url.includes("/auth/key")), "the key must be proven, not assumed");
    });
  } finally {
    await mock.close();
  }
});
