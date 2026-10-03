# dsh-plugin-jev-router

Per-turn model and reasoning-effort routing for DeepSeek Harness, decided by one Jev choice question.

## Why this exists

A coding agent sends every turn to the same model at the same effort. Turn 41 renames a variable, turn 42 debugs a race condition that only shows up under load, and both are billed at the rate of the second one.

```
turn 41  cat src/auth/refresh.ts                          read one file
turn 42  the refresh test fails about one run in five     hold an interleaving in your head
turn 43  rename expiresAt to expiresAtMs                  mechanical edit
```

Turns 41 and 43 need a file read and a rename. On the candidate table below they cost $0.000952 each instead of $0.008352. Turn 42 needs the interleaving and should keep the expensive candidate.

A rules-based router cannot make that split. "Is this turn hard?" is not a keyword. A rule that looks for the word `test` fires on turn 42 and on every request that mentions a test file. A rule that looks for `rename` catches turn 43 and misses "change the name of expiresAt everywhere". Each rule added in one direction costs accuracy in the other, and a wrong rule is silent, so nobody finds out until the bill or the failure arrives.

The router asks Jev one `choice` question per turn over the candidate table that is actually configured. Jev answers in a single forward pass and emits no output tokens, so the decision costs one pass over a summary that is capped at 4 KB and produces no completion. The answer carries the chosen candidate, a probability for every candidate, and a calibrated confidence. Anything below the confidence gate, and any failure at all, routes to the default candidate.

| | Rules-based router | Always the expensive model | Jev-routed |
|---|---|---|---|
| Decision input | keywords in the turn text | none | one calibrated choice question over the configured candidates |
| Hard turn | escalates when a rule happens to match | served correctly | served correctly |
| Easy turn | downgraded when a rule matches and nothing else in the turn trips it | over-served | downgraded |
| Unseen phrasing | needs a new rule, and each rule risks the other direction | no effect | covered by the same question |
| Output tokens spent deciding | 0 | 0 | 0 |
| Failure mode | a wrong rule is silent and permanent | budget | falls back to the default candidate |

## Install

```sh
dsh plugin --profile your-profile add dsh-plugin-jev-router
```

```sh
npm install dsh-plugin-jev-router
```

Set the key and the endpoint once:

```sh
export JEV_API_KEY=...
export JEV_API_URL=https://api.typesafe.ai/v1/systemone   # optional, this is the default
```

## How it works

One turn is routed by the first rule that applies.

1. **Escalation.** A pattern from `escalateOn` matched the summary, so the turn is known hard and Jev is not asked. The default candidate's model at its highest configured effort takes it, and the sticky hold is re-armed. The built-in patterns cover stack traces in both Python and JavaScript form, `AssertionError`, failing test counts, `why does`, race conditions, flaky and intermittent failures, deadlocks, migrations, and refactors across a codebase.
2. **Fast path.** The summary is under `trivialMaxBytes`, opens with a read-only verb such as `cat`, `ls`, `show`, `grep` or `git diff`, and contains no reasoning marker such as `explain`, `debug` or `compare`. The cheapest candidate takes it. The reasoning guard is what keeps `read the failing test output and explain why the assertion fails` out of the fast path.
3. **Sticky.** A previous expensive route is still held, so the same candidate is served without asking Jev again. A candidate is held for `stickyTurns` turns after an escalation or a confident Jev decision above the cheapest option. The hold counts down, and a decision on the cheapest candidate releases it. The fast path and the fallback leave it untouched, so a read-only turn or a degraded endpoint cannot pin the next turn. Because a held turn skips the Jev request entirely, set `stickyTurns: 0` when testing or debugging the Jev path itself, or the hold will answer before your test reaches the client.
4. **Jev.** One `choice` question over the candidate labels. The state is the request plus a short digest of recent tool activity, which is what makes failing command output visible to the decision. A confidence at or above `minConfidence` takes the answer.
5. **Fallback.** A low-confidence answer, a missing key, a non-200, a timeout, or a response that names no option routes to `defaultCandidate` and records the reason. Routing cannot fail a turn.

### Receipts

With `receiptPath` set, every turn appends one JSON line.

```json
{
  "ts": "2026-10-03T14:42:58.763Z",
  "turn": 1,
  "hash": "180adadcfbd4e7eb",
  "bytes": 30,
  "reason": "jev",
  "chosen": "deepseek-v4-fast@low",
  "chosenIndex": 0,
  "confidence": 0.9,
  "distribution": [0.9, 0.05, 0.03, 0.02],
  "candidates": [{ "label": "deepseek-v4-fast@low", "effectiveCost": 0.000952 }],
  "defaultLabel": "deepseek-reasoner@high",
  "latencyMs": 214,
  "cost": 0.000952,
  "baselineCost": 0.008352,
  "error": null
}
```

