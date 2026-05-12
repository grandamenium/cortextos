# template-service.php — Crash Fix

_Created: 2026-05-12 (cloud session — glvcrypto/glvmarketing repo not accessible from cloud)_

## Problem

`template-service.php` in the `glv-marketing` WP theme is throwing HTTP 500 on all service sub-pages.  Boss completed 2h of direct FTP/REST work and handed off at 19:55 UTC — template fix is the only remaining launch blocker.

Aiden hint: reference reyco-marine repo / reycomarine.com for the working pattern.  Same SiteGround infra, same template name.

## Diagnostic First

SSH into SiteGround and check the PHP error log before replacing anything:

```bash
ssh -p 18765 giowm1155.siteground.biz -i ~/.ssh/sg-reyco
# Or check SiteGround Site Tools → Error Log for glvmarketing.ca

# View PHP error log
tail -100 ~/glvmarketing.ca/logs/php_error.log 2>/dev/null || \
tail -100 ~/logs/php_error.log 2>/dev/null

# View current template
cat ~/glvmarketing.ca/public_html/wp-content/themes/glv-marketing/template-service.php
```

Common 500 causes to look for:
- Syntax error (`unexpected T_VARIABLE`, `unexpected '}'`, etc.)
- `Call to undefined function glv_*()` — boss may have referenced a function not in functions.php
- Missing `<?php` at top or mangled template comment header
- Unclosed string, missing semicolon

## Fix: Replace with clean version

If the log shows a syntax/fatal error, replace with the clean template in this directory:

```bash
# SCP the fixed template to the server
scp -P 18765 -i ~/.ssh/sg-reyco \
  orgs/glv/clients/glv-marketing/deliverables/template-service-fix/template-service.php \
  giowm1155.siteground.biz:~/glvmarketing.ca/public_html/wp-content/themes/glv-marketing/template-service.php
```

Then also commit the fixed file to the `glvcrypto/glvmarketing` repo so it doesn't get overwritten on next GHA deploy:

```bash
cd /path/to/glvmarketing-checkout
git checkout main
git pull origin main
cp /path/to/cortextos/orgs/glv/clients/glv-marketing/deliverables/template-service-fix/template-service.php \
  wp-content/themes/glv-marketing/template-service.php
git add wp-content/themes/glv-marketing/template-service.php
git commit -m "fix(theme): replace broken template-service.php with clean version"
git push -u origin main
```

## What the clean template does

- `Template Name: Service Page` header — WP recognises it as a selectable page template
- `get_header()` / `get_footer()` — assets enqueued via functions.php (no inline asset injection)
- Breadcrumbs from `get_post_ancestors()` — renders if page has a parent
- Reads `_glv_headline`, `_glv_subheading`, `_glv_body`, `_glv_cta_label`, `_glv_cta_url` post meta
- Falls back to `the_content()` if `_glv_body` is empty — safe for pages with no custom meta

## After Fix: Assign template to service pages

If the service pages were created via REST without the template assigned, set it via WP-CLI:

```bash
# List service sub-pages (children of Services page — probably ID 9)
wp post list --post_type=page --post_parent=9 --fields=ID,post_title,post_name

# Assign template-service.php to each
wp post meta update <ID> _wp_page_template template-service.php
```

Or via WP REST API (if WP-CLI SSH not available):

```bash
# Get posts and find the ones needing the template
curl -s "https://glvmarketing.ca/wp-json/wp/v2/pages?parent=9&per_page=20" \
  -u admin:application_password | jq '.[] | {id, title: .title.rendered}'

# Update template for a page
curl -s -X POST "https://glvmarketing.ca/wp-json/wp/v2/pages/<ID>" \
  -u admin:application_password \
  -H "Content-Type: application/json" \
  -d '{"template": "template-service.php"}'
```

## Remaining 11 Pages (Priority 2 after 500 fix)

Pages needing proper content + template assigned:

| Page | Slug | Parent |
|------|------|--------|
| Local SEO | local-seo | services/seo (or services) |
| GEO Targeting | geo | services |
| Website Design | website-design | services |
| Paid Advertising | paid-advertising | services |
| Content Marketing | content-marketing | services |
| AI Automation | ai-automation | services |
| Google Business Profile | google-business-profile | services |
| Case Study: Titan | titan | case-studies |
| Case Study: Fusion | fusion | case-studies |
| Marketing Hub | marketing-hub | (top-level or services) |
| Automation Hub | automation-hub | (top-level or services) |

## Case Studies 404 Fix (Priority 4)

`/case-studies/titan` and `/case-studies/fusion` returning 404 — likely WP rewrite cache:

```bash
# Flush rewrite rules
wp rewrite flush

# If pages exist but have wrong parent/slug:
wp post list --post_type=page --s="titan fusion" --fields=ID,post_title,post_name,post_parent
wp post update <ID> --post_parent=<case-studies-page-id>
wp rewrite flush
```
