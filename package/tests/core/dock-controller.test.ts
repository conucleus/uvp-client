// UVPDockController client tests: verifies EIP-712 bind-link signing against
// protocol-bindings typed data, ABI calldata encoding and txSender/walletClient
// dispatch for writes, typed contract reads, and fail-closed error codes.
import { describe, expect, it } from 'vitest';
import {
  decodeFunctionData,
  getAddress,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  DOCK_CONTROLLER_ABI,
  buildBindLinkTypedDataFor,
} from '@uvp-eth/protocol-bindings';
import {
  DockControllerError,
  bindLink,
  bindLinkPair,
  createDockControllerClient,
  dockOutputWindow,
  getDock,
  getDockOutput,
  getLink,
  getStageLink,
  reconcile,
  reconcileOutput,
  registerDock,
  signBindLink,
  type DockControllerTransactionSender,
  type DockControllerWalletClient,
  type EngineReadClient,
} from '../../src/core/index.js';

const bytes32 = (hexByte: string): Hex => `0x${hexByte.repeat(32)}` as Hex;
const address = (hexByte: string): Address => getAddress(`0x${hexByte.repeat(20)}`);

const DOCK_CONTROLLER = getAddress('0x000000000000000000000000000000000000d0cc');
const CHAIN_ID = 31337;
const DKID_A_TO_B = bytes32('11');
const DKID_B_TO_A = bytes32('12');
const FROM_PLAN_ID = bytes32('21');
const FROM_SOURCE_ID = bytes32('22');
const TO_PLAN_ID = bytes32('23');
const TO_STAGE_ID = bytes32('24');
const TO_SOURCE_ID = bytes32('25');
const DOC_HASH = bytes32('26');
const FROM_ORDER_ID = bytes32('31');
const TO_ORDER_ID = bytes32('32');
const CONSENT_STAGE_ID = bytes32('33');
const LINK_ID = bytes32('41');
const SIGNAL_ID = bytes32('51');
const ATOM_STAGE_ID = bytes32('52');
const PROOF_NODE = bytes32('61');
const TX_HASH = bytes32('aa');
const DEADLINE = 1_900_000_000n;

