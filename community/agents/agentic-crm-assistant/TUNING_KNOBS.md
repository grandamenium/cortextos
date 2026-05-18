# Agentic CRM Assistant Tuning Knobs

The setup skill asks for these and writes the answers into bootstrap files, CRM files, and tool references.

## Identity

- assistant name
- user preferred name
- role/context of the user
- assistant tone and message length
- proactive update rules

## Scope

- inbox/message sources to manage
- calendar sources to manage
- meeting prep and transcript sources
- personal commitments and life-admin domains
- travel/errand/finance reminder scope
- explicit exclusions

## Tool Connections

- email provider and account identifiers
- calendar provider and calendar IDs/names
- meeting note/transcript provider
- contacts source
- optional external CRM
- browser automation availability
- local CLI/MCP/connector names
- fallback path when a tool is absent

## Structured CRM

- CRM source of truth: local, external, or local-first sync
- relationship categories
- priority levels
- relationship strength scale
- stale rules by category
- VIP list
- never-auto-archive list
- required contact fields
- custom tags
- interaction types
- follow-up cadence

## Schedule

- timezone
- working hours
- quiet hours
- protected time blocks
- preferred meeting windows
- buffer rules
- morning review time
- evening review time
- pending-items digest time
- relationship review cadence
- meeting notes processing cadence

## Approvals and Privacy

- what the assistant may do autonomously
- what always requires approval
- exceptions for trusted people/domains
- what may be stored locally
- what may sync externally
- what may be ingested into the knowledge base
- retention/redaction rules

## Initial State

- first VIP contacts
- active commitments
- current open loops
- upcoming meetings/travel
- first goals for the assistant
