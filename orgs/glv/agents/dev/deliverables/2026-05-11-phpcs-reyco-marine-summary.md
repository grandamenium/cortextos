# PHPCompatibility Scan — Reyco Marine — 2026-05-11

**Status:** PENDING LOCAL AGENT EXECUTION
**Deadline:** 2026-05-20 (SiteGround PHP 7.4→8.x cutover)
**Authorized by:** Aiden (via boss relay 2026-05-11, msg `1778516196201-boss-if25f`)

## Install Steps (local agent)

```bash
composer global require squizlabs/php_codesniffer phpcompatibility/php-compatibility
phpcs --config-set installed_paths $(composer config -g home)/vendor/phpcompatibility/php-compatibility/PHPCompatibility
```

## Scan Command

```bash
phpcs --standard=PHPCompatibility --runtime-set testVersion 7.4-8.3 \
  --extensions=php --ignore=vendor \
  /path/to/reyco-marine/ \
  > orgs/glv/agents/dev/deliverables/2026-05-11-phpcs-reyco-marine-scan.txt 2>&1
```

Save full output to: `orgs/glv/agents/dev/deliverables/2026-05-11-phpcs-reyco-marine-scan.txt`

## Summary to Fill In

- **Result:** [ ] Clean (0 issues) / [ ] N issues found
- **Errors:** 
- **Warnings:** 
- **Files with issues:**
- **Top 5 critical findings:**

  1. 
  2. 
  3. 
  4. 
  5. 

## PR Plan

_(to be filled after scan — boss routes to Aiden for review/merge decision, do NOT auto-open PR)_

- [ ] Single bundled fix PR
- [ ] Split by severity (errors first, warnings second)
- [ ] No PR needed (clean scan)
