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
  x:        { url: 'https://x.com/login',               done: '**/home'         },
  linkedin: { url: 'https://www.linkedin.com/login',     done: '**/feed'         },
  threads:  { url: 'https://www.threads.net/login',      done: '**threads.net/*' },
  reddit:   { url: 'https://www.reddit.com/login',       done: '**/reddit.com/*' },
};

const AUTH_DIR = path.join(os.homedir(), '.nanoclaw', 'auth');
const PROFILE_DIR = path.join(os.homedir(), '.nanoclaw', '.browser-profile');

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
  let loginUrl, donePattern, sessionName;

  if (PLATFORMS[platform]) {
    loginUrl = PLATFORMS[platform].url;
    donePattern = PLATFORMS[platform].done;
    sessionName = platform;
  } else if (platform.startsWith('http')) {
    loginUrl = platform;
    const nameIdx = args.indexOf('--name');
    sessionName = nameIdx !== -1 ? args[nameIdx + 1] : 'custom';
    donePattern = null;
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

  if (donePattern) {
    console.log(`Waiting for login to complete (detecting redirect to ${donePattern})...`);
    console.log(`Or just close the browser when you're logged in.\n`);
    try {
      await page.waitForURL(donePattern, { timeout: 300_000 }); // 5 min
      console.log('Login detected! Saving session...');
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
