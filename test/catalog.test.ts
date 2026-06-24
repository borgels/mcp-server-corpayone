import { describe, expect, it } from 'vitest';
import {
  ENDPOINT_OPERATIONS,
  findEndpoint,
  materializePath,
  searchCapabilities,
} from '../src/corpay/catalog.js';
import { prepareOperation } from '../src/corpay/operations.js';
import { createCorpayGateway, corpayGatewayTools } from '../src/gateway.js';

describe('corpay catalog', () => {
  it('allowlists expense read and update endpoints', () => {
    expect(findEndpoint('GET', '/expenses').risk).toBe('read');
    expect(materializePath(findEndpoint('GET', '/expenses/{id}'), { id: 42 })).toBe('/expenses/42');
    expect(findEndpoint('PATCH', '/expenses/{id}').risk).toBe('commit');
  });

  it('rejects non-allowlisted endpoints', () => {
    expect(() => findEndpoint('DELETE', '/expenses/{id}')).toThrow(/not allowlisted/);
  });

  it('searches curated tools and endpoint capabilities', () => {
    const results = searchCapabilities('expense');
    expect(results.some(r => r.id === 'corpay_list_expenses')).toBe(true);
    expect(results.some(r => r.id.startsWith('endpoint.'))).toBe(true);
  });

  it('exposes a non-trivial endpoint surface', () => {
    expect(ENDPOINT_OPERATIONS.length).toBeGreaterThan(8);
  });
});

describe('prepare/commit', () => {
  it('blocks a prepared write while writes are disabled', () => {
    const op = prepareOperation({
      capability: 'corpay_prepare_expense_coding',
      method: 'PATCH',
      pathTemplate: '/expenses/{id}',
      pathParams: { id: 1 },
      body: { categoryId: 1310, labels: { project: 7 } },
      reason: 'test',
    });
    expect(op.operationHash).toMatch(/^[0-9a-f]{32}$/);
    expect(op.policyAllowed).toBe(false); // writes disabled by default
  });
});

describe('gateway contract mode', () => {
  it('returns deterministic fixtures without network', async () => {
    const gateway = createCorpayGateway({ contractMode: true });
    expect(gateway.tools).toBe(corpayGatewayTools);
    const expenses = (await gateway.callTool('list_expenses')) as { items: unknown[] };
    expect(Array.isArray(expenses.items)).toBe(true);
  });
});
