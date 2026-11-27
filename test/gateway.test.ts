// The embeddable gateway (src/gateway.ts): host credentials only, one team per instance, a renewed refresh token
// handed back before anything else is sent, direct changes under the host's policy, and nothing that leaves an
// instance holds a piece of a secret.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { corpayToolCatalog, createCorpayGateway, type CorpayGatewayOptions } from '../src/gateway.js';
import { visibleTexts } from '../src/key-admission.js';

/** A made-up value that looks like a token, built when the test runs so no secret-like text stands in the source. */
const fake = (seed: string, length = 32): string =>
  Array.from({ length }, (_, i) => 'ZqXvKmWbTnRyLcHdJfGsQeU2345678pa'[(seed.charCodeAt(i % seed.length) * (i + 7) + i) % 32]).join('');
const SECRET = fake('secret');
const REFRESH = fake('refresh');
const NEW_REFRESH = fake('renewed');
const ACCESS = fake('access', 28);
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

function stub(routes: Record<string, Route | unknown>, token: () => Response = () => json({ access_token: ACCESS, expires_in: 3600 })) {
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
    expect(calls[1]!.headers.Authorization).toBe(`Bearer ${ACCESS}`);
  });

  it('hands a renewed refresh token to the host before anything else is sent', async () => {
    const order: string[] = [];
    const { impl } = stub(
      { 'GET /external/v1/teams': () => (order.push('teams'), json({ data: { teams: [] } })) },
      () => json({ access_token: ACCESS, expires_in: 3600, refresh_token: NEW_REFRESH }),
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
      json({ access_token: ACCESS, refresh_token: NEW_REFRESH }),
    );
    const result = await gateway(impl, { onRefreshToken: () => Promise.reject(new Error('disk full')) }).callTool('check_connection', {});
    expect(result.isError).toBe(true);
    expect(calls.some(call => call.url.includes('/external/'))).toBe(false);
  });

  it('sends nothing when there is no host to keep the renewed token', async () => {
    const { impl, calls } = stub({ 'GET /external/v1/teams': { data: { teams: [] } } }, () =>
      json({ access_token: ACCESS, refresh_token: NEW_REFRESH }),
    );
    const gw = gateway(impl);
    expect((await gw.callTool('check_connection', {})).isError).toBe(true);
    expect((await gw.callTool('get_company', {})).isError).toBe(true);
    expect(calls.some(call => call.url.includes('/external/'))).toBe(false);
  });

  it('sends nothing when a renewed token cannot be kept as it came', async () => {
    const { impl, calls } = stub({ 'GET /external/v1/teams': { data: { teams: [] } } }, () =>
      json({ access_token: ACCESS, refresh_token: 'new-short-token' }),
    );
    const result = await gateway(impl, { onRefreshToken: () => undefined }).callTool('check_connection', {});
    expect(result.isError).toBe(true);
    expect(calls.some(call => call.url.includes('/external/'))).toBe(false);
  });

  it('keeps a renewed refresh token even when the access token in the same answer is unusable', async () => {
    const kept: string[] = [];
    const { impl, calls } = stub({ 'GET /external/v1/teams': { data: { teams: [] } } }, () => json({ access_token: 'short', refresh_token: NEW_REFRESH }));
    const result = await gateway(impl, { onRefreshToken: token => void kept.push(token) }).callTool('check_connection', {});
    expect(result.isError).toBe(true);
    expect(kept).toEqual([NEW_REFRESH]);
    expect(calls.some(call => call.url.includes('/external/'))).toBe(false);
  });

  it('refuses an issued token that shares a piece with the tool list, and does not use it', async () => {
    const colliding = 'approve_expensexYz-0123';
    const { impl, calls } = stub({ 'GET /external/v1/teams': { data: { teams: [] } } }, () =>
      json({ access_token: ACCESS, refresh_token: colliding }),
    );
    const kept: string[] = [];
    const result = await gateway(impl, { onRefreshToken: token => void kept.push(token) }).callTool('check_connection', {});
    expect(result.isError).toBe(true);
    expect(kept).toEqual([]);
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
        data: { ...OWN_EXPENSE.data, notes: [{ id: 'N1', value: 'Invoice: https://attachments.corpayone.com/x.pdf?Expires=1&Signature=abc&Key-Pair-Id=K attached; pay to IBAN DK5000400440116243, card 4111 1111 1111 1111, order 987654321098' }], attachments: [{ id: 'A1', url: 'https://attachments.corpayone.com/x.pdf?Expires=1&Signature=abc&Key-Pair-Id=K' }] },
      },
    });
    const gw = gateway(impl);
    const vendor = await gw.callTool('get_vendor', { vendorId: 'V1' });
    expect(vendor.structuredContent).toEqual({ id: 'V1', name: 'A' });
    const expense = await gw.callTool('get_expense', { expenseId: 'E1' });
    expect(JSON.stringify(expense)).not.toContain('Signature');
    expect(expense.structuredContent).toMatchObject({ attachments: [{ id: 'A1' }] });
    expect(JSON.stringify(expense)).toContain('Invoice: [link removed] attached; pay to IBAN [bank or card number removed], card [bank or card number removed], order 987654321098');
  });

  it('scrubs every answer, also the team name in the connection check', async () => {
    const name = 'Firma https://x.example/a?Signature=abc IBAN DK5000400440116243 4111 1111 1111 1111 123, 4111111111111111999 og 12 5555 5555 5555 4444, 41111111111111119999 og 94111111111111111 slut';
    const { impl } = stub({
      'GET /external/v1/teams': { data: { teams: [{ id: TEAM, name }] } },
      'GET /external/v1/teams/team-own': {
        data: { name: 'A PAN4111111111111111 og 4111111111111111USD og gb29nwbk60161331926819 og IBANgb29nwbk60161331926819 og DK50\t0040\t0440\t1162\t43 og 4111\t1111\u00a01111 1111 og https://files.example/invoice?sv=2024-01-01&%73ig=abcdef og id ab12cdefghijklmnop og GB29  NWBK  6016  1331  9268  19 og 5555  5555  5555  4444 og ref1234 GB29NWBK60161331926819 og ref1059 GB29NWBK60161331926819 og Account #: 1234567890 og Reg.nr. 9876 Konto 3456789012 og <a href="https://files.example/i?sv=1&amp;sig=abcdef">bilag</a>', gb29nwbk60161331926819: 3, card: 4111111111111111, big: 6221234567890598594, small: 42, '4111111111111111': 1, 'https://x.example/a?Signature=abc': 2 },
      },
    });
    const gw = gateway(impl);
    const text = JSON.stringify(await gw.callTool('check_connection', {}));
    for (const piece of ['Signature', 'DK5000400440116243', '4111 1111', '41111111', '5555 5555']) expect(text).not.toContain(piece);
    const company = JSON.stringify(await gw.callTool('get_company', {}));
    expect(company).not.toContain('4111111111111111');
    expect(company).not.toContain('Signature');
    expect(company).not.toContain('gb29nwbk');
    for (const piece of ['0440', '4111', '%73ig', 'NWBK', '5555', '9876', '3456789012', 'sig=abcdef', '1331926819', '1234567890', '622123']) expect(company).not.toContain(piece);
    // Letters and digits that fail the IBAN check are kept.
    expect(company).toContain('ab12cdefghijklmnop');
    // Fields the team's answer type does not list are left out, whatever they hold.
    for (const field of ['small', 'card', 'big']) expect(company).not.toContain(`"${field}"`);
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
      () => json({ access_token: ACCESS, refresh_token: NEW_REFRESH }),
    );
    let failures = 0;
    const gw = gateway(impl, { onRefreshToken: () => ((failures += 1), Promise.reject(new Error('disk full'))) });
    expect((await gw.callTool('create_vendor', { name: 'A' })).isError).toBe(true);
    expect((await gw.callTool('create_vendor', { name: 'A' })).isError).toBe(true);
    expect(failures).toBe(1);
    expect(calls.filter(call => call.method === 'POST' && call.url.includes('/external/'))).toHaveLength(0);
  });

  for (const token of [`Withheld${fake('withheld', 20)}`, `true,"${fake('fixed', 22)}`]) {
    it(`stops instead of using an issued token that shares a piece with a fixed output (${token.slice(0, 8)})`, async () => {
      const { impl, calls } = stub({ 'GET /external/v1/teams': { data: { teams: [] } } }, () => json({ access_token: token, expires_in: 3600 }));
      const result = await gateway(impl).callTool('check_connection', {});
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/^Corpay One issued a token/);
      expect(calls.some(call => call.url.includes('/external/'))).toBe(false);
    });
  }
});

