import crypto from 'crypto';

import { describe, expect, it } from 'vitest';

import { verifyGithubWebhookSignature } from './github-app.js';

describe('verifyGithubWebhookSignature', () => {
  it('accepts a valid sha256 signature', () => {
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    const secret = 'top-secret';
    const digest = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');

    expect(
      verifyGithubWebhookSignature(body, `sha256=${digest}`, secret),
    ).toBe(true);
  });

  it('rejects an invalid signature', () => {
    const body = Buffer.from('payload');

    expect(
      verifyGithubWebhookSignature(body, 'sha256=deadbeef', 'top-secret'),
    ).toBe(false);
  });

  it('rejects missing headers or wrong scheme', () => {
    const body = Buffer.from('payload');

    expect(verifyGithubWebhookSignature(body, undefined, 'top-secret')).toBe(false);
    expect(verifyGithubWebhookSignature(body, 'sha1=abc', 'top-secret')).toBe(false);
  });
});
