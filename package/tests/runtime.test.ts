import { describe, expect, it } from 'vitest';
import {
  createRuntimeDispatcher,
  createStaticSignalHandler,
} from '../src/runtime.js';

const effect = {
  type: 'HookReady',
  eventId: 'event-1',
  zhixuId: 'zhixu-1',
  orderId: 'order-1',
  hookId: 'exec.main#START',
  stageIdentifier: 'exec.main',
  hookName: 'START',
} as const;

describe('runtime executor adapter', () => {
  it('creates a static handler that emits executor callback signals', async () => {
    const handler = createStaticSignalHandler({
      source: 'slot-a',
      stageIdentifier: 'exec.main',
      signalName: 'exec.main.cmp',
      senderId: 'executor-1',
      idempotencyKey: (ready) => `${ready.hookId}:cmp`,
      receivedAt: '2026-04-27T00:00:03.000Z',
    });

    const result = await handler(effect, { state: {} as never });

    expect(result.status).toBe('succeeded');
    expect(result.status === 'succeeded' ? result.signals?.[0] : undefined).toEqual({
      zhixuId: 'zhixu-1',
      orderId: 'order-1',
      source: 'slot-a',
      stageIdentifier: 'exec.main',
      signalName: 'exec.main.cmp',
      senderId: 'executor-1',
      idempotencyKey: 'exec.main#START:cmp',
      receivedAt: '2026-04-27T00:00:03.000Z',
    });
  });

  it('dispatches by stage hook key and reports missing handlers as failures', async () => {
    const dispatcher = createRuntimeDispatcher({
      handlers: {
        'exec.main#START': () => ({ status: 'succeeded' }),
      },
    });
    const missing = createRuntimeDispatcher();

    await expect(dispatcher.dispatch(effect, { state: {} as never })).resolves.toEqual({ status: 'succeeded' });
    await expect(missing.dispatch(effect, { state: {} as never })).resolves.toEqual({
      status: 'failed',
      error: 'no runtime executor handler for exec.main#START',
    });
  });
});
