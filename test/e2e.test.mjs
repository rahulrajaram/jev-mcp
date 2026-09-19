// Live end-to-end tests against the real TypeSafe API.
//
// Skipped unless a credential is present in the environment, so `npm test` on a
// clean checkout and in CI never depends on network access or spends tokens.
// Run with: npm run test:e2e

import assert from "node:assert/strict";
import test from "node:test";
import { OR_KEY_VAR, payload, withClient } from "./helpers.mjs";

const KEY_VAR = ["TYPESAFE", "API", "KEY"].join("_");
const hasKey = Boolean(process.env[KEY_VAR]);
const options = { skip: hasKey ? false : `set ${KEY_VAR} to run live tests` };

const orKey = process.env[OR_KEY_VAR];
const orOptions = { skip: orKey ? false : `set ${OR_KEY_VAR} to run live OpenRouter tests` };

/** Forward the real credential to the server under test. */
function live(fn) {
  return withClient({ withKey: false, env: { [KEY_VAR]: process.env[KEY_VAR] } }, fn);
}

test("the key works and lists at least one model", options, async () => {
  await live(async (client) => {
    const body = payload(await client.callTool({ name: "jev_models", arguments: {} }));
    assert.ok(body.models.length >= 1, "expected at least one available model");
  });
});

test("classify routes a support ticket to the right team", options, async () => {
  await live(async (client) => {
    const body = payload(
      await client.callTool({
        name: "jev_classify",
        arguments: {
          state: "My running shoes arrived in the wrong size. Can I swap them for a size 10?",
          question: "Which team should handle this?",
          options: {
            returns: "Exchanges, refunds, wrong or damaged items",
            shipping: "Delivery status, delays, lost packages",
            billing: "Charges, invoices, payment problems",
          },
        },
      }),
    );
    assert.equal(body.choice, "returns");
    assert.ok(body.confidence > 0 && body.confidence <= 1);
    assert.ok(Object.keys(body.probabilities).includes("none"));
  });
});

test("check returns a high probability for a plainly urgent message", options, async () => {
  await live(async (client) => {
    const body = payload(
      await client.callTool({
        name: "jev_check",
        arguments: {
          state: "Help! My payouts have been failing for 3 days and customers are complaining.",
          question: "Does this convey urgency?",
        },
      }),
    );
    assert.ok(body.probability_yes > 0.5, `expected an urgent read, got ${body.probability_yes}`);
    assert.equal(body.verdict, "yes");
  });
});

test("ask answers several questions about one state in a single request", options, async () => {
  await live(async (client) => {
    const body = payload(
      await client.callTool({
        name: "jev_ask",
        arguments: {
          state: "I was charged twice for order A-104. Please refund the duplicate.",
          questions: [
            { id: "billing", type: "check", question: "Is this about billing?" },
            { id: "refund", type: "check", question: "Is the customer asking for a refund?" },
            { id: "anger", type: "score", question: "How frustrated is the customer?", levels: ["Calm", "Frustrated", "Very angry"] },
          ],
        },
      }),
    );
    assert.ok(body.answers.billing.noul > 0.5);
    assert.ok(body.answers.refund.noul > 0.5);
    assert.ok(typeof body.answers.anger.score === "number");
    assert.ok(body.usage.input_tokens > 0);
  });
});

// ── Live OpenRouter path ─────────────────────────────────────────────────────
// These mirror the TypeSafe live tests against POST /api/alpha/decisions, and
// stay inside Jev's problem class: classification with enumerable options,
// calibrated yes/no, rubric scoring, and batching. No reasoning, math, or
// date tasks — those are Jev's documented weak spots, not its benchmarks.

/** Forward the real OpenRouter credential to the server under test. */
function liveOr(fn) {
  return withClient({ withKey: false, env: { [OR_KEY_VAR]: orKey, JEV_PROVIDER: "openrouter" } }, fn);
}

test("openrouter: the key works and lists the Jev family", orOptions, async () => {
  await liveOr(async (client) => {
    const body = payload(await client.callTool({ name: "jev_models", arguments: {} }));
    assert.equal(body.provider, "openrouter");
    assert.ok(body.models.length >= 1, "expected the Jev family in the catalog");
    assert.ok(body.models.every((m) => m.name.includes("jev")));
  });
});

test("openrouter: classify routes a clear-cut ticket with a confident answer", orOptions, async () => {
  await liveOr(async (client) => {
    const body = payload(
      await client.callTool({
        name: "jev_classify",
        arguments: {
          state: "My running shoes arrived in the wrong size. Can I swap them for a size 10?",
          question: "Which team should handle this?",
          options: {
            returns: "Exchanges, refunds, wrong or damaged items",
            shipping: "Delivery status, delays, lost packages",
            billing: "Charges, invoices, payment problems",
          },
        },
      }),
    );
    assert.equal(body.provider, "openrouter");
    assert.equal(body.choice, "returns");
    assert.ok(body.confidence >= 0.5, `expected a confident routing, got ${body.confidence}`);
    assert.equal(typeof body.usage.cost, "number");
  });
});

test("openrouter: calibration smoke — a clear-cut ticket outranks an ambiguous one in confidence", orOptions, async () => {
  // A calibration check, not a reasoning benchmark: confidence must separate
  // an unambiguous classification from one where several options genuinely fit.
  await liveOr(async (client) => {
    const options = {
      returns: "Exchanges, refunds, wrong or damaged items",
      shipping: "Delivery status, delays, lost packages",
      billing: "Charges, invoices, payment problems",
    };
    const args = (state) => ({ name: "jev_classify", arguments: { state, question: "Which team should handle this?", options } });
    const clear = payload(
      await client.callTool(args("My running shoes arrived in the wrong size. Can I swap them for a size 10?")),
    );
    const ambiguous = payload(
      await client.callTool(args("I was charged twice for order A-104, the package never arrived, and the shoes that did arrive don't fit.")),
    );
    assert.ok(clear.confidence > ambiguous.confidence, `clear ${clear.confidence} should outrank ambiguous ${ambiguous.confidence}`);
    const spread = Object.values(ambiguous.probabilities).filter((p) => p > 0.05);
    assert.ok(spread.length >= 2, "an ambiguous ticket should spread probability across options");
  });
});

test("openrouter: ask answers several questions about one state in a single request", orOptions, async () => {
  await liveOr(async (client) => {
    const body = payload(
      await client.callTool({
        name: "jev_ask",
        arguments: {
          state: "I was charged twice for order A-104. Please refund the duplicate.",
          questions: [
            { id: "billing", type: "check", question: "Is this about billing?" },
            { id: "refund", type: "check", question: "Is the customer asking for a refund?" },
            { id: "anger", type: "score", question: "How frustrated is the customer?", levels: ["Calm", "Frustrated", "Very angry"] },
          ],
        },
      }),
    );
    assert.equal(body.provider, "openrouter");
    assert.ok(body.answers.billing.noul > 0.5);
    assert.ok(body.answers.refund.noul > 0.5);
    assert.ok(typeof body.answers.anger.score === "number");
    assert.ok(body.usage.input_tokens > 0);
    assert.ok(body.usage.cost >= 0);
  });
});
