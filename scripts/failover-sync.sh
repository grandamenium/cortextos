#!/usr/bin/env bash
# On-demand state sync between laptop and droplet.
# Usage: failover-sync.sh [push|pull] [droplet-host]

set -euo pipefail

DIRECTION="${1:-push}"
DROPLET_HOST="${2:-157.230.61.101}"
CORTEXTOS_LOCAL="/Users/samersabbagh/cortextos"
CORTEXTOS_REMOTE="/root/cortextos"

RSYNC_OPTS="-az --timeout=30 -e ssh --exclude=node_modules --exclude=dist --exclude=.git --exclude=dashboard"

case "${DIRECTION}" in
    push)
        echo "Pushing state to droplet..."
        rsync ${RSYNC_OPTS} \
            "${CORTEXTOS_LOCAL}/orgs/" \
            "root@${DROPLET_HOST}:${CORTEXTOS_REMOTE}/orgs/"
        echo "State pushed to droplet."
        ;;
    pull)
        echo "Pulling state from droplet..."
        rsync ${RSYNC_OPTS} \
            "root@${DROPLET_HOST}:${CORTEXTOS_REMOTE}/orgs/" \
            "${CORTEXTOS_LOCAL}/orgs/"
        echo "State pulled from droplet."
        ;;
    *)
        echo "Usage: failover-sync.sh [push|pull] [droplet-host]"
        exit 1
        ;;
esac
