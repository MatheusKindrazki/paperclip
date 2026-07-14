#!/usr/bin/env bash
#
# code-reviewer-burn-signature.sh - Code reviewer burn signature diagnostic tool
#
# Analyzes heartbeat_runs data to detect burn signatures (catch-up vs pathology).
# Generates three sections: A) token volume & distinct issues, B) runs-per-issue verdict,
# and C) dispatcher queue drain stats.
#
# Usage:
#   ./code-reviewer-burn-signature.sh [DAYS]
#
# Arguments:
#   DAYS  Number of days to analyze (default: 4)
#
# Environment variables:
#   PAPERCLICK_DB_URL  PostgreSQL connection string (default: local paperclip DB)
#
# Output:
#   - Section A: Daily token volume (kilo-tokens) and distinct issue count
#   - Section B: Runs-per-issue delta with verdict (CATCHUP / PATHOLOGY / PLATEAU / AMBIGUOUS)
#   - Section C: Dispatcher queue drain percentage (if dispatcher log available)
#

set -euo pipefail

# Configuration
DAYS="${1:-4}"
DB_URL="${PAPERCLICK_DB_URL:-postgresql://paperclip:paperclip@100.100.20.5:5432/paperclip}"
DISPATCHER_LOG="${DISPATCHER_LOG:-}"

# Validate DAYS argument
if ! [[ "$DAYS" =~ ^[0-9]+$ ]]; then
    echo "Error: DAYS must be a positive integer" >&2
    exit 1
fi

echo "=== Code Reviewer Burn Signature (last ${DAYS} days) ==="
echo ""

# Section A: Token volume & distinct issues
echo "## Section A: Token Volume & Distinct Issues"
echo ""

psql "$DB_URL" -F $'\t' -A - <<SQL
SELECT
    date_trunc('day', created_at) AS day,
    SUM(
        COALESCE(
            (usage_json->>'inputTokens')::integer +
            (usage_json->>'outputTokens')::integer,
            0
        )
    ) / 1000.0 AS tot_ktok,
    COUNT(DISTINCT issue_id) AS n_issues
FROM heartbeat_runs
WHERE created_at >= NOW() - INTERVAL '${DAYS} days'
GROUP BY 1
ORDER BY 1;
SQL

echo ""
echo "## Section B: Runs-per-issue Verdict"
echo ""

# Section B: Runs-per-issue delta with verdict (FIXED: F1, F2, F4, F5)
DAYS="$DAYS" python3 - <<'PY'
import os
import subprocess
import sys

days = int(os.environ.get("DAYS", "4"))

# Run psql with proper arguments (FIXED: F5)
proc = subprocess.run([
    "psql",
    os.environ.get("PAPERCLICK_DB_URL", "postgresql://paperclip:paperclip@100.100.20.5:5432/paperclip"),
    "-F", "\t",  # Fixed: separate argument for field separator
    "-A",
    "-c",
    f"""SELECT
        date_trunc('day', created_at) AS day,
        COUNT(*) AS runs,
        COUNT(DISTINCT issue_id) AS distinct_issues,
        COUNT(*)::float / NULLIF(COUNT(DISTINCT issue_id), 0) AS ratio,
        SUM(
            COALESCE(
                (usage_json->>'inputTokens')::integer +
                (usage_json->>'outputTokens')::integer,
                0
            )
        ) AS tot_vol
    FROM heartbeat_runs
    WHERE created_at >= NOW() - INTERVAL '{days} days'
    GROUP BY 1
    ORDER BY 1;"""
], capture_output=True, text=True)

lines = proc.stdout.strip().split('\n')
if not lines or lines[0] == '':
    sys.exit(0)

rows = []
for line in lines:
    # Split by tab (FIXED: F5 - removed dead | branch)
    parts = line.split('\t')
    if len(parts) < 5:
        continue
    day, runs, distinct, ratio, vol = parts[:5]
    try:
        rows.append({
            'day': day,
            'runs': int(runs),
            'distinct': int(distinct),
            'ratio': float(ratio) if ratio != '\\N' else None,
            'vol': int(vol) if vol != '\\N' else 0
        })
    except (ValueError, TypeError):
        continue

if len(rows) < 2:
    print("Insufficient data for verdict (need at least 2 days)")
    sys.exit(0)

prev = rows[-2]
last = rows[-1]

run_delta = (last['runs'] - prev['runs']) / prev['runs'] if prev['runs'] > 0 else 0
vol_delta = (last['vol'] - prev['vol']) / prev['vol'] if prev['vol'] > 0 else 0
ratio_delta = (last['ratio'] - prev['ratio']) / prev['ratio'] if prev['ratio'] and prev['ratio'] > 0 else 0

print(f"Day delta: runs={run_delta:+.1%}, vol={vol_delta:+.1%}, ratio={ratio_delta:+.1%}")

# Verdict logic (FIXED: F2 - improved catch-up detection)
verdict = "AMBIGUOUS"
if vol_delta > 0.1:  # Volume up 10%+
    verdict = "PATHOLOGY"
elif vol_delta < -0.1 and (last['ratio'] or 0) <= (prev['ratio'] or 0):  # FIXED: F2 - catch-up when volume down AND ratio stable/improving
    verdict = "CATCHUP"
elif abs(vol_delta) < 0.1:  # Volume stable ±10%
    verdict = "PLATEAU"

print(f"VERDICT: {verdict}")

# Print raw data for reference
print("\nRaw data:")
for row in rows[-2:]:
    print(f"  {row['day']}: runs={row['runs']}, distinct={row['distinct']}, ratio={row['ratio']:.2f}, vol={row['vol']}")
PY

echo ""
echo "## Section C: Dispatcher Queue Drain"
echo ""

# Section C: Dispatcher queue drain (FIXED: F3 - use proper JSON parsing)
if [[ -n "$DISPATCHER_LOG" && -f "$DISPATCHER_LOG" ]]; then
    python3 - <<'PY'
import json
import os

log_path = os.environ.get("DISPATCHER_LOG", "")
if not log_path or not os.path.exists(log_path):
    print("No dispatcher log available (DISPATCHER_LOG not set or file not found)")
    exit(0)

total_ticks = 0
drained_ticks = 0

with open(log_path, 'r') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            # Use proper JSON parsing instead of brace-counting (FIXED: F3)
            entry = json.loads(line)
            if entry.get('event') == 'tick':
                total_ticks += 1
                if entry.get('reviewQueue', {}).get('length', 0) == 0:
                    drained_ticks += 1
        except (json.JSONDecodeError, ValueError):
            # Skip invalid JSON lines
            continue

if total_ticks > 0:
    drain_pct = (drained_ticks / total_ticks) * 100
    print(f"Dispatcher ticks: {total_ticks}")
    print(f"Queue drained: {drained_ticks} ({drain_pct:.1f}%)")
else:
    print("No dispatcher ticks found in log")
PY
else
    echo "No dispatcher log available (set DISPATCHER_LOG path to analyze queue drain)"
fi

echo ""
echo "=== End of Report ==="
