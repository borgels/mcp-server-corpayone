/**
 * Team (company) scoping.
 *
 * One Corpay One OAuth grant reaches every team its user belongs to, and the
 * team is chosen per request — a `teamId` query parameter on some endpoints, a
 * `{teamId}` path segment on others. A deployment that serves one company per
 * instance therefore cannot rely on a *default*: a caller supplying their own
 * teamId would otherwise read another company's ledger.
 *
 * So when CORPAYONE_TEAM_ID is set the server treats it as a hard boundary. It
 * is injected wherever a team is required, and a caller-supplied value that
 * disagrees is rejected rather than quietly overridden — a mismatch means
 * something is trying to leave its company, which is worth failing loudly.
 *
 * Leaving CORPAYONE_TEAM_ID unset is the single-user/desktop case: the caller
 * picks the team and is trusted to, because the grant is their own.
 */
export class TeamScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamScopeError';
  }
}

export function pinnedTeamId(): string | undefined {
  return process.env.CORPAYONE_TEAM_ID?.trim() || undefined;
}

export function isTeamPinned(): boolean {
  return pinnedTeamId() !== undefined;
}

/**
 * The team to act on. Prefers the pinned team; `requested` is honoured only
 * when nothing is pinned, and disagreeing with a pinned team is an error.
 */
export function resolveTeamId(requested?: unknown): string {
  const pinned = pinnedTeamId();
  const asked = normalize(requested);

  if (pinned) {
    assertTeamAllowed(asked);
    return pinned;
  }
  if (!asked) {
    throw new TeamScopeError(
      'No team selected. Set CORPAYONE_TEAM_ID on the server, or pass teamId (list them with corpay_list_teams).',
    );
  }
  return asked;
}

/**
 * Throw if `requested` names a team other than the pinned one. `pinned`
 * defaults to the environment, but is passed explicitly by the client so a
 * team supplied through the constructor is enforced just as strictly.
 */
export function assertTeamAllowed(requested?: unknown, pinned = pinnedTeamId()): void {
  const asked = normalize(requested);
  if (!pinned || !asked || asked === pinned) return;
  throw new TeamScopeError(
    `This server is scoped to a single Corpay One team; it cannot act on team "${asked}".`,
  );
}

/**
 * Reject any team identifier in `record` that disagrees with the pinned team,
 * whatever its casing. Corpay spells the parameter `teamId` in most places and
 * `TeamId` on the v2 expense list, and its model binding is case-insensitive,
 * so the check has to be too.
 */
export function assertNoForeignTeam(
  record: Record<string, unknown> | undefined,
  pinned = pinnedTeamId(),
): void {
  for (const [key, value] of Object.entries(record ?? {})) {
    if (isTeamKey(key)) assertTeamAllowed(value, pinned);
  }
}

/**
 * Pin the team into path params. Adds `teamId` when the template needs one, and
 * rewrites a conflicting caller-supplied value only after rejecting it above.
 */
export function scopePathParams(
  pathTemplate: string,
  params: Record<string, string | number> | undefined,
): Record<string, string | number> | undefined {
  const pinned = pinnedTeamId();
  if (!pinned) return params;

  assertNoForeignTeam(params);
  if (!/\{teamId\}/i.test(pathTemplate)) return params;
  return { ...(params ?? {}), teamId: pinned };
}

/** True for the query/path keys Corpay uses to select a team. */
export function isTeamKey(key: string): boolean {
  return key.toLowerCase() === 'teamid';
}

function normalize(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
}
