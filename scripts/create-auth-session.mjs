#!/usr/bin/env node
/**
 * Create and verify browser auth sessions for SNS platforms.
 *
 * Canonical workflow:
 * 1. Human signs in with real host Chrome using a dedicated per-platform profile.
 * 2. This script exports a container-friendly Playwright storageState JSON.
 * 3. Container agents consume only ~/.nanoclaw/auth/*.json.
 *
 * This avoids mixing host-native Chrome profiles with Linux container browsers.
 *
 * Usage:
 *   node scripts/create-auth-session.mjs x
 *   node scripts/create-auth-session.mjs linkedin
 *   node scripts/create-auth-session.mjs threads
 *   node scripts/create-auth-session.mjs reddit
 *   node scripts/create-auth-session.mjs check x
 *   node scripts/create-auth-session.mjs check all
 *   node scripts/create-auth-session.mjs open x
 *   node scripts/create-auth-session.mjs sync x
 */
import { chromium } from 'playwright';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';

const HOME_DIR = os.homedir();
const AUTH_DIR = path.join(HOME_DIR, '.nanoclaw', 'auth');
const PROFILE_ROOT = path.join(HOME_DIR, '.nanoclaw', 'auth-profiles');
const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LOGIN_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 2_000;
const activeChromeChildren = new Set();
let cleanupRegistered = false;

const PLATFORMS = {
  x: {
    loginUrl: 'https://x.com/i/flow/login',
    verifyUrl: 'https://x.com/home',
    stateFile: 'x.json',
    profileDirs: ['x'],
    invalidUrlParts: ['/login', '/i/flow'],
    loginTextSnippets: ['Sign in to X', "Don't have an account? Sign up"],
    requiredCookies: ['auth_token'],
  },
  linkedin: {
    loginUrl: 'https://www.linkedin.com/login',
    verifyUrl: 'https://www.linkedin.com/in/me/',
    stateFile: 'linkedin.json',
    profileDirs: ['linkedin'],
    invalidUrlParts: ['/login', '/checkpoint', '/authwall'],
    loginTextSnippets: ['이미 LinkedIn 회원이세요? 로그인', 'Sign in', '회원가입 | LinkedIn'],
    requiredCookies: ['li_at'],
  },
  threads: {
    loginUrl: 'https://www.threads.net/login',
    verifyUrl: 'https://www.threads.net/',
    stateFile: 'threads.json',
    profileDirs: ['threads', 'threads-import'],
    invalidUrlParts: ['/login', '/accounts/login', '/accounts'],
    loginTextSnippets: [
      'Log in or sign up for Threads',
      'Continue with Instagram',
      'Log in with username instead',
      'Log in with your Instagram account',
    ],
    requiredCookies: ['sessionid'],
  },
  reddit: {
    loginUrl: 'https://www.reddit.com/login',
    verifyUrl: 'https://www.reddit.com/',
    stateFile: 'reddit.json',
    profileDirs: ['reddit'],
    invalidUrlParts: ['/login'],
    loginTextSnippets: ['Log In', 'Continue with Google', 'By continuing, you agree'],
    requiredCookies: ['reddit_session'],
  },
};

function usage() {
  console.log(`
Usage:
  node scripts/create-auth-session.mjs <platform>
  node scripts/create-auth-session.mjs open <platform>
  node scripts/create-auth-session.mjs sync <platform>
  node scripts/create-auth-session.mjs check <platform|all>

Platforms: ${Object.keys(PLATFORMS).join(', ')}

Examples:
  node scripts/create-auth-session.mjs x
  node scripts/create-auth-session.mjs check all
  node scripts/create-auth-session.mjs sync linkedin
`);
  process.exit(1);
}

function ensureChromeInstalled() {
  if (!fs.existsSync(CHROME_BIN)) {
    throw new Error(`Google Chrome not found at ${CHROME_BIN}`);
  }
}

