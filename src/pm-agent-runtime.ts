import fs from 'fs';
import os from 'os';
import path from 'path';

import { RegisteredGroup } from './types.js';

export const DEFAULT_PM_AGENT_MODEL = 'claude-opus-4-6';

export interface RepoMountDescriptor {
  repoAlias: string;
  hostPath: string;
}

export interface RepoMountIssue {
  repoAlias: string;
  hostPath: string;
  reason: string;
}

function normalizeRepoAlias(value: string): string | null {
  const normalized = value
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .toLowerCase();
  return normalized || null;
}

function expandHostPath(value: string): string {
  const homeDir = process.env.HOME || os.homedir();
  if (value === '~') return homeDir;
  if (value.startsWith('~/')) return path.join(homeDir, value.slice(2));
  return path.resolve(value);
}

export function isPmAgentGroup(
  group: Pick<RegisteredGroup, 'role' | 'folder'>,
): boolean {
  return group.role === 'pm-agent' || group.folder.startsWith('pm-');
}

export function getPmAllowedRepoAliases(
  group: Pick<RegisteredGroup, 'containerConfig'>,
): string[] {
  const raw = group.containerConfig?.envVars?.ALLOWED_REPOS;
  if (!raw) return [];

  return raw
    .split(',')
    .map((value) => normalizeRepoAlias(value))
    .filter((value, index, arr): value is string => (
      value !== null && arr.indexOf(value) === index
    ));
}

function filterRepoMounts(
  mounts: RepoMountDescriptor[],
  allowedRepoAliases: string[],
): RepoMountDescriptor[] {
  if (allowedRepoAliases.length === 0) return mounts;
  const allowed = new Set(allowedRepoAliases);
  return mounts.filter((mount) => allowed.has(mount.repoAlias));
}

export function getConfiguredPmRepoMounts(
  group: Pick<RegisteredGroup, 'containerConfig'>,
): RepoMountDescriptor[] {
  const mounts = (group.containerConfig?.additionalMounts ?? [])
    .filter((mount) => mount.readonly !== false)
    .map((mount) => {
      const hostPath = expandHostPath(mount.hostPath);
      const repoAlias = normalizeRepoAlias(
        mount.containerPath?.trim() || path.basename(hostPath),
      );
      if (!repoAlias) return null;
      return { repoAlias, hostPath: path.resolve(hostPath) };
    })
    .filter((mount): mount is RepoMountDescriptor => mount !== null);

  return filterRepoMounts(mounts, getPmAllowedRepoAliases(group));
}

export function getRuntimePmRepoMounts(
  group: Pick<RegisteredGroup, 'containerConfig'>,
  mounts: Array<{
    hostPath: string;
    containerPath: string;
    readonly: boolean;
  }>,
): RepoMountDescriptor[] {
  const repoMounts = mounts
    .filter((mount) => mount.readonly)
    .filter((mount) => mount.containerPath.startsWith('/workspace/extra/'))
    .map((mount) => {
      const repoAlias = normalizeRepoAlias(path.posix.basename(mount.containerPath));
      if (!repoAlias) return null;
      return {
        repoAlias,
        hostPath: path.resolve(mount.hostPath),
      };
    })
    .filter((mount): mount is RepoMountDescriptor => mount !== null);

  return filterRepoMounts(repoMounts, getPmAllowedRepoAliases(group));
}

function inspectRepoMount(mount: RepoMountDescriptor): RepoMountIssue | null {
  if (!fs.existsSync(mount.hostPath)) {
    return {
      repoAlias: mount.repoAlias,
      hostPath: mount.hostPath,
      reason: 'path does not exist',
    };
  }

  try {
    if (!fs.statSync(mount.hostPath).isDirectory()) {
      return {
        repoAlias: mount.repoAlias,
        hostPath: mount.hostPath,
        reason: 'path is not a directory',
      };
    }
  } catch (err) {
    return {
      repoAlias: mount.repoAlias,
      hostPath: mount.hostPath,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(mount.hostPath);
  } catch (err) {
    return {
      repoAlias: mount.repoAlias,
      hostPath: mount.hostPath,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (entries.length === 0) {
    return {
      repoAlias: mount.repoAlias,
      hostPath: mount.hostPath,
      reason: 'directory is empty',
    };
  }

  if (!fs.existsSync(path.join(mount.hostPath, '.git'))) {
    return {
      repoAlias: mount.repoAlias,
      hostPath: mount.hostPath,
      reason: '.git marker is missing',
    };
  }

  return null;
}

export function getPmRepoMountIssues(
  mounts: RepoMountDescriptor[],
  allowedRepoAliases: string[],
): RepoMountIssue[] {
  const issues: RepoMountIssue[] = [];

  if (mounts.length === 0) {
    issues.push({
      repoAlias: allowedRepoAliases.join(',') || '(unspecified)',
      hostPath: '',
      reason: 'no code repository mount configured',
    });
    return issues;
  }

  if (allowedRepoAliases.length > 0) {
    const mounted = new Set(mounts.map((mount) => mount.repoAlias));
    for (const repoAlias of allowedRepoAliases) {
      if (!mounted.has(repoAlias)) {
        issues.push({
          repoAlias,
          hostPath: '',
          reason: 'allowed repo alias is not mounted',
        });
      }
    }
  }

  for (const mount of mounts) {
    const issue = inspectRepoMount(mount);
    if (issue) issues.push(issue);
  }

  return issues;
}
