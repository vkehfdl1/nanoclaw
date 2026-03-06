#!/usr/bin/env bash
# =============================================================================
# SNS Research Script — Marketer Agent
# =============================================================================
# Orchestrates trend/keyword research across social platforms.
# Called by the Marketer agent (Claude) via bash inside the container.
#
# Usage:
#   ./sns-research.sh [OPTIONS]
#
# Options:
#   --platforms <list>     Comma-separated platforms: x,linkedin,threads,all
#                          Default: all enabled platforms
#   --frequency <freq>     Filter by research frequency: daily,weekly,all
#                          Default: all
#   --categories <list>    Comma-separated categories: tech,ai_ml,productivity,all
#                          Default: all
#   --output-dir <path>    Directory to write research output
#                          Default: /workspace/group/research
#   --format <fmt>         Output format: markdown,json,both
#                          Default: markdown
#   --insights-source <s>  Slug for the insights file name (e.g. weekly, pm-myproject)
#                          Default: weekly
#   --trigger <t>          Trigger type for insights file metadata
#                          Values: self_initiated, pm_agent_request, manual
#                          Default: self_initiated
#   --dry-run              Print plan without running
#
# Output:
#   Writes per-platform and aggregated trend files to output-dir.
#   Final report path: {output-dir}/trends-YYYY-MM.md
#
# =============================================================================

set -euo pipefail

# ── Defaults ────────────────────────────────────────────────────────────────

PLATFORMS="all"
FREQUENCY="all"
CATEGORIES="all"
OUTPUT_DIR="/workspace/group/research"
FORMAT="markdown"
INSIGHTS_SOURCE="weekly"
TRIGGER="self_initiated"
DRY_RUN=false
CONFIG_FILE="/workspace/group/config/platforms.json"
DATE=$(date +%Y-%m-%d)
YEAR_MONTH=$(date +%Y-%m)
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
TEMP_DIR="/tmp/sns-research-${TIMESTAMP}"

# ── Colors ───────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# ── Logging ──────────────────────────────────────────────────────────────────

log_info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}   $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
log_step()  { echo -e "\n${CYAN}▶ $*${NC}"; }

# ── Argument Parsing ─────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platforms)       PLATFORMS="$2";       shift 2 ;;
    --frequency)       FREQUENCY="$2";       shift 2 ;;
    --categories)      CATEGORIES="$2";      shift 2 ;;
    --output-dir)      OUTPUT_DIR="$2";      shift 2 ;;
    --format)          FORMAT="$2";          shift 2 ;;
    --insights-source) INSIGHTS_SOURCE="$2"; shift 2 ;;
    --trigger)         TRIGGER="$2";         shift 2 ;;
    --dry-run)         DRY_RUN=true;         shift   ;;
    -h|--help)
      sed -n '/^# Usage:/,/^# =/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      log_error "Unknown option: $1"
      exit 1
      ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────

# Read a value from platforms.json using Python (available in container)
json_get() {
  local file="$1"
  local query="$2"
  python3 -c "
import json, sys
with open('$file') as f:
    data = json.load(f)
result = data
for key in '$query'.split('.'):
    if isinstance(result, dict):
        result = result.get(key, '')
    else:
        result = ''
        break
if isinstance(result, (dict, list)):
    print(json.dumps(result))
else:
    print(result)
"
}

# Get list of enabled platforms from config
get_enabled_platforms() {
  python3 -c "
import json
with open('$CONFIG_FILE') as f:
    data = json.load(f)
platforms = data.get('platforms', {})
enabled = [k for k, v in platforms.items() if v.get('enabled', False)]
print(','.join(enabled))
"
}

# Check if a platform should be researched given frequency filter
should_research_platform() {
  local platform="$1"
  local platform_freq
  platform_freq=$(python3 -c "
import json
with open('$CONFIG_FILE') as f:
    data = json.load(f)
p = data.get('platforms', {}).get('$platform', {})
print(p.get('research_frequency', 'weekly'))
")

  case "$FREQUENCY" in
    all)    return 0 ;;
    daily)  [[ "$platform_freq" == "daily" ]] && return 0 || return 1 ;;
    weekly) [[ "$platform_freq" == "weekly" || "$platform_freq" == "daily" ]] && return 0 || return 1 ;;
    *)      return 0 ;;
  esac
}

