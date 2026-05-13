# System Context

**Organization:** {{org_name}}
**Description:** Agentic CRM personal assistant template
**Timezone:** {{timezone}}
**Orchestrator:** {{orchestrator_agent}}
**Dashboard:** {{dashboard_url}}
**Communication Style:** {{communication_style}}
**Day Mode:** {{day_mode_start}} - {{day_mode_end}}
**Framework:** cortextOS

## Team Roster

For the live roster:

```bash
cortextos bus list-agents
```

## Agent Health

```bash
cortextos bus read-all-heartbeats
```

## Communication

- Agent-to-agent: `cortextos bus send-message <agent> <priority> "<text>"`
- Telegram to user: `cortextos bus send-telegram <chat_id> "<text>"`
- Check inbox: `cortextos bus check-inbox`
