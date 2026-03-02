#!/usr/bin/env node
/**
 * Create browser auth sessions for SNS platforms.
 *
 * Uses the system Chrome (not Playwright's Chromium) with a persistent
 * profile so sites don't flag it as an automation browser.
 *
 * Usage:
 *   node scripts/create-auth-session.mjs x
 *   node scripts/create-auth-session.mjs linkedin
 *   node scripts/create-auth-session.mjs threads
 *   node scripts/create-auth-session.mjs reddit
 *   node scripts/create-auth-session.mjs <custom-url> --name <name>
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PLATFORMS = {
  x: {
    url: 'https://x.com',
    done: 'https://x.com/home**',
    invalidUrlParts: ['/login', '/i/flow'],
  },
  linkedin: {
    url: 'https://www.linkedin.com/login',
    done: '**/feed',
  },
  threads: {
    url: 'https://www.threads.com/login',
    invalidUrlParts: ['/login', '/accounts/login', '/accounts'],
    requiredSelectors: ['[role="region"]', '[role="menu"]'],
  },
  reddit: {
    url: 'https://www.reddit.com/login',
    done: '**/reddit.com/*',
  },
};

const AUTH_DIR = path.join(os.homedir(), '.nanoclaw', 'auth');
const PROFILE_DIR = path.join(os.homedir(), '.nanoclaw', '.browser-profile');
const LOGIN_TIMEOUT_MS = 300_000;
const LOGIN_POLL_MS = 2_000;

function containsAny(text, snippets = []) {
  return snippets.some((snippet) => text.includes(snippet));
}

async function waitForLoginCompletion(page, platformConfig = {}) {
  const {
    done: donePattern,
    invalidUrlParts = [],
    requiredSelectors = [],
  } = platformConfig;

  if (requiredSelectors.length > 0) {
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const currentUrl = page.url();
      if (!containsAny(currentUrl, invalidUrlParts)) {
        const hasRequiredUi = await page.evaluate((selectors) => {
          return selectors.every((selector) => Boolean(document.querySelector(selector)));
        }, requiredSelectors);

        if (hasRequiredUi) {
          return true;
        }
      }
      await page.waitForTimeout(LOGIN_POLL_MS);
    }
    return false;
  }

  if (donePattern) {
    await page.waitForURL(donePattern, { timeout: LOGIN_TIMEOUT_MS });
    return !containsAny(page.url(), invalidUrlParts);
  }

  if (invalidUrlParts.length > 0) {
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!containsAny(page.url(), invalidUrlParts)) {
        return true;
      }
      await page.waitForTimeout(LOGIN_POLL_MS);
    }
    return false;
  }

  return false;
}

function usage() {
  console.log(`
Usage: node scripts/create-auth-session.mjs <platform>

Platforms: ${Object.keys(PLATFORMS).join(', ')}

Custom:  node scripts/create-auth-session.mjs https://example.com/login --name mysite

Opens your real Chrome browser. Log in normally, then close the browser.
Session is saved to ~/.nanoclaw/auth/<platform>.json
`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();

  let platform = args[0];
  let loginUrl, sessionName, platformConfig = null;

  if (PLATFORMS[platform]) {
    platformConfig = PLATFORMS[platform];
    loginUrl = platformConfig.url;
    sessionName = platform;
  } else if (platform.startsWith('http')) {
    loginUrl = platform;
    const nameIdx = args.indexOf('--name');
    sessionName = nameIdx !== -1 ? args[nameIdx + 1] : 'custom';
  } else {
    console.error(`Unknown platform: ${platform}`);
    usage();
  }

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const outputPath = path.join(AUTH_DIR, `${sessionName}.json`);

  console.log(`\nOpening ${sessionName} login page...`);
  console.log(`Log in normally with your mouse and keyboard.`);
  console.log(`When you're done, close the browser window.\n`);

  // Use persistent context with system Chrome — looks like a real browser
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: null,           // use full window size
    args: ['--start-maximized'],
    ignoreDefaultArgs: ['--enable-automation'],  // hide automation banner
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto(loginUrl);

  if (platformConfig) {
    if (platformConfig.requiredSelectors?.length > 0) {
      console.log('Waiting for login to complete (detecting Threads home UI)...');
    } else if (platformConfig.done) {
      console.log(`Waiting for login to complete (detecting redirect to ${platformConfig.done})...`);
    } else {
      console.log('Waiting for login to complete...');
    }
    console.log("Or just close the browser when you're logged in.\n");
    try {
      const detected = await waitForLoginCompletion(page, platformConfig);
      if (detected) {
        console.log('Login detected! Saving session...');
      } else {
        console.log('Timeout or browser closed. Saving current state...');
      }
    } catch {
      // User may have closed browser or URL pattern didn't match
      // Try to save whatever state exists
      console.log('Timeout or browser closed. Saving current state...');
    }
  } else {
    console.log('Close the browser window when login is complete.\n');
    // Wait for browser to close
    await new Promise(resolve => context.on('close', resolve));
  }

  try {
    await context.storageState({ path: outputPath });
    console.log(`\nSession saved: ${outputPath}`);
    console.log(`Marketer agent will load this automatically on next run.`);
  } catch {
    console.log('\nBrowser was closed before saving. Run the command again.');
  }

  try { await context.close(); } catch { /* already closed */ }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