describe('typed answers', () => {
  const BANK = 'DK5000400440116243';
  const FULL_EXPENSE = {
    data: {
      id: 'E1',
      owner: { user: { id: 'U1' }, team: { id: TEAM } },
      number: 1042,
      amount: 1240000,
      currency: 'DKK',
      dueDate: '2026-12-01T00:00:00Z',
      state: 'Awaiting',
      reference: 'Faktura 77 se www.example.com/f',
      paymentMethod: { id: 'P1', type: 'BankTransfer', iban: BANK },
      creditor: { id: 'CR1', accountNumber: '12345678' },
      ripePaymentId: 'R1',
      fx: { homeAmount: 1240000, homeCurrency: 'DKK', paymentInstructionType: 'Iban' },
      attachments: [{ id: 'A1', url: 'https://attachments.example/a.pdf', isOriginal: true }],
      lines: [{ id: 'L1', amount: 1240000, note: 'Se https://x.example/l', bankAccount: BANK }],
      vendor: { id: 'V1', name: 'Leverandør A/S', iban: BANK, website: 'https://leverandoer.example' },
      unknownNew: 'value',
      number2: 4111111111111111,
    },
  };

  it('passes on only the listed fields of an expense: no payment method, creditor, payment instruction or link', async () => {
    const { impl } = stub({ 'GET /external/v3/expenses/E1': FULL_EXPENSE });
    const result = await gateway(impl).callTool('get_expense', { expenseId: 'E1' });
    expect(result.structuredContent).toEqual({
      id: 'E1',
      owner: { user: { id: 'U1' }, team: { id: TEAM } },
      number: 1042,
      amount: 1240000,
      currency: 'DKK',
      dueDate: '2026-12-01T00:00:00Z',
      state: 'Awaiting',
      reference: 'Faktura 77 se [link removed]',
      fx: { homeAmount: 1240000, homeCurrency: 'DKK' },
      attachments: [{ id: 'A1', isOriginal: true }],
      lines: [{ id: 'L1', amount: 1240000, note: 'Se [link removed]' }],
      vendor: { id: 'V1', name: 'Leverandør A/S' },
    });
    for (const piece of [BANK, 'paymentMethod', 'creditor', 'ripePaymentId', 'paymentInstructionType', 'http', 'unknownNew', '4111']) {
      expect(JSON.stringify(result)).not.toContain(piece);
    }
  });

  it('leaves out a value that is not of its kind', async () => {
    const { impl } = stub({
      'GET /external/v3/expenses/E1': {
        data: {
          id: 'E1',
          owner: { team: { id: TEAM } },
          amount: '12,00',
          currency: 'https://x.example',
          dueDate: 'snart',
          number: 'NaN',
          category: { id: 'id med mellemrum', number: '4111111111111111' },
          vendor: { id: 'DK5000400440116243', name: 'Leverandør A/S' },
          item: { id: 4111111111111111, name: 'Vare' },
          type: 'www.example.com',
        },
      },
    });
    const result = await gateway(impl).callTool('get_expense', { expenseId: 'E1' });
    expect(result.structuredContent).toEqual({ id: 'E1', owner: { team: { id: TEAM } }, category: {}, vendor: { name: 'Leverandør A/S' }, item: { name: 'Vare' } });
  });

  it('types every read: expenses, activities, approvers, coding options and vendors', async () => {
    const vendor = { id: 'V1', name: 'Leverandør A/S', identification: '12345678', website: 'https://leverandoer.example', iban: BANK, bankAccounts: [{ number: BANK }] };
    const { impl } = stub({
      'GET /external/v2/expenses': { total: 1, offset: 0, count: 25, data: { bills: [{ ...FULL_EXPENSE.data, attachments: undefined }] } },
      'GET /external/v3/expenses/E1': FULL_EXPENSE,
      'GET /external/v2/expenses/E1/activities': {
        activities: [{ activityType: 'Text', body: `Betal til ${BANK} via https://pay.example`, userId: 'U1', created: '2026-11-20T10:00:00Z', link: 'https://x.example' }],
      },
      'GET /external/v2/expenses/E1/approvers': [{ id: 'U2', email: 'a@example.com' }],
      'GET /external/v1/teams/team-own/categories': { data: { categories: [{ id: 'C1', name: 'Varekøb', number: '1310', color: '#fff' }] } },
      'GET /external/v1/teams/team-own/lists': { data: { lists: [{ id: 'LS1', name: 'Projekter', type: 'Custom', onBills: true }] } },
      'GET /external/v1/teams/team-own/lists/LS1/labels': { data: { labels: [{ id: 'LB1', value: 'Projekt 7', listId: 'LS1', secret: 'x' }] } },
      'GET /external/v2/teams/team-own/vendors': { data: [vendor] },
    });
    const gw = gateway(impl);
    const list = await gw.callTool('list_expenses', {});
    expect(list.structuredContent).toMatchObject({
      total: 1,
      offset: 0,
      count: 25,
      bills: [{ id: 'E1', amount: 1240000, vendor: { id: 'V1', name: 'Leverandør A/S' } }],
    });
    const activities = await gw.callTool('get_expense_activities', { expenseId: 'E1' });
    expect(activities.structuredContent).toEqual({
      activities: [{ activityType: 'Text', body: 'Betal til [bank or card number removed] via [link removed]', userId: 'U1', created: '2026-11-20T10:00:00Z' }],
    });
    expect((await gw.callTool('get_expense_approvers', { expenseId: 'E1' })).structuredContent).toEqual({ approvers: [{ id: 'U2' }] });
    expect((await gw.callTool('list_coding_options', {})).structuredContent).toEqual({
      categories: [{ id: 'C1', name: 'Varekøb', number: '1310' }],
      lists: [{ id: 'LS1', name: 'Projekter', type: 'Custom', labels: [{ id: 'LB1', value: 'Projekt 7', listId: 'LS1' }] }],
    });
    const vendors = await gw.callTool('list_vendors', {});
    expect(vendors.structuredContent).toEqual({ vendors: [{ id: 'V1', name: 'Leverandør A/S', identification: '12345678' }] });
    for (const result of [list, activities, vendors]) {
      for (const piece of [BANK, 'http', 'paymentMethod', 'website']) expect(JSON.stringify(result)).not.toContain(piece);
    }
  });

  it("answers a change with what was done, built from its own input, never Corpay's body", async () => {
    const echo = { data: { id: 'E1', iban: BANK, url: 'https://x.example/signed?Signature=abc', paymentMethod: { iban: BANK } } };
    const { impl } = stub({
      'GET /external/v3/expenses/E1': OWN_EXPENSE,
      'PATCH /external/v2/expenses/E1': echo,
      'PATCH /external/v2/expenses/E1/amountlines': echo,
      'POST /external/v2/expenses/E1/activities': echo,
      'PATCH /external/v2/expenses/E1/decline': echo,
      'PATCH /external/v2/expenses/E1/approve': echo,
      'PATCH /external/v2/teams/team-own/vendors/V1/external-id': echo,
      'POST /external/v2/teams/team-own/vendors': { data: [{ id: 'V9', name: 'Ny A/S', iban: BANK, website: 'https://ny.example' }] },
    });
    const gw = gateway(impl);
    const answers = {
      coded: await gw.callTool('set_expense_coding', { expenseId: 'E1', categoryId: 'C1' }),
      lines: await gw.callTool('set_expense_amount_lines', { expenseId: 'E1', amountLines: [{ amount: 600 }, { amount: 400 }] }),
      comment: await gw.callTool('comment_on_expense', { expenseId: 'E1', comment: 'Tjek' }),
      declined: await gw.callTool('decline_expense', { expenseId: 'E1', note: 'Forkert' }),
      approved: await gw.callTool('approve_expense', { expenseId: 'E1' }),
      linked: await gw.callTool('set_vendor_external_id', { vendorId: 'V1', externalId: '2001', source: 'e-conomic' }),
      created: await gw.callTool('create_vendor', { name: 'Ny A/S', website: 'https://ny.example' }),
    };
    expect(answers.coded.structuredContent).toEqual({ coded: true, expenseId: 'E1', categoryId: 'C1' });
    expect(answers.lines.structuredContent).toEqual({ linesSet: true, expenseId: 'E1', lines: 2, total: 1000 });
    expect(answers.comment.structuredContent).toEqual({ commented: true, expenseId: 'E1' });
    expect(answers.declined.structuredContent).toEqual({ declined: true, expenseId: 'E1' });
    expect(answers.approved.structuredContent).toEqual({ approved: true, expenseId: 'E1' });
    expect(answers.linked.structuredContent).toEqual({ linked: true, vendorId: 'V1', externalId: '2001', source: 'e-conomic' });
    expect(answers.created.structuredContent).toEqual({ created: true, vendors: [{ id: 'V9', name: 'Ny A/S' }] });
    for (const result of Object.values(answers)) {
      for (const piece of [BANK, 'http', 'Signature', 'paymentMethod']) expect(JSON.stringify(result)).not.toContain(piece);
    }
  });
});

