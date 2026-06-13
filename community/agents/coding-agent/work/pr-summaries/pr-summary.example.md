# PR Summary Example

## Summary

- Add ownership validation to project updates.
- Cover cross-account update attempts with a regression test.

## Tests

- `npm test -- projects.test.ts`
- `npm run lint`

## Risk

Low. The change is scoped to one update route and covered by the authorization regression test.

## Approval Needed

Opening or updating the real PR is an external action. Create an approval before running:

```bash
gh pr create --fill
```

Approval category: `other`
