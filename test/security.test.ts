import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { CorpayClient } from '../src/corpay/client.js';
import { assertSafePathSegment, findEndpoint, materializePath } from '../src/corpay/catalog.js';
import {
  assertCapabilityEndpoint,
  PREPARED_OPERATION_TTL_MS,
  prepareOperation,
  verifyPreparedOperation,
} from '../src/corpay/operations.js';
import {
  assertPathParamsInTeam,
  extractTeamId,
  fetchResourceInTeam,
} from '../src/corpay/ownership.js';
import { checkPolicy, normalizePolicyPath, type CorpayPolicy } from '../src/corpay/policy.js';
import { validateWebhookSignature } from '../src/corpay/webhooks.js';
import { createCorpayGateway } from '../src/gateway.js';
import { registerCorpayTools } from '../src/tools/corpay.js';
import { buildAuthorizeUrl, createPkcePair, pkceChallenge, stateMatches } from '../src/auth/pkce.js';
import {
  assertAuthorized,
  assertSafeHttpStartup,
  constantTimeEqual,
  HttpRequestError,
} from '../src/transports/http-helpers.js';

const PINNED = 'TEAM_ALPHA';
const OTHER = 'TEAM_BETA';
const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  delete process.env.CORPAYONE_TEAM_ID;
  delete process.env.CORPAYONE_ENABLE_WRITES;
  delete process.env.CORPAYONE_ENABLE_APPROVALS;
  delete process.env.CORPAYONE_PREPARE_SECRET;
});

interface Call {
  url: string;
  method: string;
}

/** fetch double: answers the token endpoint, then routes by path. */
function stubFetch(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.includes('/connect/token')) {
      return json({ access_token: 'token', expires_in: 3600 });
    }
    calls.push({ url, method: String(init.method ?? 'GET') });
    const path = new URL(url).pathname.replace(/^\/external/, '');
    return json(routes[path] ?? { ok: true });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function makeClient(fetchImpl: typeof fetch, teamId?: string): CorpayClient {
  return new CorpayClient({
    clientId: 'id',
    clientSecret: 'secret',
    refreshToken: 'refresh',
    env: 'production',
    teamId,
    fetchImpl,
  });
}

type Handler = (input: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

function registerTools(client: CorpayClient): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers[name] = handler;
    },
  };
  registerCorpayTools(server as never, client);
  return handlers;
}

const FOREIGN_EXPENSE = { data: { id: 'E1', teamId: OTHER, amount: 100 } };
const OWN_EXPENSE = { data: { id: 'E1', teamId: PINNED, amount: 100 } };

// ------------------------------------------------------------------ C1

