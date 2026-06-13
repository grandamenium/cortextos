# Content Pipeline

This directory is the local-first operating surface for the social media agent.

- `signals/`: normalized source signals from research, user notes, exports, or transcripts
- `angles/`: selected angles with audience, promise, proof, CTA, and risk notes
- `drafts/`: platform-specific drafts validating against `schemas/draft.schema.json`
- `approvals/`: pending, approved, and rejected approval packets
- `scheduled/`: records of approved scheduled posts
- `published/`: records of approved published posts and external actions
- `analytics/`: daily and weekly analytics reports
- `retros/`: weekly strategy reviews and operating adjustments

External publishing, scheduling, comments, replies, DMs, edits, deletes, and profile changes must remain approval-gated.
