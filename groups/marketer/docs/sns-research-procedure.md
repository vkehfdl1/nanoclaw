# SNS Research Procedure

This document defines how 홍명보 performs daily SNS trend research and deeper on-demand research.

## Overview

Use this procedure for two situations:
- the daily recurring trend check
- an explicit user request to research a topic more deeply

There is no recurring weekly research job and no recurring monthly brand review job.

## Outputs

Daily and on-demand research may produce:
1. Local research notes at `/workspace/group/research/trends-YYYY-MM.md`
2. Local structured snapshots at `/workspace/group/insights/YYYY-MM-DD-*.json`
3. A Korean Slack summary sent with `mcp__nanoclaw__send_message`
4. Optional `marketer-insight` writes to SecondBrain only when the result is notable enough to preserve

Operational logs such as `/workspace/group/published/log.md` and `/workspace/group/published/comments-log.md` stay local to the marketer group. They are not stored in SecondBrain.

## Source Files

Read these first:
- `/workspace/group/brand/profile.md`
- `/workspace/group/config/platforms.json`

Use the brand profile to decide which categories matter now. Use `platforms.json` for:
- enabled platforms
- research URLs
- seed keywords
- related hashtags
- platform constraints

## Daily Trend Selection

For the daily sweep:
1. Select up to 2 categories from `research_categories` that best fit the brand profile.
2. Take the first 3 `seed_keywords` from each selected category.
3. Treat those keywords as the day\'s search set.

## Collection Workflow

### 1. Browser-first platform check

Always start with X Explore:

```bash
agent-browser open https://x.com/explore/tabs/trending
agent-browser snapshot -i
```

Collect only trends that are plausibly relevant to AI, software, productivity, startup building, or the current brand profile.

### 2. Targeted web search

For each selected seed keyword, run these search patterns:

```text
"{seed_keyword} trending YYYY-MM"
"site:x.com {seed_keyword} YYYY-MM-DD"
"site:linkedin.com/posts {seed_keyword} YYYY"
"site:threads.net {seed_keyword}"
```

Use web search to answer four questions:
- Is this topic active right now?
- Is there evidence that people on X, LinkedIn, or Threads are discussing it?
- Is the topic close enough to the user\'s real projects or brand?
- Can we say something truthful and useful about it within 24-72 hours?

### 3. Optional platform deepening

Only open LinkedIn or Threads with `agent-browser` if the web-search results show clear relevance:

```bash
agent-browser open https://www.linkedin.com/feed/trending-articles/
agent-browser snapshot -i

agent-browser open https://www.threads.net/search
agent-browser snapshot -i
```

Use deeper browser checks to confirm that the topic is not a one-off false positive.

## Ranking Rules

Score each candidate 1-5 on:
- recency
- relevance to the current brand profile
- evidence strength
- draftability within 72 hours

Keep at most 3 opportunities per daily sweep.

Reject:
- celebrity gossip
- generic politics with no direct brand relevance
- vague hype without supporting examples
- topics that cannot be tied to a truthful, informative angle

## Output Rules

For every kept trend, capture:
- topic
- search queries used
- where the evidence came from
- why it matters now
- what angle would make it useful to the audience

Write the results to:
- `/workspace/group/research/trends-YYYY-MM.md`
- `/workspace/group/insights/YYYY-MM-DD-daily.json` or a topic-specific JSON file for on-demand research

## Slack Summary Rules

Whenever research completes, send a Korean Slack summary.

Recommended format:

```text
[일일 트렌드 점검]
- 후보 1: {topic} / 근거: {evidence} / 각도: {angle}
- 후보 2: ...
- 후보 3: ...

원하면 이 중 하나를 바로 게시물 초안으로 확장하겠습니다.
```

Do not publish anything directly from the research step.

## Approval Rules

All posts, comments, and replies require human approval in Slack before posting.

If research leads to a draftable idea:
1. prepare the draft
2. send the draft in Korean for approval
3. wait for explicit approval in Slack
4. only then publish

Silence is not approval.

## SecondBrain Rules

SecondBrain is optional.

Read from `/workspace/secondbrain/` when it helps confirm real project signals.
Write to SecondBrain only when the research result is notable enough to preserve as a `marketer-insight`.
Do not use SecondBrain for:
- routine daily sweep logs
- approval messages
- local publish logs
- local comment logs

## Troubleshooting

### Config not found

```bash
ls -la /workspace/group/config/
```

### agent-browser not available

Fall back to web search only and note that browser confirmation was skipped.

### SecondBrain not mounted

Continue with local files and Slack summary only.
