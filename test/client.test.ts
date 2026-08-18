import { afterEach, describe, expect, it, vi } from 'vitest';
import { CorpayClient } from '../src/corpay/client.js';
import { TeamScopeError } from '../src/corpay/team.js';

const PINNED = 'TEAM_ALPHA';
const OTHER = 'TEAM_BETA';

afterEach(() => {
  delete process.env.CORPAYONE_TEAM_ID;
  vi.restoreAllMocks();
});

/** A fetch double that records calls and answers the token endpoint. */
function stubFetch(responder?: (url: string, init: RequestInit) => unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.includes('/connect/token')) {
      return jsonResponse({ access_token: 'access-token-value', expires_in: 3600 });
    }
    calls.push({ url, init });
    return jsonResponse(responder?.(url, init) ?? { ok: true });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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

describe('team scoping in the client', () => {
  it('adds the pinned team to the query', async () => {
    const { impl, calls } = stubFetch();
    await makeClient(impl, PINNED).request({ method: 'GET', path: '/v2/expenses' });
    expect(new URL(calls[0]!.url).searchParams.get('teamId')).toBe(PINNED);
  });

  it('rejects a caller-supplied team that differs', async () => {
    const { impl } = stubFetch();
    await expect(
      makeClient(impl, PINNED).request({ method: 'GET', path: '/v2/expenses', query: { teamId: OTHER } }),
    ).rejects.toThrow(TeamScopeError);
  });

  it('rejects a differently-cased team parameter too', async () => {
    const { impl } = stubFetch();
    await expect(
      makeClient(impl, PINNED).request({ method: 'GET', path: '/v2/expenses', query: { TeamId: OTHER } }),
    ).rejects.toThrow(TeamScopeError);
  });

  it('collapses a duplicate team parameter onto the pinned value', async () => {
    const { impl, calls } = stubFetch();
    await makeClient(impl, PINNED).request({
      method: 'GET',
      path: '/v2/expenses',
      query: { TeamId: PINNED, State: 'Awaiting' },
    });
    // Normalized to a single lower-camel teamId. Corpay declares the parameter
    // as TeamId on this endpoint, but its model binding is case-insensitive.
    const params = new URL(calls[0]!.url).searchParams;
    expect(params.getAll('teamId')).toEqual([PINNED]);
    expect(params.has('TeamId')).toBe(false);
    expect(params.get('State')).toBe('Awaiting');
  });

  it('omits the team when the endpoint does not take one', async () => {
    const { impl, calls } = stubFetch();
    await makeClient(impl, PINNED).request({ method: 'GET', path: '/v1/teams', withTeamId: false });
    expect(new URL(calls[0]!.url).searchParams.get('teamId')).toBeNull();
  });

  it('rewrites a team carried in the request body', async () => {
    const { impl, calls } = stubFetch();
    await makeClient(impl, PINNED).request({
      method: 'POST',
      path: '/v1/webhooks',
      body: { url: 'https://example.test/hook', teamId: PINNED },
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ teamId: PINNED });
  });

  it('rejects a foreign team nested in the request body', async () => {
    const { impl } = stubFetch();
    await expect(
      makeClient(impl, PINNED).request({
        method: 'POST',
        path: '/v2/expenses',
        body: { expenses: [{ name: 'bill.pdf', teamId: OTHER }] },
      }),
    ).rejects.toThrow(TeamScopeError);
  });

  it('leaves the query alone when no team is pinned', async () => {
    const { impl, calls } = stubFetch();
    await makeClient(impl).request({ method: 'GET', path: '/v2/expenses', query: { teamId: OTHER } });
    expect(new URL(calls[0]!.url).searchParams.get('teamId')).toBe(OTHER);
  });
});

describe('request handling', () => {
  it('honours an explicit Content-Type for JSON Patch', async () => {
    const { impl, calls } = stubFetch();
    await makeClient(impl, PINNED).request({
      method: 'PATCH',
      path: '/v2/expenses/E1',
      body: [{ op: 'replace', path: '/categoryId', value: 'C1' }],
      headers: { 'Content-Type': 'application/json-patch+json' },
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json-patch+json');
  });

  it('surfaces API errors with status and redacted url', async () => {
    const impl = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/connect/token')) {
        return jsonResponse({ access_token: 'tok', expires_in: 3600 });
      }
      return jsonResponse({ title: 'Not found' }, 404);
    }) as unknown as typeof fetch;

    await expect(makeClient(impl, PINNED).request({ method: 'GET', path: '/v3/expenses/nope' })).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it('refuses to send credentials over plain http', () => {
    expect(
      () =>
        new CorpayClient({
          clientId: 'id',
          clientSecret: 'secret',
          refreshToken: 'refresh',
          apiBaseUrl: 'http://api.example.test/external',
        }),
    ).toThrow(/Refusing to send/);
  });
});
