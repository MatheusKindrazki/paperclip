#!/usr/bin/env bash
#
# cost-class-populate.sh - Populate agent metadata with cost class tags
#
# This script queries the Paperclip API for all agents and populates their
# metadata.costClass field based on a name-to-class mapping table.
#
# Usage:
#   ./cost-class-populate.sh [OPTIONS]
#
# Options:
#   --verify     Run in verification mode (read-only, no changes)
#   --apply      Apply cost class tags to agents (default mode)
#   --help       Display this help message
#
# Environment variables:
#   PAPERCLIP_API_URL  API base URL (default: http://100.100.20.5:3100/api)
#   PAPERCLIP_API_KEY  API key for authentication (optional, for future use)
#
# Features:
#   - Bash 3.2 compatible (macOS safe)
#   - Idempotent (skips already-tagged agents)
#   - Preserves existing metadata fields
#   - Verification mode for testing
#   - Comprehensive error handling
#   - Statistics reporting via temp file (subshell-safe)
#   - Future-proofed for API authentication
#

set -euo pipefail

# Default configuration
API_URL="${PAPERCLIP_API_URL:-http://100.100.20.5:3100/api}"
API_KEY="${PAPERCLIP_API_KEY:-}"
MODE="apply"  # Default to apply mode
TEMP_STATS=$(mktemp)

# Cleanup on exit
cleanup() {
    rm -f "$TEMP_STATS"
}
trap cleanup EXIT

# Initialize statistics in temp file (subshell-safe)
init_stats() {
    cat > "$TEMP_STATS" << 'EOF'
OK=0
SKIPPED=0
FAILED=0
DRIFT=0
TAGS=""
EOF
}

# Update statistics in temp file (subshell-safe)
update_stats() {
    local stat_name="$1"
    local value="$2"
    local temp_file=$(mktemp)

    # Read current stats, update specific counter, write back
    while IFS='=' read -r key value; do
        if [ "$key" = "$stat_name" ]; then
            echo "${stat_name}=$((value + 1))"
        else
            echo "${key}=${value}"
        fi
    done < "$TEMP_STATS" > "$temp_file"

    mv "$temp_file" "$TEMP_STATS"
}

# Append tag to statistics
append_tag() {
    local tag="$1"
    local temp_file=$(mktemp)

    while IFS='=' read -r key value; do
        if [ "$key" = "TAGS" ]; then
            echo "${key}=${value} ${tag}"
        else
            echo "${key}=${value}"
        fi
    done < "$TEMP_STATS" > "$temp_file"

    mv "$temp_file" "$TEMP_STATS"
}

# Display help message
show_help() {
    sed -n '/^# Usage/,/^#$/p' "$0" | sed 's/^# //g' | sed 's/^#//g'
    exit 0
}

# Display error message for unknown flags
show_flag_error() {
    local flag="$1"
    echo "Error: Unknown option: $flag" >&2
    echo "Use --help for usage information" >&2
    exit 1
}

# Parse command line arguments
parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --verify)
                MODE="verify"
                shift
                ;;
            --apply)
                MODE="apply"
                shift
                ;;
            --help)
                show_help
                ;;
            *)
                echo "Error: Unknown option: $1" >&2
                echo "Use --help for usage information" >&2
                exit 1
                ;;
        esac
    done
}

# Get cost class for an agent name
get_cost_class() {
    local agent_name="$1"

    case "$agent_name" in
        # Platform agents - core infrastructure
        paperclip-orchestrator|paperclip-monitor|paperclip-governor|\
        sentinel|moklabs-sentinel|kindra-sentinel)
            echo "platform"
            ;;

        # Core thesis agents - business value
        thesis-governor|thesis-agent)
            echo "core-thesis"
            ;;

        # Parked agents - inactive/development
        *-test|*-dev|*-deprecated|*parked*)
            echo "parked"
            ;;

        # Default to secondary for all other operational agents
        *)
            echo "secondary"
            ;;
    esac
}

# Fetch all agents from the API
fetch_agents() {
    local url="$1"

    if [ -n "$API_KEY" ]; then
        curl -s -H "Authorization: Bearer ${API_KEY}" "${url}/agents"
    else
        curl -s "${url}/agents"
    fi
}

