export const NANOCLAW_GITHUB_EVENT_MARKER = '<!-- nanoclaw:github-event -->';

export function appendGithubEventMarker(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return NANOCLAW_GITHUB_EVENT_MARKER;
  if (trimmed.includes(NANOCLAW_GITHUB_EVENT_MARKER)) {
    return trimmed;
  }
  return `${trimmed}\n\n${NANOCLAW_GITHUB_EVENT_MARKER}`;
}

export function hasGithubEventMarker(body: unknown): boolean {
  return typeof body === 'string' && body.includes(NANOCLAW_GITHUB_EVENT_MARKER);
}
