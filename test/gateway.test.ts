// The embeddable gateway (src/gateway.ts): host credentials only, one team per instance, a renewed refresh token
// handed back before anything else is sent, direct changes under the host's policy, and nothing that leaves an
// instance holds a piece of a secret.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { corpayToolCatalog, createCorpayGateway, type CorpayGatewayOptions } from '../src/gateway.js';
import { visibleTexts } from '../src/key-admission.js';

const SECRET = 'Zq7pX2vK9mWb4TnR8yLc3HdJ6fGs1QeU';
const REFRESH = 'Hb5nQ8wE2rT6yU1iO4pA7sD9fG3hJ0kL';
const NEW_REFRESH = 'Mx3cV6bN9mQ2wE5rT8yU1iO4pA7sD0fG';
const TEAM = 'team-own';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

type Route = (call: Call) => Response | undefined;

function stub(routes: Record<string, Route | unknown>, token: () => Response = () => json({ access_token: 'access-token-value-1234567890', expires_in: 3600 })) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(url),
      headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    const parsed = new URL(String(url));
    if (parsed.pathname === '/connect/token') return token();
    const key = `${call.method} ${parsed.pathname}`;
    const route = Object.hasOwn(routes, key) ? routes[key] : undefined;
    if (typeof route === 'function') return (route as Route)(call) ?? json({}, 404);
    if (route !== undefined) return json(route);
    return json({ title: 'not here' }, 404, { 'x-request-id': 'a3f1c2de-4b5a-4c6d-8e9f-abcdefabcdef' });
  }) as typeof fetch;
  return { impl, calls };
}

function gateway(fetchImpl: typeof fetch, extra: Partial<CorpayGatewayOptions> = {}) {
  return createCorpayGateway({
    clientId: 'app-client-id',
    clientSecret: SECRET,
    refreshToken: REFRESH,
    teamId: TEAM,
    fetchImpl,
    policy: { enableWrites: true },
    ...extra,
  });
}

const OWN_EXPENSE = { data: { id: 'E1', owner: { team: { id: TEAM } }, category: { id: 'C0' }, labels: [] } };
const FOREIGN_EXPENSE = { data: { id: 'E2', owner: { team: { id: 'team-other' } } } };

afterEach(() => vi.unstubAllEnvs());

describe('catalog', () => {
  it('is frozen, never broad, and marks only the approval as needing confirmation', () => {
    expect(Object.isFrozen(corpayToolCatalog)).toBe(true);
    expect(corpayToolCatalog.every(entry => entry.broad === false)).toBe(true);
    expect(corpayToolCatalog.filter(entry => entry.requiresConfirmation).map(entry => entry.name)).toEqual(['approve_expense']);
    for (const entry of corpayToolCatalog) {
      expect(['read', 'write']).toContain(entry.riskLevel);
      if (entry.name !== 'search_capabilities') expect(entry.upstream.length).toBeGreaterThan(0);
      if (entry.riskLevel === 'read') expect(entry.upstream.every(op => op.method === 'GET')).toBe(true);
    }
    const names = corpayToolCatalog.map(entry => entry.name);
    expect(names).toContain('decline_expense');
    expect(names.some(name => /payment_method|member|webhook|delete/.test(name))).toBe(false);
  });
});

describe('construction', () => {
  it('requires every credential and the team, and reads none from the environment', () => {
    vi.stubEnv('CORPAYONE_CLIENT_ID', 'env-id');
    vi.stubEnv('CORPAYONE_CLIENT_SECRET', SECRET);
    vi.stubEnv('CORPAYONE_REFRESH_TOKEN', REFRESH);
    vi.stubEnv('CORPAYONE_TEAM_ID', TEAM);
    const { impl } = stub({});
    expect(() => createCorpayGateway({ fetchImpl: impl } as unknown as CorpayGatewayOptions)).toThrow(/requires options/);
    expect(() => gateway(impl, { teamId: '../x' })).toThrow(/teamId/);
    expect(() => gateway(impl, { refreshToken: 'short' })).toThrow(/refused/);
    expect(() => gateway(impl, { refreshToken: SECRET })).toThrow(/refused/);
  });

  it('never repeats a secret in a construction error', () => {
    try {
      gateway(stub({}).impl, { refreshToken: `${SECRET.slice(0, 10)}x` });
      expect.unreachable();
    } catch (error) {
      expect(visibleTexts(error).some(text => text.includes(SECRET.slice(0, 6)))).toBe(false);
    }
  });
});