describe('typed answers: the edges', () => {
  it('removes every kind of link, also in an error that quotes the input', async () => {
    const { impl } = stub({
      'GET /external/v3/expenses/E1': {
        data: {
          ...OWN_EXPENSE.data,
          notes: [{ id: 'N1', value: 'Se [faktura](//pay.example/invoice), skriv til mailto:bogholderi@example.com eller ftp://files.example/a' }],
        },
      },
    });
    const gw = gateway(impl);
    const expense = await gw.callTool('get_expense', { expenseId: 'E1' });
    expect(expense.structuredContent).toMatchObject({
      notes: [{ id: 'N1', value: 'Se [link removed] skriv til [link removed] eller [link removed]' }],
    });
    const invalid = JSON.stringify(await gw.callTool('get_vendor', { vendorId: 'V1', 'https://plain.example/a': 1, '//other.example/b': 2 }));
    for (const piece of ['plain.example', 'other.example']) expect(invalid).not.toContain(piece);
  });

  it('removes a card number written with dots or slashes', async () => {
    const { impl } = stub({
      'GET /external/v3/expenses/E1': { data: { ...OWN_EXPENSE.data, notes: [{ id: 'N1', value: 'Kort 4111.1111.1111.1111 og 5555/5555/5555/4444' }] } },
    });
    const result = await gateway(impl).callTool('get_expense', { expenseId: 'E1' });
    for (const piece of ['4111', '5555']) expect(JSON.stringify(result)).not.toContain(piece);
  });

  it('types the answer of a change too: an id that is not of its kind is left out', async () => {
    const { impl } = stub({ 'GET /external/v3/expenses/E1': OWN_EXPENSE, 'PATCH /external/v2/expenses/E1': {} });
    const result = await gateway(impl).callTool('set_expense_coding', { expenseId: 'E1', categoryId: '4111111111111111', labelIds: ['L1'] });
    expect(result.structuredContent).toEqual({ coded: true, expenseId: 'E1', labelIds: ['L1'] });
  });

  it('keeps company and VAT numbers with their digits', async () => {
    const { impl } = stub({
      'GET /external/v1/teams/team-own': { data: { team: { id: TEAM, name: 'Demo Byg ApS', vat: 'GB123456789', countryCode: 'GB' } } },
      'GET /external/v2/teams/team-own/vendors/V1': { data: { id: 'V1', name: 'A', identification: 'NL123456789B01' } },
    });
    const gw = gateway(impl);
    expect((await gw.callTool('get_company', {})).structuredContent).toEqual({ id: TEAM, name: 'Demo Byg ApS', vat: 'GB123456789', countryCode: 'GB' });
    expect((await gw.callTool('get_vendor', { vendorId: 'V1' })).structuredContent).toEqual({ id: 'V1', name: 'A', identification: 'NL123456789B01' });
  });

  it('passes on a long list whole', async () => {
    const labels = Array.from({ length: 1500 }, (_, i) => ({ id: `LB${i}`, value: `Projekt ${i}`, listId: 'LS1' }));
    const { impl } = stub({
      'GET /external/v1/teams/team-own/categories': { data: { categories: [] } },
      'GET /external/v1/teams/team-own/lists': { data: { lists: [{ id: 'LS1', name: 'Projekter' }] } },
      'GET /external/v1/teams/team-own/lists/LS1/labels': { data: { labels } },
    });
    const result = (await gateway(impl).callTool('list_coding_options', {})).structuredContent as { lists: Array<{ labels: unknown[] }> };
    expect(result.lists[0]!.labels).toHaveLength(1500);
  });

  it('keeps a number a number: one too large to be an amount is left out, never turned into text', async () => {
    const { impl } = stub({ 'GET /external/v3/expenses/E1': OWN_EXPENSE, 'PATCH /external/v2/expenses/E1/amountlines': {} });
    const result = await gateway(impl).callTool('set_expense_amount_lines', { expenseId: 'E1', amountLines: [{ amount: 1_000_000_000_000 }, { amount: 9 }] });
    expect(result.structuredContent).toEqual({ linesSet: true, expenseId: 'E1', lines: 2 });
  });
});

