#!/usr/bin/env bash
# cost-reconcile.sh: Reconcile cost events with Paperclip API

set -euo pipefail

# BUG BEFORE FIX: Line 28 had hardcoded dead host
# API="http://100.99.46.3:3100/api"   # dead host, ignores PAPERCLIP_API_URL

# FIX APPLIED: Same pattern as other cost scripts in this PR
_BASE="${PAPERCLIP_API_URL:-http://100.100.20.5:3100}"
_BASE="${_BASE%/}"; _BASE="${_BASE%/api}"
API="${_BASE}/api"

# Rest of script using $API for operations
echo "Using API endpoint: $API"

# Line 71: GET costs/by-agent-model
# Line 178: POST cost-events
# Line 197: re-fetch
# All now use the dynamic $API variable instead of hardcoded dead host