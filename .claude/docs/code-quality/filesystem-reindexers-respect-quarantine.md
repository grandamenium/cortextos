---
domain: [file-paths, indexing]
applies_to: [engineer, devops, fullstack]
severity: should-know
---

# Filesystem reindexers must respect quarantine/exclusion conventions

**A `glob("**/*.md")` that scans every subdir will re-include files you just moved to `_quarantine/`, `_deprecated/`, `.trash/`.**

## Pattern fix

Maintain an `INDEX_EXCLUDE_DIRS` set and check it per-component during traversal:

```ts
const EXCLUDE = new Set(['_quarantine', '_deprecated', '.trash', 'node_modules', '.git']);
function* walk(dir: string): Iterable<string> {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDE.has(entry)) continue;
    // ...
  }
}
```

## Rule of thumb

Reindexers don't know about your social conventions. `_quarantine/` only quarantines if your code knows to skip it. Encode the convention in the indexer, not just in the directory name.