describe('UVPDockController client', () => {
  it('signs bindLink with buildBindLinkTypedDataFor and recovers the signer address', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const req = {
      dkid: DKID_A_TO_B,
      fromOrderId: FROM_ORDER_ID,
      toOrderId: TO_ORDER_ID,
      toConsentStageId: CONSENT_STAGE_ID,
      deadline: DEADLINE,
    };

    const signature = await signBindLink(
      { dockControllerAddress: DOCK_CONTROLLER, chainId: CHAIN_ID },
      req,
      account,
    );

    const expectedTypedData = buildBindLinkTypedDataFor(
      { dockControllerAddress: DOCK_CONTROLLER, chainId: CHAIN_ID },
      req,
    );
    const recovered = await recoverTypedDataAddress({
      domain: expectedTypedData.domain,
      types: expectedTypedData.types,
      primaryType: expectedTypedData.primaryType,
      message: {
        ...expectedTypedData.message,
        deadline: BigInt(expectedTypedData.message.deadline),
      },
      signature,
    });

    expect(recovered).toBe(account.address);
  });

  it('encodes and dispatches registerDock, bindLink, bindLinkPair, reconcile, and reconcileOutput', async () => {
    const sent: Array<{ readonly to: Address; readonly data: Hex; readonly chainId?: number }> = [];
    const txSender: DockControllerTransactionSender = {
      sendTransaction: async (args) => {
        sent.push(args);
        return TX_HASH;
      },
    };
    const writeConfig = {
      dockControllerAddress: DOCK_CONTROLLER,
      chainId: CHAIN_ID,
      txSender,
    };

    const registerTx = await registerDock(writeConfig, {
      fromPlanId: FROM_PLAN_ID,
      fromSourceId: FROM_SOURCE_ID,
      toPlanId: TO_PLAN_ID,
      toStageId: TO_STAGE_ID,
      toSourceId: TO_SOURCE_ID,
      docHash: DOC_HASH,
      outputs: [
        {
          signalId: SIGNAL_ID,
          atoms: [{ stageId: ATOM_STAGE_ID, signalId: SIGNAL_ID, capabilityProof: [PROOF_NODE] }],
          window: [
            {
              op: 0,
              sourceId: FROM_SOURCE_ID,
              signalId: SIGNAL_ID,
              arity: 0,
              delaySeconds: 0,
            },
          ],
          capabilityProof: [PROOF_NODE],
        },
      ],
    });
    expect(registerTx).toBe(TX_HASH);

    const bindReqAtoB = {
      dkid: DKID_A_TO_B,
      fromOrderId: FROM_ORDER_ID,
      toOrderId: TO_ORDER_ID,
      toConsentStageId: CONSENT_STAGE_ID,
      selectorProof: [PROOF_NODE],
      deadline: DEADLINE,
    };
    const bindReqBtoA = {
      dkid: DKID_B_TO_A,
      fromOrderId: TO_ORDER_ID,
      toOrderId: FROM_ORDER_ID,
      toConsentStageId: CONSENT_STAGE_ID,
      selectorProof: [],
      deadline: DEADLINE,
    };
    const sigB = `0x${'1b'.repeat(65)}` as Hex;
    const sigA = `0x${'2a'.repeat(65)}` as Hex;

    await bindLink(writeConfig, bindReqAtoB, sigB);
    await bindLinkPair(writeConfig, {
      reqAtoB: bindReqAtoB,
      sigB,
      reqBtoA: bindReqBtoA,
      sigA,
    });
    await reconcile(writeConfig, LINK_ID, [[PROOF_NODE]]);
    await reconcileOutput(writeConfig, LINK_ID, 0, [PROOF_NODE]);

    expect(sent).toHaveLength(5);
    for (const call of sent) {
      expect(call.to).toBe(DOCK_CONTROLLER);
      expect(call.chainId).toBe(CHAIN_ID);
    }

    const decodedRegister = decodeFunctionData({ abi: DOCK_CONTROLLER_ABI, data: sent[0]!.data });
    expect(decodedRegister.functionName).toBe('registerDock');
    expect(decodedRegister.args[0]).toBe(FROM_PLAN_ID);
    expect(decodedRegister.args[5]).toBe(DOC_HASH);

    const decodedBind = decodeFunctionData({ abi: DOCK_CONTROLLER_ABI, data: sent[1]!.data });
    expect(decodedBind.functionName).toBe('bindLink');
    expect(decodedBind.args[0]).toMatchObject({
      dkid: DKID_A_TO_B,
      fromOrderId: FROM_ORDER_ID,
      toOrderId: TO_ORDER_ID,
      toConsentStageId: CONSENT_STAGE_ID,
      selectorProof: [PROOF_NODE],
      deadline: DEADLINE,
    });
    expect(decodedBind.args[1]).toBe(sigB);

    const decodedPair = decodeFunctionData({ abi: DOCK_CONTROLLER_ABI, data: sent[2]!.data });
    expect(decodedPair.functionName).toBe('bindLinkPair');
    expect(decodedPair.args[1]).toBe(sigB);
    expect(decodedPair.args[3]).toBe(sigA);

    const decodedReconcile = decodeFunctionData({ abi: DOCK_CONTROLLER_ABI, data: sent[3]!.data });
    expect(decodedReconcile.functionName).toBe('reconcile');
    expect(decodedReconcile.args).toEqual([LINK_ID, [[PROOF_NODE]]]);

    const decodedReconcileOutput = decodeFunctionData({
      abi: DOCK_CONTROLLER_ABI,
      data: sent[4]!.data,
    });
    expect(decodedReconcileOutput.functionName).toBe('reconcileOutput');
    expect(decodedReconcileOutput.args).toEqual([LINK_ID, 0n, [PROOF_NODE]]);
  });

  it('dispatches writes through walletClient when txSender is omitted', async () => {
    const walletCalls: Array<{ readonly to: Address; readonly data: Hex; readonly chain?: null }> = [];
    const walletClient: DockControllerWalletClient = {
      sendTransaction: async (args) => {
        walletCalls.push(args);
        return TX_HASH;
      },
    };

    const txHash = await reconcile(
      { dockControllerAddress: DOCK_CONTROLLER, walletClient },
      LINK_ID,
      [],
    );

    expect(txHash).toBe(TX_HASH);
    expect(walletCalls).toHaveLength(1);
    expect(walletCalls[0]!.to).toBe(DOCK_CONTROLLER);
    expect(walletCalls[0]!.chain).toBeNull();
    expect(decodeFunctionData({ abi: DOCK_CONTROLLER_ABI, data: walletCalls[0]!.data })).toEqual({
      functionName: 'reconcile',
      args: [LINK_ID, []],
    });
  });

  it('reads getDock, getDockOutput, getLink, getStageLink, and dockOutputWindow through publicClient', async () => {
    const calls: Array<{
      readonly address: Address;
      readonly abi: readonly unknown[];
      readonly functionName: string;
      readonly args: readonly unknown[];
    }> = [];
    const publisher = address('09');
    const consent = address('08');

    const publicClient: EngineReadClient = {
      readContract: async (args) => {
        calls.push(args);
        switch (args.functionName) {
          case 'getDock':
            return [
              FROM_PLAN_ID,
              FROM_SOURCE_ID,
              TO_PLAN_ID,
              TO_STAGE_ID,
              TO_SOURCE_ID,
              DOC_HASH,
              publisher,
              true,
            ];
          case 'getDockOutput':
            return [
              SIGNAL_ID,
              0,
              [{ stageId: ATOM_STAGE_ID, signalId: SIGNAL_ID, relation: 0 }],
              [{ op: 4, sourceId: FROM_SOURCE_ID, signalId: SIGNAL_ID, arity: 1, delaySeconds: 60n }],
            ];
          case 'getLink':
            return {
              dkid: DKID_A_TO_B,
              fromPlanId: FROM_PLAN_ID,
              fromOrderId: FROM_ORDER_ID,
              toPlanId: TO_PLAN_ID,
              toOrderId: TO_ORDER_ID,
              toStageId: TO_STAGE_ID,
              toConsent: consent,
              boundAt: 1_700_000_000n,
              exists: true,
            };
          case 'getStageLink':
            return LINK_ID;
          case 'dockOutputWindow':
            return [true, true, 1_700_000_060n, true, false];
          default:
            throw new Error(`unexpected functionName: ${args.functionName}`);
        }
      },
    };

    const readConfig = { dockControllerAddress: DOCK_CONTROLLER, publicClient };
    const dock = await getDock(readConfig, DKID_A_TO_B);
    const output = await getDockOutput(readConfig, DKID_A_TO_B, 0);
    const link = await getLink(readConfig, LINK_ID);
    const stageLink = await getStageLink(readConfig, TO_PLAN_ID, TO_ORDER_ID, TO_STAGE_ID);
    const window = await dockOutputWindow(readConfig, LINK_ID, 0);

    expect(calls.every((call) => call.abi === DOCK_CONTROLLER_ABI)).toBe(true);
    expect(dock).toEqual({
      fromPlanId: FROM_PLAN_ID,
      fromSourceId: FROM_SOURCE_ID,
      toPlanId: TO_PLAN_ID,
      toStageId: TO_STAGE_ID,
      toSourceId: TO_SOURCE_ID,
      docHash: DOC_HASH,
      publisher,
      exists: true,
    });
    expect(output).toEqual({
      signalId: SIGNAL_ID,
      relation: 0,
      atoms: [{ stageId: ATOM_STAGE_ID, signalId: SIGNAL_ID, relation: 0 }],
      window: [{ op: 4, sourceId: FROM_SOURCE_ID, signalId: SIGNAL_ID, arity: 1, delaySeconds: 60n }],
    });
    expect(link).toEqual({
      dkid: DKID_A_TO_B,
      fromPlanId: FROM_PLAN_ID,
      fromOrderId: FROM_ORDER_ID,
      toPlanId: TO_PLAN_ID,
      toOrderId: TO_ORDER_ID,
      toStageId: TO_STAGE_ID,
      toConsent: consent,
      boundAt: 1_700_000_000n,
      exists: true,
    });
    expect(stageLink).toBe(LINK_ID);
    expect(window).toEqual({
      active: true,
      srcSatisfied: true,
      srcDueAt: 1_700_000_060n,
      dstAdmissionReady: true,
      emitted: false,
    });
  });

  it('binds sign, write, and read surfaces through createDockControllerClient', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const client = createDockControllerClient({
      dockControllerAddress: DOCK_CONTROLLER,
      chainId: CHAIN_ID,
      signer: account,
      txSender: { sendTransaction: async () => TX_HASH },
      publicClient: {
        readContract: async () => [true, false, 123n, false, false],
      },
    });

    const sig = await client.signBindLink({
      dkid: DKID_A_TO_B,
      fromOrderId: FROM_ORDER_ID,
      toOrderId: TO_ORDER_ID,
      toConsentStageId: CONSENT_STAGE_ID,
      deadline: DEADLINE,
    });
    const txHash = await client.bindLink(
      {
        dkid: DKID_A_TO_B,
        fromOrderId: FROM_ORDER_ID,
        toOrderId: TO_ORDER_ID,
        toConsentStageId: CONSENT_STAGE_ID,
        selectorProof: [],
        deadline: DEADLINE,
      },
      sig,
    );
    const window = await client.dockOutputWindow(LINK_ID, 0);

    expect(txHash).toBe(TX_HASH);
    expect(window.srcDueAt).toBe(123n);
  });

  it('surfaces typed DockControllerError codes on missing transport, invalid input, and malformed reads', async () => {
    await expect(
      reconcile({ dockControllerAddress: DOCK_CONTROLLER }, LINK_ID, []),
    ).rejects.toMatchObject({
      name: 'DockControllerError',
      code: 'invalid_config',
    });

    await expect(
      dockOutputWindow(
        {
          dockControllerAddress: DOCK_CONTROLLER,
          publicClient: { readContract: async () => [true, true, 0n, true, false] },
        },
        '0x1234',
        0,
      ),
    ).rejects.toMatchObject({
      name: 'DockControllerError',
      code: 'invalid_input',
    });

    await expect(
      dockOutputWindow(
        {
          dockControllerAddress: DOCK_CONTROLLER,
          publicClient: { readContract: async () => [true, true] },
        },
        LINK_ID,
        0,
      ),
    ).rejects.toMatchObject({
      name: 'DockControllerError',
      code: 'invalid_response',
    });

    const client = createDockControllerClient({
      dockControllerAddress: DOCK_CONTROLLER,
      chainId: CHAIN_ID,
    });
    await expect(
      client.signBindLink({
        dkid: DKID_A_TO_B,
        fromOrderId: FROM_ORDER_ID,
        toOrderId: TO_ORDER_ID,
        toConsentStageId: CONSENT_STAGE_ID,
        deadline: DEADLINE,
      }),
    ).rejects.toBeInstanceOf(DockControllerError);
  });
});