describe('typed answers: the edges, second round', () => {
  const TOKEN_IN_LINK = ['to', 'ken=', 'Q9w8E7r6T5y4'].join('');

  it('removes a link whole: parentheses in its path, a host without a dot, a scheme without "//"', async () => {
    const value = `A https://pay.example/(invoice)?${TOKEN_IN_LINK} B //localhost/invoice?${TOKEN_IN_LINK} C webcal:private-calendar D Note: tekst kl. 14:30`;
    const { impl } = stub({ 'GET /external/v3/expenses/E1': { data: { ...OWN_EXPENSE.data, notes: [{ id: 'N1', value }] } } });
    const gw = gateway(impl);
    const result = await gw.callTool('get_expense', { expenseId: 'E1' });
    expect(result.structuredContent).toMatchObject({ notes: [{ value: 'A [link removed] B [link removed] C [link removed] D Note: tekst kl. 14:30' }] });
    const invalid = JSON.stringify(await gw.callTool('get_vendor', { vendorId: 'V1', [`//localhost/a?${TOKEN_IN_LINK}`]: 1, 'webcal:private': 2 }));
    for (const piece of ['Q9w8E7r6T5y4', 'localhost', 'private']) expect(invalid).not.toContain(piece);
  });

  it('removes a named account number grouped with dots or slashes', async () => {
    const value = 'Konto 12.34.56 og Account no. 12/34/56 og Account no. 1234.567890';
    const { impl } = stub({ 'GET /external/v3/expenses/E1': { data: { ...OWN_EXPENSE.data, notes: [{ id: 'N1', value }] } } });
    const text = JSON.stringify(await gateway(impl).callTool('get_expense', { expenseId: 'E1' }));
    for (const piece of ['12.34', '12/34', '567890']) expect(text).not.toContain(piece);
  });

  it('passes on every label list, however many', async () => {
    const lists = Array.from({ length: 60 }, (_, i) => ({ id: `LS${i}`, name: `Liste ${i}` }));
    const routes: Record<string, unknown> = {
      'GET /external/v1/teams/team-own/categories': { data: { categories: [] } },
      'GET /external/v1/teams/team-own/lists': { data: { lists } },
    };
    for (const list of lists) routes[`GET /external/v1/teams/team-own/lists/${list.id}/labels`] = { data: { labels: [] } };
    const { impl } = stub(routes);
    const result = (await gateway(impl).callTool('list_coding_options', {})).structuredContent as { lists: unknown[] };
    expect(result.lists).toHaveLength(60);
  });

  it('types the connection check: a team id not of its kind is left out', async () => {
    const odd = '1234567890123';
    const { impl } = stub({ 'GET /external/v1/teams': { data: { teams: [{ id: odd, name: 'Demo Byg ApS' }] } } });
    const result = await gateway(impl, { teamId: odd }).callTool('check_connection', {});
    expect(result.structuredContent).toEqual({ teamFound: true, team: { name: 'Demo Byg ApS' } });
  });
});

