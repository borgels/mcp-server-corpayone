import type { HttpMethod } from './client.js';

export type CapabilityRisk = 'read' | 'draft' | 'commit' | 'dangerous';

export interface EndpointOperation {
  id: string;
  method: HttpMethod;
  pathTemplate: string;
  summary: string;
  risk: CapabilityRisk;
  /** Provisional = documented elsewhere (full Swagger), confirmed live during bring-up. */
  provisional?: boolean;
}

export interface Capability {
  id: string;
  title: string;
  kind: 'tool' | 'endpoint';
  description: string;
  risk: CapabilityRisk;
  keywords: string[];
}

/**
 * Corpay One API endpoints.
 *
 * Base URL is `.../external`; resources are version-prefixed per the official
 * getting-started guide. Read + webhook endpoints are documented there; the
 * expense coding-write endpoint is taken from the full Swagger (api.corpayone.com/docs)
 * and re-verified live during bring-up (marked `provisional`).
 *
 * The product's core entity is the "expense" (an uploaded bill/document). Coding
 * fields seen on the webhook surface include category (GL account), label, and
 * department. Most calls require a `teamId` (the company slug).
 */
export const ENDPOINT_OPERATIONS: EndpointOperation[] = [
  { id: id('GET', '/v1/teams'), method: 'GET', pathTemplate: '/v1/teams', summary: 'List teams (companies) the token can access.', risk: 'read' },
  { id: id('GET', '/v2/expenses'), method: 'GET', pathTemplate: '/v2/expenses', summary: 'List expenses (bills/documents); filter by state, requires teamId.', risk: 'read' },
  { id: id('GET', '/v3/expenses/{id}'), method: 'GET', pathTemplate: '/v3/expenses/{id}', summary: 'Get full detail for one expense.', risk: 'read' },
  { id: id('GET', '/v1/webhooks'), method: 'GET', pathTemplate: '/v1/webhooks', summary: 'List active webhook subscriptions (requires teamId).', risk: 'read' },
  { id: id('POST', '/v1/webhooks'), method: 'POST', pathTemplate: '/v1/webhooks', summary: 'Create a webhook subscription.', risk: 'commit' },
  { id: id('PUT', '/v1/webhooks'), method: 'PUT', pathTemplate: '/v1/webhooks', summary: 'Update a webhook subscription.', risk: 'commit' },
  { id: id('DELETE', '/v1/webhooks/{id}'), method: 'DELETE', pathTemplate: '/v1/webhooks/{id}', summary: 'Delete a webhook subscription.', risk: 'dangerous' },
  // Expense coding write — confirm exact path/verb/fields against the live Swagger.
  { id: id('PATCH', '/v2/expenses/{id}'), method: 'PATCH', pathTemplate: '/v2/expenses/{id}', summary: 'Update an expense (coding: category, label, department, ...).', risk: 'commit', provisional: true },
];

/** Webhook event types Corpay One can emit (subscribe selectively). */
export const WEBHOOK_EVENTS = [
  // Expense state transitions.
  'expense.state.pending',
  'expense.state.awaiting',
  'expense.state.booked',
  'expense.state.initialized',
  'expense.state.paid',
  'expense.state.paused',
  'expense.state.refunded',
  'expense.state.cancelled',
  // Field/action events.
  'expense.vendor.updated',
  'expense.amount.updated',
  'expense.amountlines.updated',
  'expense.label.updated',
  'expense.note.updated',
  'expense.item.updated',
  'expense.date.updated',
  'expense.type.updated',
  'expense.invoicenumber.updated',
  'expense.paymentdate.updated',
  'expense.category.updated',
  'expense.department.updated',
  'expense.creditnote.linked',
  'payment.updated',
  'expense.approval.declined',
  'expense.approval.approved',
  'expense.approver.added',
] as const;

export const CURATED_CAPABILITIES: Capability[] = [
  tool('corpay_check_connection', 'Check Corpay One connection', 'Validate OAuth credentials and list accessible teams.', 'read', ['auth', 'setup', 'teams']),
  tool('corpay_search_capabilities', 'Search capabilities', 'Find supported tools and allowlisted endpoint operations.', 'read', ['discovery']),
  tool('corpay_list_expenses', 'List expenses', 'List expenses (bills/documents), filterable by state. Requires teamId.', 'read', ['expense', 'bill', 'approval']),
  tool('corpay_get_expense', 'Get expense', 'Read full detail for one expense, incl. vendor, amounts, lines, coding.', 'read', ['expense', 'bill']),
  tool('corpay_prepare_expense_coding', 'Prepare expense coding', 'Dry-run update of an expense’s coding — category (account), label, department.', 'draft', ['expense', 'coding', 'category', 'label', 'write']),
  tool('corpay_commit_prepared_operation', 'Commit prepared operation', 'Execute a prepared, policy-checked write with a confirmation hash.', 'commit', ['write']),
  tool('corpay_list_webhooks', 'List webhooks', 'List active webhook subscriptions.', 'read', ['webhook']),
  tool('corpay_prepare_webhook_change', 'Prepare webhook change', 'Dry-run create/update/delete of a webhook subscription.', 'draft', ['webhook', 'write']),
  tool('corpay_call_endpoint', 'Call allowlisted endpoint', 'Call a validated, allowlisted Corpay One endpoint (read unless policy permits).', 'read', ['advanced']),
];

export function searchCapabilities(query: string): Capability[] {
  const q = query.trim().toLowerCase();
  const fromEndpoints: Capability[] = ENDPOINT_OPERATIONS.map(op => ({
    id: `endpoint.${op.id}`,
    title: `${op.method} ${op.pathTemplate}`,
    kind: 'endpoint' as const,
    description: op.summary,
    risk: op.risk,
    keywords: [op.method.toLowerCase(), ...op.pathTemplate.split('/').filter(Boolean)],
  }));
  const all = [...CURATED_CAPABILITIES, ...fromEndpoints];
  if (!q) return all;
  return all.filter(
    c =>
      c.id.toLowerCase().includes(q) ||
      c.title.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q) ||
      c.keywords.some(k => k.includes(q)),
  );
}

export function findEndpoint(method: HttpMethod, pathTemplate: string): EndpointOperation {
  const match = ENDPOINT_OPERATIONS.find(
    op => op.method === method && op.pathTemplate === pathTemplate,
  );
  if (!match) {
    throw new Error(`Endpoint is not allowlisted: ${method} ${pathTemplate}`);
  }
  return match;
}

export function materializePath(
  endpoint: EndpointOperation,
  params: Record<string, string | number>,
): string {
  return endpoint.pathTemplate.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = params[key];
    if (value === undefined) {
      throw new Error(`Missing path parameter: ${key}`);
    }
    return encodeURIComponent(String(value));
  });
}

function id(method: string, pathTemplate: string): string {
  return `${method} ${pathTemplate}`;
}

function tool(
  id: string,
  title: string,
  description: string,
  risk: CapabilityRisk,
  keywords: string[],
): Capability {
  return { id, title, kind: 'tool', description, risk, keywords };
}
