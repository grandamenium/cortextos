---
domain: [file-paths, deployment, build-systems]
applies_to: [engineer, devops, fullstack]
severity: should-know
---

# Filesystem moves leave stale absolute paths in multiple places

**Moving a build directory (project relocation, USB volume reorg, monorepo→polyrepo splits) leaves the old path baked into shebangs, virtualenvs, lockfiles, package.json scripts, ESM `paths` configs, sourcemap URLs.** The trap: the move may keep some entry points working through internal resolution while breaking others. One symptom proves the move is broken; absence-of-symptoms does NOT prove it's healthy — call graphs differ.

## Pattern fix

After `mv`, run a one-liner sweep:

```bash
OLD=...; NEW=...
grep -rln "$OLD" "$NEW" | while read f; do
  sed -i '' "s|$OLD|$NEW|g" "$f"
done
# verify
grep -rln "$OLD" "$NEW"  # expect empty
```

Then drive BOTH a CLI invocation AND an entry-point invocation.

## Rule of thumb

Prefer `npm install` (or equivalent rebuild) over `mv` when the relocation is permanent — those rebuild path-dependent files automatically. `mv` is a fast-path optimization that owes you a sweep.