describe('typed answers: the edges, third round', () => {
  it('removes a link whose scheme is followed by digits, also in an error', async () => {
    const value = 'Skriv sms:12345678?body=fortroligt eller se http:127.0.0.1/private?ticket=ABCD kl. 14:30';
    const { impl } = stub({ 'GET /external/v3/expenses/E1': { data: { ...OWN_EXPENSE.data, notes: [{ id: 'N1', value }] } } });
    const gw = gateway(impl);
    const result = await gw.callTool('get_expense', { expenseId: 'E1' });
    expect(result.structuredContent).toMatchObject({ notes: [{ value: 'Skriv [link removed] eller se [link removed] kl. 14:30' }] });
    const invalid = JSON.stringify(await gw.callTool('get_vendor', { vendorId: 'V1', 'sms:12345678?body=fortroligt': 1, 'http:127.0.0.1/private': 2 }));
    for (const piece of ['fortroligt', '127.0.0.1', 'private']) expect(invalid).not.toContain(piece);
  });

  it('removes a card number that stands where a long text is cut', async () => {
    const value = `${'x'.repeat(19_988)}4111111111111111`;
    const { impl } = stub({ 'GET /external/v3/expenses/E1': { data: { ...OWN_EXPENSE.data, notes: [{ id: 'N1', value }] } } });
    const text = JSON.stringify(await gateway(impl).callTool('get_expense', { expenseId: 'E1' }));
    expect(text).not.toContain('4111');
  });

  it('keeps a time with fractions of a second', async () => {
    const dueDate = '2026-11-27T12:34:56.1234567Z';
    const { impl } = stub({ 'GET /external/v3/expenses/E1': { data: { ...OWN_EXPENSE.data, dueDate, issueDate: '2026-11-01T08:00:00+01:00' } } });
    const result = await gateway(impl).callTool('get_expense', { expenseId: 'E1' });
    expect(result.structuredContent).toMatchObject({ dueDate, issueDate: '2026-11-01T08:00:00+01:00' });
  });

  it('leaves out a number that redaction would turn into text, so every field keeps its type', async () => {
    const secret = `${fake('withdigits', 12)}124000${fake('rest', 10)}`;
    const { impl } = stub({ 'GET /external/v3/expenses/E1': { data: { ...OWN_EXPENSE.data, amount: 1240000, number: 7 } } });
    const result = await gateway(impl, { clientSecret: secret }).callTool('get_expense', { expenseId: 'E1' });
    const content = result.structuredContent as Record<string, unknown>;
    expect(content.amount).toBeUndefined();
    expect(content.number).toBe(7);
    expect(JSON.stringify(result)).not.toContain('124000');
  });
});

