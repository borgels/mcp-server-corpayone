import { afterEach, describe, expect, it } from 'vitest';
import { prepareOperation, verifyPreparedOperation } from '../src/corpay/operations.js';
import { prepareExpenseCoding } from '../src/corpay/coding.js';
import type { CorpayClient } from '../src/corpay/client.js';

afterEach(() => {
  delete process.env.CORPAYONE_ENABLE_WRITES;
  delete process.env.CORPAYONE_TEAM_ID;
});

function prepareCoding() {
  return prepareOperation({
    capability: 'corpay_prepare_expense_amount_lines',
    method: 'PATCH',
    pathTemplate: '/v2/expenses/{expenseId}/amountlines',
    pathParams: { expenseId: 'E1' },
    body: { amountLines: [{ amount: 930_000 }] },
    reason: 'split the bill',
  });
}

describe('prepare/commit ceremony', () => {
  it('returns a dry run that has not been sent', () => {
    const op = prepareCoding();
    expect(op.dryRun).toBe(true);
    expect(op.operationHash).toHaveLength(64);
  });

  it('reports the policy decision without throwing', () => {
    const op = prepareCoding();
    expect(op.policyDecision.allowed).toBe(false);
    expect(op.policyDecision.reason).toMatch(/writes disabled/);
  });

  it('accepts an unmodified operation', () => {
    const op = prepareCoding();
    expect(() => verifyPreparedOperation(op)).not.toThrow();
  });

  it('rejects an operation whose body was edited after preparing', () => {
    const op = prepareCoding();
    const tampered = { ...op, body: { amountLines: [{ amount: 9_300_000 }] } };
    expect(() => verifyPreparedOperation(tampered)).toThrow(/hash does not match/);
  });

  it('rejects an operation retargeted at another expense', () => {
    const op = prepareCoding();
    const tampered = { ...op, pathParams: { expenseId: 'E2' } };
    expect(() => verifyPreparedOperation(tampered)).toThrow(/hash does not match/);
  });

  it('hashes independently of key order', () => {
    const a = prepareOperation({
      capability: 'c',
      method: 'PATCH',
      pathTemplate: '/v2/expenses/{expenseId}/amountlines',
      pathParams: { expenseId: 'E1' },
      body: { alpha: 1, beta: 2 },
      reason: 'r',
    });
    const b = prepareOperation({
      capability: 'c',
      method: 'PATCH',
      pathTemplate: '/v2/expenses/{expenseId}/amountlines',
      pathParams: { expenseId: 'E1' },
      body: { beta: 2, alpha: 1 },
      reason: 'r',
    });
    expect(a.operationHash).toBe(b.operationHash);
  });

  it('recovers a body the client stringified in transit', () => {
    const op = prepareCoding();
    const restringified = { ...op, body: JSON.stringify(op.body) };
    expect(verifyPreparedOperation(restringified).body).toEqual(op.body);
  });

  it('refuses to prepare an endpoint that is not allowlisted', () => {
    expect(() =>
      prepareOperation({
        capability: 'c',
        method: 'POST',
        pathTemplate: '/v2/expenses/{expenseId}/pay',
        reason: 'r',
      }),
    ).toThrow(/not allowlisted/);
  });

  it('pins the team into a prepared path', () => {
    process.env.CORPAYONE_TEAM_ID = 'TEAM_ALPHA';
    const op = prepareOperation({
      capability: 'corpay_prepare_coding_list_change',
      method: 'POST',
      pathTemplate: '/v1/teams/{teamId}/departments',
      reason: 'r',
    });
    expect(op.pathParams).toEqual({ teamId: 'TEAM_ALPHA' });
  });

  it('refuses to prepare a write against another team', () => {
    process.env.CORPAYONE_TEAM_ID = 'TEAM_ALPHA';
    expect(() =>
      prepareOperation({
        capability: 'corpay_prepare_coding_list_change',
        method: 'POST',
        pathTemplate: '/v1/teams/{teamId}/departments',
        pathParams: { teamId: 'TEAM_BETA' },
        reason: 'r',
      }),
    ).toThrow(/cannot act on team/);
  });
});

describe('expense coding', () => {
  function clientReturning(expense: unknown): CorpayClient {
    return {
      request: async () => ({ data: expense }),
    } as unknown as CorpayClient;
  }

  it('uses add for fields that are currently unset', async () => {
    const result = await prepareExpenseCoding(clientReturning({ category: null, labels: [], departments: [] }), {
      expenseId: 'E1',
      categoryId: 'C1',
      labelIds: ['L1'],
      reason: 'code it',
    });
    expect(result.patch).toEqual([
      { op: 'add', path: '/categoryId', value: 'C1' },
      { op: 'add', path: '/labels', value: ['L1'] },
    ]);
  });

  it('uses replace for fields that already hold a value', async () => {
    const result = await prepareExpenseCoding(
      clientReturning({
        category: { id: 'OLD', name: 'Misc', number: '1310' },
        labels: [{ id: 'LOLD' }],
        departments: [{ id: 'DOLD' }],
      }),
      { expenseId: 'E1', categoryId: 'C1', labelIds: ['L1'], departmentIds: ['D1'], reason: 'recode' },
    );
    expect(result.patch.map(p => p.op)).toEqual(['replace', 'replace', 'replace']);
  });

  it('reports the current coding so the change can be reviewed', async () => {
    const result = await prepareExpenseCoding(
      clientReturning({
        state: 'Awaiting',
        amount: 930_000,
        currency: 'DKK',
        vendor: { name: 'Acme' },
        category: { id: 'OLD', number: '1310' },
        labels: [],
        departments: [],
      }),
      { expenseId: 'E1', categoryId: 'C1', reason: 'recode' },
    );
    expect(result.current).toMatchObject({ state: 'Awaiting', amount: 930_000, vendor: 'Acme' });
    expect(result.operation.contentType).toBe('application/json-patch+json');
  });

  it('refuses a request that would change nothing', async () => {
    await expect(
      prepareExpenseCoding(clientReturning({}), { expenseId: 'E1', reason: 'nothing' }),
    ).rejects.toThrow(/Nothing to code/);
  });

  it('reports an expense it cannot read', async () => {
    const client = { request: async () => ({}) } as unknown as CorpayClient;
    await expect(
      prepareExpenseCoding(client, { expenseId: 'E9', categoryId: 'C1', reason: 'r' }),
    ).rejects.toThrow(/was not found/);
  });
});
