---
domain: [tests, integration, artifacts]
applies_to: [engineer, devops, fullstack]
severity: blocker
---

# Integration tests must read the artifact the production consumer reads

**When a feature has cross-module wiring (orchestrator computes Z, passes to spawnee, spawnee writes artifact A that a downstream consumer reads), at least ONE test must (a) drive the orchestrator's full code path AND (b) assert on the *content* of artifact A, not on the internal state the orchestrator wrote.**

## Pattern fix

For every feature that produces an on-disk artifact (prompt files, sentinels, lockfiles, marker files, IPC messages, JSONL events), ask "what does the downstream consumer actually read?" and assert on that, not on what the test fixture wrote.

```ts
// BAD — asserts on the writer's internal state
expect(orchestrator.computedPrompt).toContain('expected text');

// GOOD — asserts on the artifact the consumer reads
const written = readFileSync(`${tmpDir}/spawned-prompt.txt`, 'utf-8');
expect(written).toContain('expected text');
```

## Rule of thumb

If your test reads the variable you just wrote, you're asserting that JavaScript still has variables. The integration value is in reading what the next stage of the pipeline reads. Tests that don't bridge the artifact boundary are unit tests in disguise.
