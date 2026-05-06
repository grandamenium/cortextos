# Security Agent Tools

## Core Bus Commands
All standard cortextOS bus commands apply. See `.claude/skills/bus-reference/SKILL.md` for the full reference.

## Security-Specific Tools

### Dependency Auditing
| Command | Purpose |
|---------|---------|
| `npm audit --audit-level=moderate` | Scan Node.js dependencies for known CVEs |
| `npm audit fix` | Auto-fix where possible (review changes before committing) |
| `pip audit` / `safety check` | Python dependency audit (if applicable) |

### Secret Scanning
| Command | Purpose |
|---------|---------|
| `gitleaks detect --source .` | Scan repo for leaked secrets (API keys, tokens, passwords) |
| `grep -rn "sk-\|ghp_\|xoxb-\|AKIA" --include="*.ts" --include="*.js" --include="*.env"` | Quick manual secret pattern scan |

### Code Review
| Command | Purpose |
|---------|---------|
| `git diff <base>..HEAD -- src/` | Review code changes for security implications |
| `grep -rn "eval\|exec\|spawn\|innerHTML"` | Scan for dangerous code patterns |

### System Audit
| Command | Purpose |
|---------|---------|
| `find . -name ".env*" -exec stat {} \;` | Check .env file permissions (should be 0600) |
| `cortextos bus list-agents --format json` | Audit running agent configurations |
| `pm2 list` | Check process management state |

## Browser-Based Analysis
For web application security testing, use the agent-browser skill. See `.claude/skills/agent-browser/SKILL.md`.

## Important
- Never print secret values in logs, memory, or task results
- Use structure-probing techniques (file size, line count, key names) instead of cat/head on credential files
- Always confirm authorization scope before active scanning
