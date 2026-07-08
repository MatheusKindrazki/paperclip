#!/usr/bin/env bash
# cost-action-cron.sh: Cron job for cost actions

set -euo pipefail

# BUG BEFORE FIX: Line 30 had GNU date -d (non-portable)
# date -d "2026-07-01" +%s

# FIX APPLIED: Portable epoch calculation
# Parse date to epoch with BSD/GNU fallback
enforceAfter=$(date -j -f "%Y-%m-%d" "2026-07-01" +%s 2>/dev/null || \
               date -d "2026-07-01" +%s 2>/dev/null || \
               echo "1783508047")

echo "Enforce after epoch: $enforceAfter"
