import type { HttpMethod } from './client.js';

/**
 * How consequential an operation is.
 *
 * `approval` is separated from `commit` because approving a bill releases it
 * for payment — a money-movement decision rather than bookkeeping — and is
 * gated by its own switch, so a server can be allowed to code expenses without
 * ever being able to approve them.
 */
export type CapabilityRisk = 'read' | 'draft' | 'commit' | 'approval' | 'dangerous';

export interface EndpointOperation {
  id: string;
  method: HttpMethod;
  pathTemplate: string;
  summary: string;
  risk: CapabilityRisk;
  /** Absent from the public OpenAPI documents; verified against the live API. */
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
 * Every Corpay One endpoint this server will talk to.
 *
 * Generated from the published OpenAPI documents at api.corpayone.com/docs
 * (public-v1, public-v2, public-v3) and kept as an explicit allowlist: paths
 * are version-prefixed and relative to the `/external` base URL, so a typo or
 * an invented path fails closed instead of reaching Corpay.
 *
 * Corpay declares its OAuth scopes globally rather than per operation, so no
 * scope is recorded per endpoint here; see the README for the grant to request.
 */
export const ENDPOINT_OPERATIONS: EndpointOperation[] = [
  op('GET', '/v1/payments/methods', 'Get/list cards (payment methods).', 'read'),
  op('GET', '/v1/payments/methods/bank/accounts/{accountId}', 'View/read a bank account info (payment method).', 'read'),
  op('GET', '/v1/payments/methods/cards/{cardId}', 'View/read a card (payment method).', 'read'),
  op('GET', '/v1/teams', 'Get/list teams of the authenticated user.', 'read'),
  op('POST', '/v1/teams', 'Add/create teams.', 'dangerous'),
  op('DELETE', '/v1/teams/{teamId}', 'Delete a team (where authenticated user must be a member).', 'dangerous'),
  op('GET', '/v1/teams/{teamId}', 'View/read a team (where authenticated user must be a member).', 'read'),
  op('GET', '/v1/teams/{teamId}/categories', 'List team categories.', 'read'),
  op('POST', '/v1/teams/{teamId}/categories', 'Import team categories.', 'commit'),
  op('PUT', '/v1/teams/{teamId}/categories', 'Merge team categories.', 'commit'),
  op('POST', '/v1/teams/{teamId}/categories/async', 'Import team categories in the background (202 Accepted).', 'commit'),
  op('PUT', '/v1/teams/{teamId}/categories/async', 'Merge team categories in the background (202 Accepted).', 'commit'),
  op('DELETE', '/v1/teams/{teamId}/categories/{categoryId}', 'Delete a team category.', 'dangerous'),
  op('GET', '/v1/teams/{teamId}/categories/{categoryId}', 'Get a team category.', 'read'),
  op('PUT', '/v1/teams/{teamId}/categories/{categoryId}', 'Update a single team category.', 'commit'),
  op('GET', '/v1/teams/{teamId}/departments', 'List departments on the team.', 'read'),
  op('POST', '/v1/teams/{teamId}/departments', 'Create team department.', 'commit'),
  op('PUT', '/v1/teams/{teamId}/departments', 'Merge departments into the team.', 'commit'),
  op('DELETE', '/v1/teams/{teamId}/departments/{departmentId}', 'Delete team department.', 'dangerous'),
  op('GET', '/v1/teams/{teamId}/departments/{departmentId}', 'Get team department.', 'read'),
  op('GET', '/v1/teams/{teamId}/lists', 'List team lists.', 'read'),
  op('POST', '/v1/teams/{teamId}/lists', 'Create team list.', 'commit'),
  op('DELETE', '/v1/teams/{teamId}/lists/{listId}', 'Delete team list.', 'dangerous'),
  op('GET', '/v1/teams/{teamId}/lists/{listId}', 'Get team list.', 'read'),
  op('PATCH', '/v1/teams/{teamId}/lists/{listId}', 'Update team list.', 'commit'),
  op('GET', '/v1/teams/{teamId}/lists/{listId}/labels', 'List team list labels.', 'read'),
  op('POST', '/v1/teams/{teamId}/lists/{listId}/labels', 'Import team list labels.', 'commit'),
  op('PUT', '/v1/teams/{teamId}/lists/{listId}/labels', 'Merge team list labels.', 'commit'),
  op('POST', '/v1/teams/{teamId}/lists/{listId}/labels/async', 'Import team list labels in background.', 'commit'),
  op('PUT', '/v1/teams/{teamId}/lists/{listId}/labels/async', 'Merge team list labels in background.', 'commit'),
  op('GET', '/v1/teams/{teamId}/lists/{listId}/labels/{labelId}', 'Get a team list label.', 'read'),
  op('GET', '/v1/teams/{teamId}/members', 'List members of the team.', 'read'),
  op('POST', '/v1/teams/{teamId}/members', 'Create a team member.', 'dangerous'),
  op('DELETE', '/v1/teams/{teamId}/members/{userId}', 'Delete a team member.', 'dangerous'),
  op('PATCH', '/v1/teams/{teamId}/members/{userId}', 'Update a team member.', 'dangerous'),
  op('GET', '/v1/teams/{teamId}/modules', 'List modules activated on the team.', 'read'),
  op('GET', '/v1/teams/{teamId}/usage/export/summary', 'Export a usage summary for the team.', 'read'),
  op('GET', '/v1/users/me', 'View/read the current authenticated user.', 'read'),
  op('GET', '/v1/webhooks', 'Get/list webhooks created by the authenticated user (only by this API client/consumer).', 'read'),
  op('POST', '/v1/webhooks', 'Add/create webhooks.', 'commit'),
  op('PUT', '/v1/webhooks', 'Update existing webhooks.', 'commit'),
  op('DELETE', '/v1/webhooks/{webhookId}', 'Remove/delete webhooks.', 'dangerous'),
  op('GET', '/v1/webhooks/{webhookId}', 'Get/read a specific webhook created by the authenticated user (only by this API client/consumer).', 'read'),
  op('POST', '/v1/webhooks/{webhookId}/expenses/{expenseId}/logs', 'Create a webhook sync log entry for an expense.', 'commit'),
  op('GET', '/v2/creditaccounts/team/{teamId}', 'Get all the credit account ids related to this team.', 'read'),
  op('GET', '/v2/creditaccounts/team/{teamId}/card/{id}', 'Get credit account card information.', 'read'),
  op('GET', '/v2/creditaccounts/{creditAccountId}/team/{teamId}/balance', 'Get the total balance for a credit account.', 'read'),
  op('GET', '/v2/creditaccounts/{creditAccountId}/team/{teamId}/payment/{creditAccountPaymentId}', 'Get a specific payment related to a specific credit account.', 'read'),
  op('GET', '/v2/creditaccounts/{creditAccountId}/team/{teamId}/payments', 'Get the payments related to a specific credit account.', 'read'),
  op('GET', '/v2/creditaccounts/{creditAccountId}/team/{teamId}/transaction/{creditAccountTransactionId}', 'Get a specific transaction related to a specific credit account.', 'read'),
  op('PATCH', '/v2/creditaccounts/{creditAccountId}/team/{teamId}/transaction/{creditAccountTransactionId}', 'Update the bookkeeping details of a credit account transaction.', 'commit'),
  op('GET', '/v2/creditaccounts/{creditAccountId}/team/{teamId}/transactions', 'Get the transactions related to a specific credit account.', 'read'),
  op('GET', '/v2/expenses', 'Get/list expenses.', 'read'),
  op('POST', '/v2/expenses', 'Upload an expense.', 'commit'),
  op('POST', '/v2/expenses/generate', 'Generate an expense.', 'commit'),
  op('DELETE', '/v2/expenses/{expenseId}', 'Delete an expense.', 'dangerous'),
  op('GET', '/v2/expenses/{expenseId}/activities', 'View/read an expense activities.', 'read'),
  op('POST', '/v2/expenses/{expenseId}/activities', 'Post an activity (note/decline reason) on an expense.', 'approval'),
  op('PATCH', '/v2/expenses/{expenseId}/amountlines', 'Set expense amount lines.', 'commit'),
  op('PATCH', '/v2/expenses/{expenseId}/approve', 'Approve an expense waiting for approval.', 'approval'),
  op('GET', '/v2/expenses/{expenseId}/approvers', 'Get expense approvers.', 'read'),
  op('POST', '/v2/expenses/{expenseId}/attachments', 'Attach a file to an expense.', 'commit'),
  op('PATCH', '/v2/expenses/{expenseId}/category', 'Set expense category.', 'commit'),
  op('PATCH', '/v2/expenses/{expenseId}/decline', 'Decline an expense waiting for approval.', 'approval'),
  op('POST', '/v2/expenses/{expenseId}/labels', 'Set a label on an expense.', 'commit'),
  op('GET', '/v2/expenses/{expenseId}/links', 'Fetch all the links existing on an expense.', 'read'),
  op('GET', '/v2/teams/{teamId}/items', 'List the items on the team.', 'read'),
  op('POST', '/v2/teams/{teamId}/items', 'Overwrite the team item list.', 'commit'),
  op('PUT', '/v2/teams/{teamId}/items', 'Add new items to the team item list.', 'commit'),
  op('GET', '/v2/teams/{teamId}/items/disable', 'Disable the items feature for the team.', 'commit'),
  op('GET', '/v2/teams/{teamId}/items/enable', 'Enable the items feature for the team.', 'commit'),
  op('GET', '/v2/teams/{teamId}/vendors', 'List vendors.', 'read'),
  op('POST', '/v2/teams/{teamId}/vendors', 'Create a vendor.', 'commit'),
  op('GET', '/v2/teams/{teamId}/vendors/{vendorId}', 'View/read a vendor.', 'read'),
  op('PATCH', '/v2/teams/{teamId}/vendors/{vendorId}/external-id', 'Set a vendor external id (ERP link).', 'commit'),
  op('PATCH', '/v2/teams/{teamId}/vendors/{vendorId}/initialize-external-identification', 'Initialize external identification for a vendor.', 'commit'),
  op('GET', '/v3/creditaccounts/team/{teamId}/payment/{creditAccountPaymentId}', 'Get a specific payment related to a specific credit account.', 'read'),
  op('GET', '/v3/creditaccounts/team/{teamId}/transaction/{creditAccountTransactionId}', 'Get a credit account transaction.', 'read'),
  op('GET', '/v3/expenses/{expenseId}', 'View/read an expense.', 'read'),
  // Not in the public spec, but the only way to set several coding fields
  // atomically; confirmed working and kept for that reason.
  op('PATCH', '/v2/expenses/{expenseId}', 'Update expense coding fields via RFC 6902 JSON Patch (/categoryId, /labels, /departments).', 'commit', true),
];

/** Expense states, as used by the `State` filter on the expense list. */
export const EXPENSE_STATES = [
  'Pending', 'Booked', 'Paid', 'Cancelled', 'Awaiting',
  'Paused', 'Duplicate', 'Refunded', 'Initialized',
] as const;

/** Document types Corpay recognises. */
export const EXPENSE_TYPES = ['Bill', 'Receipt', 'Creditnote', 'Reimbursement', 'FuelBill'] as const;

/** Webhook event types Corpay One can emit (subscribe selectively). */
export const WEBHOOK_EVENTS = [
  'expense.state.pending',
  'expense.state.awaiting',
  'expense.state.booked',
  'expense.state.initialized',
  'expense.state.paid',
  'expense.state.paused',
  'expense.state.refunded',
  'expense.state.cancelled',
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
  tool('corpay_search_capabilities', 'Search capabilities', 'Find supported tools and allowlisted endpoint operations. Start here.', 'read', ['discovery', 'help']),
  tool('corpay_get_capability', 'Get capability', 'Return details for one tool or allowlisted endpoint.', 'read', ['discovery']),
  tool('corpay_check_connection', 'Check connection', 'Validate the OAuth grant and report the team this server is scoped to.', 'read', ['auth', 'setup', 'health']),
  tool('corpay_get_company_context', 'Get company context', 'The team this server acts for, plus its activated modules.', 'read', ['team', 'company', 'context']),
  tool('corpay_list_teams', 'List teams', 'List teams the grant can reach. A scoped server reports only its own.', 'read', ['team', 'company']),
  tool('corpay_list_expenses', 'List expenses', 'List bills, receipts and credit notes, filtered by state or type.', 'read', ['expense', 'bill', 'invoice', 'receipt', 'inbox']),
  tool('corpay_get_expense', 'Get expense', 'Full detail for one expense: vendor, amounts, lines and coding.', 'read', ['expense', 'bill', 'detail']),
  tool('corpay_get_expense_activities', 'Get expense activity log', 'The activity and history trail for an expense.', 'read', ['expense', 'history', 'audit']),
  tool('corpay_get_expense_approvers', 'Get expense approvers', 'Who must approve an expense, and who already has.', 'read', ['expense', 'approval']),
  tool('corpay_list_coding_options', 'List coding options', 'Categories, label lists, departments and items in one read — the vocabulary for coding an expense.', 'read', ['coding', 'category', 'account', 'label', 'department', 'dimension', 'item']),
  tool('corpay_list_vendors', 'List vendors', 'List vendors (creditors) on the team.', 'read', ['vendor', 'supplier', 'creditor']),
  tool('corpay_get_vendor', 'Get vendor', 'Read one vendor.', 'read', ['vendor', 'supplier']),
  tool('corpay_list_credit_accounts', 'List credit accounts', 'Credit and card accounts belonging to the team.', 'read', ['card', 'credit', 'account']),
  tool('corpay_list_card_transactions', 'List card transactions', 'Transactions on a credit account, with their bookkeeping state.', 'read', ['card', 'transaction', 'credit']),
  tool('corpay_list_payment_methods', 'List payment methods', 'Cards and bank accounts registered as payment methods.', 'read', ['payment', 'card', 'bank']),
  tool('corpay_list_team_members', 'List team members', 'People on the team and their roles.', 'read', ['member', 'user', 'people']),
  tool('corpay_list_webhooks', 'List webhooks', 'Webhook subscriptions visible to this grant.', 'read', ['webhook', 'integration']),
  tool('corpay_call_endpoint', 'Call allowlisted endpoint', 'Call any allowlisted endpoint directly. Reads run immediately; writes must go through prepare and commit.', 'read', ['advanced', 'escape hatch']),
  tool('corpay_prepare_expense_coding', 'Prepare expense coding', 'Dry-run the coding of an expense — category, labels, department, item.', 'draft', ['coding', 'category', 'label', 'write']),
  tool('corpay_prepare_expense_amount_lines', 'Prepare expense split', 'Dry-run splitting an expense into several coded amount lines.', 'draft', ['coding', 'split', 'lines', 'write']),
  tool('corpay_prepare_card_transaction_coding', 'Prepare card transaction coding', 'Dry-run the bookkeeping details of a credit account transaction.', 'draft', ['card', 'coding', 'write']),
  tool('corpay_prepare_vendor_change', 'Prepare vendor change', 'Dry-run creating a vendor or setting its external id.', 'draft', ['vendor', 'write']),
  tool('corpay_prepare_coding_list_change', 'Prepare coding list change', 'Dry-run a change to categories, departments, label lists or items.', 'draft', ['category', 'department', 'label', 'item', 'write']),
  tool('corpay_prepare_webhook_change', 'Prepare webhook change', 'Dry-run creating, updating or deleting a webhook subscription.', 'draft', ['webhook', 'write']),
  tool('corpay_commit_prepared_operation', 'Commit prepared operation', 'Execute a prepared write after restating its hash.', 'commit', ['write', 'commit']),
  tool('corpay_prepare_expense_approval', 'Prepare expense approval', 'Dry-run approving or declining an expense. Approval releases a bill for payment.', 'draft', ['approval', 'approve', 'decline', 'payment']),
  tool('corpay_commit_expense_approval', 'Commit expense approval', 'Approve or decline an expense. Gated separately from ordinary writes.', 'approval', ['approval', 'approve', 'decline', 'payment']),
];

export function searchCapabilities(query: string, limit = 20): Capability[] {
  const q = query.trim().toLowerCase();
  const all = [...CURATED_CAPABILITIES, ...endpointCapabilities()];
  if (!q) return all.slice(0, limit);
  return all
    .filter(
      c =>
        c.id.toLowerCase().includes(q) ||
        c.title.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.keywords.some(k => k.includes(q)),
    )
    .slice(0, limit);
}

export function getCapability(id: string): Capability | undefined {
  return [...CURATED_CAPABILITIES, ...endpointCapabilities()].find(c => c.id === id);
}

export function findEndpoint(method: HttpMethod, pathTemplate: string): EndpointOperation {
  const match = ENDPOINT_OPERATIONS.find(
    op => op.method === method && op.pathTemplate === pathTemplate,
  );
  if (!match) {
    throw new Error(
      `Endpoint is not allowlisted: ${method} ${pathTemplate}. Use corpay_search_capabilities to find one that is.`,
    );
  }
  return match;
}

export function materializePath(
  endpoint: EndpointOperation,
  params: Record<string, string | number> = {},
): string {
  return endpoint.pathTemplate.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = params[key];
    if (value === undefined) {
      throw new Error(`Missing path parameter: ${key}`);
    }
    return encodeURIComponent(String(value));
  });
}

function endpointCapabilities(): Capability[] {
  return ENDPOINT_OPERATIONS.map(op => ({
    id: `endpoint.${op.id}`,
    title: `${op.method} ${op.pathTemplate}`,
    kind: 'endpoint' as const,
    description: op.summary,
    risk: op.risk,
    keywords: [op.method.toLowerCase(), ...op.pathTemplate.split(/[/{}]/).filter(Boolean)],
  }));
}

function op(
  method: HttpMethod,
  pathTemplate: string,
  summary: string,
  risk: CapabilityRisk,
  provisional?: boolean,
): EndpointOperation {
  return { id: `${method} ${pathTemplate}`, method, pathTemplate, summary, risk, provisional };
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