# Update agent metadata
update_agent() {
    local agent_id="$1"
    local current_metadata="$2"
    local new_class="$3"

    # Merge existing metadata with cost class
    local updated_metadata
    updated_metadata=$(echo "$current_metadata" | jq --arg class "$new_class" '. + {costClass: $class}')

    # Prepare PATCH request
    local patch_data="{\"metadata\": $updated_metadata}"

    if [ -n "$API_KEY" ]; then
        curl -s -X PATCH \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer ${API_KEY}" \
            -d "$patch_data" \
            "${API_URL}/agents/${agent_id}"
    else
        curl -s -X PATCH \
            -H "Content-Type: application/json" \
            -d "$patch_data" \
            "${API_URL}/agents/${agent_id}"
    fi
}

# Process a single agent
process_agent() {
    local agent_id="$1"
    local agent_name="$2"
    local current_metadata="$3"
    local mode="$4"

    # Get the appropriate cost class for this agent
    local cost_class
    cost_class=$(get_cost_class "$agent_name")

    # Check if already tagged
    local existing_class
    existing_class=$(echo "$current_metadata" | jq -r 'if type == "object" then .costClass // empty else empty end' 2>/dev/null)

    if [ "$existing_class" = "$cost_class" ]; then
        echo "ok: $agent_name already has costClass=$cost_class"
        update_stats "SKIPPED" 0
        return 0
    fi

    if [ -n "$existing_class" ]; then
        echo "DRIFT: $agent_name has costClass=$existing_class, should be $cost_class"
        update_stats "DRIFT" 0
        update_stats "FAILED" 0
        return 1
    fi

    # In verify mode, just report what would be done
    if [ "$mode" = "verify" ]; then
        echo "VERIFY: $agent_name (${agent_id}) would be tagged as $cost_class"
        update_stats "OK" 0
        append_tag "$agent_name:$cost_class"
        return 0
    fi

    # Apply the cost class tag
    echo "APPLY: $agent_name (${agent_id}) -> $cost_class"

    local response
    response=$(update_agent "$agent_id" "$current_metadata" "$cost_class")

    if echo "$response" | jq -e '.metadata.costClass == "'"$cost_class"'"' > /dev/null 2>&1; then
        echo "✓ Successfully tagged $agent_name as $cost_class"
        update_stats "OK" 0
        append_tag "$agent_name:$cost_class"
        return 0
    else
        echo "✗ Failed to tag $agent_name"
        echo "Response: $response" >&2
        update_stats "FAILED" 0
        return 1
    fi
}

# Main execution
main() {
    parse_args "$@"

    echo "=== Cost Class Population Script ==="
    echo "API URL: $API_URL"
    echo "Mode: $MODE"
    echo ""

    # Check API availability
    echo "Checking API availability..."
    if ! curl -s "${API_URL}/agents" > /dev/null 2>&1; then
        echo "Error: API is not reachable at $API_URL" >&2
        exit 1
    fi
    echo "✓ API is reachable"
    echo ""

    # Fetch agents
    echo "Fetching agents..."
    local agents_json
    if ! agents_json=$(fetch_agents "$API_URL"); then
        echo "Error: Failed to fetch agents from API" >&2
        exit 1
    fi

    local agent_count
    agent_count=$(echo "$agents_json" | jq '. | length')
    echo "✓ Found $agent_count agents"
    echo ""

    if [ "$agent_count" -eq 0 ]; then
        echo "No agents found. Exiting."
        exit 0
    fi

    # Initialize statistics
    init_stats

    # Process each agent
    echo "Processing agents..."
    echo ""

    echo "$agents_json" | jq -r '.[] | "\(.id)|\(.name)|\(.metadata)"' | while IFS='|' read -r agent_id agent_name metadata; do
        # Handle null or string metadata
        if [ "$metadata" = "null" ] || [ "$metadata" = "" ]; then
            metadata="{}"
        fi
        process_agent "$agent_id" "$agent_name" "$metadata" "$MODE"
    done || true

    # Display final statistics
    echo ""
    echo "=== Summary ==="

    # Read stats from temp file
    source "$TEMP_STATS"

    echo "Total agents processed: $agent_count"
    echo "Successful: $OK"
    echo "Skipped (already tagged): $SKIPPED"
    echo "Failed: $FAILED"

    if [ "$MODE" = "verify" ]; then
        echo ""
        echo "Verification Summary:"
        echo "Total agents verified: $agent_count"
        echo "Drift detected: $DRIFT"
        if [ "$DRIFT" -eq 0 ]; then
            echo "✓ No drift detected - all agents correctly tagged"
        else
            echo "⚠ Agents with incorrect cost classes: $DRIFT"
        fi
    fi

    if [ "$FAILED" -gt 0 ]; then
        echo ""
        echo "Warning: Some agents failed to process. Review logs above."
        exit 1
    fi

    echo ""
    echo "✓ Completed successfully"
}

# Run main function
main "$@"