Receipts store the summary hash and its byte size, never the summary text, so a log can be shared for analysis without exposing the conversation. Because the full distribution and the per-candidate cost are both recorded, a different cost preference can be re-applied over the same decisions with no model call at all, which is what `jev-route replay` does.

### Jev wire format

One POST per routed turn, using the same family shape as the other Jev plugins.

```json
{
  "state": "<turn summary and the candidate table>",
  "question": "<the routing instruction>",
  "type": "choice",
  "options": [
    "deepseek-v4-fast@low",
    "deepseek-v4@low",
    "deepseek-v4@high",
    "deepseek-reasoner@high"
  ]
}
```

A choice question carries its candidates in `options`. The `levels` field belongs to a score question and is not sent here.

The response is read tolerantly. A `probabilities` array over the options, a `probabilities` object keyed by label or by index, a chosen `choice`, `option` or `index`, and an envelope such as `{ "answer": { ... } }` all reduce to the same answer. Confidence is read as a probability in [0, 1] and defaults to the peak of the distribution when the endpoint does not report one. A response that names no option raises `malformed` and the turn falls back.

## Configuration

```yaml
- id: jev-router
  name: dsh-plugin-jev-router
  inject: []
  config:
    # Routing targets. The rates below are example list prices, in USD per
    # million tokens. Replace them with the rates you are billed.
    candidates:
      - { model: deepseek-v4-fast, effort: low, costPerMTokIn: 0.07, costPerMTokOut: 0.14 }
      - { model: deepseek-v4, effort: low, costPerMTokIn: 0.28, costPerMTokOut: 0.42 }
      - { model: deepseek-v4, effort: high, costPerMTokIn: 0.28, costPerMTokOut: 0.42 }
      - { model: deepseek-reasoner, effort: high, costPerMTokIn: 0.55, costPerMTokOut: 2.19 }
    # Accepts a model@effort label, a bare model name, or a list index.
    # Default: the most expensive candidate, so an undecidable turn is never
    # under-served.
    defaultCandidate: deepseek-reasoner@high
    # A Jev answer below this confidence routes to the default candidate.
    minConfidence: 0.5
    # Turns a candidate stays pinned after an escalation or an expensive Jev
    # choice. 0 disables the hold, which is the setting to use when testing or
    # debugging the Jev path, since a held turn skips the request entirely.
    stickyTurns: 1
    # Extra escalation patterns, appended to the built-in defaults.
    escalateOn: []
    # Extra trivial patterns, appended to the built-in defaults.
    trivialPatterns: []
    # Set false to route with only the patterns given above.
    useDefaultPatterns: true
    # Byte cap for the trivial fast path.
    trivialMaxBytes: 240
    # Byte cap on the summary sent to Jev.
    maxSummaryBytes: 4000
    endpoint: https://api.typesafe.ai/v1/systemone
    apiKey: ''
    timeoutMs: 2500
    question: ''
    # Token profile used to turn per-million rates into a per-turn cost.
    tokensInPerTurn: 12000
    tokensOutPerTurn: 800
    # JSONL receipt log. Empty disables it.
    receiptPath: ''
    # Inject the current route into the system prompt. Off by default because a
    # section that changes every turn rewrites the cached prefix.
    promptSection: false
    # Cost weight used by `jev-route replay --prefer cheap`.
    replayCostAversion: 2
```

Environment variables fill in the fields that are not set in config.

| Variable | Field |
|---|---|
| `JEV_API_URL` | `endpoint` |
| `JEV_API_KEY` | `apiKey` |
| `JEV_ROUTER_RECEIPTS` | `receiptPath` |
| `JEV_ROUTER_CANDIDATES` | `candidates`, as a JSON array |

## CLI

```sh
jev-route route "cat src/index.ts"
jev-route route "the refresh test fails about one run in five" --json
jev-route receipts ~/.dsh/jev-router/receipts.jsonl
jev-route replay ~/.dsh/jev-router/receipts.jsonl --prefer cheap
jev-route replay ~/.dsh/jev-router/receipts.jsonl --prefer cheap --lambda 3 --limit 50
jev-route doctor
```

`route` prints the decision and the distribution over the candidate table.

```
Reason           fast-path
Chosen           deepseek-v4-fast@low
Confidence       -
Sticky remaining 0 turn(s)
Cost             $0.000952   (default baseline $0.008352)

Distribution
> [0 ] deepseek-v4-fast@low     p=     -  $0.000952/turn  rank 0
  [1 ] deepseek-v4@low          p=     -  $0.003696/turn  rank 1
  [2 ] deepseek-v4@high         p=     -  $0.003696/turn  rank 2
  [3 ] deepseek-reasoner@high   p=     -  $0.008352/turn  rank 3
```

`receipts` summarises a log with the route reason breakdown, the fallback rate and the cost saved against always using the default candidate.

