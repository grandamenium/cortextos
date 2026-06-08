# System Context

**Organization:** {{org}}
**Runtime:** codex-app-server
**Timezone:** (set from context.json at agent creation)
**Orchestrator:** (set from context.json at agent creation)
**Dashboard:** (set from context.json at agent creation)
**Framework:** cortextOS Node.js

---

This file contains static org context only. For the live agent roster, run:
```bash
cortextos bus list-agents
```

For agent health (last heartbeat per agent), run:
```bash
cortextos bus read-all-heartbeats
```
