# jev-mcp

An MCP server that exposes [TypeSafe Jev](https://docs.typesafe.ai) as typed judgment tools.

Jev is a System One model. It returns a typed answer and a calibrated probability
distribution, never prose. These tools surface that faithfully rather than hiding
it behind a label.

It reaches Jev through either of two APIs, and uses whichever one your key belongs
to: TypeSafe's own (`api.typesafe.ai`) or OpenRouter's Decisions API
(`openrouter.ai/api/alpha/decisions`). Both serve the same model with the same
question schema, so the tools behave identically. See [The key](#the-key).

## Install

Requires Node 20.12+ and a key for either path — see [The key](#the-key).

> **This is the `rahulrajaram` fork, version 0.5.0 and forward.** It adds the
> OpenRouter access path and fixes two limits: Score questions are capped at the
> API's 10 levels instead of 255, and the default state cap tracks Jev's ~32k-token
> window instead of exceeding it. Upstream `rashedint32/jev-mcp` (npm
> `jev-mcp@0.4.0`) has neither. Install from this fork, not from npm's `jev-mcp`.

### Install and update this fork

All three paths run the same code. Pick one.

**1. A local checkout — fastest launch, recommended when you have a clone.**

```bash
git clone git@github.com:rahulrajaram/jev-mcp.git
cd jev-mcp && npm ci && npm run build
claude mcp add --scope user jev -- node "$PWD/dist/index.js"
```

Update: `git pull --ff-only && npm ci && npm run build`, then restart the client.

**2. Any MCP client, straight from git — no clone to maintain.**

```bash
claude mcp add --scope user jev -- npx -y github:rahulrajaram/jev-mcp#main
```

Or in a client's JSON config:

```json
{
  "mcpServers": {
    "jev": { "command": "npx", "args": ["-y", "github:rahulrajaram/jev-mcp#main"] }
  }
}
```

`npx` installs the package from git, builds it once, and caches it per commit, so the
next launch picks up a new commit. To force a rebuild, clear the cache with
`npx --yes clear-npx-cache`, or re-run the `mcp add` with a specific commit.

**3. Claude Code plugin — registers the server and the agent skill together.**

```bash
/plugin marketplace add rahulrajaram/jev-mcp
/plugin install jev@jev-mcp
```

Update:

```bash
/plugin marketplace update jev-mcp
/plugin update jev@jev-mcp
```

The plugin launches the same git spec through `npx`, so the first session builds once.

Do not register the server directly **and** install the plugin. Two servers named
`jev` will otherwise both register.

### Upstream

`rashedint32/jev-mcp` is the original, published to npm as `jev-mcp@0.4.0`: no
OpenRouter path, and both limit defects. Do not mix it with this fork — installing
`npx -y jev-mcp` or `/plugin marketplace add rashedInt32/jev-mcp` gives you that
version. To follow upstream changes here:

```bash
git remote add upstream https://github.com/rashedint32/jev-mcp
git fetch upstream && git merge upstream/main
```

### The key

The server picks the API your key belongs to. With no configuration it looks for a
TypeSafe key first, then an OpenRouter key:

| Path | Key sources, in order | API |
| --- | --- | --- |
| TypeSafe | `TYPESAFE_API_KEY`, `JEV_API_KEY`, `~/.config/typesafe/key` | `api.typesafe.ai` through the official SDK |
| OpenRouter | `OPENROUTER_API_KEY`, `~/.config/openrouter/key` | `POST openrouter.ai/api/alpha/decisions` |

Set `JEV_PROVIDER=typesafe` or `JEV_PROVIDER=openrouter` to pin one instead of
letting the keys decide. The key is never a tool argument, so it cannot land in a
transcript or in a model's context.

The key file is the most reliable source, because some MCP clients strip the
environment before spawning servers:

```sh
# TypeSafe (key from console.typesafe.ai/settings/keys)
mkdir -p ~/.config/typesafe
printf '%s' "ts_..." > ~/.config/typesafe/key
chmod 600 ~/.config/typesafe/key

# OpenRouter (key from openrouter.ai/keys)
mkdir -p ~/.config/openrouter
printf '%s' "sk-or-..." > ~/.config/openrouter/key
chmod 600 ~/.config/openrouter/key
```

If you prefer the variable, put it in `~/.zshenv` rather than in any repo, and make
sure it is **exported**. Without `export` the variable exists only in the shell that
read it, and every server Claude Code spawns fails with a missing-key error.

Model ids differ by path: TypeSafe takes `jev-latest` (the default) while OpenRouter
takes `typesafe/jev-1.13` or the `~typesafe/jev-latest` alias (the default there),
which the server applies for you unless you set `JEV_MODEL` yourself. OpenRouter also
reports the per-call dollar `cost` in each result's `usage`; the TypeSafe API bills by
input token and reports none.

### Plugin internals

The server is declared **inline** under `mcpServers` in `.claude-plugin/plugin.json`.
There is no `.mcp.json` anywhere in the repo, and that is deliberate.

A `.mcp.json` at the plugin root is auto-discovered by the plugin loader, so it works.
But any session opened in this directory *also* reads that same file as a project
config, where `${CLAUDE_PLUGIN_ROOT}` is undefined. The result is a missing-variable
warning and a scope conflict on the same server name. The inline form has exactly one
loader and produces neither. Verify with `claude mcp list`: the server appears as
`plugin:jev:jev` and the diagnostics section stays empty.

One trap. `claude plugin details jev` reports `MCP servers (0)` for an inline
declaration even while the server is connected and working. That is a gap in the
inventory count, not a failure. Trust `claude mcp list` over `plugin details` here.

The plugin deliberately ships **no `env` block**. Naming the key there would expand to
an empty string when the variable is unset, and an empty string is not nullish, so it
would shadow the `~/.config/typesafe/key` fallback and turn a working setup into a
missing-key error. Leaving `env` out keeps all three key sources live.

## Tools

| Tool | Primitive | Use when |
| --- | --- | --- |
| `jev_classify` | Choice | The answer is one of a fixed set you define |
| `jev_score` | Score | The answer is a degree on an ordered scale |
| `jev_check` | Noul | The answer is yes or no, and you want the probability |
| `jev_ask` | all three | You have several questions about the same state |
| `jev_models` | — | Confirm the key works and find a model id |

Every tool returns the full probability distribution alongside the answer, plus
`confidence` for Choice and Score. Results come back as MCP structured content, so a
client gets typed data rather than a JSON string to re-parse. Each result also reports
`provider` (which API served it), `model` (the model id that answered), and `usage`
with `cost` when the provider reports it.

### Prefer `jev_ask`

Jev prefills the state once and scores every question in a single forward pass, so
extra questions add almost no latency or cost. TypeSafe's own
[measurement](https://docs.typesafe.ai/cookbooks/parallel_questions) on a
document-dominated workload puts one batched call at 12.2x cheaper and 10.0x faster
than one call per question, with no change in the answers.

Questions in one request cannot see each other's answers. State any speculative
premise explicitly and let your own code decide which answers apply.

## Design rules

1. **The caller owns the option set.** `jev_classify` requires options from you, so
   the model can pick the wrong one but can never invent one. A selector cannot
   choose a candidate the enumerator dropped. This is the single most common way
   these integrations fail.
2. **Probabilities are always returned.** Not just the winner.
3. **The key lives in the environment.** Never in an argument.
4. **Nothing is silently dropped, overwritten, or truncated.** A request that cannot
   be honoured exactly fails with a reason instead of quietly changing meaning.
5. **Only JSON-RPC reaches stdout.** Logs go to stderr, always.
6. **Every answer is checked against the question sent.** A choice that was never
   offered, a distribution over the wrong options, a legend that does not match the
   levels, or a missing answer in a batch is an error of kind `malformed_response`,
   never a result. A caller that trusted the label alone would otherwise execute
   something it never proposed.

### The no-match option

Each selecting tool adds a `none` option by default so the model can decline rather
than being forced to pick. Turn it off with `add_none: false` when one option must
always apply.

If you already use the name `none` for an option of your own, the added option takes
a different key instead of overwriting yours, and the response reports which key
carries the no-match meaning in `none_option`. Your option and its probability always
survive intact.

### Confidence gating

Choice and Score answers include an `action` of `act`, `review`, or `abstain`, derived
from `confidence` and the thresholds you pass in `act_above` and `review_above`
(defaults 0.8 and 0.5). `jev_check` returns a `verdict` of `yes`, `no`, or `uncertain`
from `yes_at_or_above` and `no_at_or_below` (defaults 0.7 and 0.3).

These defaults are starting points, not universal rules. Calibrate them on your own
data and on what it costs to be wrong; a destructive action deserves a higher bar than
a read-only one. Confidence describes how concentrated the distribution is. It is not
a claim that the answer is correct.

A Noul near 0.5 means yes and no are close to equally likely, not that the answer is
"medium", which is why the middle band reports `uncertain` rather than rounding.

### Errors

Failures come back with `isError` and a classified body: `kind`, `retryable`, and
where available `status`, `requestId`, and a `hint`. A rejected key (`authentication`,
never retryable) is distinguishable from a rate limit (`rate_limit`, retryable) and
from a malformed question (`invalid_request`) and from an answer that fails validation
against the question (`malformed_response`, retryable, nothing to act on). Both
providers are retried before an error surfaces here: the TypeSafe SDK does it on its
path, and the OpenRouter client retries 408, 429, and 5xx with exponential backoff,
honouring `Retry-After` when the response carries one. An OpenRouter `429` after those
retries still arrives as `rate_limit`.

Every judgment result also carries `latency_ms` for the API round trip and the
`provider` that served it, so calibration notes can record cost alongside confidence.

An exhausted provider balance is its own kind, `insufficient_credits` (HTTP 402), with
a hint pointing at the credits page. It is never retried: the same request fails until
a human adds funds or the state shrinks. Jev is cheap enough that this usually means a
shared account is out of credit rather than the call being large — a full-budget Jev
request costs well under a cent.

### Limits

Jev's own limits, enforced here so a request the API would always reject never costs
a round trip:

| Limit | Value |
| --- | --- |
| Choice options | 255 per question |
| Score levels | 10 per question |
| Context | about 32k tokens shared by `state` and all questions, roughly 150,000 characters of English |
| Input | text only; no image, audio, or video |
| Language | English is strongest; other languages are handled but less well |
| Rate | 250k tokens/s and 1,200 requests/min on the TypeSafe API |

`JEV_MAX_QUESTIONS` (default 64) and `JEV_MAX_STATE_CHARS` (default 150,000) are local
caps that bound one call's cost, sitting just under the API's own budget. Oversized
state is rejected rather than truncated, because truncating silently changes the
material the judgment rests on. Raise either if your workload packs tighter than
English prose; the API remains the final arbiter.

Past 255 options, search in two passes: one question picks a window, a second ranks
within it.

### Budgeting the state

Jev's entire request budget — state plus every question — is about **32,000 tokens**.
English prose runs near 4 characters per token, which is where the 150,000-character
default comes from, but that ratio is not a constant: terse, repetitive, or
code-like text costs far more tokens per character. A measured probe of `"x "`
repeated ran at about **2 characters per token**, so a state that looks comfortably
under 150,000 characters can still exhaust the budget.

Two guards, in order:

1. The server rejects a state beyond `JEV_MAX_STATE_CHARS` **before** any request goes
   out, and the error names the estimate in tokens and asks for a filtered state.
2. The API is the final arbiter. A genuine overflow returns `400
   max_tokens_exceeded`, never a credit or server error.

So the working habit is: build the state in code from the fields the question needs,
not from the document you happen to have. When the decision depends on locating the
right part of something large, do it in two passes — one [Noul](/primitives) per
candidate passage to filter relevance, then a second call over the passages that
survived. Accuracy also falls as irrelevant state grows, so filtering is not only a
budget measure.

Call `jev_models` to read the effective limits (context budget, state cap, question
cap, option cap, level cap) before building a large call; the caps reflect
`JEV_MAX_STATE_CHARS` and `JEV_MAX_QUESTIONS` as configured.

## Agent skill

`skills/jev/SKILL.md` teaches an agent when to reach for these tools and how to shape
the call. It is a bridge, not a tutorial. Primitive semantics, state design, and
composition patterns live in TypeSafe's own `typesafe-ai` skill and in the docs, so
this one deliberately does not repeat them.

Its first section is a three-way test: answer it yourself, call a tool, or write SDK
code. That test follows the same line as [When not to reach for this](#when-not-to-reach-for-this)
below, so an agent loading the skill does not end up arguing with this README.

Point your client at the directory, or copy the file to `~/.claude/skills/jev/`.

## Configuration

| Variable | Effect |
| --- | --- |
| `TYPESAFE_API_KEY` | Required on the TypeSafe path. `JEV_API_KEY` also works. |
| `OPENROUTER_API_KEY` | Required on the OpenRouter path. |
| `JEV_PROVIDER` | `typesafe` or `openrouter`. Defaults to the API whose key is present, preferring TypeSafe. |
| `JEV_MODEL` | Model id. Defaults to `jev-latest` (TypeSafe) or `~typesafe/jev-latest` (OpenRouter). |
| `JEV_KEY_FILE` | Overrides `~/.config/typesafe/key`. |
| `JEV_OR_KEY_FILE` | Overrides `~/.config/openrouter/key`. |
| `OPENROUTER_BASE_URL` | Overrides `https://openrouter.ai`. Mainly for tests or a proxy. |
| `JEV_TIMEOUT_MS` | Per-attempt timeout. Defaults to 15000. |
| `JEV_MAX_QUESTIONS` | Questions per `jev_ask`. Defaults to 64. |
| `JEV_MAX_STATE_CHARS` | Largest state accepted. Defaults to 150000, about 32k tokens of English. |
| `TYPESAFE_LOG_LEVEL` | SDK verbosity on the TypeSafe path. Safe at any level; all output goes to stderr. |

An unusable value for any numeric setting falls back to the default and warns on
stderr, rather than becoming `NaN` and disabling the limit it was meant to enforce.

## Troubleshooting

**Every call reports a missing key.** Some MCP clients filter the environment before
spawning servers, which drops `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`. Confirm the
variable is exported, then pass it explicitly in the client's server config if it
still does not arrive. Run `jev_models` to check the key in isolation.

**A 401 from OpenRouter.** The message reads `User not found`. That is a rejected
`OPENROUTER_API_KEY`, not a missing model. Check the key at openrouter.ai/keys and
that you are not pointing `JEV_PROVIDER=openrouter` at a TypeSafe key.

**A 404 on the model.** Check the id for the path: `jev-latest` on TypeSafe,
`typesafe/jev-1.13` or `~typesafe/jev-latest` on OpenRouter.

**A 402 reports `insufficient_credits`.** The OpenRouter balance cannot cover the
request, so add credits at openrouter.ai/settings/credits or shrink the state. If the
balance is shared with other models, give Jev its own TypeSafe key instead
(`JEV_PROVIDER=typesafe`) so a busy large-context session cannot starve the judgments.

**A 400 reports `max_tokens_exceeded`.** The state plus questions genuinely exceeded
Jev's ~32k-token budget, which a character count cannot always predict. Filter the
state in code; do not raise `JEV_MAX_STATE_CHARS` for this, since the API rejects it
anyway.

**A 400 naming too many score levels.** A Score question takes at most 10 levels. The
server rejects that locally, so a 400 here means the level count came through some
other route; reduce `levels`.

**The server connects and then dies.** On a stdio transport, anything written to
stdout that is not JSON-RPC breaks the connection. This server routes all logging to
stderr, so `TYPESAFE_LOG_LEVEL=debug` is safe to turn on while debugging.

## When not to reach for this

Jev earns its place on a decision that repeats thousands of times inside software,
where code can enumerate the options first and you need a number to threshold on.

For a one-off judgment during a conversation, an ordinary model answer is usually
better, because it comes with reasoning you can argue with. Jev gives you a number
and a label. That is a feature at scale and a limitation in dialogue.

If deterministic code already decides the case correctly, keep the deterministic
code. Typed output guarantees the interface, not the truth. Measure before adopting.

Do not ask Jev to compute. It is a one-pass chooser with no scratchpad, so counting,
arithmetic, date comparison, and threshold cutoffs are unreliable, and the answer still
comes back with a confident probability. Do that work in code and pass the result in as
a fact. Add a reference date to `state` for any question about "today". See TypeSafe's
[numeric and date limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

## Development

```bash
npm ci
npm run build
npm run typecheck
npm test          # offline: unit tests plus regression tests against a local stand-in
npm run test:e2e  # live, requires TYPESAFE_API_KEY or OPENROUTER_API_KEY
```

Inside this repo the plugin's server is not the one you want: the plugin resolves its
own copy from git, not from this checkout, so it runs the last pushed commit rather
than your working tree. For work here, register the local build directly and skip the
plugin:

```bash
claude mcp add --scope user jev -- node /absolute/path/to/jev-mcp/dist/index.js
```

Releasing this fork: bump `version` in `package.json`, `.claude-plugin/plugin.json`,
and `.claude-plugin/marketplace.json` together, commit, and push. Git-based installs
(`github:rahulrajaram/jev-mcp#main`) pick the new commit up on the next launch, and
`/plugin update jev@jev-mcp` refreshes a plugin install. Publishing to npm requires a
package name you own — `jev-mcp` on npm belongs to upstream — so use a scope such as
`@rahulrajaram/jev-mcp` if you ever publish, and update the plugin's `args` to match;
until then, keep the fork's plugin pointed at the git spec so it cannot resolve to
upstream's 0.4.0.

The offline suite runs the real built server over stdio against local stand-ins for
the TypeSafe and OpenRouter APIs and asserts on the request bodies it actually sends,
so a regression in what reaches the model fails the build.

## License

MIT
