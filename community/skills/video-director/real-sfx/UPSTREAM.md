# Where this copy of real-sfx comes from

This folder is Video Director's own copy of real-sfx by Alexander Korbanov at Clipwing (MIT).

- Source: https://github.com/Clipwing/skills, folder `skills/real-sfx`
- Commit: `edbefcbc3474869e6cc1e8a7ca583b0efd0dab7e`
- Copied: 2026-11-06

`tools/sync-real-sfx.sh` (at the top of the Video Director repository) brings in what Clipwing has changed since the
commit above and updates it. A weekly GitHub Action (`.github/workflows/real-sfx-upstream.yml`) runs it and opens a
pull request when there is anything new.

## Changes made here

Each one stays when Clipwing's later changes are brought in. If Clipwing changes the same lines, the update stops and
shows both versions.

| File | Change | Why |
|---|---|---|
| `LICENSE` | added: the standard MIT text, Alexander Korbanov (Clipwing) | Clipwing's README gives the scripts as MIT; the folder had no licence file |
| `SKILL.md` | added the section "Inside Video Director" | this copy is run by Video Director's Sound engineering steps, which override some of its defaults |
| `scripts/setup.py` | `check` finds the index through `index_path()`, so it honours `REAL_SFX_INDEX` | with the index kept in `~/.config/real-sfx/`, `check` reported it missing |
| `UPSTREAM.md` | this file | |
