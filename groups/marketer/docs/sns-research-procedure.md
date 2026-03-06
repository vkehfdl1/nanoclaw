# SNS Research Procedure

Operational procedure for 홍명보's daily trend check and on-demand research.

## Use This For

- the daily recurring trend check
- explicit user requests for deeper topic research

There is no recurring weekly research job and no recurring monthly brand review job.

## Inputs

Read these first:
- `/workspace/group/brand/profile.md`
- `/workspace/group/config/platforms.json`

Use them to decide:
- which categories matter now
- which platforms are enabled
- which seed keywords and hashtags to search

## Research Loop

### 1. Pick the day's search set

For the daily sweep:
- choose up to 2 categories from `research_categories`
- take the first 3 `seed_keywords` from each chosen category
- use those keywords as the day's search set

### 2. Start with platform evidence

Always check X Explore first:

```bash
agent-browser open https://x.com/explore/tabs/trending
agent-browser snapshot -i
```

Only keep trends that plausibly connect to the current brand profile.

Auth rules before doing login-required SNS work:
- Use only `/workspace/extra/auth/*.json` as the canonical auth input inside the container.
- Do not use `/workspace/extra/auth-profiles/` as an auth source from inside the container. Those host profiles are only for human re-auth on the host.
- Treat `/workspace/extra/auth/x-auth.json` as a hint only, not definitive login state.
- Validate login against the live site UI plus canonical auth cookies. Useful evidence includes `auth_token` for X, `li_at` for LinkedIn, and `sessionid` for Threads.
- If auth is invalid, ask the user to refresh it from the host with `npm run auth:session -- <platform>`.

### 3. Run targeted web search

For each selected seed keyword, run these patterns:

```text
"{seed_keyword} trending YYYY-MM"
"site:x.com {seed_keyword} YYYY-MM-DD"
"site:linkedin.com/posts {seed_keyword} YYYY"
"site:threads.net {seed_keyword}"
```

Use web search to confirm:
- the topic is active now
- the topic is being discussed on relevant platforms
- the topic is close enough to the user's real work or brand
- a truthful and useful angle exists within 24-72 hours

### 4. Deepen only when needed

Open LinkedIn or Threads with `agent-browser` only when web search shows clear relevance:

```bash
agent-browser open https://www.linkedin.com/feed/trending-articles/
agent-browser snapshot -i

agent-browser open https://www.threads.net/search
agent-browser snapshot -i
```

Use this only to confirm or refine a candidate trend, not as a default step for every keyword.

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
- topics that cannot support a truthful, informative angle

## Outputs

For every kept trend, capture:
- topic
- search queries used
- evidence source
- why it matters now
- suggested angle

Write outputs to local working files:
- `/workspace/group/research/trends-YYYY-MM.md`
- `/workspace/group/insights/YYYY-MM-DD-daily.json` or a topic-specific JSON file for on-demand research

Then send a Korean Slack summary with `mcp__nanoclaw__send_message`.

## Memory Boundary

- Local working notes, research snapshots, and operating logs stay under `/workspace/group/`.
- Durable shared marketer context goes to `/workspace/secondbrain/`.
- Write to SecondBrain only when the result is worth team-wide recall, such as reusable research findings, final published posts, campaign progress, or durable brand learnings.
- Do not write routine daily sweep noise, approval chatter, or temporary working notes to SecondBrain.

## Troubleshooting

### Config missing

```bash
ls -la /workspace/group/config/
```

### agent-browser unavailable

Fall back to web search only and note that browser confirmation was skipped.

### SecondBrain not mounted

Continue with local files and Slack summary only.
