---
domain: [tests, llm, ai-orchestration]
applies_to: [engineer, devops, fullstack]
severity: should-know
---

# Tests that synthesize structured emit must also exercise the recommended-helper invocation

**A test that hand-builds a structured event payload validates the SHAPE of the payload but not the CALL SITE — the helper that the production code is supposed to invoke.** When a feature ships a structured-emit primitive (e.g. `cortextos bus log-event` with rich `--meta` JSON), tests that synthesize payloads with `JSON.stringify({...})` and feed them through the consumer prove the consumer can parse the shape but say nothing about whether the production code actually CALLS the helper.

## Pattern fix

For every helper the brief asks production code to call, write a test that drives the production code path AND asserts the helper was invoked (mock the helper, verify call count + args; OR drive end-to-end and assert on the bus-event log). Synthesizing the payload directly bypasses the very thing the brief is trying to enforce — that callers route through the helper.

## Rule of thumb

If your brief says "production code must call `recommendedHelper()`" but your test creates the artifact `recommendedHelper()` would have created without calling it, you've validated the artifact's downstream consumer, not the helper's call site. The bug class is "feature ships, tests pass, helper never gets called in production."

## Source incident

Engineer's pr-deep-evaluator on jarvis #140 (2026-05-08) caught this: tests synthesized event payloads via direct JSONL writes instead of going through the recommended emit helper. Tests passed; production code never wired the helper. Caught pre-merge.
