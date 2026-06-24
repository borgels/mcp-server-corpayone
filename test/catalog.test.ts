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
  it('allowlists bill read and update endpoints', () => {
    expect(findEndpoint('GET', '/bills').risk).toBe('read');
    expect(materializePath(findEndpoint('GET', '/bills/{id}'), { id: 42 })).toBe('/bills/42');
    expect(findEndpoint('PATCH', '/bills/{id}').risk).toBe('commit');
  });

  it('rejects non-allowlisted endpoints', () => {
    expect(() => findEndpoint('DELETE', '/bills/{id}')).toThrow(/not allowlisted/);
  });

  it('searches curated tools and endpoint capabilities', () => {
    const results = searchCapabilities('bill');
    expect(results.some(r => r.id === 'corpay_list_bills')).toBe(true);
    expect(results.some(r => r.id.startsWith('endpoint.'))).toBe(true);
  });

  it('exposes a non-trivial endpoint surface', () => {
    expect(ENDPOINT_OPERATIONS.length).toBeGreaterThan(8);
  });
});

describe('prepare/commit', () => {
  it('blocks a prepared write while writes are disabled', () => {
    const op = prepareOperation({
      capability: 'corpay_prepare_bill_coding',
      method: 'PATCH',
      pathTemplate: '/bills/{id}',
      pathParams: { id: 1 },
      body: { projectId: 7 },
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
    const bills = (await gateway.callTool('list_bills')) as { items: unknown[] };
    expect(Array.isArray(bills.items)).toBe(true);
  });
});
