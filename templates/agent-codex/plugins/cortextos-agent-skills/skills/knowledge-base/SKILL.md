---
name: knowledge-base
description: "You are about to research a topic, answer a factual question about the org, or look up context about a person, project, or tool. Before searching the web or asking the user, query the knowledge base first — the answer may already exist from a previous research session. After you complete any substantial research, ingest your findings so future agents do not repeat the same work. The KB is the org's shared memory across all agents."
---

# Knowledge Base (RAG)

The knowledge base lets you search indexed documents using natural language — memory files, research notes, org knowledge. Query before searching externally. Ingest after completing research.

---

## Query (before starting research)

```bash
cortextos bus kb-query "your question" \
  --org $CTX_ORG \
  --agent $CTX_AGENT_NAME
```

Use this:
- Before starting any research task — check if knowledge already exists
- When referencing named entities (people, projects, tools) — check for existing context
- When answering factual questions about the org — query before searching externally

---

## Ingest (after completing research)

```bash
# Ingest to shared org collection (visible to all agents)
cortextos bus kb-ingest /path/to/docs \
  --org $CTX_ORG \
  --scope shared

# Ingest to your private collection (only visible to you)
cortextos bus kb-ingest /path/to/docs \
  --org $CTX_ORG \
  --agent $CTX_AGENT_NAME \
  --scope private
```

Ingest after:
- Completing substantive research (always ingest your findings)
- Writing or updating MEMORY.md
- Learning important facts about the org, users, or systems

---

## List Collections

```bash
cortextos bus kb-collections --org $CTX_ORG
```

---

## Checking Available Collections

List all KB collections for the org:

```bash
cortextos bus kb-collections --org $CTX_ORG
```

If no collections appear, the KB may not be configured yet — check that `GEMINI_API_KEY` is set in `orgs/$CTX_ORG/secrets.env`.

---

## Workflow Pattern

```
1. User asks question about <topic>
2. kb-query "<topic>" — check existing knowledge
3. If found → answer from KB, cite source
4. If not found → research externally
5. After research → kb-ingest findings
6. Answer user with fresh knowledge now in KB
```
