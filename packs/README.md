# Vertical Install Packs

Self-contained, version-pinned templates that instantiate a complete cortextOS
deployment for a specific vertical (e.g. a multi-office law firm) with one
command: `cortextos add-org --pack <vertical>`.

A pack is ~70% pre-built (org-agnostic agents, skills, crons, manifest) and
~30% collected per-install (firm name, offices, credentials) by an interactive
wizard. See `docs/design/install-packs/` for the format spec and inventory
schema.

This directory is published with the package (see `package.json` `files`) so
packs ship to consumers. It is intentionally empty until the first pack lands
(P2).
