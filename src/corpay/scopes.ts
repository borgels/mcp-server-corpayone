/**
 * Scope-gated availability.
 *
 * Corpay refuses some endpoints unless the OAuth grant carries a scope beyond
 * what a standard app registration can obtain, and a caller cannot tell that
 * from the response: the API answers with an HTML error page, which looks like a
 * broken endpoint rather than a missing permission.
 *
 * So rather than offering tools that are guaranteed to fail, the server only
 * exposes what the grant can actually reach. Which scopes are held is declared
 * by configuration, defaulting to the set a standard registration gets.
 *
 * The mapping below is measured against the live production API, not inferred
 * from the OpenAPI documents — Corpay declares scopes only globally there, and
 * the real behaviour does not follow the obvious pattern. Notably `teams.all`
 * *does* cover `/teams/{id}/modules` but *not* `/teams/{id}/departments` or
 * `/teams/{id}/members`, and `expenses.all` covers `/expenses/{id}/approvers`.
 * Treat this list as a record of observation; re-run `npm run smoke:live` after
 * changing a grant.
 */

/** Scopes a standard Corpay app registration can obtain and use. */
export const STANDARD_SCOPES = [
  'expenses.all',
  'teams.all',
  'teams.categories.all',
  'teams.categories.list',
  'teams.lists.all',
  'teams.vendors.all',
  'webhooks.all',
  'offline_access',
] as const;

/**
 * Scopes this grant holds. Defaults to the standard set; override with
 * CORPAYONE_SCOPE (the same variable the token grant uses) when the app has
 * been granted more, and the extra tools appear.
 */
export function grantedScopes(): Set<string> {
  const configured = process.env.CORPAYONE_SCOPE?.trim();
  if (!configured) return new Set(STANDARD_SCOPES);
  return new Set(configured.split(/[\s,]+/).filter(Boolean));
}

/** Whether the grant can reach something needing `required`. */
export function hasScope(required: string | undefined): boolean {
  if (!required) return true;
  return grantedScopes().has(required);
}

/**
 * Scopes that could not be obtained on a standard registration at the time of
 * writing, with what each unlocks. Adding one to the app in the developer portal
 * was not sufficient — identity.corpayone.com keeps a separate client allowlist
 * — so enabling them needs Corpay support.
 */
export const EXTRA_SCOPES: Record<string, string> = {
  'departments.all': 'departments as a coding dimension',
  'items.read': 'the team item list',
  'items.write': 'changing the team item list',
  'cardtransactions.all': 'credit accounts and card transactions',
  'payments.all': 'payment methods (cards and bank accounts)',
  'teams.members.list': 'listing team members',
  'teams.members.all': 'managing team members',
  'users.read': 'the authenticated user profile',
};

/** A message explaining why something is not available on this grant. */
export function explainMissingScope(required: string): string {
  const unlocks = EXTRA_SCOPES[required];
  return (
    `This needs the Corpay OAuth scope "${required}"${unlocks ? ` (${unlocks})` : ''}, ` +
    'which this grant does not hold. A standard Corpay app registration cannot ' +
    'obtain it — selecting it in the developer portal is not enough, because ' +
    'identity.corpayone.com keeps its own client allowlist — so it has to be ' +
    'enabled by Corpay. Once granted, list it in CORPAYONE_SCOPE.'
  );
}
