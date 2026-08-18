import type { HttpMethod } from './corpay/client.js';

export interface CorpayHttpErrorInit {
  status: number;
  method: HttpMethod;
  url: string;
  payload?: unknown;
  retryAfter?: string;
  fallbackMessage?: string;
}

/** Error for non-2xx responses from the Corpay One API, with redaction-friendly fields. */
export class CorpayHttpError extends Error {
  readonly status: number;
  readonly method: HttpMethod;
  readonly url: string;
  readonly payload: unknown;
  readonly retryAfter?: string;

  constructor(init: CorpayHttpErrorInit) {
    const url = redactUrl(init.url);
    // A scope-gated 403 is explained here rather than at each call site, so the
    // reason travels with the error even when it propagates straight to the
    // MCP client. Corpay answers these with an HTML error page, which is worse
    // than useless in a tool result.
    const scopeHint = missingScopeFor(init.status, url);
    const summary =
      typeof init.payload === 'object' && init.payload !== null
        ? JSON.stringify(init.payload)
        : (init.fallbackMessage ?? '');
    super(
      scopeHint ??
        `Corpay One API request failed with HTTP ${init.status}` +
          ` | ${init.method} ${url}` +
          (summary ? ` | ${summary}` : ''),
    );
    this.name = 'CorpayHttpError';
    this.status = init.status;
    this.method = init.method;
    this.url = redactUrl(init.url);
    this.payload = init.payload;
    this.retryAfter = init.retryAfter;
  }
}

/** Strip query strings so tokens passed as query params never reach logs. */
export function redactUrl(urlValue: string): string {
  try {
    const url = new URL(urlValue);
    return `${url.origin}${url.pathname}`;
  } catch {
    return urlValue.split('?')[0] ?? urlValue;
  }
}

/**
 * Endpoints Corpay refuses unless the app registration carries an extra scope.
 * A bare 403 here reads like a broken endpoint, so name the missing scope.
 */
const SCOPE_GATED: Array<{ pattern: RegExp; scope: string }> = [
  { pattern: /\/departments/i, scope: 'departments.all' },
  { pattern: /\/items/i, scope: 'items.read (and items.write to change them)' },
  { pattern: /\/creditaccounts/i, scope: 'cardtransactions.all' },
  { pattern: /\/payments\/methods/i, scope: 'payments.all' },
  { pattern: /\/members/i, scope: 'teams.members.list' },
  { pattern: /\/modules/i, scope: 'teams.modules.list' },
  { pattern: /\/approvers/i, scope: 'expenses.approvers.read' },
];

/** Explain a 403 that is really a missing scope, not a missing permission. */
export function explainForbidden(error: CorpayHttpError): string | undefined {
  return missingScopeFor(error.status, error.url);
}

function missingScopeFor(status: number, url: string): string | undefined {
  if (status !== 403) return undefined;
  const hit = SCOPE_GATED.find(entry => entry.pattern.test(url));
  if (!hit) return undefined;
  return (
    `Corpay returned 403 for ${url}. This endpoint needs the OAuth scope ` +
    `"${hit.scope}", which this app's token does not carry. Note that selecting ` +
    'the scope in the developer portal is not sufficient: identity.corpayone.com ' +
    'keeps its own client allowlist and still refuses the scope at authorize ' +
    'time, so enabling it requires Corpay support. Other endpoints are ' +
    'unaffected — this is a scope limit, not a broken endpoint.'
  );
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof CorpayHttpError) {
    return explainForbidden(error) ?? error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
