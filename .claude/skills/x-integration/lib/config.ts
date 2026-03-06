/**
 * X Integration - Configuration
 *
 * All environment-specific settings in one place.
 * Override via environment variables or modify defaults here.
 */

import os from 'os';
import path from 'path';
const HOME_DIR = process.env.HOME || os.homedir();

function expandHomePath(value: string): string {
  if (value === '~') return HOME_DIR;
  if (value.startsWith('~/')) return path.join(HOME_DIR, value.slice(2));
  return path.resolve(value);
}

const DEFAULT_AUTH_ROOT = path.join(HOME_DIR, '.nanoclaw');
const browserProfileDir = expandHomePath(
  process.env.X_BROWSER_PROFILE_DIR || path.join(DEFAULT_AUTH_ROOT, 'auth-profiles', 'x'),
);
const authMarkerPath = expandHomePath(
  process.env.X_AUTH_MARKER_PATH || path.join(DEFAULT_AUTH_ROOT, 'auth', 'x-auth.json'),
);

/**
 * Configuration object with all settings
 */
export const config = {
  // Chrome executable path
  // Default: standard macOS Chrome location
  // Override: CHROME_PATH environment variable
  chromePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',

  // Browser profile directory for persistent login sessions
  browserDataDir: browserProfileDir,

  // Auth state marker file
  authPath: authMarkerPath,

  // Browser viewport settings
  viewport: {
    width: 1280,
    height: 800,
  },

  // Timeouts (in milliseconds)
  timeouts: {
    navigation: 30000,
    elementWait: 5000,
    afterClick: 1000,
    afterFill: 1000,
    afterSubmit: 3000,
    pageLoad: 3000,
  },

  // X character limits
  limits: {
    tweetMaxLength: 280,
  },

  // Chrome launch arguments
  chromeArgs: [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
  ],

  // Args to ignore when launching Chrome
  chromeIgnoreDefaultArgs: ['--enable-automation'],
};