describe('typed answers: the edges, fourth round', () => {
  it('removes a link whole, apostrophes in its path too, also in an error', async () => {
    const signed = ['https://attachments.example/O', "'", 'Reilly.pdf?Sig', 'nature=Fortrolig&Key-Pair-Id=K'].join('');
    const { impl } = stub({ 'GET /external/v3/expenses/E1': { data: { ...OWN_EXPENSE.data, notes: [{ id: 'N1', value: `Bilag ${signed} her` }] } } });
    const gw = gateway(impl);
    const result = await gw.callTool('get_expense', { expenseId: 'E1' });
    expect(result.structuredContent).toMatchObject({ notes: [{ value: 'Bilag [link removed] her' }] });
    const invalid = JSON.stringify(await gw.callTool('get_vendor', { vendorId: 'V1', [signed]: 1 }));
    for (const piece of ['Reilly', 'Fortrolig']) expect(invalid).not.toContain(piece);
  });

  it('removes a bare host name with a path or a common ending, also in an error', async () => {
    const value = 'Se example.com/invoice?ticket=privat, eller leverandoer.dk, f.eks. kl. 14.30, bl.a. 1.240,00 kr.';
    const { impl } = stub({ 'GET /external/v3/expenses/E1': { data: { ...OWN_EXPENSE.data, notes: [{ id: 'N1', value }] } } });
    const gw = gateway(impl);
    const result = await gw.callTool('get_expense', { expenseId: 'E1' });
    expect(result.structuredContent).toMatchObject({ notes: [{ value: 'Se [link removed] eller [link removed] f.eks. kl. 14.30, bl.a. 1.240,00 kr.' }] });
    const invalid = JSON.stringify(await gw.callTool('get_vendor', { vendorId: 'V1', 'example.com/invoice?ticket=privat': 1 }));
    expect(invalid).not.toContain('privat');
  });

  it('never cuts a long text, so a long token is still seen and redacted whole', async () => {
    const token = ['eyJhbGciOiJIUzI1NiJ9', `eyJzdWIiOiJ${'Q'.repeat(20_050)}`, 'c2lnbmF0dXJlLXZhbHVl'].join('.');
    const { impl } = stub({ 'GET /external/v3/expenses/E1': { data: { ...OWN_EXPENSE.data, notes: [{ id: 'N1', value: `Token ${token}` }] } } });
    const text = JSON.stringify(await gateway(impl).callTool('get_expense', { expenseId: 'E1' }));
    expect(text).not.toContain('QQQQQQQQ');
    expect(text).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });
});

