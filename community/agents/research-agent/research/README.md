# Research Workspace

This directory contains user-editable research configuration and generated outputs.

Copy examples before first run:

```bash
cp research/sources.example.json research/sources.json
cp research/scoring-rubric.example.json research/scoring-rubric.json
```

Then run the `research-agent-setup` skill or edit the files manually.

Generated paths:

- `research/db/signals.db` -- local SQLite signal memory
- `research/output/YYYY-MM-DD/` -- daily research brief artifacts
- `research/topic-briefings/YYYY-MM-DD/` -- topic option, detail, and enrichment artifacts
- `research/archive/` -- optional user-managed archive

Generated files are local working data and should not be published without review.
