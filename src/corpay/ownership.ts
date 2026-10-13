import type { CorpayClient } from './client.js';
import { encodePathSegment } from './catalog.js';
import { isTeamKey, TeamScopeError } from './team.js';

/**
 * Resource ownership checks for by-id endpoints.
 *
 * Endpoints such as `/v3/expenses/{expenseId}` or `/v1/webhooks/{webhookId}`
 * address a resource by its id alone; the `teamId` query parameter the client
 * adds is not something Corpay is documented to enforce there. On a server
 * pinned to one team (CORPAYONE_TEAM_ID), an id belonging to another company
 * the grant can reach would otherwise be read or written. So before such a
 * call the resource is fetched and its team compared with the pinned one.
 *
 * The check fails closed: if the team of the resource cannot be determined,
 * the call is refused.
 */
export type TeamOwnedResource = 'expense' | 'webhook';

/** Path parameters that name a resource whose team must be verified. */
const OWNED_PARAMS: Record<string, TeamOwnedResource> = {
  expenseId: 'expense',
  webhookId: 'webhook',
};

function readPath(kind: TeamOwnedResource, id: string): string {
  const segment = encodePathSegment(id, `${kind} id`);
  return kind === 'expense' ? `/v3/expenses/${segment}` : `/v1/webhooks/${segment}`;
}

/**
 * Fetch a by-id resource and, when the client is pinned to a team, verify it
 * belongs to that team. Returns the raw response so callers that wanted the
 * resource anyway do not read it twice.
 */
export async function fetchResourceInTeam<T = unknown>(
  client: CorpayClient,
  kind: TeamOwnedResource,
  id: string,
): Promise<T> {
  const payload = await client.request<T>({ method: 'GET', path: readPath(kind, id) });
  const pinned = client.pinnedTeam();
  if (pinned) assertPayloadInTeam(payload, kind, id, pinned);
  return payload;
}

/**
 * Throw unless the resource belongs to the pinned team. A no-op (and no
 * network call) when the client is not pinned to a team.
 */
export async function assertResourceInTeam(
  client: CorpayClient,
  kind: TeamOwnedResource,
  id: string,
): Promise<void> {
  if (!client.pinnedTeam()) return;
  await fetchResourceInTeam(client, kind, id);
}

/**
 * Verify every team-owned resource named in the path parameters of an
 * allowlisted template (e.g. `{expenseId}`, `{webhookId}`).
 */
export async function assertPathParamsInTeam(
  client: CorpayClient,
  pathTemplate: string,
  pathParams: Record<string, string | number> | undefined,
): Promise<void> {
  if (!client.pinnedTeam()) return;
  for (const match of pathTemplate.matchAll(/\{(\w+)\}/g)) {
    const name = match[1] as string;
    const kind = OWNED_PARAMS[name];
    if (!kind) continue;
    const value = pathParams?.[name];
    if (value === undefined) continue; // materializePath reports the missing param
    await assertResourceInTeam(client, kind, String(value));
  }
}

/** Compare the team found in a resource payload with the pinned team. */
export function assertPayloadInTeam(
  payload: unknown,
  kind: TeamOwnedResource,
  id: string,
  pinned: string,
): void {
  const owner = extractTeamId(payload, kind);
  if (owner === undefined) {
    throw new TeamScopeError(
      `Could not determine which team ${kind} "${id}" belongs to; refusing to act on it from a team-scoped server.`,
    );
  }
  if (owner !== pinned) {
    throw new TeamScopeError(
      `This server is scoped to a single Corpay One team; ${kind} "${id}" belongs to another team.`,
    );
  }
}

/**
 * Find the owning team id in a Corpay response. Corpay wraps single resources
 * as `{ data: { ... } }` (sometimes `{ data: { expense: { ... } } }`) and
 * names the field `teamId` (casing varies) or nests it as `team: { id }`,
 * directly or under `owner` (expenses: `data.owner.team.id`).
 * Returns undefined when no team is present, or when the candidates disagree.
 */
export function extractTeamId(payload: unknown, kind?: TeamOwnedResource): string | undefined {
  const candidates = new Set<string>();
  const visit = (node: unknown): void => {
    if (!isRecord(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (isTeamKey(key) && typeof value === 'string' && value.trim()) {
        candidates.add(value.trim());
      }
      if (key.toLowerCase() === 'team' && isRecord(value) && typeof value.id === 'string' && value.id.trim()) {
        candidates.add(value.id.trim());
      }
    }
  };

  const data = isRecord(payload) ? payload.data : undefined;
  visit(payload);
  visit(data);
  // Live /v3/expenses/{id} responses carry the team as data.owner.team.id.
  if (isRecord(data)) visit(data.owner);
  if (kind && isRecord(data)) {
    visit(data[kind]);
    const nested = data[kind];
    if (isRecord(nested)) visit(nested.owner);
  }

  return candidates.size === 1 ? [...candidates][0] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
