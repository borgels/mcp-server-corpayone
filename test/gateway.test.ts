// The embeddable gateway (src/gateway.ts): host credentials only, one team per instance, a renewed refresh token
// handed back before anything else is sent, direct changes under the host's policy, and nothing that leaves an
// instance holds a piece of a secret.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { corpayToolCatalog, createCorpayGateway, type CorpayGatewayOptions } from '../src/gateway.js';
import { visibleTexts } from '../src/key-admission.js';
import { scrub } from '../src/corpay/gateway-tools.js';

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
        data: { ...OWN_EXPENSE.data, note: 'Invoice: https://attachments.corpayone.com/x.pdf?Expires=1&Signature=abc&Key-Pair-Id=K attached; pay to IBAN DK5000400440116243, card 4111 1111 1111 1111, order 987654321097', attachments: [{ id: 'A1', url: 'https://attachments.corpayone.com/x.pdf?Expires=1&Signature=abc&Key-Pair-Id=K' }] },
      },
    });
    const gw = gateway(impl);
    const vendor = await gw.callTool('get_vendor', { vendorId: 'V1' });
    expect(vendor.structuredContent).toEqual({ data: { id: 'V1', name: 'A', logo: '[link removed]' } });
    const expense = await gw.callTool('get_expense', { expenseId: 'E1' });
    expect(JSON.stringify(expense)).not.toContain('Signature');
    expect(JSON.stringify(expense)).toContain('Invoice: [link removed] attached; pay to IBAN [bank or card number removed], card [bank or card number removed], order 987654321097');
  });

  it('scrubs every answer, also the team name in the connection check', async () => {
    const name = 'Firma https://x.example/a?Signature=abc IBAN DK5000400440116243 4111 1111 1111 1111 123, 4111111111111111999 og 12 5555 5555 5555 4444, 41111111111111119999 og 94111111111111111 slut';
    const { impl } = stub({
      'GET /external/v1/teams': { data: { teams: [{ id: TEAM, name }] } },
      'GET /external/v1/teams/team-own': {
        data: { name: 'A PAN4111111111111111 og 4111111111111111USD og gb29nwbk60161331926819 og IBANgb29nwbk60161331926819 og DK50\t0040\t0440\t1162\t43 og 4111\t1111\u00a01111 1111 og https://files.example/invoice?sv=2024-01-01&%73ig=abcdef og id ab12cdefghijklmnop og GB29  NWBK  6016  1331  9268  19 og 5555  5555  5555  4444 og ref1234 GB29NWBK60161331926819 og ref1059 GB29NWBK60161331926819 og Account #: 1234567890 og Reg.nr. 9876 Konto 3456789012 og <a href="https://files.example/i?sv=1&amp;sig=abcdef">bilag</a> og Konto nr. 22334455 og Account (DKK): 66778899 og A/C 55443322 og GB29-NWBK-6016-1331-9268-19 og 4111.1111.1111.1111 og 5555‑5555‑5555‑4444 og https://files.example/bob\'s.pdf?Expires=2000000000&Signature=abc&Key-Pair-Id=K og //files.example/i.pdf?Expires=2000000000&Signature=abc og https://files.example/x.pdf?hdnts=exp=2000000000~acl=/*~hmac=a1d9',
          accountNo: '12345678',
          bankAccountNo: '12345678',
          account: { number: '12345678' },
          acct: { details: { number: '87654321' } },
          'account.number': '22334455',
          cvv2: '123',
          cvc2: '456',
          payee: { reference: '33445566' },
          uuid: '9ff6e103-1fb4-41ed-be17-8ae66ab1877b',
          vendorId: '9ff6e103-1fb4-41ed-be17-8ae66ab1877b',
          pan12: 'PAN 501800000009',
          pan12n: 501800000009,
          entity: '<a href="https://files.example/i.pdf?sig&#61;abc">file</a>',
          encoded: 'https%3A%2F%2Ffiles.example%2Fi.pdf%3Fsig%3Dabc',
          relative: '/invoice.pdf?sig=abc',
          imgix: 'https://example.imgix.net/invoice.pdf?s=e277f90a8d8f26a7a94942c435c5cdf3',
          bankruptcyStatus: 'none',
          accounting: { number: 4000 },
          report: 'https://example.test/report?code=DKK',
          signedUuid: 'File https://files.example/9ff6e103-1fb4-41ed-be17-8ae66ab1877b.pdf?sig=abcdef',
          entityScheme: '<a href="https&#58;&#47;&#47;files.example/a?sig=abcdef">file</a>',
          doubleEncoded: 'https%253A%252F%252Ffiles.example%252Fa%253Fsig%253Dabcdef',
          bare: 'invoice.pdf?sig=abcdef',
          bankAccountNumbers: ['12345678'],
          routingCode: '123456789',
          bsb: '123456',
          aba: '021000021',
          bankAccountId: 'DK5000400440116243',
          cardId: '4111111111111111',
          trailing: 'card 501800000009 0',
          labels: 'Account number is 12345678 og Pay to Account No: 12/34/567890',
          slashes: '/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a',
          plain: 'https://public.example/report.pdf',
          bareDownload: 'download?sig=abcdef',
          dotSlash: './file?sig=abcdef',
          nested: 'files/invoice.pdf?sig=abcdef',
          fiveTimes: '%2525252568ttps%252525253A%252525252F%252525252Ffiles.example%252525252Fi%252525253Fsig%252525253Dabc',
          imagekit: 'https://ik.imagekit.io/demo/private.jpg?ik-s=abcdef&ik-t=9999999999',
          bankRoutingNumber: '021000021',
          cardSecurityCode: '123',
          creditCard: { number: '12345678' },
          beneficiary: { number: '12/34/567890' },
          slashedCard: '4111/1111/1111/1111',
          spaced: 'Account number:         12345678',
          htmlPan: '&#52;&#49;&#49;&#49;&#49;&#49;&#49;&#49;&#49;&#49;&#49;&#49;&#49;&#49;&#49;&#49;',
          perHex: 'https://x.example/a%25%33%46sig%25%33%44abcdef',
          nbspNumbers: 'GB29&nbsp;NWBK&nbsp;6016&nbsp;1331&nbsp;9268&nbsp;19; 4111&nbsp;1111&nbsp;1111&nbsp;1111',
          newline: 'https://files.example/invoice.pdf?si\ng=abcdef',
          cloudinary: 'https://res.cloudinary.com/demo/image/authenticated/s--iDy_JeBq--/c_fill,w_300/sample.png',
          quoted: 'Account number: "12345678"; CVV is 123; Expiry: 12/28',
          jsonText: '{"accountNumber":"12345678","cvv":"123"}',
          CARDDetails: { number: '12345678', code: '123' },
          CID: '1234',
          beneficiaryAccount: { number: '12345678 DKK' },
          transitionId: 'T1',
          carddetails: { number: '12345678', code: '123' },
          beneficiaries: [{ number: '12345678' }],
          cardStuff: { details: '{"code":"123","month":"12","year":"28"}' },
          markup: '<b>Account number:</b> 98765432 og <span>4111</span><span>1111</span><span>1111</span><span>1111</span>',
          percent: '4111%201111%201111%201111',
          wwwInside: 'See (www.example.test/private/signed-token).',
          splitLink: 'https://files.example/a?sig=\nabcdef',
          separated: 'CVV: 1 2 3; Expiry: 2028-12',
          payeeIds: { payee: { id: '24681357', vendorId: 'V24681357' } },
          nestedHtml: 'https://x/a&amp;amp;amp;#63;sig&amp;amp;amp;#61;abc',
          dashLabel: 'Account number - 12345678',
          cardVerificationValue: '123',
          cardDetails: { code: '123', expiryMonth: '12', expiryYear: '28' },
          cvvText: 'CVV: 123',
          accountingBank: { number: '12345678' },
          discarded: { amount: 5000, id: '12345' },

          url: "https://files.example/bob's.pdf?Expires=2000000000&Signature=abc",
          gb29nwbk60161331926819: 3, card: 4111111111111111, big: 6221234567890598594, small: 42, '4111111111111111': 1, 'https://x.example/a?Signature=abc': 2 },
      },
    });
    const gw = gateway(impl);
    const text = JSON.stringify(await gw.callTool('check_connection', {}));
    for (const piece of ['Signature', 'DK5000400440116243', '4111 1111', '41111111', '5555 5555']) expect(text).not.toContain(piece);
    const company = JSON.stringify(await gw.callTool('get_company', {}));
    expect(company).not.toContain('4111111111111111');
    expect(company).not.toContain('Signature');
    expect(company).not.toContain('gb29nwbk');
    for (const piece of ['0440', '4111', '%73ig', 'NWBK', '5555', '9876', '3456789012', 'sig=abcdef', '1331926819', '1234567890', '622123', '22334455', '66778899', '55443322', '12345678', 'Signature', 'hmac', 'Key-Pair']) {
      expect(company).not.toContain(piece);
    }
    for (const piece of ['87654321', '33445566', '501800000009', 'sig&#61;abc', 'sig%3Dabc', 'sig=abc', 's=e277f90a', '"cvv2"', '"cvc2"', 'sig%253D', '123456789', '021000021', 'DK5000400440116243', '567890']) {
      expect(company).not.toContain(piece);
    }
    // Every link is removed, signed or not: a key may stand anywhere in one.
    expect(company).not.toContain('public.example');
    for (const piece of ['6016', 'iDy_JeBq', 'si\\ng', '"CARDDetails":{"number"', '"CID"', '12345678 DKK', 'CVV is 123', '12/28', 'accountNumber']) {
      expect(company).not.toContain(piece);
    }
    expect(company).toContain('"transitionId":"T1"');
    for (const piece of ['"carddetails"', '"beneficiaries":[{"number"', '"month"', '98765432', '4111%20', 'www.example', 'abcdef', '1 2 3', '2028-12']) {
      expect(company).not.toContain(piece);
    }
    expect(company).toContain('"payee":{"id":"24681357","vendorId":"V24681357"}');
    for (const piece of ['sig%25%33%44', 'amp;#61', '"cardVerificationValue"', '"expiryMonth"', '"code":"123"', 'CVV: 123', '"accountingBank":{"number"']) {
      expect(company).not.toContain(piece);
    }
    expect(company).toContain('"discarded":{"amount":5000,"id":"12345"}');
    for (const piece of ['sig=abcdef', 'ik-s', '021000021', '"cardSecurityCode"', '"creditCard":{"number"', '567890', '4111/1111', '         12345678', '&#52;&#49;', 'sig%252525253D']) {
      expect(company).not.toContain(piece);
    }

    // Ids, ordinary fields and ordinary links are kept as they are.
    expect(company).toContain('"uuid":"9ff6e103-1fb4-41ed-be17-8ae66ab1877b"');
    expect(company).toContain('"vendorId":"9ff6e103-1fb4-41ed-be17-8ae66ab1877b"');
    expect(company).toContain('"bankruptcyStatus":"none"');
    expect(company).toContain('"accounting":{"number":4000}');
    // Any link with a query that sets a value is removed: the names of signing keys cannot all be known.
    expect(company).not.toContain('report?code=DKK');
    // Letters and digits that fail the IBAN check are kept.
    expect(company).toContain('ab12cdefghijklmnop');
    expect(company).toContain('"small":42');
    // An error that quotes the input is scrubbed too.
    const invalid = JSON.stringify(await gw.callTool('get_vendor', { vendorId: 'V1', 'https://x.example/a?Signature=abc': 1 }));
    expect(invalid).not.toContain('Signature');
  });

  it('looks for a query and reads field names in linear time', () => {
    const started = Date.now();
    scrub({ note: '?'.repeat(200_000), other: `${'%25'.repeat(50_000)}3F`, ['A'.repeat(200_000)]: 1 });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('keeps ids as they are, in the data and in the text alike', async () => {
    const { impl } = stub({ 'GET /external/v1/teams/team-own': { data: { id: '4111111111111111', companyId: '4111111111111111', labelIds: ['label-4111111111111111'], cardId: '4111111111111111' } } });
    const result = await gateway(impl).callTool('get_company', {});
    const data = (result.structuredContent as { data: Record<string, unknown> }).data;
    expect(data.id).toBe('4111111111111111');
    expect(data.labelIds).toEqual(['label-4111111111111111']);
    expect(data.companyId).toBe('4111111111111111');
    expect(data.cardId).toBe('[bank or card number removed]');
    expect(result.content[0]!.text).toContain('"id":"4111111111111111"');
  });

  it('keeps the text and the data of an answer the same, ids included', async () => {
    const { impl } = stub({ 'GET /external/v1/teams/team-own': { data: { id: 'b7c1e2f0-1a2b-4c3d-9e8f-0a1b2c3d4e5f', name: 'A' } } });
    const result = await gateway(impl).callTool('get_company', {});
    expect(result.content[0]!.text).toContain(JSON.stringify(result.structuredContent));
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
