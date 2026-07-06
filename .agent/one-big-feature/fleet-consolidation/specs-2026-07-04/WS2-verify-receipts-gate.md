# WS2 — Verify-Receipts / Claim-Gate (Tier 2: block & escalate)

## 1. GOAL
Turn the shipped warn-only certainty guard into a graduated **claim gate**: when an
outbound Telegram message asserts a HIGH-STAKES completion ("deployed", "merged to
main", "sent to client") with no matching verification receipt, the send is held and
the agent is forced to either record a receipt or explicitly override — so Josh's
"never state a claim without a live check" becomes enforced in code, not just logged.

## 2. GROUNDED CURRENT STATE (fork/main @ 32190ed)

### What exists and works
- **Claim detector** — `src/utils/claim-detector.ts:86` `detectsCompletionClaim(text)`.
  Pure, conservative, one flat list of 24 `CLAIM_PATTERNS` (`claim-detector.ts:22-48`)
  and a `NEGATION_PATTERNS` veto (`:58-74`). Returns a single boolean — it does **not**
  classify WHICH kind of claim ("deployed" vs "done" are indistinguishable today).
- **Receipt ledger** — `src/utils/verification-receipt.ts`. Append-only JSONL at
  `{ctxRoot}/state/verification-receipts.jsonl` (`receiptLedgerPath` `:39`). Records
  `{agent, kind, ref, ts}` (`recordVerificationReceipt` `:48`); `hasRecentReceipt`
  (`:74`) scans newest-first within a window; `CLAIM_RECEIPT_WINDOW_MS = 30min` (`:110`).
  Fail-open everywhere. Receipt `kind`/`ref` are **free-form** — no enum, no link to a
  claim class.
- **Warn-only guard** — `emitClaimWithoutReceiptWarning` (`verification-receipt.ts:122`)
  is a pure OBSERVER: logs `claim_without_receipt` (severity `warning`) and returns a
  boolean the caller ignores.
- **Wiring** — `src/cli/bus.ts:1191-1212`, inside the `send-telegram` action **AFTER**
  the send has already succeeded (`:1201`). It cannot block by construction — it runs
  post-send in a fail-open try/catch.
- **Receipt recorder command** — `bus verify-receipt --kind --ref` (`bus.ts:1240-1258`).
- **Tests** — `tests/unit/utils/claim-detector.test.ts`,
  `tests/unit/utils/verification-receipt.test.ts`.

### The blocking precedent to copy
- **Banned-prompt validator** — `src/utils/cron-prompt-validator.ts`. This is the
  fork's proven pattern for a HARD gate at a write choke point: `validateCronsPrompt`
  (`:103`) **throws** to refuse the write; a compiled floor (`BANNED_CRON_PROMPT_PATTERNS`
  `:21`) plus a JSON **overlay escape hatch** at `state/cron-banned-patterns.json`
  (`loadOverlayPatterns` `:49`). WS2 Tier 2 should mirror this shape (compiled floor +
  overlay + refuse), not invent a new mechanism.

### Chat routing (blast-radius input)
- `send-telegram <chat-id> <message>` targets **any** chat (`bus.ts:1067-1077`). The
  agent's owner (Josh-facing) chat is `CHAT_ID` in the agent `.env`
  (read pattern at `bus.ts:3060`). Agent-to-agent traffic and activity posts use
  different chat ids. This means a block can be **scoped to owner-facing sends only**
  (chatId === agent .env `CHAT_ID`), leaving all agent↔agent chatter untouched — the
  single most important blast-radius control.

### What's missing / broken for Tier 2
1. No **claim classification** — cannot tell "deployed" (high-stakes) from "done"
   (low-stakes), so we can't route claim classes onto different ladder rungs.
2. Guard runs **post-send** and is structurally incapable of holding a message.
3. Receipt `kind` is free-form — no way to require a receipt *of the matching class*
   (a `curl` receipt should satisfy "deployed", a random `manual` note maybe not).
4. No override channel — a legitimate high-stakes claim with an off-ledger receipt
   (Josh verified by eye) has no clean way through except editing code.

## 3. DESIGN (minimal, reuse-first)

### 3a. The escalation ladder (three rungs, by claim class)
Keep the blast radius tiny by mapping **claim classes** to **rungs**, and gating
**only owner-facing sends** (chatId === agent's `.env` CHAT_ID).

| Rung | Behavior | Claim classes |
|------|----------|---------------|
| **WARN** (shipped, unchanged) | log `claim_without_receipt`, send proceeds | everything the detector fires on today: `done`, `fixed`, `it works`, `all set`, … |
| **REQUIRE-CONFIRM** | send is **held**; CLI exits non-zero with a message telling the agent to record a receipt (`bus verify-receipt`) or re-run with `--confirm-claim`. Re-running with a fresh matching receipt, OR with the explicit flag, lets it through. | `deployed`, `merged` (to main), `pushed to prod` |
| **BLOCK-UNLESS-RECEIPT** | send refused **unless** a receipt of the matching class exists in-window. No plain `--confirm-claim` bypass; requires an actual receipt OR a dated override marker (banned-prompt style). | `sent to client`, `sent to <external>`, `emailed the client`, `invoice sent` |

Rationale: the two claim types Josh has been burned by most are (a) "it's live/deployed"
without a live check, and (b) telling him something went to a client that didn't. (a)
sits on REQUIRE-CONFIRM (recoverable, agent may genuinely have verified off-ledger →
one extra step). (b) sits on BLOCK — an unverified "sent to client" is the most
expensive false claim, so it demands a real receipt or an explicit dated override.

### 3b. New: claim classifier (extend, don't rewrite the detector)
Add a **separate** pure module `src/utils/claim-classifier.ts` that reuses
`detectsCompletionClaim` for the low bar and adds class detection on top:

```
export type ClaimClass = 'deploy' | 'merge' | 'external-send' | 'generic';
export type ClaimRung  = 'warn' | 'require-confirm' | 'block';

// Ordered, high-stakes first. Generic falls out of the existing detector.
export function classifyClaim(text: string): { cls: ClaimClass; rung: ClaimRung } | null
export function requiredReceiptKinds(cls: ClaimClass): readonly string[]  // e.g. deploy → ['deploy','curl']
```

- HIGH-STAKES patterns live here (small, explicit): `external-send`
  (`sent to (the )?client`, `emailed (the )?client`, `invoice sent`, `sent to <name>`),
  `merge` (`merged to main`, `merged to prod`), `deploy` (`deployed`, `pushed to prod`,
  `now live in prod`).
- `generic` = detector fires but no high-stakes class → **warn** rung (today's behavior).
- Do **not** touch `claim-detector.ts` — the classifier imports it. This keeps the
  shipped, tested warn path byte-identical and isolates all new judgment in one file.

### 3c. New: the gate function (pure, testable)
Add `evaluateClaimGate(...)` to `verification-receipt.ts` (co-located with the ledger):

```
export type GateDecision =
  | { action: 'allow' }
  | { action: 'warn'; cls: ClaimClass }
  | { action: 'hold'; cls: ClaimClass; rung: 'require-confirm' | 'block';
      reason: string; requiredKinds: readonly string[]; hasOverride: boolean };

export function evaluateClaimGate(opts: {
  ctxRoot: string; agent: string; text: string;
  isOwnerChat: boolean; confirmFlag: boolean; withinMs?: number;
}): GateDecision
```

Logic:
1. If not `isOwnerChat` → `allow` (agent↔agent and activity traffic are never gated).
2. `classifyClaim(text)`; if null → `allow`.
3. If rung `warn` → `warn` (caller emits the existing event, proceeds).
4. For `require-confirm` / `block`: check `hasRecentReceiptOfKind(ctxRoot, agent,
   requiredKinds, withinMs)` (new thin wrapper over the ledger scan — filter on
   `obj.kind ∈ requiredKinds` in addition to the time window; reuse the existing
   newest-first loop in `hasRecentReceipt`).
   - receipt present → `allow`.
   - receipt absent, rung `require-confirm`, `confirmFlag` true → `allow`
     (agent asserted verification; logged as `claim_confirmed_override`).
   - receipt absent, rung `block`, dated override marker present
     (`state/claim-gate-override.json`, banned-prompt style) → `allow` (logged).
   - otherwise → `hold`.

Fail-open: wrap the whole body; **on ANY error return `{action:'allow'}`**. A broken
gate must never wedge outbound comms.

### 3d. Wiring change in `send-telegram` (bus.ts) — surgical
Move the certainty check to run **BEFORE** the send, but **only** compute the block
there; keep the existing post-send warn event exactly where it is for the `warn` path.

- Add `--confirm-claim` option to the `send-telegram` command.
- Just before the `api.sendMessage` branch (around `bus.ts:1128`), if
  `env.agentName && env.ctxRoot`:
  - Determine `isOwnerChat` by reading `CHAT_ID` from the agent `.env` (same match as
    `bus.ts:3060`) and comparing to `chatId`.
  - Call `evaluateClaimGate({...})`.
  - On `action === 'hold'`: print a clear, non-secret message to stderr
    (claim class, required receipt kinds, how to record one, and that `--confirm-claim`
    is available for `require-confirm` only), log a `claim_blocked` event
    (severity `warning`), and `process.exit(2)`. **Do not send.**
  - On `allow`/`warn`: proceed exactly as today (the post-send
    `emitClaimWithoutReceiptWarning` at `:1201` stays for the `warn`/allow paths).
- **Streaming / --image / --file**: gate the **initial `<message>`** text the same way
  (it is available before the send begins). Streaming appends from stdin are NOT gated
  (can't be known ahead of time) — acceptable, streaming is not the claim vector.

### 3e. Config / kill-switch
- Env `CTX_CLAIM_GATE=off|warn|enforce` (default `warn` on first ship = behaves exactly
  like today; flip to `enforce` after a staging soak). `off` disables the module
  entirely. This is the safety valve: if the gate ever misfires in the fleet, Josh flips
  one env var, no redeploy of logic.
- Owner-chat-only scoping is **not** configurable off — it is a hard invariant.

## 4. STAGING / PROD-OPS (Josh-gated)
- **Ship in `warn` mode** (`CTX_CLAIM_GATE=warn`, the default). In warn mode the new
  code path computes the decision but only logs — **zero behavior change** vs today.
  This is a normal PR, not a prod-op.
- **Flip to `enforce`** on the live fleet is a **prod-op → Josh-gated, staging-first**:
  1. Run the fleet in `warn` for a soak window; collect `claim_blocked`-*would-have*
     events from the event log.
  2. Review: any legitimate owner-facing high-stakes send that would have been held?
     Tune classifier patterns / receipt-kind map until the would-block set is only real
     unverified claims.
  3. Only then set `CTX_CLAIM_GATE=enforce` (per-agent `.env` or fleet env), one agent
     first (e.g. codexer), watch, then fleet-wide.
- **No change to prod data.** This workstream touches outbound comms only, never DB /
  pipeline / dedup. It does not fall under the AuditOS staging-first destructive-op rule,
  but the enforce flip is still gated on the soak review above.

## 5. FILES TO TOUCH (tight)
- **ADD** `src/utils/claim-classifier.ts` — class + rung detection (imports the
  existing detector; no edit to `claim-detector.ts`).
- **EDIT** `src/utils/verification-receipt.ts` — add `hasRecentReceiptOfKind` (thin
  filter over existing scan) and `evaluateClaimGate` + `GateDecision` types. No change
  to shipped functions.
- **EDIT** `src/cli/bus.ts` — add `--confirm-claim` option; insert the pre-send gate
  block in the `send-telegram` action; read `CTX_CLAIM_GATE`. ~35 lines, localized.
- **ADD** `tests/unit/utils/claim-classifier.test.ts`.
- **ADD** `tests/unit/utils/claim-gate.test.ts` (evaluateClaimGate decision matrix).
- (optional) **ADD** `state/claim-gate-override.json` seed doc — not code; document the
  override shape in the spec, create the file lazily.

Explicitly **NOT** touched: `claim-detector.ts`, the receipt storage format, the
banned-prompt validator, any other bus command. No broad refactor — that is the
conflict-bomb failure mode this consolidation is trying to avoid.

## 6. TEST PLAN
- **claim-classifier.test.ts**
  - `deployed to production` → `{cls:'deploy', rung:'require-confirm'}`.
  - `merged to main` → `{cls:'merge', rung:'require-confirm'}`.
  - `sent to the client` / `invoice sent` / `emailed the client` → `{cls:'external-send',
    rung:'block'}`.
  - `Done.` / `it works now` → `{cls:'generic', rung:'warn'}`.
  - Negation still vetoes: `about to deploy`, `not yet merged`, `should I email the
    client?` → `null`.
- **claim-gate.test.ts** (all with a tmp ctxRoot + seeded ledger)
  - not owner chat → `allow` regardless of text.
  - owner chat, generic claim, no receipt → `warn`.
  - owner chat, `deployed`, no receipt, no confirm → `hold/require-confirm`.
  - owner chat, `deployed`, matching `deploy`/`curl` receipt in-window → `allow`.
  - owner chat, `deployed`, no receipt, `confirmFlag` → `allow`.
  - owner chat, `sent to client`, no receipt, `confirmFlag` → still `hold/block`
    (confirm flag does NOT bypass block rung).
  - owner chat, `sent to client`, valid dated override marker → `allow`.
  - stale receipt (outside window) → treated as absent.
  - malformed ledger / missing ctxRoot / thrown error → `allow` (fail-open) — assert
    no throw escapes.
- **Regression**: existing `claim-detector.test.ts` and `verification-receipt.test.ts`
  pass unchanged (proves the warn path is byte-identical).
- **Manual (staging)**: `CTX_CLAIM_GATE=enforce bus send-telegram <ownerChat> "deployed
  to prod"` with an empty ledger → exits 2, no send; after `bus verify-receipt --kind
  deploy --ref <url>` → sends.

## 7. RISKS + OPEN QUESTIONS

### Risks
- **Blast radius** — every outbound Telegram flows through `send-telegram`. *Mitigation:*
  owner-chat-only scoping (agent↔agent untouched), default `warn` mode = no behavior
  change, one-env-var kill switch, whole gate fail-open.
- **False block wedges a real deliverable** — a genuinely-verified send held because the
  agent didn't record a receipt. *Mitigation:* `require-confirm` rung has the
  `--confirm-claim` escape; only `external-send` is hard-blocked, and even that has the
  dated override marker. Soak in `warn` before enforce.
- **Classifier drift** — high-stakes patterns are English-fragile. *Mitigation:* keep
  the list small and explicit; unknown phrasings degrade to `warn` (never over-block).
- **exit-code 2 breaking callers** — some cron/worker scripts may treat any non-zero as
  fatal and retry-loop. *Mitigation:* distinct exit code (2, not 1); gate only fires on
  owner-chat high-stakes claims, which workers rarely emit; verify against the worker
  SKILLs before enforce flip.

### Open questions for Josh
1. **external-send hard-block**: OK that `sent to client` with no receipt is BLOCKED
   (needs a receipt or dated override), not just require-confirm? This is the strongest
   rung — confirming it matches your "certainty enforced in code" intent.
2. **Owner-chat scope**: agreed that agent↔agent messages are never gated (only sends to
   your `.env` CHAT_ID)? Or do you want claims *between agents* gated too (bigger blast
   radius, catches an agent lying to another agent's context)?
3. **Confirm flag semantics**: is an agent asserting `--confirm-claim` (with a logged
   `claim_confirmed_override` event) sufficient for the deploy/merge rung, or do you want
   those to ALSO require a real receipt (i.e. collapse require-confirm into block)?
4. **Default ship mode**: ship in `warn` (recommended — zero behavior change, soak first)
   vs ship straight to `enforce`?

## 8. EFFORT
**S–M.** Two new small pure modules + one localized bus edit + two test files. No schema,
no data migration, no cross-cutting refactor. It reuses the receipt ledger, the detector,
and the banned-prompt gate shape wholesale.

**Pipeline**: small direct job — does **not** need the full discovery→spec→shard build.
One spec (this), one focused PR, staging soak, then the Josh-gated enforce flip.
