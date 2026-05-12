# Reyco Marine — N4/N5 CI Workflow (Ready to Deploy)

_Drafted: 2026-05-08 (cloud session dev agent heartbeat)_
_Updated: 2026-05-11 — PHP 8.1 (EOL Dec 2025) → 8.3 runner; testVersion expanded to `7.4-8.3` range for full deprecation coverage._
_Updated: 2026-05-12 — smoke-test job: SMOKE_URLS updated to verified reycomarine.com production paths (exp_1778496458_smku); REQUIRED_MARKERS updated to theme-accurate Tailwind markers (next hypothesis after exp close 2026-05-13T10:57Z, verified 2026-05-11 against live site)._
_Scout signal HIGH priority item from 2026-05-07: review Claude Code CI auto-fix integration path before implementing N4/N5 manually._

## Decision Summary

**Claude Code `claude-code-action@v1`** (Anthropic's official GitHub Action, GA since Sep 2025) is **complementary to N4/N5 — not a replacement**:
- N4 (PHP lint CI) → catches PHP syntax + compatibility errors as a CI gate
- N5 (PR-triggered CI) → surfaces those failures on every PR
- `claude-code-action@v1` → auto-reviews PRs and can auto-fix failures that N4 catches

**Implementation order: N4+N5 first → claude-code-action optional second.**
Both require `ANTHROPIC_API_KEY` to be stored as a GitHub repo secret (claude-code-action only).

---

## File 1: `.github/workflows/ci.yml` (N4 + N5 — copy into glvcrypto/reyco-marine)

```yaml
name: CI

on:
  push:
    branches: [master]
  pull_request:
    branches: [master]

jobs:
  php-lint:
    name: PHP Syntax Check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up PHP 8.3
        uses: shivammathur/setup-php@v2
        with:
          php-version: '8.3'
          tools: composer

      - name: PHP syntax check (all .php files)
        run: |
          find . -name '*.php' \
            -not -path './vendor/*' \
            -not -path './.git/*' \
            | xargs -I{} php -l {} 2>&1
          echo "PHP syntax check: PASS"

      - name: PHP 8.x removed-pattern grep gate
        run: |
          CHANGED_PHP=$(git diff --name-only HEAD~1 HEAD 2>/dev/null | grep '\.php$' || find . -name '*.php' -not -path './vendor/*' -not -path './.git/*')
          if [ -z "$CHANGED_PHP" ]; then
            echo "No PHP files to check."
            exit 0
          fi
          FAIL=0
          for file in $CHANGED_PHP; do
            [ -f "$file" ] || continue
            for pattern in "each(" "create_function(" "(real)" "ereg(" "eregi(" "split("; do
              if grep -q "$pattern" "$file"; then
                echo "FAIL: PHP 8.x-incompatible pattern '$pattern' found in $file"
                FAIL=1
              fi
            done
          done
          if [ $FAIL -ne 0 ]; then exit 1; fi
          echo "PHP 8.x removed-pattern gate: PASS"

  phpcs-compat:
    name: PHPCompatibility PHPCS (PHP 7.4-8.3)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up PHP 8.3
        uses: shivammathur/setup-php@v2
        with:
          php-version: '8.3'
          tools: composer

      - name: Install PHPCS + PHPCompatibility
        run: |
          composer global require squizlabs/php_codesniffer phpcompatibility/php-compatibility
          echo "$(composer config -g home)/vendor/bin" >> $GITHUB_PATH
          phpcs --config-set installed_paths \
            $(composer config -g home)/vendor/phpcompatibility/php-compatibility/PHPCompatibility

      - name: Run PHPCompatibility scan
        run: |
          phpcs \
            --standard=PHPCompatibility \
            --runtime-set testVersion 7.4-8.3 \
            --extensions=php \
            --ignore=vendor \
            --warning-severity=0 \
            . \
            || (echo "FAIL: PHPCompatibility found PHP 7.4→8.x incompatibilities" && exit 1)
          echo "PHPCompatibility gate: PASS"
        # testVersion 7.4-8.3 = check for all removals/changes from 7.4 through 8.3
        # --warning-severity=0 = report ERRORs only, suppress WARNINGs
        # Change to --warning-severity=5 to fail on warnings too

  smoke-test:
    name: Production Smoke Test
    runs-on: ubuntu-latest
    # Only run on master push (not on PRs — site not deployed yet)
    if: github.event_name == 'push' && github.ref == 'refs/heads/master'
    steps:
      - name: Structural marker + WP runtime error scan
        run: |
          SMOKE_URLS=(
            "https://reycomarine.com/"
            "https://reycomarine.com/boats-and-marine/"
            "https://reycomarine.com/service/"
            "https://reycomarine.com/product/2022-mercury-me-60-elpt-4s-efi/"
            "https://reycomarine.com/service/engine-repair/"
            "https://reycomarine.com/boats-and-marine/outboard-motors/"
          )
          # Theme-accurate markers (Tailwind theme — not WP classic class names).
          # reyco-nav-link: custom class, 9× per page; <main/<footer/<nav: HTML5 structural elements.
          # Verified 2026-05-11 against live reycomarine.com.
          REQUIRED_MARKERS=("reyco-nav-link" "<main" "<footer" "<nav")
          WP_ERROR_PATTERNS=("Fatal error" "Parse error" "There has been a critical error" "Call to undefined" "Call to a member function" "class not found" "wp-die")

          FAIL=0
          for url in "${SMOKE_URLS[@]}"; do
            html=$(curl -s --max-time 15 "$url")
            for marker in "${REQUIRED_MARKERS[@]}"; do
              if ! echo "$html" | grep -q "$marker"; then
                echo "FAIL: structural marker '$marker' missing from $url"
                FAIL=1
              fi
            done
            for pattern in "${WP_ERROR_PATTERNS[@]}"; do
              if echo "$html" | grep -qi "$pattern"; then
                echo "FAIL: WP runtime error '$pattern' found in $url"
                FAIL=1
              fi
            done
          done

          if [ $FAIL -ne 0 ]; then exit 1; fi
          echo "Smoke test: PASS (6 URLs, structural markers + WP error scan)"
```

---

## File 2: `.github/workflows/claude-review.yml` (Optional — Claude Code PR auto-review)

Requires: `ANTHROPIC_API_KEY` repo secret + Claude GitHub App installed (`/install-github-app` or https://github.com/apps/claude).

```yaml
name: Claude Code PR Review

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  claude-review:
    name: Claude Code Review
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4

      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            Review this pull request for the Reyco Marine WordPress/WooCommerce theme.
            Focus on:
            1. PHP 8.1 compatibility — flag any removed functions, strict type issues, dynamic property usage
            2. WooCommerce HPOS compatibility — no direct wp_postmeta/get_post_meta calls for orders
            3. WordPress coding standards — proper escaping, nonces, sanitization
            4. Mobile responsiveness — Tailwind CSS utility classes, responsive breakpoints
            5. Performance — avoid N+1 queries, unnecessary globals, unguarded wp_query loops
            Post specific, actionable review comments. Flag ERRORs (must fix) vs WARNINGs (should fix).
          claude_args: "--max-turns 5 --model claude-sonnet-4-6"
```

---

## Implementation Checklist (for local agent)

### Step 1 — PHP lint CI (N4 + N5)
- [ ] `git checkout master && git pull origin master`
- [ ] `git checkout -b feat/n4-n5-php-lint-ci`
- [ ] Copy `ci.yml` above to `reyco-marine/.github/workflows/ci.yml`
- [ ] `git add .github/workflows/ci.yml && git commit -m "feat(ci): PHP lint + PHPCompatibility + smoke test (N4/N5)"`
- [ ] `git push -u origin feat/n4-n5-php-lint-ci`
- [ ] Open PR → Aiden review

### Step 2 — Claude Code auto-review (optional, needs ANTHROPIC_API_KEY)
- [ ] Install Claude GitHub App: run `/install-github-app` in Claude Code CLI, or visit https://github.com/apps/claude
- [ ] Add `ANTHROPIC_API_KEY` as GitHub repo secret in reyco-marine settings
- [ ] Copy `claude-review.yml` above to `reyco-marine/.github/workflows/claude-review.yml`
- [ ] Open PR for Aiden review

### Step 3 — Local PHPCompatibility PHPCS (dev machine)
Already documented in deploy-reliability surface. Still required for pre-push gate:
```bash
composer global require squizlabs/php_codesniffer phpcompatibility/php-compatibility
phpcs --config-set installed_paths $(composer config -g home)/vendor/phpcompatibility/php-compatibility/PHPCompatibility
# Scan (use same testVersion range as CI):
phpcs --standard=PHPCompatibility --runtime-set testVersion 7.4-8.3 --extensions=php --ignore=vendor /path/to/reyco-marine/wp-content/themes/reyco-marine/
```

---

## Notes

- `shivammathur/setup-php@v2` is the standard PHP setup action for GitHub Actions — handles PHP version + PECL extensions
- PHPCompatibility scan uses `testVersion 7.4-8.3` — covers all removals/deprecations from PHP 7.4 through 8.3. SiteGround targeting 8.1 (EOL Dec 2025); recommend requesting 8.3 (active through Dec 2027). Either way the range catches all issues.
- CI runner uses PHP 8.3 — runs on the latest stable PHP to catch runtime issues regardless of SiteGround's specific target version
- Smoke URLs: all 6 verified 200 on reycomarine.com 2026-05-11 (exp_1778496458_smku). Old staging URLs (`reyco.glvmarketing.ca`, `/products/`, `/services/`) were stale — `/products/` and `/services/` returned 404 even on staging.
- `REQUIRED_MARKERS`: reyco-marine uses Tailwind utility classes — WP classic class names (`.site-header`, `.site-footer`, `main.site-main`, `nav.site-nav`) do NOT exist in the theme. Replaced with `reyco-nav-link` (theme-specific custom class, 9× per page) + HTML5 structural tags (`<main`, `<footer`, `<nav`). Verified 2026-05-11 against live reycomarine.com. A broken WP deploy (white screen, PHP fatal) would be missing all 4 markers.
- smoke-test job guarded by `if: github.event_name == 'push' && github.ref == 'refs/heads/master'` — runs only after master deploy, not on PRs
- Single product URL (`/product/2022-mercury-me-60-elpt-4s-efi/`) could 404 if the product is deleted; update to a durable inventory page URL once one exists
- Claude review action (`claude-review.yml`) is additive — costs ~$0.10–$0.30 per PR review depending on diff size
- `claude-code-action@v1` breaking changes from beta: `direct_prompt` → `prompt`, `mode` removed (auto-detected), `custom_instructions` → `claude_args: --append-system-prompt`
- If PHP lint or PHPCS CI fails on a PR, Claude Code auto-fix (via `subscribe_pr_activity` in a Claude Code session) can watch + fix automatically
