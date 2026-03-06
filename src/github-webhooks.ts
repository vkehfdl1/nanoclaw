import http, { IncomingMessage, Server, ServerResponse } from 'http';

import {
  createGithubWebhookDelivery,
  getGithubWebhookDelivery,
  updateGithubWebhookDelivery,
} from './db.js';
import { enqueueGithubEvent, GithubEventRunnerDeps } from './github-event-runner.js';
import { normalizeGithubEvent } from './github-events.js';
import { getGithubWebhookConfig, verifyGithubWebhookSignature } from './github-app.js';
import { logger } from './logger.js';

const MAX_WEBHOOK_BODY_BYTES = 2 * 1024 * 1024;

function writeJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(payload));
  res.end(payload);
}

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_WEBHOOK_BODY_BYTES) {
        reject(new Error('Webhook payload too large'));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: GithubEventRunnerDeps,
): Promise<void> {
  const config = getGithubWebhookConfig();
  if (!config.enabled || !config.webhookSecret) {
    writeJson(res, 503, { ok: false, error: 'GitHub webhook server is disabled' });
    return;
  }

  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: 'Method not allowed' });
    return;
  }

  const eventName = req.headers['x-github-event'];
  const deliveryId = req.headers['x-github-delivery'];
  const signature = req.headers['x-hub-signature-256'];
  if (typeof eventName !== 'string' || typeof deliveryId !== 'string') {
    writeJson(res, 400, { ok: false, error: 'Missing GitHub webhook headers' });
    return;
  }

  const rawBody = await readRequestBody(req);
  if (!verifyGithubWebhookSignature(rawBody, typeof signature === 'string' ? signature : undefined, config.webhookSecret)) {
    writeJson(res, 401, { ok: false, error: 'Invalid GitHub webhook signature' });
    return;
  }

  if (getGithubWebhookDelivery(deliveryId)) {
    writeJson(res, 202, { ok: true, duplicate: true });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf-8'));
  } catch (err) {
    writeJson(res, 400, {
      ok: false,
      error: `Invalid JSON payload: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  createGithubWebhookDelivery({
    delivery_id: deliveryId,
    event_name: eventName,
    action:
      payload && typeof payload === 'object' && payload !== null && typeof (payload as { action?: unknown }).action === 'string'
        ? (payload as { action: string }).action
        : null,
    repository_full_name:
      payload && typeof payload === 'object' && payload !== null &&
        typeof (payload as { repository?: { full_name?: unknown } }).repository?.full_name === 'string'
        ? (payload as { repository: { full_name: string } }).repository.full_name
        : null,
    installation_id:
      payload && typeof payload === 'object' && payload !== null &&
        Number.isInteger((payload as { installation?: { id?: unknown } }).installation?.id)
        ? Number((payload as { installation: { id: number } }).installation.id)
        : null,
    resource_key: null,
    received_at: new Date().toISOString(),
    status: 'received',
    error: null,
    payload_json: JSON.stringify(payload),
  });

  const normalized = normalizeGithubEvent(eventName, payload, deliveryId);
  if (!normalized.event) {
    updateGithubWebhookDelivery(deliveryId, {
      status: 'ignored',
      error: normalized.ignoreReason || null,
    });
    writeJson(res, 202, {
      ok: true,
      ignored: true,
      reason: normalized.ignoreReason || 'ignored',
    });
    return;
  }

  enqueueGithubEvent(normalized.event, deps);
  writeJson(res, 202, { ok: true });
}

export function startGithubWebhookServer(
  deps: GithubEventRunnerDeps,
): Server | null {
  const config = getGithubWebhookConfig();
  if (!config.enabled) {
    logger.info('GitHub webhook server disabled: GITHUB_APP_WEBHOOK_SECRET is not configured');
    return null;
  }

  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    if (url !== config.path) {
      writeJson(res, 404, { ok: false, error: 'Not found' });
      return;
    }

    handleWebhookRequest(req, res, deps).catch((err) => {
      logger.error({ err }, 'Unhandled GitHub webhook request error');
      writeJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  server.listen(config.port, config.host, () => {
    logger.info(
      {
        host: config.host,
        port: config.port,
        path: config.path,
      },
      'GitHub webhook server listening',
    );
  });

  return server;
}

export function stopGithubWebhookServer(server: Server | null): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}
