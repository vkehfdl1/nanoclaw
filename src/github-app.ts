import crypto from 'crypto';

import {
  GITHUB_WEBHOOK_HOST,
  GITHUB_WEBHOOK_PATH,
  GITHUB_WEBHOOK_PORT,
} from './config.js';
import { readEnvFile } from './env.js';

export interface GithubWebhookConfig {
  host: string;
  port: number;
  path: string;
  appId: string | null;
  webhookSecret: string | null;
  privateKeyPath: string | null;
  enabled: boolean;
}

export function getGithubWebhookConfig(): GithubWebhookConfig {
  const env = readEnvFile([
    'GITHUB_APP_ID',
    'GITHUB_APP_WEBHOOK_SECRET',
    'GITHUB_APP_PRIVATE_KEY_PATH',
  ]);

  const appId = process.env.GITHUB_APP_ID || env.GITHUB_APP_ID || null;
  const webhookSecret =
    process.env.GITHUB_APP_WEBHOOK_SECRET ||
    env.GITHUB_APP_WEBHOOK_SECRET ||
    null;
  const privateKeyPath =
    process.env.GITHUB_APP_PRIVATE_KEY_PATH ||
    env.GITHUB_APP_PRIVATE_KEY_PATH ||
    null;

  return {
    host: GITHUB_WEBHOOK_HOST,
    port: GITHUB_WEBHOOK_PORT,
    path: GITHUB_WEBHOOK_PATH,
    appId,
    webhookSecret,
    privateKeyPath,
    enabled: !!webhookSecret,
  };
}

export function verifyGithubWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const [scheme, signature] = signatureHeader.split('=');
  if (scheme !== 'sha256' || !signature) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(signature, 'hex');
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}