# Get research keywords for a category + platform
get_keywords() {
  local category="$1"
  local platform="$2"
  python3 -c "
import json
with open('$CONFIG_FILE') as f:
    data = json.load(f)
cats = data.get('research_categories', {})
cat = cats.get('$category', {})
hashtags = cat.get('related_hashtags', {}).get('$platform', [])
seeds = cat.get('seed_keywords', [])
all_kw = seeds + hashtags
print('|'.join(all_kw[:10]))  # Limit to 10
"
}

# ── Research Functions ────────────────────────────────────────────────────────

# Gather web search trends for a keyword + platform
research_via_web_search() {
  local platform="$1"
  local keyword="$2"
  local output_file="$3"

  log_info "Web search: [$platform] '$keyword'"

  # The agent itself will perform the actual web search using its tools.
  # This script emits a structured search request that the agent processes.
  cat >> "$output_file" << EOF

### Search: $keyword (via web search)
**Platform:** $platform
**Query:** "site:$platform OR $keyword trending $(date +%Y)"
**Status:** PENDING — agent should run web search for this query
EOF
}

# Emit browser automation instructions for a platform's trending page
research_via_browser() {
  local platform="$1"
  local url="$2"
  local output_file="$3"

  log_info "Browser research: [$platform] $url"

  cat >> "$output_file" << EOF

### Browser Visit: $platform trending
**URL:** $url
**Status:** PENDING — agent should visit this URL with agent-browser
**Steps:**
  1. agent-browser open $url
  2. agent-browser snapshot -i
  3. Extract trending topics and top post examples
  4. Record in structured format below
EOF
}

