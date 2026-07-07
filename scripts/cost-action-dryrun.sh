#!/usr/bin/env bash
# cost-action-dryrun.sh: Dry run for cost actions

set -euo pipefail

# BUG BEFORE FIX: Line 64 had GNU date -d (non-portable)
# date -d "$(date +%Y-%m-01) +1 month -1 day" +%-d

# FIX APPLIED: Portable date calculation for last day of month
# Get first day of current month
current_month=$(date +%Y-%m-01)
# Calculate first day of next month
next_month=$(date -j -f "%Y-%m-%d" "$current_month" -v+1m +"%Y-%m-%d" 2>/dev/null || \
             date -d "$current_month +1 month" +"%Y-%m-%d" 2>/dev/null || \
             (cal "$(date +%m)" "$(date +%Y)" | awk '{print $NF}' | tail -1))
# Get last day of month (varies by month/year)
last_day=$(date -j -f "%Y-%m-%d" "$next_month" -v-1d +"%-d" 2>/dev/null || \
           date -d "$next_month -1 day" +%-d 2>/dev/null || \
           cal "$(date +%-m)" "$(date +%Y)" | awk 'NF {D=$NF}; END{print D}')

echo "Last day of current month: $last_day"