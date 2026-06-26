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

describe('gateway contract', () => {
  it('matches the Borgels gateway tool shape (riskLevel/enabledByDefault)', () => {
    for (const tool of corpayGatewayTools) {
      expect(['read', 'write', 'destructive']).toContain(tool.riskLevel);
      expect(typeof tool.enabledByDefault).toBe('boolean');
    }
    const writeTool = corpayGatewayTools.find(t => t.name === 'write_expense_coding');
    expect(writeTool?.riskLevel).toBe('write');
    expect(writeTool?.enabledByDefault).toBe(false);
  });

  it('returns GatewayToolResult fixtures in contract mode (no network)', async () => {
    const gateway = createCorpayGateway({ contractMode: true });
    expect(gateway.tools).toBe(corpayGatewayTools);

    const list = await gateway.callTool('list_expenses');
    expect(list.isError).toBeUndefined();
    expect(list.content[0]?.type).toBe('text');
    expect(Array.isArray((list.structuredContent as { items: unknown[] }).items)).toBe(true);

    const categories = await gateway.callTool('list_categories');
    expect(Array.isArray((categories.structuredContent as { categories: unknown[] }).categories)).toBe(true);

    const options = await gateway.callTool('list_coding_options');
    const optsSc = options.structuredContent as { categories: unknown[]; lists: Array<{ labels: unknown[] }> };
    expect(Array.isArray(optsSc.categories)).toBe(true);
    expect(Array.isArray(optsSc.lists)).toBe(true);
    expect(Array.isArray(optsSc.lists[0]?.labels)).toBe(true);

    const write = await gateway.callTool('write_expense_coding', {
      id: 'exp_1',
      categoryId: 'gR39ejaL',
      labelIds: ['lbl_7'],
    });
    const structured = write.structuredContent as {
      updated: boolean;
      patch: Array<{ op: string; path: string; value: unknown }>;
    };
    expect(structured.updated).toBe(true);
    expect(structured.patch).toContainEqual({ op: 'add', path: '/categoryId', value: 'gR39ejaL' });
    expect(structured.patch).toContainEqual({ op: 'add', path: '/labelIds', value: ['lbl_7'] });

    const unknown = await gateway.callTool('nope');
    expect(unknown.isError).toBe(true);
  });

  it('gates the coding write on enableWrites', async () => {
    // Without enableWrites (and no CORPAYONE_ENABLE_WRITES env), the write is
    // blocked by policy before any network call.
    const blocked = await createCorpayGateway({ env: 'production' }).callTool('write_expense_coding', {
      id: 'exp_1',
      categoryId: 'gR39ejaL',
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0]?.text ?? '').toMatch(/writes disabled/i);

    // With enableWrites, the write proceeds to the PATCH call.
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/connect/token')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      calls.push({ url: href, method: init?.method });
      return new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const enabled = await createCorpayGateway({
      env: 'production',
      enableWrites: true,
      clientId: 'c',
      clientSecret: 's',
      refreshToken: 'r',
      teamId: 'TEAM',
      fetchImpl,
    }).callTool('write_expense_coding', { id: 'exp_1', categoryId: 'gR39ejaL' });
    expect(enabled.isError).toBeFalsy();
    expect(calls.some((call) => call.method === 'PATCH')).toBe(true);
  });
});
