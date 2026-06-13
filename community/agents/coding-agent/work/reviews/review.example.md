# Review Example

Task: `task_example_review`
Repository: `example-app`
Target: `PR #123`
Reviewer: `{{agent_name}}`
Date: `YYYY-MM-DD`

## Findings

### High: Missing authorization check in update path

File: `src/routes/projects.ts:88`

The update handler trusts the project ID from the request without checking ownership. A user who can guess another project ID could update data outside their account. Add an ownership check before applying the update and cover the cross-account case in tests.

## Tests Reviewed

- `npm test -- projects`
- CI check: `unit`

## Residual Risk

Did not run browser/E2E tests. Risk is limited to API authorization behavior if unit coverage is added.
