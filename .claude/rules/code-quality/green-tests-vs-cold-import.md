---
domain: [tests, entry-points, modules]
applies_to: [engineer, devops, fullstack]
severity: blocker
---

# A green test suite does not prove the production entry point will import

**Test runners (vitest, jest, pytest) collect modules in filesystem/dependency order and may resolve circular imports differently from a cold start.**

## Pattern fix

For any module that is a process entry point (anything launchd / systemd / a CLI / `node X` / `python -m X` invokes), add a regression test that imports it in a fresh subprocess:

```ts
test('cli.js imports cleanly from cold subprocess', () => {
  execSync('node -e "require(\\"./dist/cli.js\\")"');
});
```

**Architectural fix:** module-level state (singletons, registries) shared across cycle-prone boundaries belongs in its own no-deps leaf module, not in the entry-point module itself.

## Rule of thumb

Test runner's collection-order caching can't mask a cycle in a cold interpreter. If your CLI works under `npm test` but breaks under `node dist/cli.js`, you have an import cycle that the test runner masked. Always test the cold-import path separately.
