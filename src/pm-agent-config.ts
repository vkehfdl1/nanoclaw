import path from 'path';

import { RegisteredGroup } from './types.js';

export const DEFAULT_PM_EXCLUDE_PATTERNS = [
  'node_modules',
  '.venv',
  'dist',
  '.git/objects',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
];

function normalizeAlias(value: string): string {
  return value
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/\/{2,}/g, '/');
}

export function deriveRepoAlias(repoFullName: string): string {
  const repoName = repoFullName.split('/').pop() || repoFullName;
  return normalizeAlias(repoName).toLowerCase();
}

export function getAllowedRepoAliases(group: RegisteredGroup): string[] {
  const raw = group.containerConfig?.envVars?.ALLOWED_REPOS;
  if (!raw) return [];

  return raw
    .split(',')
    .map((value) => normalizeAlias(value).toLowerCase())
    .filter((value, index, arr) => value.length > 0 && arr.indexOf(value) === index);
}

export function getMountedRepoAliases(group: RegisteredGroup): string[] {
  return (group.containerConfig?.additionalMounts ?? [])
    .map((mount) => mount.containerPath || path.basename(mount.hostPath))
    .map((value) => normalizeAlias(value).toLowerCase())
    .filter((value, index, arr) => value.length > 0 && arr.indexOf(value) === index);
}

export function resolvePrimaryRepoAlias(
  group: RegisteredGroup,
  repoFullName: string,
): string {
  const derived = deriveRepoAlias(repoFullName);
  const allowed = getAllowedRepoAliases(group);
  if (allowed.includes(derived)) return derived;
  if (allowed.length === 1) return allowed[0];

  const mounted = getMountedRepoAliases(group);
  if (mounted.includes(derived)) return derived;
  if (mounted.length === 1) return mounted[0];

  return derived;
}