`replay` re-scores recorded distributions under a different preference and reports which turns would have changed. Every replayable turn carries the probability Jev assigned to each candidate and the per-turn cost of each candidate, so the replayed choice is

```
argmax over i of   p(i) - lambda * (cost(i) / cost(max))
```

with `lambda` 0 for `--prefer quality` and the configured `replayCostAversion` for `--prefer cheap`. Both terms are dimensionless and live in [0, 1], so `lambda` states directly how many units of probability one unit of relative cost is worth. Turns that never asked Jev carry no distribution and keep their choice.

`doctor` reports the endpoint, whether the key is present, whether the endpoint answers, the effective candidate table with its ranks, the pattern counts and any configuration warnings. It exits non-zero when the key is missing or the endpoint does not answer.

All commands accept `--config <path>` with a JSON object using the same field names as the plugin config, and `--json` for machine-readable output.

## Cost

At the default token profile, 12,000 input tokens and 800 output tokens per turn, one turn costs

```
deepseek-v4-fast@low   12,000 x $0.07/M + 800 x $0.14/M  =  $0.000952
deepseek-v4@high       12,000 x $0.28/M + 800 x $0.42/M  =  $0.003696
deepseek-reasoner@high 12,000 x $0.55/M + 800 x $2.19/M  =  $0.008352
```

At 200 turns a day, with 120 that the fast path takes, 55 that Jev sends to the mid candidate and 25 that escalate or hold the default:

```
routed          120 x $0.000952 + 55 x $0.003696 + 25 x $0.008352  =  $0.5263/day
always default                            200 x $0.008352         =  $1.6704/day
always mid                                200 x $0.003696         =  $0.7392/day
```

Routing saves $1.1441 a day against the always-default baseline, 68.5%, and $0.2129 a day against the always-mid baseline, 28.8%. The saving is bounded by the share of turns that can move off the default, and the always-mid comparison is the honest lower bound, since that configuration is already cheaper than the routed mix on the turns it gets wrong. Each routed decision adds one Jev forward pass over a summary capped at 4 KB, roughly 1,000 input tokens and no output tokens. Run `jev-route receipts` on your own log for the number that matches your traffic instead of this example.

## Harness integration

The plugin registers on the host context in three places.

- `ctx.jevRouter` always receives the router instance. A dispatch layer calls `await ctx.jevRouter.routeTurn(summary)` and reads `decision.candidate.model` and `decision.candidate.effort`.
- `ctx.shellEnv` publishes `DSH_JEV_ROUTER_MODEL`, `DSH_JEV_ROUTER_EFFORT`, `DSH_JEV_ROUTER_REASON` and `DSH_JEV_ROUTER_RECEIPTS` for the current turn.
- A pre-dispatch hook is probed in the order `ctx.dispatch.before`, `ctx.model.beforeDispatch`, `ctx.turn.before`. The first slot that accepts a handler receives one and the chosen slot is written to the plugin log. The harness surface this plugin was built against exposes no model-selection hook, so the probe normally reports no slot and the log says to drive the router through `ctx.jevRouter` instead. Adding the official hook name to `DISPATCH_SLOTS` in `src/index.ts` is the only change needed when one appears.

`routeTurn` is exported as a free function, so a harness can route without loading the plugin at all.

```ts
import { routeTurn } from 'dsh-plugin-jev-router'

const decision = await routeTurn(
  { request: 'rename expiresAt to expiresAtMs', digest: 'tool: grep expiresAt src/ (12 hits)' },
  [
    { model: 'deepseek-v4-fast', effort: 'low', costPerMTokIn: 0.07, costPerMTokOut: 0.14 },
    { model: 'deepseek-v4', effort: 'high', costPerMTokIn: 0.28, costPerMTokOut: 0.42 },
    { model: 'deepseek-reasoner', effort: 'high', costPerMTokIn: 0.55, costPerMTokOut: 2.19 },
  ],
  { defaultCandidate: 'deepseek-reasoner@high' },
)

console.log(decision.candidate.model, decision.candidate.effort, decision.reason)
```

The free function is stateless. `JevRouter` adds the sticky hold, the receipt log and the live metrics, and accepts a `client` in its options or as a second argument when a caller wants to supply its own.

## Related projects

- [metajev](https://github.com/YYTbit/metajev) -- the general form of what this plugin does per turn. Decisions are keyed by state, question, and model; thresholds and routing live in a policy that reads the record, so a preference change costs no model calls.
- [dsh-plugin-jev-compaction](https://github.com/YYTbit/dsh-plugin-jev-compaction) -- the other end of the same context problem. This plugin decides which model serves a turn; that one decides which messages survive to reach it.
- [dsh-plugin-meta-memory](https://github.com/YYTbit/dsh-plugin-meta-memory) -- structured long-term memory for DeepSeek Harness

## License

MIT -- YYTbit
