
## Clerk Localization: sign-up password placeholder (2026-04-25)

**Issue:** `@clerk/localizations` deDE package leaves `formFieldInputPlaceholder__signUpPassword` undefined. Clerk CDN falls back to English "Create a password" **silently** — no console warning.

**Key distinction:**
- `formFieldInputPlaceholder__password` → used on sign-in flow
- `formFieldInputPlaceholder__signUpPassword` → used on sign-up flow (separate key)

**Fix:** Add at root level of the localization object (NOT nested inside `signUp.start`):
```ts
formFieldInputPlaceholder__signUpPassword: "Passwort erstellen"
```

Nesting under `signUp.start` is ignored by Clerk's resolver. Root-level keys only.

**Reference:** Committed in c8d02f7 (frontend-dev, 2026-04-25). Typed in `@clerk/backend/shared` but absent from enUS and deDE locale packages.