describe('calls', () => {
  it('checks the connection with the app and the team', async () => {
    const { impl, calls } = stub({ 'GET /external/v1/teams': { data: { teams: [{ id: TEAM, name: 'Eksempel ApS' }, { id: 'team-other', name: 'Other' }] } } });
    const result = await gateway(impl).callTool('check_connection', {});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ teamFound: true, team: { id: TEAM, name: 'Eksempel ApS' } });
    expect(calls[0]!.url).toBe('https://identity.corpayone.com/connect/token');
    expect(calls[0]!.headers.Authorization).toMatch(/^Basic /);
    expect(calls[1]!.url).toBe('https://api.corpayone.com/external/v1/teams');
    expect(calls[1]!.headers.Authorization).toBe('Bearer access-token-value-1234567890');
  });

  it('hands a renewed refresh token to the host before anything else is sent', async () => {
    const order: string[] = [];
    const { impl } = stub(
      { 'GET /external/v1/teams': () => (order.push('teams'), json({ data: { teams: [] } })) },
      () => json({ access_token: 'access-token-value-1234567890', expires_in: 3600, refresh_token: NEW_REFRESH }),
    );
    const saved: string[] = [];
    const gw = gateway(impl, { onRefreshToken: async token => void (order.push('saved'), saved.push(token)) });
    const result = await gw.callTool('check_connection', {});
    expect(saved).toEqual([NEW_REFRESH]);
    expect(order).toEqual(['saved', 'teams']);
    expect(JSON.stringify(result)).not.toContain(NEW_REFRESH.slice(0, 8));
  });

  it('sends nothing when the host cannot keep the renewed token', async () => {
    const { impl, calls } = stub({ 'GET /external/v1/teams': { data: { teams: [] } } }, () =>
      json({ access_token: 'access-token-value-1234567890', refresh_token: NEW_REFRESH }),
    );
    const result = await gateway(impl, { onRefreshToken: () => Promise.reject(new Error('disk full')) }).callTool('check_connection', {});
    expect(result.isError).toBe(true);
    expect(calls.some(call => call.url.includes('/external/'))).toBe(false);
  });

  it('sends nothing when there is no host to keep the renewed token', async () => {
    const { impl, calls } = stub({ 'GET /external/v1/teams': { data: { teams: [] } } }, () =>
      json({ access_token: 'access-token-value-1234567890', refresh_token: NEW_REFRESH }),
    );
    const gw = gateway(impl);
    expect((await gw.callTool('check_connection', {})).isError).toBe(true);
    expect((await gw.callTool('get_company', {})).isError).toBe(true);
    expect(calls.some(call => call.url.includes('/external/'))).toBe(false);
  });

  it('says that the access was refused when the token is no longer accepted', async () => {
    const { impl } = stub({}, () => json({ error: 'invalid_grant', secret: REFRESH }, 400));
    const result = await gateway(impl).callTool('list_expenses', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/^Corpay One refused the app's access \(HTTP 400\)/);
    expect(result.failure).toEqual({ httpStatus: 400 });
    expect(result.content[0]!.text).not.toContain('invalid_grant');
  });

  it('asks every list for the instance team', async () => {
    const { impl, calls } = stub({ 'GET /external/v2/expenses': { data: { expenses: [] } } });
    await gateway(impl).callTool('list_expenses', { state: 'Awaiting' });
    const url = new URL(calls[1]!.url);
    expect(url.searchParams.get('TeamId')).toBe(TEAM);
    expect(url.searchParams.get('State')).toBe('Awaiting');
  });

  it('refuses an expense of another team, and sends no change for it', async () => {
    const { impl, calls } = stub({ 'GET /external/v3/expenses/E2': FOREIGN_EXPENSE });
    const gw = gateway(impl);
    expect((await gw.callTool('get_expense', { expenseId: 'E2' })).content[0]!.text).toMatch(/another Corpay One team/);
    expect((await gw.callTool('approve_expense', { expenseId: 'E2' })).isError).toBe(true);
    expect(calls.some(call => call.method !== 'GET' && call.url.includes('/external/'))).toBe(false);
  });

  it('refuses an id that is not one segment without calling Corpay', async () => {
    const { impl, calls } = stub({});
    for (const expenseId of ['../../v1/teams', 'E1/approve', 'E1?x=1', '%2e%2e']) {
      expect((await gateway(impl).callTool('get_expense', { expenseId })).isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it('codes an expense in one JSON Patch, with replace for a set field and add for an empty one', async () => {
    const { impl, calls } = stub({ 'GET /external/v3/expenses/E1': OWN_EXPENSE, 'PATCH /external/v2/expenses/E1': { data: { id: 'E1' } } });
    const result = await gateway(impl).callTool('set_expense_coding', { expenseId: 'E1', categoryId: 'C1', labelIds: ['L1'] });
    expect(result.isError).toBeUndefined();
    const patch = calls.find(call => call.method === 'PATCH')!;
    expect(patch.headers['Content-Type']).toBe('application/json-patch+json');
    expect(patch.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(patch.body!)).toEqual([
      { op: 'replace', path: '/categoryId', value: 'C1' },
      { op: 'add', path: '/labels', value: ['L1'] },
    ]);
  });

  it('approves and declines an expense of its own team directly', async () => {
    const { impl, calls } = stub({
      'GET /external/v3/expenses/E1': OWN_EXPENSE,
      'PATCH /external/v2/expenses/E1/approve': { data: { id: 'E1', state: 'Booked' } },
      'PATCH /external/v2/expenses/E1/decline': { data: { id: 'E1' } },
    });
    const gw = gateway(impl);
    expect((await gw.callTool('approve_expense', { expenseId: 'E1' })).isError).toBeUndefined();
    expect((await gw.callTool('decline_expense', { expenseId: 'E1', note: 'Forkert beløb' })).isError).toBeUndefined();
    expect(JSON.parse(calls.find(call => call.url.endsWith('/decline'))!.body!)).toEqual({ note: 'Forkert beløb' });
  });

  it('sends no change without the host enabling writes', async () => {
    const { impl, calls } = stub({ 'GET /external/v3/expenses/E1': OWN_EXPENSE });
    const result = await gateway(impl, { policy: {} }).callTool('approve_expense', { expenseId: 'E1' });
    expect(result.content[0]!.text).toMatch(/Writes are disabled/);
    expect(calls).toHaveLength(0);
  });

  it('creates a vendor without bank details and refuses unknown fields', async () => {
    const { impl, calls } = stub({ 'POST /external/v2/teams/team-own/vendors': { data: {} } });
    const gw = gateway(impl);
    expect((await gw.callTool('create_vendor', { name: 'Leverandør A/S', country: 'dk', iban: 'DK5000400440116243' })).isError).toBe(true);
    expect((await gw.callTool('create_vendor', { name: 'Leverandør A/S', country: 'dk' })).isError).toBeUndefined();
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ vendors: [{ name: 'Leverandør A/S', country: 'DK' }] });
  });

  it('leaves bank and card numbers and signed attachment links out of an answer', async () => {
    const { impl } = stub({
      'GET /external/v2/teams/team-own/vendors/V1': {
        data: { id: 'V1', name: 'A', iban: 'DK5000400440116243', bankAccount: { regNumber: '1234' }, logo: 'https://files.example/a.png' },
      },
      'GET /external/v3/expenses/E1': {
        data: { ...OWN_EXPENSE.data, note: 'Invoice: https://attachments.corpayone.com/x.pdf?Expires=1&Signature=abc&Key-Pair-Id=K attached; pay to IBAN DK5000400440116243, card 4111 1111 1111 1111, order 987654321098', attachments: [{ id: 'A1', url: 'https://attachments.corpayone.com/x.pdf?Expires=1&Signature=abc&Key-Pair-Id=K' }] },
      },
    });
    const gw = gateway(impl);
    const vendor = await gw.callTool('get_vendor', { vendorId: 'V1' });
    expect(vendor.structuredContent).toEqual({ data: { id: 'V1', name: 'A', logo: 'https://files.example/a.png' } });
    const expense = await gw.callTool('get_expense', { expenseId: 'E1' });
    expect(JSON.stringify(expense)).not.toContain('Signature');
    expect(JSON.stringify(expense)).toContain('Invoice: [signed link removed] attached; pay to IBAN [bank or card number removed], card [bank or card number removed], order 987654321098');
  });

  it('scrubs every answer, also the team name in the connection check', async () => {
    const name = 'Firma https://x.example/a?Signature=abc IBAN DK5000400440116243 4111 1111 1111 1111 123, 4111111111111111999 og 12 5555 5555 5555 4444, 41111111111111119999 og 94111111111111111 slut';
    const { impl } = stub({
      'GET /external/v1/teams': { data: { teams: [{ id: TEAM, name }] } },
      'GET /external/v1/teams/team-own': { data: { name: 'A', card: 4111111111111111, small: 42 } },
    });
    const gw = gateway(impl);
    const text = JSON.stringify(await gw.callTool('check_connection', {}));
    for (const piece of ['Signature', 'DK5000400440116243', '4111 1111', '41111111', '5555 5555']) expect(text).not.toContain(piece);
    const company = JSON.stringify(await gw.callTool('get_company', {}));
    expect(company).not.toContain('4111111111111111');
    expect(company).toContain('"small":42');
    // An error that quotes the input is scrubbed too.
    const invalid = JSON.stringify(await gw.callTool('get_vendor', { vendorId: 'V1', 'https://x.example/a?Signature=abc': 1 }));
    expect(invalid).not.toContain('Signature');
  });

  it('gives an HTTP error as our own text with failure metadata, never the body', async () => {
    const { impl } = stub({});
    const result = await gateway(impl).callTool('get_vendor', { vendorId: 'V9' });
    expect(result.content[0]!.text).toBe('Corpay One API request failed with HTTP 404 (GET). Corpay One found nothing with this id. Check the ids.');
    expect(result.failure).toEqual({ httpStatus: 404, requestId: 'a3f1c2de-4b5a-4c6d-8e9f-abcdefabcdef' });
  });

  it('withholds an answer that echoes a secret', async () => {
    const { impl } = stub({ 'GET /external/v1/teams/team-own': { data: { name: `Firma ${SECRET}`, note: REFRESH.slice(3, 15) } } });
    const result = await gateway(impl).callTool('get_company', {});
    for (const secret of [SECRET, REFRESH]) {
      for (let i = 0; i + 6 <= secret.length; i += 1) expect(JSON.stringify(result)).not.toContain(secret.slice(i, i + 6));
    }
  });

  it('searches only the tools the instance offers', async () => {
    const { impl } = stub({});
    const gw = gateway(impl, { policy: { enableWrites: true, disabledTools: ['approve_expense'] } });
    expect(gw.tools.some(tool => tool.name === 'approve_expense')).toBe(false);
    const found = await gw.callTool('search_capabilities', { query: 'approve expense' });
    expect(JSON.stringify(found.structuredContent)).not.toContain('corpay_approve_expense');
  });
});

describe('renewal', () => {
  it('renews once for sequential and concurrent reads, and uses the rotated token from then on', async () => {
    const grants: string[] = [];
    let n = 0;
    const { impl } = stub({ 'GET /external/v1/teams': { data: { teams: [] } }, 'GET /external/v2/expenses': { data: {} } }, () => {
      n += 1;
      return json({ access_token: `access-token-value-${n}-1234567890`, expires_in: 3600, refresh_token: n === 1 ? NEW_REFRESH : `Rq${n}cV6bN9mQ2wE5rT8yU1iO4pA7sD0fG` });
    });
    const wrapped = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/connect/token')) grants.push(new URLSearchParams(String(init?.body)).get('refresh_token') ?? '');
      return impl(url, init);
    }) as typeof fetch;
    const gw = gateway(wrapped, { onRefreshToken: () => undefined });
    await Promise.all([gw.callTool('check_connection', {}), gw.callTool('list_expenses', {})]);
    await gw.callTool('check_connection', {});
    await gw.callTool('list_expenses', {});
    expect(grants).toEqual([REFRESH]);
  });

  it('sends nothing more from an instance whose renewed token the host could not keep', async () => {
    const { impl, calls } = stub(
      { 'POST /external/v2/teams/team-own/vendors': { data: {} } },
      () => json({ access_token: 'access-token-value-1234567890', refresh_token: NEW_REFRESH }),
    );
    let failures = 0;
    const gw = gateway(impl, { onRefreshToken: () => ((failures += 1), Promise.reject(new Error('disk full'))) });
    expect((await gw.callTool('create_vendor', { name: 'A' })).isError).toBe(true);
    expect((await gw.callTool('create_vendor', { name: 'A' })).isError).toBe(true);
    expect(failures).toBe(1);
    expect(calls.filter(call => call.method === 'POST' && call.url.includes('/external/'))).toHaveLength(0);
  });

  for (const token of ['Withheldxq7pX2vK9mWb4TnR8yLc', 'true,"Zq7pX2vK9mWb4TnR8yLc']) {
    it(`stops instead of using an issued token that shares a piece with a fixed output (${token.slice(0, 8)})`, async () => {
      const { impl, calls } = stub({ 'GET /external/v1/teams': { data: { teams: [] } } }, () => json({ access_token: token, expires_in: 3600 }));
      const result = await gateway(impl).callTool('check_connection', {});
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/^Corpay One issued a token/);
      expect(calls.some(call => call.url.includes('/external/'))).toBe(false);
    });
  }
});
