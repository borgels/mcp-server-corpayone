import { describe, expect, it } from 'vitest';
import {
  ENDPOINT_OPERATIONS,
  WEBHOOK_EVENTS,
  findEndpoint,
  materializePath,
  searchCapabilities,
} from '../src/corpay/catalog.js';
import { prepareOperation } from '../src/corpay/operations.js';
import { createCorpayGateway, corpayGatewayTools } from '../src/gateway.js';
import { validateWebhookSignature } from '../src/corpay/webhooks.js';
import { createHmac } from 'node:crypto';

describe('corpay catalog', () => {
  it('allowlists the documented expense and webhook endpoints', () => {
    expect(findEndpoint('GET', '/v2/expenses').risk).toBe('read');
    expect(materializePath(findEndpoint('GET', '/v3/expenses/{id}'), { id: 'vBXyq5om' })).toBe(
      '/v3/expenses/vBXyq5om',
    );
    expect(findEndpoint('PATCH', '/v2/expenses/{id}').risk).toBe('commit');
    expect(findEndpoint('POST', '/v1/webhooks').risk).toBe('commit');
    expect(findEndpoint('DELETE', '/v1/webhooks/{id}').risk).toBe('dangerous');
  });

  it('rejects non-allowlisted endpoints', () => {
    expect(() => findEndpoint('GET', '/v2/vendors')).toThrow(/not allowlisted/);
  });

  it('exposes the documented webhook event set', () => {
    expect(WEBHOOK_EVENTS).toContain('expense.state.booked');
    expect(WEBHOOK_EVENTS).toContain('expense.category.updated');
    expect(ENDPOINT_OPERATIONS.length).toBeGreaterThanOrEqual(7);
  });

  it('searches curated tools and endpoint capabilities', () => {
    const results = searchCapabilities('expense');
    expect(results.some(r => r.id === 'corpay_list_expenses')).toBe(true);
    expect(results.some(r => r.id.startsWith('endpoint.'))).toBe(true);
  });
});

describe('prepare/commit', () => {
  it('blocks a prepared write while writes are disabled', () => {
    const op = prepareOperation({
      capability: 'corpay_prepare_expense_coding',
      method: 'PATCH',
      pathTemplate: '/v2/expenses/{id}',
      pathParams: { id: 'vBXyq5om' },
      body: { categoryId: 1310, labels: { project: 7 } },
      reason: 'test',
    });
    expect(op.path).toBe('/v2/expenses/vBXyq5om');
    expect(op.operationHash).toMatch(/^[0-9a-f]{32}$/);
    expect(op.policyAllowed).toBe(false); // writes disabled by default
  });
});

describe('webhook signature validation', () => {
  it('accepts a correctly signed payload and rejects tampering', () => {
    const secret = 'whsec_test';
    const body = '{"data":{"event":"expense.state.booked"}}';
    const ts = 1752246797;
    const sig = createHmac('sha512', secret).update(`${ts}.${body}`).digest('hex');
    const header = `t=${ts};v1=${sig}`;
    expect(validateWebhookSignature(header, body, secret)).toBe(true);
    expect(validateWebhookSignature(header, body + 'x', secret)).toBe(false);
    expect(validateWebhookSignature('garbage', body, secret)).toBe(false);
  });
});

describe('gateway contract mode', () => {
  it('returns deterministic fixtures without network', async () => {
    const gateway = createCorpayGateway({ contractMode: true });
    expect(gateway.tools).toBe(corpayGatewayTools);
    const expenses = (await gateway.callTool('list_expenses')) as { items: unknown[] };
    expect(Array.isArray(expenses.items)).toBe(true);
  });

  it('exposes a write_expense_coding tool (disabled by default) with a contract fixture', async () => {
    const writeTool = corpayGatewayTools.find(t => t.name === 'write_expense_coding');
    expect(writeTool?.risk).toBe('write');
    expect(writeTool?.defaultEnabled).toBe(false);
    const gateway = createCorpayGateway({ contractMode: true });
    const result = (await gateway.callTool('write_expense_coding', {
      id: 'exp_1',
      category: 1310,
      labels: { project: 7 },
    })) as { updated: boolean; category: unknown };
    expect(result.updated).toBe(true);
    expect(result.category).toBe(1310);
  });
});