describe('by-id resources are scoped to the pinned team', () => {
  it('finds the owning team in the common response shapes', () => {
    expect(extractTeamId({ data: { teamId: PINNED } })).toBe(PINNED);
    expect(extractTeamId({ data: { TeamId: PINNED } })).toBe(PINNED);
    expect(extractTeamId({ data: { team: { id: PINNED } } })).toBe(PINNED);
    expect(extractTeamId({ data: { expense: { teamId: PINNED } } }, 'expense')).toBe(PINNED);
    expect(extractTeamId({ data: { id: 'E1' } })).toBeUndefined();
    expect(extractTeamId({ teamId: PINNED, data: { teamId: OTHER } })).toBeUndefined();
  });

  it('refuses an expense that belongs to another team', async () => {
    const { impl } = stubFetch({ '/v3/expenses/E1': FOREIGN_EXPENSE });
    await expect(fetchResourceInTeam(makeClient(impl, PINNED), 'expense', 'E1')).rejects.toThrow(
      /belongs to another team/,
    );
  });

  it('fails closed when the team cannot be determined', async () => {
    const { impl } = stubFetch({ '/v3/expenses/E1': { data: { id: 'E1' } } });
    await expect(fetchResourceInTeam(makeClient(impl, PINNED), 'expense', 'E1')).rejects.toThrow(
      /Could not determine/,
    );
  });

  it('accepts an expense of the pinned team and skips the check when unpinned', async () => {
    const own = stubFetch({ '/v3/expenses/E1': OWN_EXPENSE });
    await expect(fetchResourceInTeam(makeClient(own.impl, PINNED), 'expense', 'E1')).resolves.toEqual(OWN_EXPENSE);
    const unpinned = stubFetch({ '/v3/expenses/E1': FOREIGN_EXPENSE });
    await expect(fetchResourceInTeam(makeClient(unpinned.impl), 'expense', 'E1')).resolves.toEqual(FOREIGN_EXPENSE);
  });

  it('checks webhook ids in path templates', async () => {
    const { impl } = stubFetch({ '/v1/webhooks/W1': { data: { id: 'W1', teamId: OTHER } } });
    await expect(
      assertPathParamsInTeam(makeClient(impl, PINNED), '/v1/webhooks/{webhookId}', { webhookId: 'W1' }),
    ).rejects.toThrow(/another team/);
  });

  it('corpay_get_expense refuses a foreign expense', async () => {
    process.env.CORPAYONE_TEAM_ID = PINNED;
    const { impl } = stubFetch({ '/v3/expenses/E1': FOREIGN_EXPENSE });
    const tools = registerTools(makeClient(impl, PINNED));
    await expect(tools.corpay_get_expense!({ expenseId: 'E1' })).rejects.toThrow(/another team/);
  });

  it('corpay_get_expense sends the pinned team instead of omitting it', async () => {
    process.env.CORPAYONE_TEAM_ID = PINNED;
    const { impl, calls } = stubFetch({ '/v3/expenses/E1': OWN_EXPENSE });
    const tools = registerTools(makeClient(impl, PINNED));
    await tools.corpay_get_expense!({ expenseId: 'E1' });
    expect(new URL(calls[0]!.url).searchParams.get('teamId')).toBe(PINNED);
  });

  it('activities/approvers do not read a foreign expense', async () => {
    process.env.CORPAYONE_TEAM_ID = PINNED;
    for (const tool of ['corpay_get_expense_activities', 'corpay_get_expense_approvers']) {
      const { impl, calls } = stubFetch({ '/v3/expenses/E1': FOREIGN_EXPENSE });
      const tools = registerTools(makeClient(impl, PINNED));
      await expect(tools[tool]!({ expenseId: 'E1' })).rejects.toThrow(/another team/);
      expect(calls.some(c => /activities|approvers/.test(c.url))).toBe(false);
    }
  });

  it('corpay_call_endpoint refuses expense and webhook templates for foreign ids', async () => {
    process.env.CORPAYONE_TEAM_ID = PINNED;
    const { impl, calls } = stubFetch({
      '/v3/expenses/E1': FOREIGN_EXPENSE,
      '/v1/webhooks/W1': { data: { teamId: OTHER } },
    });
    const tools = registerTools(makeClient(impl, PINNED));
    await expect(
      tools.corpay_call_endpoint!({ method: 'GET', pathTemplate: '/v2/expenses/{expenseId}/links', pathParams: { expenseId: 'E1' } }),
    ).rejects.toThrow(/another team/);
    await expect(
      tools.corpay_call_endpoint!({ method: 'GET', pathTemplate: '/v1/webhooks/{webhookId}', pathParams: { webhookId: 'W1' } }),
    ).rejects.toThrow(/another team/);
    expect(calls.some(c => c.url.includes('/links'))).toBe(false);
  });

  it('prepare tools refuse foreign expenses', async () => {
    process.env.CORPAYONE_TEAM_ID = PINNED;
    const { impl } = stubFetch({ '/v3/expenses/E1': FOREIGN_EXPENSE });
    const tools = registerTools(makeClient(impl, PINNED));
    await expect(
      tools.corpay_prepare_expense_approval!({ expenseId: 'E1', decision: 'approve', reason: 'r' }),
    ).rejects.toThrow(/another team/);
    await expect(
      tools.corpay_prepare_expense_amount_lines!({ expenseId: 'E1', amountLines: [{ amount: 1 }], reason: 'r' }),
    ).rejects.toThrow(/another team/);
    await expect(
      tools.corpay_prepare_expense_coding!({ expenseId: 'E1', categoryId: 'C1', reason: 'r' }),
    ).rejects.toThrow(/another team/);
  });

  it('commit re-checks ownership before sending the write', async () => {
    process.env.CORPAYONE_TEAM_ID = PINNED;
    process.env.CORPAYONE_ENABLE_WRITES = 'true';
    const op = prepareOperation({
      capability: 'corpay_prepare_expense_amount_lines',
      method: 'PATCH',
      pathTemplate: '/v2/expenses/{expenseId}/amountlines',
      pathParams: { expenseId: 'E1' },
      body: { amountLines: [{ amount: 1 }] },
      reason: 'r',
    });
    const { impl, calls } = stubFetch({ '/v3/expenses/E1': FOREIGN_EXPENSE });
    const tools = registerTools(makeClient(impl, PINNED));
    const result = await tools.corpay_commit_prepared_operation!({
      operation: op,
      confirmOperationHash: op.operationHash,
      idempotencyKey: 'idempotency-1',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/another team/);
    expect(calls.some(c => c.method === 'PATCH')).toBe(false);
  });

  it('gateway get_expense and write_expense_coding refuse a foreign expense', async () => {
    const { impl, calls } = stubFetch({ '/v3/expenses/E1': FOREIGN_EXPENSE });
    const gateway = createCorpayGateway({
      clientId: 'id',
      clientSecret: 'secret',
      refreshToken: 'refresh',
      env: 'production',
      teamId: PINNED,
      fetchImpl: impl,
      enableWrites: true,
    });
    const read = await gateway.callTool('get_expense', { id: 'E1' });
    expect(read.isError).toBe(true);
    const write = await gateway.callTool('write_expense_coding', { id: 'E1', categoryId: 'C1' });
    expect(write.isError).toBe(true);
    expect(write.content[0]!.text).toMatch(/another team/);
    expect(calls.some(c => c.method === 'PATCH')).toBe(false);
  });
});

// ------------------------------------------------------------------ C2

describe('prepared operations are signed, expire, and stay on their endpoints', () => {
  function prepare(now?: Date) {
    return prepareOperation(
      {
        capability: 'corpay_prepare_expense_amount_lines',
        method: 'PATCH',
        pathTemplate: '/v2/expenses/{expenseId}/amountlines',
        pathParams: { expenseId: 'E1' },
        body: { amountLines: [{ amount: 1 }] },
        reason: 'r',
      },
      now,
    );
  }

  it('rejects an operation re-hashed with an unkeyed digest', () => {
    const op = prepare();
    const forged = {
      ...op,
      capability: 'corpay_prepare_expense_approval',
      pathTemplate: '/v2/expenses/{expenseId}/approve',
      body: undefined,
    };
    const { operationHash: _h, dryRun: _d, policyDecision: _p, ...unsigned } = forged;
    forged.operationHash = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
    expect(() => verifyPreparedOperation(forged)).toThrow(/hash does not match/);
  });

  it('rejects an operation signed with a different secret', () => {
    process.env.CORPAYONE_PREPARE_SECRET = 'first-secret-value';
    const op = prepare();
    process.env.CORPAYONE_PREPARE_SECRET = 'second-secret-value';
    expect(() => verifyPreparedOperation(op)).toThrow(/hash does not match/);
  });

  it('rejects an operation after it expires', () => {
    const preparedAt = new Date('2026-01-01T00:00:00Z');
    const op = prepare(preparedAt);
    expect(Date.parse(op.expiresAt) - preparedAt.getTime()).toBe(PREPARED_OPERATION_TTL_MS);
    expect(() => verifyPreparedOperation(op, new Date(preparedAt.getTime() + 60_000))).not.toThrow();
    expect(() =>
      verifyPreparedOperation(op, new Date(preparedAt.getTime() + PREPARED_OPERATION_TTL_MS + 1)),
    ).toThrow(/expired/);
  });

  it('rejects an extended expiry', () => {
    const op = prepare();
    const extended = { ...op, expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
    expect(() => verifyPreparedOperation(extended)).toThrow(/hash does not match/);
  });

  it('ties each capability to its endpoints', () => {
    expect(() =>
      assertCapabilityEndpoint('corpay_prepare_expense_amount_lines', 'PATCH', '/v2/expenses/{expenseId}/amountlines'),
    ).not.toThrow();
    expect(() =>
      assertCapabilityEndpoint('corpay_prepare_vendor_change', 'PATCH', '/v2/expenses/{expenseId}/approve'),
    ).toThrow(/cannot target/);
    expect(() => assertCapabilityEndpoint('made_up', 'PATCH', '/v2/expenses/{expenseId}')).toThrow(/Unknown/);
    expect(() => assertCapabilityEndpoint('toString', 'PATCH', '/v2/expenses/{expenseId}')).toThrow(/Unknown/);
  });

  it('prepare refuses a capability outside its endpoints', () => {
    expect(() =>
      prepareOperation({
        capability: 'corpay_prepare_coding_list_change',
        method: 'PATCH',
        pathTemplate: '/v2/expenses/{expenseId}/amountlines',
        pathParams: { expenseId: 'E1' },
        reason: 'r',
      }),
    ).toThrow(/cannot target/);
  });

  it('corpay_prepare_coding_list_change only accepts coding-list templates', async () => {
    const { impl } = stubFetch({});
    const tools = registerTools(makeClient(impl));
    await expect(
      tools.corpay_prepare_coding_list_change!({
        method: 'PATCH',
        pathTemplate: '/v2/expenses/{expenseId}/amountlines',
        pathParams: { expenseId: 'E1' },
        teamId: PINNED,
        reason: 'r',
      }),
    ).rejects.toThrow(/cannot target/);
    await expect(
      tools.corpay_prepare_coding_list_change!({
        method: 'POST',
        pathTemplate: '/v2/teams/{teamId}/vendors',
        teamId: PINNED,
        reason: 'r',
      }),
    ).rejects.toThrow(/cannot target/);
    const ok = await tools.corpay_prepare_coding_list_change!({
      method: 'POST',
      pathTemplate: '/v1/teams/{teamId}/categories',
      teamId: PINNED,
      body: [],
      reason: 'r',
    });
    expect(ok.isError).toBeFalsy();
  });
});

// ------------------------------------------------------------------ C3

describe('path parameters and policy paths are normalized', () => {
  it.each(['', ' ', '.', '..', 'a/b', 'a\\b', 'a?b', 'a#b', '%2e%2e', 'x%2Fy', 'x%5cy', 'a\nb'])(
    'rejects %j as a path segment',
    value => {
      expect(() => assertSafePathSegment(value)).toThrow(/Invalid/);
    },
  );

  it('accepts ordinary ids', () => {
    expect(assertSafePathSegment('3f2a-91')).toBe('3f2a-91');
    expect(assertSafePathSegment(42)).toBe('42');
  });

  it('materializePath refuses traversal in a parameter', () => {
    const endpoint = findEndpoint('GET', '/v3/expenses/{expenseId}');
    expect(() => materializePath(endpoint, { expenseId: '..' })).toThrow(/Invalid/);
  });

  it('gateway refuses an id that is not a single segment without calling Corpay', async () => {
    const { impl, calls } = stubFetch({});
    const gateway = createCorpayGateway({
      clientId: 'id',
      clientSecret: 'secret',
      refreshToken: 'refresh',
      env: 'production',
      fetchImpl: impl,
      enableWrites: true,
    });
    for (const id of ['../../v1/teams', 'E1/approve', 'E1?x=1', '%2e%2e']) {
      expect((await gateway.callTool('get_expense', { id })).isError).toBe(true);
      expect((await gateway.callTool('write_expense_coding', { id, categoryId: 'C1' })).isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it('normalizes dot segments and escapes before matching deny patterns', () => {
    expect(normalizePolicyPath('/v1/teams/T1/x/../members').encoded).toBe('/v1/teams/T1/members');
    expect(normalizePolicyPath('/v1/teams/T1/%6Dembers').decoded).toBe('/v1/teams/T1/members');

    const policy: CorpayPolicy = {
      writesEnabled: true,
      approvalsEnabled: false,
      allowedCapabilities: [],
      allowedMethods: ['POST', 'PUT', 'PATCH', 'DELETE'],
      deniedPathPatterns: ['/members'],
    };
    const check = (path: string) =>
      checkPolicy({ capability: 'x', method: 'POST', path }, policy);
    expect(check('/v1/teams/T1/%6Dembers').allowed).toBe(false);
    expect(check('/v1/teams/T1/x/../members').allowed).toBe(false);
    expect(check('/v1/teams/T1//members').allowed).toBe(false);
    expect(check('/v1/teams/T1/categories').allowed).toBe(true);
  });
});

// ------------------------------------------------------------------ C4

describe('OAuth capture uses state and PKCE', () => {
  it('derives the S256 challenge per RFC 7636', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
    const pair = createPkcePair();
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.challenge).toBe(pkceChallenge(pair.verifier));
  });

  it('puts state and the challenge on the authorize URL', () => {
    const url = new URL(
      buildAuthorizeUrl({
        identityBase: 'https://identity.example',
        clientId: 'c',
        scope: 's',
        redirectUri: 'http://localhost:1/cb',
        state: 'STATE',
        codeChallenge: 'CHAL',
      }),
    );
    expect(url.searchParams.get('state')).toBe('STATE');
    expect(url.searchParams.get('code_challenge')).toBe('CHAL');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('matches state exactly', () => {
    expect(stateMatches('abc', 'abc')).toBe(true);
    expect(stateMatches('abc', 'abd')).toBe(false);
    expect(stateMatches('abc', null)).toBe(false);
    expect(stateMatches('abc', '')).toBe(false);
  });

  it('binds the callback listener to loopback and sends the verifier', () => {
    const source = readFileSync(new URL('../src/auth/capture-token.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/server\.listen\(port, '127\.0\.0\.1'/);
    expect(source).toMatch(/code_verifier: pkce\.verifier/);
    expect(source).toMatch(/stateMatches\(state,/);
  });
});

// ------------------------------------------------------------- webhooks

describe('webhook signature parsing', () => {
  const secret = 'whsec';
  const body = '{"a":1}';
  const sig = (t: number) => createHmac('sha512', secret).update(`${t}.${body}`).digest('hex');

  it('accepts a valid signature and rejects a wrong one', () => {
    expect(validateWebhookSignature(`t=100;v1=${sig(100)}`, body, secret)).toBe(true);
    expect(validateWebhookSignature(`t=101;v1=${sig(100)}`, body, secret)).toBe(false);
    expect(validateWebhookSignature('garbage', body, secret)).toBe(false);
  });

  it('handles adversarial headers in linear time', () => {
    const header = `t=${'t='.repeat(50_000)}`;
    const started = Date.now();
    expect(validateWebhookSignature(header, body, secret)).toBe(false);
    expect(validateWebhookSignature(';'.repeat(100_000), body, secret)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

// ------------------------------------------------------------- HTTP

describe('HTTP transport token and startup checks', () => {
  it('compares tokens in constant time', () => {
    expect(constantTimeEqual('Bearer a', 'Bearer a')).toBe(true);
    expect(constantTimeEqual('Bearer a', 'Bearer ab')).toBe(false);
    process.env.MCP_HTTP_TOKEN = 'secret';
    expect(() => assertAuthorized({ headers: { authorization: 'Bearer secreT' } } as never)).toThrow(HttpRequestError);
    expect(() => assertAuthorized({ headers: { authorization: 'Bearer secret' } } as never)).not.toThrow();
  });

  it('refuses to start when forwarded-user trust is on without a token', () => {
    const base = { host: '127.0.0.1', port: 0, maxBodyBytes: 1 };
    expect(() => assertSafeHttpStartup({ X_TRUST_FORWARDED_USER: 'true' }, base)).toThrow(/MCP_HTTP_TOKEN/);
    expect(() =>
      assertSafeHttpStartup({ X_TRUST_FORWARDED_USER: 'true' }, { ...base, httpToken: 't' }),
    ).not.toThrow();
    expect(() => assertSafeHttpStartup({ X_TRUST_FORWARDED_USER: 'false' }, base)).not.toThrow();
  });
});