# Research a single platform
research_platform() {
  local platform="$1"
  local platform_output="$TEMP_DIR/platform-${platform}.md"

  log_step "Researching platform: $platform"

  # Get platform details from config
  local platform_name
  platform_name=$(python3 -c "
import json
with open('$CONFIG_FILE') as f:
    data = json.load(f)
print(data['platforms']['$platform']['name'])
")

  local trending_url
  trending_url=$(python3 -c "
import json
with open('$CONFIG_FILE') as f:
    data = json.load(f)
urls = data['platforms']['$platform'].get('research_urls', {})
print(urls.get('trending', ''))
")

  local collection_method
  collection_method=$(python3 -c "
import json
with open('$CONFIG_FILE') as f:
    data = json.load(f)
print(data['platforms']['$platform'].get('data_collection_method', 'browser'))
")

  # Start platform section
  cat > "$platform_output" << EOF
## Platform: $platform_name
**Date:** $DATE
**Collection Method:** $collection_method

EOF

  if [[ "$DRY_RUN" == true ]]; then
    log_info "[DRY RUN] Would research: $platform ($collection_method)"
    echo "**[DRY RUN]** Research plan printed only." >> "$platform_output"
  fi

  # Emit browser research instructions for trending page
  if [[ -n "$trending_url" ]]; then
    research_via_browser "$platform" "$trending_url" "$platform_output"
  fi

  # Emit keyword research tasks based on selected categories
  local cats_to_research
  if [[ "$CATEGORIES" == "all" ]]; then
    cats_to_research=$(python3 -c "
import json
with open('$CONFIG_FILE') as f:
    data = json.load(f)
print(','.join(data.get('research_categories', {}).keys()))
")
  else
    cats_to_research="$CATEGORIES"
  fi

  IFS=',' read -ra cat_list <<< "$cats_to_research"
  for category in "${cat_list[@]}"; do
    local keywords
    keywords=$(get_keywords "$category" "$platform")
    if [[ -n "$keywords" ]]; then
      IFS='|' read -ra kw_list <<< "$keywords"
      local first_kw="${kw_list[0]}"
      research_via_web_search "$platform" "$first_kw $category" "$platform_output"
    fi
  done

  # Append placeholder for parsed output
  cat >> "$platform_output" << EOF

### Parsed Trends Output
<!-- Agent fills this in after running browser/search steps above -->
\`\`\`json
{
  "platform": "$platform",
  "date": "$DATE",
  "trending_topics": [],
  "top_keywords": [],
  "competitor_insights": [],
  "content_opportunities": [],
  "raw_notes": ""
}
\`\`\`
EOF

  log_ok "Platform research plan ready: $platform"
  cat "$platform_output"
}

# ── Aggregation ───────────────────────────────────────────────────────────────

aggregate_research() {
  local final_report="$OUTPUT_DIR/trends-${YEAR_MONTH}.md"

  log_step "Aggregating research into: $final_report"

  # Write header
  cat > "$final_report" << EOF
# SNS Research Report — $YEAR_MONTH
**Generated:** $DATE
**Platforms:** $PLATFORMS
**Categories:** $CATEGORIES

---

## Executive Summary
<!-- Agent fills this in after collecting all platform data -->

**Top trending topics this period:**
- _pending_

**Key opportunities identified:**
- _pending_

**Recommended content focus:**
- _pending_

---

EOF

  # Append per-platform sections
  for platform_file in "$TEMP_DIR"/platform-*.md; do
    if [[ -f "$platform_file" ]]; then
      cat "$platform_file" >> "$final_report"
      echo "" >> "$final_report"
      echo "---" >> "$final_report"
      echo "" >> "$final_report"
    fi
  done

  # Append cross-platform insights section
  cat >> "$final_report" << EOF
## Cross-Platform Insights
<!-- Agent fills this in after analyzing individual platform data -->

### Common themes across platforms
- _pending_

### Platform-specific opportunities
- _pending_

### Competitor activity summary
- _pending_

---

## Content Ideas Generated from Research

| # | Idea | Platforms | Format | Category | Priority |
|---|------|-----------|--------|----------|----------|
| 1 | _pending_ | | | | |

---

## Action Items

- [ ] Review top trends and select content themes for the week
- [ ] Draft posts based on content ideas above
- [ ] Schedule research follow-up for: $(date -d '+7 days' +%Y-%m-%d 2>/dev/null || date -v+7d +%Y-%m-%d 2>/dev/null || echo "next week")

EOF

  log_ok "Research report created: $final_report"
  echo "$final_report"
}

# ── JSON Output ───────────────────────────────────────────────────────────────

generate_json_output() {
  local json_output="$OUTPUT_DIR/trends-${YEAR_MONTH}.json"

  python3 -c "
import json, os, glob
from datetime import datetime

result = {
    'version': '1.0',
    'generated_at': '$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    'report_period': '$YEAR_MONTH',
    'platforms_researched': '$PLATFORMS'.split(',') if '$PLATFORMS' != 'all' else [],
    'categories': '$CATEGORIES'.split(',') if '$CATEGORIES' != 'all' else [],
    'status': 'pending_agent_collection',
    'platform_data': {},
    'aggregated': {
        'trending_topics': [],
        'content_opportunities': [],
        'competitor_insights': []
    }
}

# Seed platform_data keys from config
with open('$CONFIG_FILE') as f:
    config = json.load(f)
for platform_id, platform_config in config.get('platforms', {}).items():
    if not platform_config.get('enabled', False):
        continue
    result['platform_data'][platform_id] = {
        'name': platform_config['name'],
        'status': 'pending',
        'trending_topics': [],
        'top_keywords': [],
        'competitor_insights': [],
        'content_opportunities': [],
        'collected_at': None
    }

with open('$json_output', 'w') as f:
    json.dump(result, f, indent=2)

print('$json_output')
"

  log_ok "JSON output scaffold: $json_output"
}

# ── Insights File Generation ────────────────────────────────────────────────
# Creates a structured insights JSON file in /workspace/group/insights/
# that serves as the machine-readable input to the content creation pipeline.

generate_insights_file() {
  local source_label="${1:-weekly}"   # e.g. weekly, pm-myproject, on-demand
  local trigger="${2:-self_initiated}" # self_initiated | pm_agent_request | manual
  local insights_dir="/workspace/group/insights"
  local insights_file="${insights_dir}/${DATE}-${source_label}.json"

  mkdir -p "$insights_dir"

  # Resolve platform list for the insights file
  local platforms_list
  if [[ "$PLATFORMS" == "all" ]]; then
    platforms_list=$(get_enabled_platforms)
  else
    platforms_list="$PLATFORMS"
  fi
  # Convert comma-separated to JSON array string
  local platforms_json
  platforms_json=$(python3 -c "
import json
platforms = [p.strip() for p in '$platforms_list'.split(',') if p.strip()]
print(json.dumps(platforms))
")

  python3 -c "
import json
from datetime import datetime, timezone

# NOTE: This generates an insights SCAFFOLD.
# The agent is expected to fill in trending_topics, competitor_insights,
# secondbrain_signals, optimal_posting_times, and content_opportunities
# after completing the browser/search research steps in the markdown report.

insights = {
    'id': '${DATE}-${source_label}',
    'date': '$DATE',
    'source': '${source_label}_research',
    'trigger': '$trigger',
    'platforms_researched': json.loads('$platforms_json'),
    'trending_topics': [],
    'competitor_insights': [],
    'secondbrain_signals': [],
    'optimal_posting_times': {},
    'content_opportunities': [],
    'status': 'pending_agent_collection',
    '_note': 'Agent must fill trending_topics, competitor_insights, secondbrain_signals, optimal_posting_times, and content_opportunities from research. Then set status to pending_drafts and run the content creation pipeline.',
    'research_report': '/workspace/group/research/trends-${YEAR_MONTH}.md',
    'created_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'drafts_created_at': None,
    'notes': ''
}

with open('$insights_file', 'w') as f:
    json.dump(insights, f, indent=2)
    f.write('\n')

print('$insights_file')
"

  log_ok "Insights scaffold created: $insights_file"
  echo "$insights_file"
}

# ── Main ──────────────────────────────────────────────────────────────────────

main() {
  log_step "SNS Research — $DATE"
  log_info "Platforms: $PLATFORMS | Frequency: $FREQUENCY | Categories: $CATEGORIES"
  log_info "Output dir: $OUTPUT_DIR | Format: $FORMAT"

  # Validate config
  if [[ ! -f "$CONFIG_FILE" ]]; then
    log_error "Config not found: $CONFIG_FILE"
    log_info "Hint: copy groups/marketer/config/platforms.json to $CONFIG_FILE"
    exit 1
  fi

  # Prepare directories
  mkdir -p "$OUTPUT_DIR" "$TEMP_DIR"

  # Resolve platforms list
  local platforms_to_research
  if [[ "$PLATFORMS" == "all" ]]; then
    platforms_to_research=$(get_enabled_platforms)
  else
    platforms_to_research="$PLATFORMS"
  fi

  if [[ -z "$platforms_to_research" ]]; then
    log_error "No platforms to research. Check config enabled flags."
    exit 1
  fi

  log_info "Will research platforms: $platforms_to_research"

  # Research each platform
  IFS=',' read -ra platform_list <<< "$platforms_to_research"
  local researched=0
  for platform in "${platform_list[@]}"; do
    platform=$(echo "$platform" | tr -d '[:space:]')

    # Check if platform exists in config
    local exists
    exists=$(python3 -c "
import json
with open('$CONFIG_FILE') as f:
    data = json.load(f)
print('yes' if '$platform' in data.get('platforms', {}) else 'no')
")
    if [[ "$exists" != "yes" ]]; then
      log_warn "Unknown platform '$platform' — skipping"
      continue
    fi

    # Check frequency filter
    if ! should_research_platform "$platform"; then
      log_info "Skipping $platform (frequency filter: $FREQUENCY)"
      continue
    fi

    research_platform "$platform"
    ((researched++))
  done

  if [[ "$researched" -eq 0 ]]; then
    log_warn "No platforms were researched (check frequency filter or enabled status)"
    exit 0
  fi

  # Generate output
  local report_path
  report_path=$(aggregate_research)

  if [[ "$FORMAT" == "json" || "$FORMAT" == "both" ]]; then
    generate_json_output
  fi

  # Generate structured insights scaffold (always — used by content pipeline)
  local insights_path
  insights_path=$(generate_insights_file "$INSIGHTS_SOURCE" "$TRIGGER")

  # Cleanup temp
  rm -rf "$TEMP_DIR"

  log_step "Research plan complete"
  echo ""
  echo "Next steps for agent:"
  echo "  1. Read the research plan at: $report_path"
  echo "  2. Execute each 'PENDING' browser visit and web search"
  echo "  3. Fill in the parsed JSON blocks with actual data"
  echo "  4. Update the Executive Summary and Content Ideas sections"
  echo "  5. Update the insights scaffold at: $insights_path"
  echo "     - Fill trending_topics, competitor_insights, secondbrain_signals"
  echo "     - Fill optimal_posting_times and content_opportunities"
  echo "     - Set status to 'pending_drafts'"
  echo "  6. Run the content creation pipeline:"
  echo "     - For each content_opportunity with urgency 'high' or 'medium': create draft"
  echo "     - For urgency 'low': append to /workspace/group/research/backlog.md"
  echo "     - Update insights file status to 'drafts_created' when done"
  echo "  7. Send Korean Slack approval requests for all new drafts"
  echo ""
}

main "$@"
