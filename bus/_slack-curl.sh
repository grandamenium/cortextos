#!/usr/bin/env bash
# _slack-curl.sh - Shared helper for Slack Web API calls
# Keeps SLACK_BOT_TOKEN out of shell traces (set +x) while preserving stderr.
# Source this file, then call the functions. Requires SLACK_BOT_TOKEN in env.

slack_api_post() {
    local method="$1"; shift
    (
        set +x
        curl -s -X POST "https://slack.com/api/${method}" \
            -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
            -H "Content-Type: application/json; charset=utf-8" \
            "$@"
    )
}
