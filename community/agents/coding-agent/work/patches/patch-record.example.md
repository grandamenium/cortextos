# Patch Record Example

Task: `task_example_patch`
Repository: `example-app`
Branch: `agent/task-example-project-auth`
Base: `main`
Date: `YYYY-MM-DD`

## Intent

Prevent cross-account project updates by enforcing ownership checks in the update handler.

## Files Changed

- `src/routes/projects.ts`: adds ownership guard before update.
- `src/routes/projects.test.ts`: covers denied cross-account update.

## Tests

```bash
npm test -- projects.test.ts
npm run lint
```

## Risks

- Existing admin paths may need a separate bypass if admins are expected to update all projects.

## Rollback

Revert the branch or patch before merge. No data migration is involved.
