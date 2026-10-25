import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeExecutorHandler } from '../src/runtime.js';
import {
  assertCallbackUrlAllowed,
  createHandlersFromExecutorConfig,
  createWebhookReplayGuard,
  DEFAULT_CALLBACK_MAX_ATTEMPTS,
  DEFAULT_CALLBACK_RETRY_BASE_DELAY_MS,
  InMemoryExecutorJobStore,
  loadExecutorConfig,
  parseCallbackHostAllowlist,
  signWebhookBody,
  startExecutorServer,
  verifyWebhookSignature,
  WEBHOOK_NONCE_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  type ExecutorJob,
} from '../src/server.js';

const executorToken = 'executor-token';
const callbackToken = 'callback-token';
const effect = {
  type: 'HookReady',
  eventId: 'event-1',
  zhixuId: 'zhixu-1',
  orderId: 'order-1',
  hookId: 'exec.main#START',
  stageIdentifier: 'exec.main',
  hookName: 'START',
} as const;

describe('executor HTTP server', () => {
  it('verifies timestamped nonce-bound webhook HMACs and rejects replays of captured requests', () => {
    const body = '{"signal":{"orderId":"order-1"}}';
    const nowMs = () => 1_800_000_000_000;
    const fields = { timestamp: '1800000000', nonce: 'a'.repeat(32) };
    const signature = signWebhookBody(callbackToken, body, fields);
    const verify = (overrides: Partial<Parameters<typeof verifyWebhookSignature>[3]> = {}) =>
      verifyWebhookSignature(body, signature, callbackToken, { ...fields, nowMs, ...overrides });

    expect(verify()).toBe(true);
    expect(verify({ nonce: 'b'.repeat(32) })).toBe(false);
    expect(verify({ timestamp: '1799000000' })).toBe(false);
    expect(verifyWebhookSignature(body, signature, callbackToken)).toBe(false);
    expect(verify({ nowMs: () => 1_800_000_000_000 + 5 * 60_000 + 1 })).toBe(false);
    expect(verifyWebhookSignature(body, signWebhookBody(callbackToken, body, fields).replace(/.$/, '0'), callbackToken, { ...fields, nowMs })).toBe(false);
    expect(verifyWebhookSignature(body, undefined, callbackToken, { ...fields, nowMs })).toBe(false);
    expect(verifyWebhookSignature(`${body} `, signature, callbackToken, { ...fields, nowMs })).toBe(false);
    expect(verifyWebhookSignature(body, signWebhookBody('wrong-secret', body, fields), callbackToken, { ...fields, nowMs })).toBe(false);
  });

  it('burns each webhook nonce once inside the acceptance window', () => {
    const guard = createWebhookReplayGuard();
    const at = 1_800_000_000_000;
    expect(guard.observe('c'.repeat(32), at, at)).toBe(true);
    expect(guard.observe('c'.repeat(32), at, at + 1000)).toBe(false);
    expect(guard.observe('d'.repeat(32), at, at + 1000)).toBe(true);
    expect(guard.observe('c'.repeat(32), at, at + 5 * 60_000 + 1)).toBe(true);
  });

  it('evicts expired nonces before live ones when tracked capacity overflows', () => {
    const toleranceMs = 5 * 60_000;
    const guard = createWebhookReplayGuard({ toleranceMs, maxTrackedNonces: 2 });
    const at = 1_800_000_000_000;
    expect(guard.observe('f'.repeat(32), at, at)).toBe(true);
    expect(guard.observe('e'.repeat(32), at + toleranceMs + 1, at)).toBe(true);
    expect(guard.observe('g'.repeat(32), at, at)).toBe(true);
    expect(guard.observe('f'.repeat(32), at, at + 1000)).toBe(false);
  });

  it('accepts dispatches and posts callback signals to a webhook endpoint', async () => {
    const callbackBodies: unknown[] = [];
    const callbackEndpoint = createServer((request, response) => {
      void (async () => {
        if (request.headers.authorization !== `Bearer ${callbackToken}`) {
          response.statusCode = 401;
          response.end('unauthorized');
          return;
        }
        callbackBodies.push(JSON.parse(await readBody(request)) as unknown);
        response.statusCode = 202;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ ok: true }));
      })();
    });
    await new Promise<void>((resolve) => callbackEndpoint.listen(0, '127.0.0.1', resolve));
    const callbackAddress = callbackEndpoint.address();
    if (!callbackAddress || typeof callbackAddress === 'string') {
      throw new Error('callback test server did not bind to a TCP address');
    }
    const callbackUrl = `http://127.0.0.1:${callbackAddress.port}/v0/signals`;
    const executor = await startExecutorServer({
      executorId: 'exec-executor',
      executorToken,
      callbackToken,
      callbackHostAllowlist: ['127.0.0.1'],
      handlers: createHandlersFromExecutorConfig({
        executorId: 'exec-executor',
        handlers: {
          'exec.main#START': {
            source: 'slot-a',
            stageIdentifier: 'exec.main',
            signalName: 'exec.main.cmp',
            receivedAt: '2026-04-27T00:00:03.000Z',
          },
        },
      }),
      port: 0,
    });

    try {
      const accepted = await fetch(`${executor.url}/v0/dispatches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${executorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ dispatchId: 'dispatch-1', effect, callbackUrl }),
      });
      expect(accepted.status).toBe(202);
      await eventually(async () => {
        const jobs = await getJobs(executor.url);
        expect(jobs[0]?.status).toBe('callback_succeeded');
      });

      expect(callbackBodies).toEqual([
        {
          signal: {
            zhixuId: 'zhixu-1',
            orderId: 'order-1',
            source: 'slot-a',
            stageIdentifier: 'exec.main',
            signalName: 'exec.main.cmp',
            senderId: 'exec-executor',
            idempotencyKey: 'order-1:slot-a:exec.main.cmp',
            receivedAt: '2026-04-27T00:00:03.000Z',
          },
        },
      ]);
    } finally {
      await executor.close();
      await new Promise<void>((resolve) => callbackEndpoint.close(() => resolve()));
    }
  });

  it('signs dispatched callback bodies with timestamp+nonce headers a receiver can verify', async () => {
    const hmacSecret = 'callback-hmac-secret';
    const captured: { readonly body: string; readonly headers: Record<string, string | string[] | undefined> }[] = [];
    const executor = await startExecutorServer({
      executorId: 'exec-executor',
      executorToken,
      callbackToken,
      callbackHmacSecret: hmacSecret,
      callbackHostAllowlist: ['127.0.0.1'],
      handlers: createHandlersFromExecutorConfig({
        executorId: 'exec-executor',
        handlers: {
          'exec.main#START': {
            source: 'slot-a',
            stageIdentifier: 'exec.main',
            signalName: 'exec.main.cmp',
          },
        },
      }),
      port: 0,
      fetchImpl: async (_input, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        captured.push({ body: String(init?.body ?? ''), headers });
        return new Response('ok', { status: 200 });
      },
    });

    try {
      const response = await fetch(`${executor.url}/v0/dispatches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${executorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ dispatchId: 'dispatch-signed', effect, callbackUrl: 'http://127.0.0.1:1/v0/signals' }),
      });
      expect(response.status).toBe(202);
      await eventually(async () => {
        const jobs = await getJobs(executor.url);
        expect(jobs[0]?.status).toBe('callback_succeeded');
      });

      expect(captured).toHaveLength(1);
      const delivery = captured[0]!;
      const timestamp = delivery.headers[WEBHOOK_TIMESTAMP_HEADER];
      const nonce = delivery.headers[WEBHOOK_NONCE_HEADER];
      expect(typeof timestamp).toBe('string');
      expect(typeof nonce).toBe('string');
      expect(verifyWebhookSignature(delivery.body, delivery.headers[WEBHOOK_SIGNATURE_HEADER] as string, hmacSecret, {
        timestamp: typeof timestamp === 'string' ? timestamp : undefined,
        nonce: typeof nonce === 'string' ? nonce : undefined,
      })).toBe(true);
      expect(verifyWebhookSignature(delivery.body, delivery.headers[WEBHOOK_SIGNATURE_HEADER] as string, hmacSecret, {
        timestamp: typeof timestamp === 'string' ? timestamp : undefined,
        nonce: 'e'.repeat(32),
      })).toBe(false);
    } finally {
      await executor.close();
    }
  });

  it('rejects missing auth and unknown handlers', async () => {
    const executor = await startExecutorServer({
      executorId: 'exec-executor',
      executorToken,
      callbackToken,
      callbackHostAllowlist: ['127.0.0.1'],
      handlers: {},
      port: 0,
    });
    try {
      const unauthorized = await fetch(`${executor.url}/v0/jobs`);
      expect(unauthorized.status).toBe(401);

      const unknown = await fetch(`${executor.url}/v0/dispatches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${executorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          dispatchId: 'dispatch-unknown',
          effect,
          callbackUrl: 'http://127.0.0.1:1/v0/signals',
        }),
      });
      expect(unknown.status).toBe(404);
    } finally {
      await executor.close();
    }
  });

  it('records handler and callback failures on jobs', async () => {
    const handlerFailure = await startExecutorServer({
      executorId: 'exec-executor',
      executorToken,
      callbackToken,
      callbackHostAllowlist: ['127.0.0.1'],
      handlers: {
        'exec.main#START': () => ({ status: 'failed', error: 'local executor failed' }),
      },
      port: 0,
    });
    try {
      const response = await fetch(`${handlerFailure.url}/v0/dispatches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${executorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ dispatchId: 'dispatch-handler-failed', effect, callbackUrl: 'http://127.0.0.1:1/v0/signals' }),
      });
      expect(response.status).toBe(202);
      await eventually(async () => {
        const jobs = await getJobs(handlerFailure.url);
        expect(jobs[0]?.status).toBe('handler_failed');
        expect(jobs[0]?.lastError).toBe('local executor failed');
      });
    } finally {
      await handlerFailure.close();
    }

    const callbackFailure = await startExecutorServer({
      executorId: 'exec-executor',
      executorToken,
      callbackToken,
      callbackHostAllowlist: ['127.0.0.1'],
      handlers: createHandlersFromExecutorConfig({
        executorId: 'exec-executor',
        handlers: {
          'exec.main#START': {
            source: 'slot-a',
            stageIdentifier: 'exec.main',
            signalName: 'exec.main.cmp',
          },
        },
      }),
      port: 0,
      fetchImpl: async () => new Response('callback rejected', { status: 500 }),
      callbackRetry: { maxAttempts: DEFAULT_CALLBACK_MAX_ATTEMPTS, baseDelayMs: 0 },
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await fetch(`${callbackFailure.url}/v0/dispatches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${executorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ dispatchId: 'dispatch-callback-failed', effect, callbackUrl: 'http://127.0.0.1:1/v0/signals' }),
      });
      expect(response.status).toBe(202);
      await eventually(async () => {
        const jobs = await getJobs(callbackFailure.url);
        expect(jobs[0]?.status).toBe('callback_failed');
        expect(jobs[0]?.callbacks?.[0]).toMatchObject({
          signalIndex: 0,
          delivered: false,
          attempts: DEFAULT_CALLBACK_MAX_ATTEMPTS,
        });
        expect(jobs[0]?.lastError).toContain('callback endpoint failed with 500');
      });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('callback delivery failed for signal 0 after 3 attempt(s)'));
    } finally {
      errorSpy.mockRestore();
      await callbackFailure.close();
    }
  });

  it('retries a failing callback POST with backoff before reporting success', async () => {
    let attempt = 0;
    const executor = await startExecutorServer({
      executorId: 'exec-executor',
      executorToken,
      callbackToken,
      callbackHostAllowlist: ['127.0.0.1'],
      handlers: createHandlersFromExecutorConfig({
        executorId: 'exec-executor',
        handlers: {
          'exec.main#START': {
            source: 'slot-a',
            stageIdentifier: 'exec.main',
            signalName: 'exec.main.cmp',
          },
        },
      }),
      port: 0,
      fetchImpl: async () => {
        attempt += 1;
        return attempt < DEFAULT_CALLBACK_MAX_ATTEMPTS
          ? new Response('flaky endpoint', { status: 503 })
          : new Response('ok', { status: 200 });
      },
    });
    try {
      const startedAt = Date.now();
      const response = await fetch(`${executor.url}/v0/dispatches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${executorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ dispatchId: 'dispatch-callback-retry', effect, callbackUrl: 'http://127.0.0.1:1/v0/signals' }),
      });
      expect(response.status).toBe(202);
      await eventually(async () => {
        const jobs = await getJobs(executor.url);
        expect(jobs[0]?.status).toBe('callback_succeeded');
        expect(jobs[0]?.callbacks?.[0]).toEqual({
          signalIndex: 0,
          delivered: true,
          attempts: DEFAULT_CALLBACK_MAX_ATTEMPTS,
        });
      });
      expect(attempt).toBe(DEFAULT_CALLBACK_MAX_ATTEMPTS);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(DEFAULT_CALLBACK_RETRY_BASE_DELAY_MS);
    } finally {
      await executor.close();
    }
  });

  it('records per-signal delivery truthfully when only some signals are delivered', async () => {
    const twoSignalHandler: RuntimeExecutorHandler = (dispatchEffect) => ({
      status: 'succeeded',
      signals: [
        {
          zhixuId: dispatchEffect.zhixuId,
          orderId: dispatchEffect.orderId,
          source: 'slot-a',
          stageIdentifier: dispatchEffect.stageIdentifier,
          signalName: `${dispatchEffect.stageIdentifier}.cmp`,
          senderId: 'exec-executor',
        },
        {
          zhixuId: dispatchEffect.zhixuId,
          orderId: dispatchEffect.orderId,
          source: 'slot-a',
          stageIdentifier: dispatchEffect.stageIdentifier,
          signalName: `${dispatchEffect.stageIdentifier}.done`,
          senderId: 'exec-executor',
        },
      ],
    });
    const executor = await startExecutorServer({
      executorId: 'exec-executor',
      executorToken,
      callbackToken,
      callbackHostAllowlist: ['127.0.0.1'],
      handlers: { 'exec.main#START': twoSignalHandler },
      port: 0,
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { signal?: { signalName?: string } };
        if (body.signal?.signalName === 'exec.main.cmp') {
          return new Response('ok', { status: 200 });
        }
        return new Response('callback rejected', { status: 500 });
      },
      callbackRetry: { baseDelayMs: 0 },
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await fetch(`${executor.url}/v0/dispatches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${executorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ dispatchId: 'dispatch-partial-callback', effect, callbackUrl: 'http://127.0.0.1:1/v0/signals' }),
      });
      expect(response.status).toBe(202);
      await eventually(async () => {
        const jobs = await getJobs(executor.url);
        expect(jobs[0]?.status).toBe('callback_failed');
        expect(jobs[0]?.callbacks).toHaveLength(2);
      });
      const jobs = await getJobs(executor.url);
      const job = jobs[0];
      expect(job?.callbacks?.[0]).toMatchObject({ signalIndex: 0, delivered: true, attempts: 1 });
      expect(job?.callbacks?.[1]?.delivered).toBe(false);
      expect(job?.callbacks?.[1]?.error).toContain('callback endpoint failed with 500');
      expect(job?.lastError).toContain('1/2 signal(s)');
      expect(job?.lastError).toContain('were delivered');
    } finally {
      errorSpy.mockRestore();
      await executor.close();
    }
  });

  it('rejects a duplicate dispatch job id instead of overwriting the existing job', async () => {
    let outboundCalls = 0;
    const executor = await startExecutorServer({
      executorId: 'exec-executor',
      executorToken,
      callbackToken,
      callbackHostAllowlist: ['127.0.0.1'],
      handlers: createHandlersFromExecutorConfig({
        executorId: 'exec-executor',
        handlers: {
          'exec.main#START': {
            source: 'slot-a',
            stageIdentifier: 'exec.main',
            signalName: 'exec.main.cmp',
          },
        },
      }),
      port: 0,
      fetchImpl: async () => {
        outboundCalls += 1;
        return new Response('ok', { status: 200 });
      },
    });
    try {
      const first = await fetch(`${executor.url}/v0/dispatches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${executorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ dispatchId: 'dispatch-conflict', effect, callbackUrl: 'http://127.0.0.1:1/v0/signals' }),
      });
      expect(first.status).toBe(202);

      const second = await fetch(`${executor.url}/v0/dispatches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${executorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ dispatchId: 'dispatch-conflict', effect, callbackUrl: 'http://127.0.0.1:1/v0/signals' }),
      });
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({
        error: 'job_already_exists',
        jobId: 'dispatch-conflict',
      });

      const jobs = await getJobs(executor.url);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.id).toBe('dispatch-conflict');
    } finally {
      await executor.close();
    }
  });

  it('resolves concurrent duplicate dispatches to exactly one accepted job', async () => {
    let outboundCalls = 0;
    const executor = await startExecutorServer({
      executorId: 'exec-executor',
      executorToken,
      callbackToken,
      callbackHostAllowlist: ['127.0.0.1'],
      handlers: createHandlersFromExecutorConfig({
        executorId: 'exec-executor',
        handlers: {
          'exec.main#START': {
            source: 'slot-a',
            stageIdentifier: 'exec.main',
            signalName: 'exec.main.cmp',
          },
        },
      }),
      port: 0,
      fetchImpl: async () => {
        outboundCalls += 1;
        return new Response('ok', { status: 200 });
      },
    });
    try {
      const dispatch = () => fetch(`${executor.url}/v0/dispatches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${executorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ dispatchId: 'dispatch-race', effect, callbackUrl: 'http://127.0.0.1:1/v0/signals' }),
      });
      const [first, second] = await Promise.all([dispatch(), dispatch()]);

      expect([first.status, second.status].sort()).toEqual([202, 409]);
      const jobs = await getJobs(executor.url);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.id).toBe('dispatch-race');
      expect(outboundCalls).toBeLessThanOrEqual(1);
    } finally {
      await executor.close();
    }
  });

  it('contains a failing job-store write inside the detached dispatch path instead of raising an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const backingStore = new InMemoryExecutorJobStore();
    let updateCalls = 0;
    const executor = await startExecutorServer({
      executorId: 'exec-executor',
      executorToken,
      callbackToken,
      callbackHostAllowlist: ['127.0.0.1'],
      handlers: { 'exec.main#START': () => ({ status: 'succeeded' }) },
      jobStore: {
        create: (job) => backingStore.create(job),
        get: (jobId) => backingStore.get(jobId),
        list: () => backingStore.list(),
        update: async () => {
          updateCalls += 1;
          throw new Error('job store write failed');
        },
      },
    });
    try {
      const accepted = await fetch(`${executor.url}/v0/dispatches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${executorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ dispatchId: 'dispatch-store-fault', effect, callbackUrl: 'http://127.0.0.1:1/v0/signals' }),
      });
      expect(accepted.status).toBe(202);

      await eventually(async () => {
        expect(updateCalls).toBeGreaterThanOrEqual(2);
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await executor.close();
    }
  });

  it('never follows a callback redirect and never replays the bearer to the redirect target', async () => {
    const seen: { path: string; authorization?: string }[] = [];
    const redirector = createServer((request, response) => {
      seen.push({
        path: request.url ?? '',
        ...(typeof request.headers.authorization === 'string'
          ? { authorization: request.headers.authorization }
          : {}),
      });
      if ((request.url ?? '').startsWith('/v0/signals')) {
        response.statusCode = 302;
        response.setHeader('location', '/leak');
        response.end();
        return;
      }
      response.statusCode = 200;
      response.end('redirect-target');
    });
    await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve));
    const redirectorAddress = redirector.address();
    if (!redirectorAddress || typeof redirectorAddress === 'string') {
      throw new Error('redirect test server did not bind to a TCP address');
    }
    const executor = await startExecutorServer({
      executorId: 'exec-executor',
      executorToken,
      callbackToken,
      callbackHostAllowlist: ['127.0.0.1'],
      handlers: createHandlersFromExecutorConfig({
        executorId: 'exec-executor',
        handlers: {
          'exec.main#START': {
            source: 'slot-a',
            stageIdentifier: 'exec.main',
            signalName: 'exec.main.cmp',
          },
        },
      }),
      port: 0,
    });

    try {
      const callbackUrl = `http://127.0.0.1:${redirectorAddress.port}/v0/signals`;
      const accepted = await fetch(`${executor.url}/v0/dispatches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${executorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ dispatchId: 'dispatch-redirect', effect, callbackUrl }),
      });
      expect(accepted.status).toBe(202);

      await eventually(async () => {
        const jobs = await getJobs(executor.url);
        expect(jobs[0]?.status).toBe('callback_failed');
        expect(jobs[0]?.lastError).toContain('callback endpoint failed with 302');
      });

      expect(seen.filter((entry) => entry.path === '/leak')).toEqual([]);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((entry) => entry.authorization === `Bearer ${callbackToken}`)).toBe(true);
    } finally {
      await executor.close();
      await new Promise<void>((resolve) => redirector.close(() => resolve()));
    }
  });

  it('rejects dispatches without a dispatchId instead of synthesizing a timestamped job id', async () => {
    const executor = await startExecutorServer({
      executorId: 'exec-executor',
      executorToken,
      callbackToken,
      callbackHostAllowlist: ['127.0.0.1'],
      handlers: {},
      port: 0,
    });
    try {
      for (const body of [
        { effect, callbackUrl: 'http://127.0.0.1:1/v0/signals' },
        { dispatchId: '', effect, callbackUrl: 'http://127.0.0.1:1/v0/signals' },
      ]) {
        const response = await fetch(`${executor.url}/v0/dispatches`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${executorToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: 'bad_request',
          message: expect.stringContaining('dispatchId'),
        });
      }
      expect(await getJobs(executor.url)).toHaveLength(0);
    } finally {
      await executor.close();
    }
  });

  it('rejects callback URLs outside the explicit allowlist before enqueuing and never sends the callback token', async () => {
    let outboundCalls = 0;
    const executor = await startExecutorServer({
      executorId: 'exec-executor',
      executorToken,
      callbackToken,
      callbackHostAllowlist: ['127.0.0.1'],
      handlers: createHandlersFromExecutorConfig({
        executorId: 'exec-executor',
        handlers: {
          'exec.main#START': {
            source: 'slot-a',
            stageIdentifier: 'exec.main',
            signalName: 'exec.main.cmp',
          },
        },
      }),
      port: 0,
      fetchImpl: async () => {
        outboundCalls += 1;
        return new Response('ok', { status: 200 });
      },
    });
    try {
      for (const callbackUrl of [
        'http://169.254.169.254/latest/meta-data/',
        'https://example.invalid/v0/signals',
        'file:///etc/passwd',
        'http://localhost:9/v0/signals',
        'http://[::1]/v0/signals',
      ]) {
        const response = await fetch(`${executor.url}/v0/dispatches`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${executorToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ dispatchId: `dispatch-ssrf-${outboundCalls}`, effect, callbackUrl }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: 'bad_request' });
      }

      expect(outboundCalls).toBe(0);
      expect(await getJobs(executor.url)).toHaveLength(0);
    } finally {
      await executor.close();
    }
  });

  it('refuses to start without an explicit callback host allowlist', async () => {
    await expect(startExecutorServer({
      executorId: 'exec-executor',
      executorToken,
      callbackToken,
      handlers: {},
      port: 0,
    })).rejects.toThrow(/callback host allowlist is empty/);
  });

  it('sends the callback bearer token to non-loopback hosts only when allowlisted', async () => {
    const outbound: { url: string; authorization?: string }[] = [];
    const executor = await startExecutorServer({
      executorId: 'exec-executor',
      executorToken,
      callbackToken,
      handlers: createHandlersFromExecutorConfig({
        executorId: 'exec-executor',
        handlers: {
          'exec.main#START': {
            source: 'slot-a',
            stageIdentifier: 'exec.main',
            signalName: 'exec.main.cmp',
          },
        },
      }),
      port: 0,
      fetchImpl: async (input, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        outbound.push({
          url: String(input),
          ...(typeof headers.authorization === 'string' ? { authorization: headers.authorization } : {}),
        });
        return new Response('ok', { status: 200 });
      },
      callbackHostAllowlist: ['callbacks.internal'],
    });

    try {
      const response = await fetch(`${executor.url}/v0/dispatches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${executorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          dispatchId: 'dispatch-allowlisted',
          effect,
          callbackUrl: 'http://callbacks.internal/v0/signals',
        }),
      });
      expect(response.status).toBe(202);
      await eventually(async () => {
        const jobs = await getJobs(executor.url);
        expect(jobs[0]?.status).toBe('callback_succeeded');
      });
      expect(outbound).toEqual([
        {
          url: 'http://callbacks.internal/v0/signals',
          authorization: `Bearer ${callbackToken}`,
        },
      ]);

      const blocked = await fetch(`${executor.url}/v0/dispatches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${executorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          dispatchId: 'dispatch-not-allowlisted',
          effect,
          callbackUrl: 'http://other.internal/v0/signals',
        }),
      });
      expect(blocked.status).toBe(400);
      expect(outbound).toHaveLength(1);
    } finally {
      await executor.close();
    }
  });

  it('parses the callback host allowlist env format and validates scheme/host', () => {
    expect(parseCallbackHostAllowlist(undefined)).toEqual([]);
    expect(parseCallbackHostAllowlist('')).toEqual([]);
    expect(parseCallbackHostAllowlist('callbacks.internal:8443, 10.0.0.7 , [::2]')).toEqual([
      'callbacks.internal:8443',
      '10.0.0.7',
      '::2',
    ]);

    expect(() => assertCallbackUrlAllowed('http://127.0.0.1:9/v0/signals', [])).toThrow(/not allowed/);
    expect(() => assertCallbackUrlAllowed('http://127.0.0.1:9/v0/signals', ['127.0.0.1'])).not.toThrow();

    expect(() => assertCallbackUrlAllowed('ftp://127.0.0.1/v0/signals', ['127.0.0.1'])).toThrow(/scheme/);
    expect(() => assertCallbackUrlAllowed('http://169.254.169.254/', ['127.0.0.1'])).toThrow(/not allowed/);
    expect(() => assertCallbackUrlAllowed('not a url', [])).toThrow(/valid URL/);
  });

  it('loads static handler config from JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-executor-config-'));
    const configPath = join(dir, 'executor.json');
    try {
      await writeFile(configPath, JSON.stringify({
        executorId: 'exec-executor',
        handlers: {
          'exec.main#START': {
            source: 'slot-a',
            stageIdentifier: 'exec.main',
            signalName: 'exec.main.cmp',
          },
        },
      }));

      const config = await loadExecutorConfig(configPath);
      const handlers = createHandlersFromExecutorConfig(config);
      expect(Object.keys(handlers)).toEqual(['exec.main#START']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keys the config-handler default idempotency key on orderId/source/signalName so a re-emitted HookReady reuses it', async () => {
    const handlers = createHandlersFromExecutorConfig({
      executorId: 'exec-executor',
      handlers: {
        'exec.main#START': {
          source: 'slot-a',
          stageIdentifier: 'exec.main',
          signalName: 'exec.main.cmp',
        },
      },
    });
    const handler = handlers['exec.main#START'];
    if (!handler) {
      throw new Error('expected a handler for exec.main#START');
    }
    const idempotencyKeyOf = (result: Awaited<ReturnType<typeof handler>>) =>
      result.status === 'succeeded' ? result.signals?.[0]?.idempotencyKey : undefined;

    const first = await handler(effect, { state: {} });
    const reemitted = await handler({ ...effect, eventId: 'event-2' }, { state: {} });

    expect(idempotencyKeyOf(first)).toBe('order-1:slot-a:exec.main.cmp');
    expect(idempotencyKeyOf(first)).toBe(idempotencyKeyOf(reemitted));
  });
});

async function getJobs(baseUrl: string): Promise<readonly ExecutorJob[]> {
  const response = await fetch(`${baseUrl}/v0/jobs`, {
    headers: { authorization: `Bearer ${executorToken}` },
  });
  const json = await response.json() as { jobs: ExecutorJob[] };
  return json.jobs;
}

async function eventually(assertion: () => Promise<void>, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function readBody(request: AsyncIterable<Buffer>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
