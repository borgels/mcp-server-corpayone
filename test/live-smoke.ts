/**
 * Live read-only smoke test against the real Corpay One API.
 *
 * Not part of `npm test` — it needs real credentials and reaches the network.
 * Run it during bring-up of a new deployment:
 *
 *   CORPAYONE_TEAM_ID=<team> npx tsx test/live-smoke.ts
 *
 * Every call here is a GET. Nothing is written, and the team boundary is
 * exercised by asking for a team the server is not scoped to.
 */
import { CorpayClient } from '../src/corpay/client.js';
import { pinnedTeamId } from '../src/corpay/team.js';
import { grantedScopes, hasScope } from '../src/corpay/scopes.js';
import { formatUnknownError } from '../src/errors.js';

const client = new CorpayClient();
let failures = 0;

async function check(name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    const result = await run();
    console.log(`  ok    ${name}${summarize(result)}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${name}: ${formatUnknownError(error)}`);
  }
}

/** Run only if the grant holds `scope`; otherwise record it as skipped. */
async function optional(scope: string, name: string, run: () => Promise<unknown>): Promise<void> {
  if (!hasScope(scope)) {
    console.log(`  skip  ${name} (needs scope ${scope})`);
    return;
  }
  await check(name, run);
}

async function firstExpenseId(c: CorpayClient): Promise<string | undefined> {
  try {
    const r = await c.request<{ data?: { bills?: Array<{ id?: string }> } }>({
      method: 'GET',
      path: '/v2/expenses',
      query: { Count: 10 },
    });
    return r?.data?.bills?.[0]?.id;
  } catch {
    return undefined;
  }
}

/** The inverse: the call is expected to fail, and passing would be the bug. */
async function checkRejects(name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    failures += 1;
    console.log(`  FAIL  ${name}: expected a rejection, but the call succeeded`);
  } catch {
    console.log(`  ok    ${name} (rejected as intended)`);
  }
}

function summarize(result: unknown): string {
  const data = (result as { data?: Record<string, unknown> } | undefined)?.data;
  if (!data || typeof data !== 'object') return '';
  const entries = Object.entries(data).map(([key, value]) =>
    Array.isArray(value) ? `${key}=${value.length}` : key,
  );
  return entries.length ? ` — ${entries.join(', ')}` : '';
}

async function main(): Promise<void> {
  const team = pinnedTeamId();
  console.log(`Corpay One live smoke test${team ? ` (team ${team})` : ' (no team pinned)'}`);
  console.log(`scopes: ${[...grantedScopes()].sort().join(' ')}
`);

  await check('GET /v1/teams', () =>
    client.request({ method: 'GET', path: '/v1/teams', withTeamId: false }),
  );

  if (!team) {
    console.log('\nSet CORPAYONE_TEAM_ID to exercise the team-scoped reads.');
    process.exit(failures ? 1 : 0);
  }

  const base = `/v1/teams/${encodeURIComponent(team)}`;
  await check('GET team', () => client.request({ method: 'GET', path: base, withTeamId: false }));
  await check('GET modules', () =>
    client.request({ method: 'GET', path: `${base}/modules`, withTeamId: false }),
  );
  await check('GET categories', () =>
    client.request({ method: 'GET', path: `${base}/categories`, withTeamId: false }),
  );
  await check('GET lists', () =>
    client.request({ method: 'GET', path: `${base}/lists`, withTeamId: false }),
  );
  // Scope-gated reads are only exercised when the grant holds the scope; they
  // are skipped rather than reported as failures, since a standard grant is
  // expected not to reach them.
  await optional('departments.all', 'GET departments', () =>
    client.request({ method: 'GET', path: `${base}/departments`, withTeamId: false }),
  );
  await optional('items.read', 'GET items', () =>
    client.request({
      method: 'GET',
      path: `/v2/teams/${encodeURIComponent(team)}/items`,
      withTeamId: false,
    }),
  );
  await check('GET vendors', () =>
    client.request({
      method: 'GET',
      path: `/v2/teams/${encodeURIComponent(team)}/vendors`,
      withTeamId: false,
    }),
  );
  await check('GET expenses', () =>
    client.request({ method: 'GET', path: '/v2/expenses', query: { Count: 10 } }),
  );
  await optional('cardtransactions.all', 'GET credit accounts', () =>
    client.request({
      method: 'GET',
      path: `/v2/creditaccounts/team/${encodeURIComponent(team)}`,
      withTeamId: false,
    }),
  );
  await optional('payments.all', 'GET payment methods', () =>
    client.request({ method: 'GET', path: '/v1/payments/methods' }),
  );
  await optional('teams.members.list', 'GET members', () =>
    client.request({ method: 'GET', path: `${base}/members`, withTeamId: false }),
  );
  await check('GET webhooks', () => client.request({ method: 'GET', path: '/v1/webhooks' }));

  const first = await firstExpenseId(client);
  if (first) {
    await check('GET expense (v3)', () =>
      client.request({ method: 'GET', path: `/v3/expenses/${first}`, withTeamId: false }),
    );
    await check('GET expense activities', () =>
      client.request({ method: 'GET', path: `/v2/expenses/${first}/activities` }),
    );
    await check('GET expense approvers', () =>
      client.request({ method: 'GET', path: `/v2/expenses/${first}/approvers` }),
    );
  }

  // The boundary itself: asking for another team must not reach the network.
  await checkRejects('cross-team read is refused', () =>
    client.request({ method: 'GET', path: '/v2/expenses', query: { teamId: 'NOT_THIS_TEAM' } }),
  );

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch(error => {
  console.error(formatUnknownError(error));
  process.exit(1);
});