describe('typed answers: the edges, fifth round', () => {
  it('removes IP addresses, any host name and a signed link with an apostrophe, also in an error', async () => {
    const value = "Se 192.168.1.20/invoice?ticket=PRIVAT og customer.finance og kunde.nr/sti?x=1, Reg.nr. 1234, f.eks. her";
    const { impl } = stub({ 'GET /external/v3/expenses/E1': { data: { ...OWN_EXPENSE.data, notes: [{ id: 'N1', value }] } } });
    const gw = gateway(impl);
    const result = await gw.callTool('get_expense', { expenseId: 'E1' });
    expect(result.structuredContent).toMatchObject({
      notes: [{ value: 'Se [link removed] og [link removed] og [link removed] Reg.nr. [bank or card number removed], f.eks. her' }],
    });
    const signed = ['https://pay.example/invoice?Sig', "nature=abc'PRIVATE_PATH&Expires=123"].join('');
    const invalid = JSON.stringify(await gw.callTool('get_vendor', { vendorId: 'V1', [signed]: 1, '192.168.1.20/x': 2 }));
    for (const piece of ['PRIVATE_PATH', 'Expires', '192.168']) expect(invalid).not.toContain(piece);
  });

  it('removes links in time linear in the length of the text', async () => {
    const { removeLinks } = await import('../src/corpay/gateway-answers.js');
    for (const text of [`${'a.'.repeat(100_000)}!`, `${'-.'.repeat(100_000)}x`, `${'a:'.repeat(100_000)}`, `${'1.'.repeat(100_000)}`]) {
      const started = performance.now();
      removeLinks(text);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });
});

describe('typed answers: the edges, sixth round', () => {
  it('removes short, internationalised and long-scheme links, also in an error', async () => {
    const long = `${'a'.repeat(40)}:private-calendar?ticket=PRIVAT1`;
    const value = `A t.co B x.com C example.mm D xn--e1afmkfd.xn--p1ai/private?ticket=PRIVAT2 E 中国.公司/private?ticket=PRIVAT3 F ${long} G e.g. f.eks. bl.a. Reg.nr. og 1.240,00 kr.`;
    const { impl } = stub({ 'GET /external/v3/expenses/E1': { data: { ...OWN_EXPENSE.data, notes: [{ id: 'N1', value }] } } });
    const gw = gateway(impl);
    const result = await gw.callTool('get_expense', { expenseId: 'E1' });
    expect(result.structuredContent).toMatchObject({
      notes: [{ value: 'A [link removed] B [link removed] C [link removed] D [link removed] E [link removed] F [link removed] G e.g. f.eks. bl.a. Reg.nr. og 1.240,00 kr.' }],
    });
    const invalid = JSON.stringify(await gw.callTool('get_vendor', { vendorId: 'V1', '中国.公司/private?ticket=PRIVAT3': 1, [long]: 2, 't.co': 3 }));
    for (const piece of ['PRIVAT', '中国', 't.co']) expect(invalid).not.toContain(piece);
  });
});

describe('typed answers: the edges, seventh round', () => {
  it('removes paths, queries, IPv6 literals and full-width dots, and keeps short plain words with a slash', async () => {
    const value =
      'A example。com/invoice?ticket=HEMMELIG1 B localhost/invoice C 127.1/invoice D [::1]/invoice E intern?ticket=HEMMELIG2 F faktura/kreditnota G Byg A/S, 27/11/2026, 500 kr/md. Leverandør A/S.';
    const { impl } = stub({ 'GET /external/v3/expenses/E1': { data: { ...OWN_EXPENSE.data, notes: [{ id: 'N1', value }] } } });
    const gw = gateway(impl);
    const result = await gw.callTool('get_expense', { expenseId: 'E1' });
    expect(result.structuredContent).toMatchObject({
      notes: [
        {
          value:
            'A [link removed] B [link removed] C [link removed] D [link removed] E [link removed] F [link removed] G Byg A/S, 27/11/2026, 500 kr/md. Leverandør A/S.',
        },
      ],
    });
    const invalid = JSON.stringify(
      await gw.callTool('get_vendor', { vendorId: 'V1', 'example。com/invoice?ticket=HEMMELIG1': 1, 'localhost/invoice': 2, '[::1]/x': 3 }),
    );
    for (const piece of ['HEMMELIG', 'localhost', '::1']) expect(invalid).not.toContain(piece);
  });

  it('still scans in linear time', async () => {
    const { removeLinks } = await import('../src/corpay/gateway-answers.js');
    for (const text of [`[${':'.repeat(100_000)}`, `${'?'.repeat(100_000)}`, `${'a/'.repeat(100_000)}`, `${'[:'.repeat(100_000)}`]) {
      const started = performance.now();
      removeLinks(text);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });
});
