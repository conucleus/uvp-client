import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import type { ZhixuDefinition } from '@uvp-eth/compiler';
import { planRegistrationArgs } from '../../src/core/registration.js';
import { compilePlan } from '../../src/headless/plan.js';

const PUBLISHER = '0x0000000000000000000000000000000000000002' as Address;

const definition: ZhixuDefinition = {
  apiVersion: 'uvp/v0',
  kind: 'Zhixu',
  metadata: { name: 'write_sdk_demo' },
  spec: {
    platform: { type: 'cloud' },
    nucleation: { id: 'core' },
    stages: [
      {
        name: 'assign',
        source: 'buyer',
        selectedStages: ['main'],
        receiveSignals: { PLACE: 'buyer::assign.seed' },
        sendSignals: [{ name: 'executor_selected' }, { name: 'seed' }],
        executor: { supplierType: 'organization', supplierID: 'selector-org' },
      },
      {
        name: 'main',
        source: 'buyer',
        receiveSignals: {
          START: 'buyer::assign.executor_selected',
          TIMEOUT: 'buyer::(assign.executor_selected +5s) & ~main.cmp',
        },
        sendSignals: [{ name: 'str' }, { name: 'cmp' }, { name: 'err' }],
        executor: { supplierType: 'organization', supplierID: 'org-1' },
      },
    ],
  },
};

describe('headless plan compilation', () => {
  it('compiles a definition into register args and a publisher-bound planId', async () => {
    const compiled = await compilePlan({ definition, publisher: PUBLISHER });

    expect(compiled.planId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(compiled.registerArgs.planHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(compiled.registerArgs.hooks.length).toBeGreaterThan(0);
    const registration = planRegistrationArgs(compiled.registerArgs, compiled.planId);
    expect(registration.planId).toBe(compiled.planId);
    expect(registration.hooks.length).toBe(compiled.registerArgs.hooks.length);
    expect(registration.executorCandidatesRoot).toBe(compiled.registerArgs.executorCandidatesRoot);
  });
});