function ensureDirs() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.mkdirSync(PROFILE_ROOT, { recursive: true });
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function registerCleanupHandlers() {
  if (cleanupRegistered) {
    return;
  }
  cleanupRegistered = true;

  const cleanup = () => {
    for (const child of activeChromeChildren) {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
  process.on('exit', cleanup);
}

function profileDirFor(platformKey, createIfMissing = true) {
  const config = PLATFORMS[platformKey];
  if (!config) {
    throw new Error(`Unknown platform: ${platformKey}`);
  }

  const candidates = config.profileDirs.map((dir) => path.join(PROFILE_ROOT, dir));
  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  const selected = existing ?? candidates[0];

  if (createIfMissing) {
    fs.mkdirSync(selected, { recursive: true });
  }

  return selected;
}

function statePathFor(platformKey) {
  return path.join(AUTH_DIR, PLATFORMS[platformKey].stateFile);
}

function backupFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const backupPath = `${filePath}.bak-${timestamp()}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function getProfileLockInfo(profileDir) {
  const lockPath = path.join(profileDir, 'SingletonLock');
  const stat = fs.lstatSync(lockPath, { throwIfNoEntry: false });
  if (!stat) {
    return null;
  }

  try {
    if (!stat.isSymbolicLink()) {
      return null;
    }
    const target = fs.readlinkSync(lockPath);
    const pidMatch = target.match(/-(\d+)$/);
    const pid = pidMatch ? Number(pidMatch[1]) : null;
    return {
      lockPath,
      target,
      pid,
      alive: pid ? isPidAlive(pid) : false,
    };
  } catch {
    return null;
  }
}

function clearStaleProfileLocks(profileDir) {
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile', 'LOCK']) {
    const filePath = path.join(profileDir, name);
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // ignore
    }
  }
}

function ensureProfileAvailable(profileDir) {
  const lockInfo = getProfileLockInfo(profileDir);
  if (!lockInfo) {
    return;
  }

  if (lockInfo.alive) {
    throw new Error(
      `Chrome profile is already open: ${profileDir} (pid ${lockInfo.pid}). Close that Chrome window first.`,
    );
  }

  clearStaleProfileLocks(profileDir);
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate a debug port'));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function connectOverCdp(port, timeoutMs = 20_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await sleep(300);
    }
  }
  throw new Error(`Timed out connecting to Chrome CDP on port ${port}`);
}

function spawnChrome(userDataDir, port, url) {
  registerCleanupHandlers();
  ensureProfileAvailable(userDataDir);

  const child = spawn(
    CHROME_BIN,
    [
      `--user-data-dir=${userDataDir}`,
      '--profile-directory=Default',
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--new-window',
      url,
    ],
    { stdio: 'ignore' },
  );
  activeChromeChildren.add(child);
  child.once('exit', () => {
    activeChromeChildren.delete(child);
  });
  return child;
}

function cloneProfileToTemp(profileDir) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-auth-profile-'));
  execFileSync(
    'rsync',
    [
      '-a',
      '--delete',
      '--exclude', 'Singleton*',
      '--exclude', 'LOCK',
      '--exclude', 'lockfile',
      '--exclude', '*.tmp',
      `${profileDir}/`,
      `${tempDir}/`,
    ],
    { stdio: 'ignore' },
  );
  return tempDir;
}

async function detectStatus(platformKey, page) {
  const config = PLATFORMS[platformKey];
  const cookies = await page.context().cookies();
  const cookieNames = new Set(cookies.map((cookie) => cookie.name));
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const normalizedBody = bodyText.replace(/\s+/g, ' ').trim();
  const url = page.url();

  const hasRequiredCookies = config.requiredCookies.every((name) => cookieNames.has(name));
  const urlLooksLoggedOut = config.invalidUrlParts.some((part) => url.includes(part));
  const bodyLooksLoggedOut = config.loginTextSnippets.some((snippet) => normalizedBody.includes(snippet));

  let account = null;

  if (platformKey === 'x') {
    const profileLink = page.locator('a[data-testid="AppTabBar_Profile_Link"]');
    const switcher = page.locator('button[data-testid="SideNav_AccountSwitcher_Button"]');
    if (await profileLink.count()) {
      const href = await profileLink.first().getAttribute('href');
      if (href && href.startsWith('/')) {
        account = href.slice(1);
      }
    }
    if (!account && await switcher.count()) {
      const switcherText = (await switcher.first().innerText().catch(() => '')).trim();
      const handle = switcherText.match(/@([A-Za-z0-9_]{1,15})/);
      if (handle) {
        account = handle[1];
      }
    }
  } else if (platformKey === 'linkedin') {
    const slugMatch = url.match(/linkedin\.com\/in\/([^/?#]+)/);
    if (slugMatch) {
      account = slugMatch[1];
    }
  } else if (platformKey === 'threads') {
    const handle = normalizedBody.match(/@([A-Za-z0-9._]+)/);
    if (handle) {
      account = handle[1];
    }
  } else if (platformKey === 'reddit') {
    const handle = normalizedBody.match(/u\/([A-Za-z0-9_-]+)/);
    if (handle) {
      account = handle[1];
    }
  }

  return {
    loggedIn: hasRequiredCookies && !urlLooksLoggedOut && !bodyLooksLoggedOut,
    url,
    title: await page.title().catch(() => ''),
    account,
    requiredCookies: config.requiredCookies.filter((name) => cookieNames.has(name)),
  };
}

async function saveState(context, outputPath) {
  const tempPath = `${outputPath}.tmp`;
  await context.storageState({ path: tempPath, indexedDB: true });
  backupFileIfExists(outputPath);
  fs.renameSync(tempPath, outputPath);
}

async function waitForLogin(platformKey, page) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await detectStatus(platformKey, page);
    if (status.loggedIn) {
      return status;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return detectStatus(platformKey, page);
}

async function runInteractiveLogin(platformKey) {
  ensureChromeInstalled();
  ensureDirs();

  const profileDir = profileDirFor(platformKey);
  const outputPath = statePathFor(platformKey);
  const config = PLATFORMS[platformKey];
  const port = await getFreePort();
  const chrome = spawnChrome(profileDir, port, config.loginUrl);

  let browser;
  try {
    browser = await connectOverCdp(port);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? await context.newPage();

    console.log(`\nOpened ${platformKey} in real Chrome.`);
    console.log(`Profile: ${profileDir}`);
    console.log(`State file: ${outputPath}`);
    console.log('Log in normally. The script will save state as soon as login is detected.\n');

    const status = await waitForLogin(platformKey, page);
    if (!status.loggedIn) {
      throw new Error(`Login was not detected for ${platformKey}. Final URL: ${status.url}`);
    }

    await saveState(context, outputPath);

    console.log(`Saved: ${outputPath}`);
    console.log(`URL: ${status.url}`);
    console.log(`Title: ${status.title}`);
    console.log(`Account: ${status.account ?? 'unknown'}`);
    console.log(`Cookies: ${status.requiredCookies.join(', ')}`);
  } finally {
    try {
      await browser?.close();
    } catch {
      // ignore
    }
    try {
      chrome.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
}

async function syncFromProfile(platformKey) {
  ensureChromeInstalled();
  ensureDirs();

  const sourceProfile = profileDirFor(platformKey, false);
  if (!fs.existsSync(sourceProfile)) {
    throw new Error(`Profile does not exist: ${sourceProfile}`);
  }

  const copiedProfile = cloneProfileToTemp(sourceProfile);
  const outputPath = statePathFor(platformKey);
  const config = PLATFORMS[platformKey];
  const port = await getFreePort();
  const chrome = spawnChrome(copiedProfile, port, config.verifyUrl);

  let browser;
  try {
    browser = await connectOverCdp(port);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(config.verifyUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(8_000);

    const status = await detectStatus(platformKey, page);
    if (!status.loggedIn) {
      throw new Error(`Profile is not logged in for ${platformKey}. Final URL: ${status.url}`);
    }

    await saveState(context, outputPath);

    console.log(`Saved: ${outputPath}`);
    console.log(`Profile: ${sourceProfile}`);
    console.log(`URL: ${status.url}`);
    console.log(`Title: ${status.title}`);
    console.log(`Account: ${status.account ?? 'unknown'}`);
    console.log(`Cookies: ${status.requiredCookies.join(', ')}`);
  } finally {
    try {
      await browser?.close();
    } catch {
      // ignore
    }
    try {
      chrome.kill('SIGTERM');
    } catch {
      // ignore
    }
    fs.rmSync(copiedProfile, { recursive: true, force: true });
  }
}

async function checkState(platformKey) {
  const outputPath = statePathFor(platformKey);
  if (!fs.existsSync(outputPath)) {
    return {
      platform: platformKey,
      statePath: outputPath,
      exists: false,
      loggedIn: false,
      account: null,
      url: null,
      title: null,
      requiredCookies: [],
    };
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: outputPath });
    const page = await context.newPage();
    const config = PLATFORMS[platformKey];
    await page.goto(config.verifyUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(5_000);

    const status = await detectStatus(platformKey, page);
    await context.close();

    return {
      platform: platformKey,
      statePath: outputPath,
      exists: true,
      ...status,
    };
  } finally {
    await browser.close();
  }
}

function openProfile(platformKey) {
  ensureChromeInstalled();
  ensureDirs();

  const profileDir = profileDirFor(platformKey);
  ensureProfileAvailable(profileDir);
  const config = PLATFORMS[platformKey];
  const chrome = spawn(
    'open',
    [
      '-na',
      'Google Chrome',
      '--args',
      `--user-data-dir=${profileDir}`,
      '--profile-directory=Default',
      '--new-window',
      config.loginUrl,
    ],
    { detached: true, stdio: 'ignore' },
  );
  chrome.unref();

  console.log(`Opened ${platformKey} login in Chrome.`);
  console.log(`Profile: ${profileDir}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    usage();
  }

  let command = 'login';
  let target = args[0];

  if (['check', 'open', 'sync'].includes(args[0])) {
    command = args[0];
    target = args[1];
  }

  if (!target) {
    usage();
  }

  if (command === 'check' && target === 'all') {
    const results = [];
    for (const platformKey of Object.keys(PLATFORMS)) {
      results.push(await checkState(platformKey));
    }
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (!PLATFORMS[target]) {
    usage();
  }

  if (command === 'check') {
    console.log(JSON.stringify(await checkState(target), null, 2));
    return;
  }

  if (command === 'open') {
    openProfile(target);
    return;
  }

  if (command === 'sync') {
    await syncFromProfile(target);
    return;
  }

  await runInteractiveLogin(target);
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
