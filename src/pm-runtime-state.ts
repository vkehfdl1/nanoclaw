import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';

export function getSeenIssuesPath(groupFolder: string): string {
  return path.join(GROUPS_DIR, groupFolder, 'seen_issues.json');
}

export function readSeenIssueNumbers(groupFolder: string): number[] {
  const filePath = getSeenIssuesPath(groupFolder);
  if (!fs.existsSync(filePath)) return [];

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export function writeSeenIssueNumbers(
  groupFolder: string,
  issueNumbers: number[],
): void {
  const filePath = getSeenIssuesPath(groupFolder);
  const normalized = [...new Set(
    issueNumbers
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0),
  )].sort((a, b) => a - b);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2) + '\n');
}

export function markSeenIssueNumber(
  groupFolder: string,
  issueNumber: number,
): void {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return;
  const current = readSeenIssueNumbers(groupFolder);
  if (current.includes(issueNumber)) return;
  current.push(issueNumber);
  writeSeenIssueNumbers(groupFolder, current);
}
