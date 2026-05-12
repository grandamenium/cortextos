# RFC: bus-hooks framework — wire, defer, or revert?

**Status:** draft for discussion
**Author:** dev (analyst-dispatched)
**Date:** 2026-05-03
**References:** PR #272 (the framework itself), PR #298 / #300 / #301 (the three direct-fix hooks shipped without it)

## TL;DR — recommendation

**Defer wiring (option B).** Keep `src/bus/hooks.ts` in place; do not invest in Day-3 handler implementations or hooks.json plumbing yet. Revisit when we have a 5th-or-more concrete hook to ship and the direct-fix pattern is producing real cost (drift across hook code paths, duplicated telemetry shapes, hard-to-reason-about fan-out).

The framework is well-designed but presently unused. Wiring it now buys little — the three immediate-pain hooks already work. Reverting it discards correct, tested infrastructure that would cost ~630 LOC to rebuild later. Defer is the cheapest correct move.

This RFC frames the decision honestly: the framework is not obviously valuable today, but the *future-us* who hits N≥5 hooks will probably want it back.

## Status quo (as of 2026-05-03)

`src/bus/hooks.ts` lands at 344 lines, accompanied by 18 tests in `tests/unit/bus/hooks.test.ts`. PR #272 itself is solid: typed `HandlerResult` contract, in-process registry, fail-open `loadHookRegistry`, deep-equal event matching, fire/block/escalate emit taxonomy, dispatcher catches handler throws.

But:

- **0 production callers.** A repo-wide grep for `dispatchHook|loadHookRegistry|matchHooks|registerHandler` returns only `src/bus/hooks.ts` (the file itself) and its test file. Nothing else in the codebase invokes the framework.
- **0 hooks.json files on disk.** `find orgs -name hooks.json` returns nothing. There is no production schema, no registered hooks anywhere.
- **Day-3 wiring never landed.** PR #272's own description names a follow-up: *"A separate PR will land the built-in handler scaffolds. Day-3 dispatch logic for bash_spawn / send_message / webhook_fetch is intentionally deferred — log_event handler is fully implemented in the follow-up."* That follow-up did not ship.
- **Three real hooks shipped without it.** PR #298 (agent_crashed → bus alert), PR #300 (cron survival mismatch detector), PR #301 (approval → agent-bot Telegram ping) all bypass the framework entirely. Each is a direct fix at the existing call site of the relevant subsystem (daemon agent-process, agent-manager, bus/approval).

The framework is enabling infrastructure with no production load.

## Section 1 — what would the framework give us over direct-fix?

Three plausible benefits, ranked by how strong I think each is for *our specific situation*:

### 1.1 Config-driven handlers (medium-strong)

