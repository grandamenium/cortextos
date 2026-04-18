# Frontend Role

Role-specific skill pack for frontend/design agents. Automatically installed when creating an agent with `--role frontend`.

## What This Adds

1. **`skills/active/design-engineering.md`** — Emil Kowalski's animation & interaction design framework
2. **`skills/active/frontend-design.md`** — Distinctive, production-grade frontend design methodology
3. **`CLAUDE.md` additions** — Design system section appended to the agent's CLAUDE.md with non-negotiable design rules

## What the Org Must Provide

- **`DESIGN.md`** in the agent directory — The org-specific design system (colors, typography, spacing, components). This is NOT templated because every org has a different visual identity. The onboarding flow will prompt the user to configure this.

## Usage

```bash
cortextos add-agent my-frontend-dev --role frontend
```
