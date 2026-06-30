# CI Note Example

Task: `task_example_ci`
Repository: `example-app`
Branch: `agent/task-example-fix-ci`
CI Provider: `github-actions`
Run: `https://example.invalid/actions/runs/123`
Date: `YYYY-MM-DD`

## Failing Check

`unit`

## Relevant Log

```text
Expected status 200, received 403
```

## Diagnosis

The test fixture creates a user but does not attach the required project role after the authorization change.

## Local Reproduction

```bash
npm test -- projects.test.ts
```

## Next Action

Update the fixture helper and rerun the targeted test before broadening to the full unit suite.