`hooks.json` lets ops people change which events trigger which actions without editing TypeScript. Today, changing the recipients of the agent_crashed alert (PR #298 hardcoded `['chief', 'analyst']`) means a code change + PR + merge + restart. With the framework, it would be a JSON edit + restart.

**How real is this benefit?** Honest answer: weakly real for cortextOS's current users. Cobi is the operator, and Cobi is also the dev. The "edit JSON instead of TS" optimisation primarily pays off when the people configuring hooks are different from the people writing them. For the ecom-agent-factory teams cortextOS is positioning toward, this *might* matter — but the demand has not surfaced yet.

The hardcoded-recipients problem is real (queued as a Hook 1 follow-up) but can be solved in a 30-line PR that reads from `orgs/<org>/context.json`. Doesn't need the framework.

### 1.2 Telemetry consistency (medium)

The framework emits `hook_fire` / `hook_block` / `hook_escalate` events through `cortextos bus log-event` for every dispatch. Today, each direct-fix hook emits its own ad-hoc bus event (or none — #301 emits no telemetry on the agent-bot ping). A dashboard wanting to count "how many hooks fired across the system this week" cannot do it cleanly today.

**How real is this benefit?** Real but not blocking. We have no such dashboard, no analyst is asking for cross-hook aggregate metrics, no operator has been blocked by missing telemetry. It would be nicer to have. It's not on fire.

A weaker version of this benefit can be had by standardising the bus-event shape across the three direct-fix hooks (a one-page convention doc, ~20 LOC of refactor per hook). Doesn't need the framework.

### 1.3 Consistency / readability for new contributors (weak-medium)

If a new contributor lands and asks "where do hooks live?", today the answer is "search for the side-effect, find the call site". With the framework wired, the answer is "look at `orgs/<org>/hooks.json`". That's better discoverability.

**How real is this benefit?** Theoretical. Cobi is the only contributor most weeks. The discoverability benefit is real for an open-source community model, which cortextOS gestures at but does not yet have.

### Honest summary of section 1

The framework's benefits are **all real but all soft**. None of them are presently producing pain that direct-fix is failing to relieve. Every benefit kicks in harder at higher hook count and higher contributor count, neither of which we currently have.

## Section 2 — cost to wire end-to-end + migrate the three existing hooks

### 2.1 Wiring cost (greenfield)

To make the framework actually do something in production:

1. **Day-3 handler implementations.** The four `HandlerType`s — `log_event`, `send_message`, `bash`, `webhook` — each need a registered `HandlerFn` that knows how to execute the handler payload from `hooks.json`. Day-2 stubbed the contract; Day-3 fills it. PR #272 itself estimates "log_event handler is fully implemented in the follow-up" plus three more deferred. **Estimate: ~200–400 LOC + ~30 tests across one PR.**

2. **Dispatcher entry point.** Currently nothing calls `dispatchHook`. Wire it into the event emit pipeline so every `cortextos bus log-event` invocation: (a) loads the org's hooks.json, (b) calls `matchHooks`, (c) dispatches each match. This is the load-bearing change — every event in the system now passes through the framework. **Estimate: ~50 LOC in `src/bus/system.ts` (or wherever log-event lands), plus performance / failure-mode test coverage. ~80–120 LOC total.**

3. **Schema + per-org config.** Define `hooks.json` validation, write a starter config for each org currently in the repo, document the schema. **Estimate: ~50 LOC validation + 4 hooks.json files + schema doc. ~150 LOC total.**

4. **Operations hardening.** `loadHookRegistry` is fail-open today — good. But the dispatcher entry point (step 2) is now on the hot path of every logged event. We need: caching of registry reads, performance bounds, a kill-switch env var, regression tests for "what if a handler hangs". **Estimate: ~100 LOC + ~10 tests.**

**Total greenfield wire-in estimate: ~500–700 LOC, ~50 tests, 2–3 PRs to land safely.**

### 2.2 Migration delta for the three direct-fix hooks

For each existing hook, migration means: (a) extract the side-effect logic into a registered handler implementation (mostly already there), (b) define the matching `event_pattern` in hooks.json, (c) delete the direct call site in favour of the dispatcher path, (d) re-test end-to-end.

| Hook | Direct-fix LOC | Migration delta |
|---|---|---|
| #298 agent_crashed → bus alert | ~80 LOC in daemon (`hook-crash-alert.ts` already detects, sends to chief/analyst) | Move chief/analyst recipients to hooks.json `event_pattern` + `to`. Delete inline `sendMessage` calls. ~30 LOC change + 2 tests. |
| #300 cron-survival mismatch | ~150 LOC in daemon (poll loop + injectCronList JSON pipeline) | Awkward fit — this is daemon-internal scheduling, not an event-emit-driven flow. The mismatch detection happens inside the daemon's own loop, not in response to a `cortextos bus log-event` call. **Migration would require either: (a) re-architecting the detector to emit a synthetic event that the framework matches against, or (b) keeping it direct-fix.** ~100 LOC re-architecture, OR no migration. |
| #301 approval → agent-bot Telegram ping | ~70 LOC in `src/bus/approval.ts` | Clean fit. Convert `pingAgentChatId` to a registered `send_message` handler matching `event_pattern: { type: 'approval_created' }`. ~40 LOC change + 4 tests (existing tests rewrite). |

**Total migration estimate: ~170 LOC + ~10 tests, OR ~270 LOC + ~10 tests if we re-architect #300. The #300 awkwardness is a real signal that not every hook fits the framework.**

### 2.3 Combined cost

Wire (~600 LOC) + migrate (~200 LOC) ≈ **~800 LOC of net work, ~60 tests, 3–4 PRs**, plus a non-trivial risk window where every logged event hits the new dispatcher path.

## Section 3 — risk of half-migrated state

This is the risk that argues against the "wire it later" outcome and for either "wire now" or "revert".

**The current state IS half-migrated.** PR #272 added the framework. PRs #298 / #300 / #301 added hooks. They do not talk to each other. A new contributor reading `src/bus/hooks.ts` reasonably concludes that hooks live there. They will be wrong — the actual hooks live in `src/daemon/agent-process.ts`, `src/daemon/agent-manager.ts`, `src/bus/approval.ts`. They will discover this only by grepping for the side-effect.

This drift cost compounds. Every additional direct-fix hook makes the framework look more abandoned. Every additional un-wired Day reduces the chance the framework will ever be wired.

Concrete drift markers as of today:

- `src/bus/hooks.ts:1` says *"dispatcher wiring pending Aussie/Codex Thu execution"* (Aussie/Codex/Thu are agent names; the comment is dated 2026-04-29, four days ago). The wiring did not happen.
- `src/bus/hooks.ts:343` has `void dirname;` — a deliberate `tsc` silencer for an import that the *future dispatcher* was meant to use. That dispatcher does not exist.
- Three new hooks shipped in the four days since #272 merged. None used the framework.

Half-migrated is the worst of both worlds: framework code maintenance burden + direct-fix mental-model burden + the "which is canonical" question every time a new hook is proposed.

**This risk is the strongest argument for picking an outcome — any outcome — and committing to it.**

## Section 4 — recommendation: three honest outcomes

### Option A: wire it now

Spend the ~3 PRs / ~800 LOC to land Day-3 + wire dispatchHook into log-event + migrate the three existing hooks. Pay the cost up-front to get out of half-migrated state.

**Argues for:** ends the drift. Future hooks have one obvious place to live. Telemetry consistency + config-driven hooks + better discoverability all unlock at once.

**Argues against:** the benefits are soft (section 1). The cost is real (section 2). Hook #300 awkwardly fits. Migration risk: every logged event in the system now passes through the new dispatcher; bugs land hot. Cobi is in Vietnam and the merge cadence is unpredictable per analyst's earlier note — adding three more PRs to the queue right now is poor timing.

### Option B: defer wiring, gate on hook count (recommended)

Keep the framework code as-is. Add a comment at the top of `src/bus/hooks.ts` linking to this RFC and noting the framework is unwired pending an N≥5-hook trigger. Continue direct-fix for new hooks. Re-evaluate when we have:

- 5+ shipped hooks (currently 3 — agent_crashed, cron_survival, approval_ping)
- and at least one of: a non-Cobi contributor proposing a hook, an operator request to change hook routing without a code deploy, OR a dashboard need for cross-hook aggregate metrics

**Argues for:** cheapest. Preserves the option of wiring later. Keeps the well-designed framework code from being thrown away. Lets us ship the next 1-2 ecom-factory hooks at the speed direct-fix allows.

**Argues against:** half-migrated state persists. The "drift cost compounds" critique in section 3 is real — every month of un-wired status makes future wiring less likely. We need to commit to *actually* re-evaluating at the trigger, not letting it slip indefinitely. Without a calendar deadline this risks becoming silent permanent debt.

**Mitigation:** set a deadline. *"Re-evaluate by 2026-08-01 OR at hook #5, whichever first."* If by 2026-08-01 we have <5 hooks AND no contributor/dashboard demand has surfaced, downgrade to option C (revert).

### Option C: revert PR #272

`git revert <merge-commit>`. Delete `src/bus/hooks.ts` and its tests. Continue direct-fix as the only pattern. If we ever need a framework, rebuild it from scratch when the demand is concrete.

**Argues for:** ends half-migrated state instantly. ~344 LOC of dead code + 18 tests are deleted. The codebase is smaller and more obviously consistent. Future-Cobi reading the repo is not confused.

**Argues against:** throws away ~630 LOC of correct, tested infrastructure. If the trigger does fire (5+ hooks, non-Cobi contributor, etc.) we will rebuild something quite similar. The framework code is well-designed — losing it is a real cost. Also: reverting a merged PR signals "we got this wrong" more strongly than deferring does. That signal might be wrong in this case (the framework is not wrong, it's just early).

## My read

Option B (defer with a deadline) is the right move *unless* the analyst or Cobi believes one of these is true:

1. The "drift cost" of half-migrated state will actively confuse new contributors *now* (in which case lean Option C — get rid of the confusion).
2. We have concrete hook ideas in the queue that would push us to N≥5 within ~4 weeks (in which case lean Option A — wire it before the queue lands so the queue itself uses the framework).

Otherwise, defer + deadline is cheapest, preserves optionality, and avoids both the wire-in cost (Option A) and the discard-good-code cost (Option C).

## Open questions for the analyst / Cobi

1. Is there a known queue of hooks for the next 4 weeks I'm not aware of? (would push toward A)
2. How worried are we about the half-migrated readability concern? (would push toward C)
3. Is the recipients-from-context.json follow-up (queued from Hook 1) blocked on this RFC, or can it ship as a 30-line direct-fix PR independently? (recommend independent — does not need the framework)
4. Should the deadline-for-re-evaluation be calendar-based (2026-08-01) or count-based (at hook #5)? Recommend "whichever first" so we don't quietly let it slip.

## Appendix A — what would change with each outcome

| | Option A (wire now) | Option B (defer + deadline) | Option C (revert) |
|---|---|---|---|
| `src/bus/hooks.ts` | Stays. Dispatcher gets entry point. | Stays as-is. Comment added linking to RFC. | Deleted. |
| `tests/unit/bus/hooks.test.ts` | Stays. New tests added for handler implementations + dispatcher integration. | Stays as-is. | Deleted. |
| `src/daemon/agent-process.ts` | Migrated #300 path emits synthetic event into dispatcher OR keeps direct-fix (decide during impl). | Unchanged. | Unchanged. |
| `src/bus/approval.ts` | `pingAgentChatId` becomes a registered `send_message` handler. | Unchanged. | Unchanged. |
| `orgs/<org>/hooks.json` | Created, populated with 3 hooks. | Not created. | Not created. |
| Net LOC | +800 / -250 (migration deletions) ≈ +550 | 0 (modulo a single comment) | -630 |
| New PRs | 3–4 | 0 (or 1 for the comment) | 1 |
| Risk window | Hot — every event passes through new dispatcher | Cold | Cold |
| Reversibility | Reversible but more PRs to undo | Trivial — already reversible | Reversible (re-merge #272 from history) |

## Appendix B — what this RFC is NOT

- **Not a recommendation to revert PR #272.** PR #272 was correctly scoped, well-tested, and the analyst's review at the time was right. The decision today is about *what to do next*, not about whether #272 should have shipped.
- **Not a critique of the framework's design.** The `HandlerResult` contract, fail-open registry loading, and fire/block/escalate taxonomy are all sensible.
- **Not an argument against config-driven hooks in principle.** Config-driven hooks are good when the demand exists. The argument is about whether the demand exists *now* for *us*.
