import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import type { CorpayClient, HttpMethod, QueryValue } from '../corpay/client.js';
import {
  EXPENSE_STATES,
  EXPENSE_TYPES,
  WEBHOOK_EVENTS,
  findEndpoint,
  getCapability,
  materializePath,
  searchCapabilities,
} from '../corpay/catalog.js';
import { prepareOperation, verifyPreparedOperation, type PreparedOperation } from '../corpay/operations.js';
import { checkPolicy, isApprovalCapability, loadPolicy } from '../corpay/policy.js';
import { prepareExpenseCoding } from '../corpay/coding.js';
import { isTeamPinned, pinnedTeamId, resolveTeamId, scopePathParams } from '../corpay/team.js';
import { writeAuditEvent } from '../corpay/audit.js';
import { formatUnknownError } from '../errors.js';

const methodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const queryValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]).optional();
const querySchema = z.record(z.string(), queryValueSchema).optional();
const pathParamsSchema = z.record(z.string(), z.union([z.string(), z.number()])).optional();
// Typed as an object rather than z.unknown() so the generated JSON Schema
// advertises `type: "object"`. Without that hint some MCP clients stringify the
// argument instead of nesting it, and Corpay then rejects the body.
const bodySchema = z.record(z.string(), z.unknown()).optional();
const idempotencyKeySchema = z.string().trim().min(8).optional();
const reasonSchema = z.string().trim().min(1).describe('Why this change is being made; recorded in the audit log.');

const preparedOperationSchema = z.object({
  capability: z.string().trim().min(1),
  method: methodSchema,
  pathTemplate: z.string().trim().min(1),
  pathParams: pathParamsSchema,
  query: querySchema,
  body: z.unknown().optional(),
  contentType: z.string().optional(),
  dryRun: z.literal(true),
  reason: z.string().trim().min(1),
  operationHash: z.string().trim().min(32),
  // Informational only — commit re-derives the decision from the verified
  // operation. Optional because z.unknown() is *required* inside a Zod object,
  // which would reject a caller that trimmed this field with a confusing
  // "expected nonoptional" error.
  policyDecision: z.unknown().optional(),
});

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const DRY_RUN = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const WRITE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export function registerCorpayTools(server: McpServer, client: CorpayClient): void {
  // ---------------------------------------------------------------- discovery

  server.registerTool(
    'corpay_search_capabilities',
    {
      title: 'Search Corpay One Capabilities',
      description:
        'Search the curated tools and the allowlisted Corpay One endpoints. Use this first when deciding which capability to call.',
      inputSchema: {
        query: z.string().trim().default(''),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    async input => jsonToolResult(searchCapabilities(input.query, input.limit)),
  );

  server.registerTool(
    'corpay_get_capability',
    {
      title: 'Get Corpay One Capability',
      description: 'Return the details of one discovered tool or allowlisted endpoint.',
      inputSchema: { id: z.string().trim().min(1) },
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    async input =>
      jsonToolResult(getCapability(input.id) ?? { error: `Unknown capability: ${input.id}` }),
  );

  // ------------------------------------------------------------------ context

  server.registerTool(
    'corpay_check_connection',
    {
      title: 'Check Corpay One Connection',
      description:
        'Validate the OAuth grant and report which team this server is scoped to, plus whether writes and approvals are enabled.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const policy = loadPolicy();
      const teams = await client.request<{ data?: { teams?: TeamSummary[] } }>({
        method: 'GET',
        path: '/v1/teams',
        withTeamId: false,
      });
      const pinned = pinnedTeamId();
      const all = teams?.data?.teams ?? [];
      const scoped = pinned ? all.filter(t => t.id === pinned) : all;
      return jsonToolResult({
        connected: true,
        teamScope: pinned ? 'pinned' : 'grant-wide',
        team: pinned ? (scoped[0] ?? { id: pinned, warning: 'Pinned team is not in this grant.' }) : undefined,
        teams: pinned ? undefined : all,
        writesEnabled: policy.writesEnabled,
        approvalsEnabled: policy.approvalsEnabled,
      });
    },
  );

  server.registerTool(
    'corpay_get_company_context',
    {
      title: 'Get Corpay One Company Context',
      description:
        'The team this server acts for, together with the modules activated on it. Amounts throughout the Corpay API are in minor units (øre for DKK).',
      inputSchema: { teamId: teamIdArg() },
      annotations: READ_ONLY,
    },
    async input => {
      const teamId = resolveTeamId(input.teamId);
      const [team, modules] = await Promise.all([
        client.request({ method: 'GET', path: `/v1/teams/${encodeURIComponent(teamId)}`, withTeamId: false }),
        client
          .request({ method: 'GET', path: `/v1/teams/${encodeURIComponent(teamId)}/modules`, withTeamId: false })
          .catch(error => ({ error: formatUnknownError(error) })),
      ]);
      return jsonToolResult({ team, modules, amountUnit: 'minor units (øre for DKK)' });
    },
  );

  server.registerTool(
    'corpay_list_teams',
    {
      title: 'List Corpay One Teams',
      description:
        'List the teams (companies) this grant can reach. A server pinned to one team reports only that team.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const response = await client.request<{ data?: { teams?: TeamSummary[] } }>({
        method: 'GET',
        path: '/v1/teams',
        withTeamId: false,
      });
      const pinned = pinnedTeamId();
      const teams = response?.data?.teams ?? [];
      return jsonToolResult(pinned ? teams.filter(t => t.id === pinned) : teams);
    },
  );

  // ----------------------------------------------------------------- expenses

  server.registerTool(
    'corpay_list_expenses',
    {
      title: 'List Corpay One Expenses',
      description:
        'List bills, receipts and credit notes. Filter by state or type. Amounts are in minor units (øre for DKK). Returns at most 100 per page; use offset to page.',
      inputSchema: {
        state: z.enum(EXPENSE_STATES).optional().describe('Awaiting = waiting for approval.'),
        type: z.enum(EXPENSE_TYPES).optional(),
        pendingUserApproval: z.boolean().optional().describe('Only expenses awaiting this user.'),
        includeInactive: z.boolean().optional(),
        includeArchived: z.boolean().optional(),
        offset: z.number().int().min(0).optional(),
        count: z.number().int().min(10).max(100).default(25).describe('Corpay requires 10-100.'),
        teamId: teamIdArg(),
      },
      annotations: READ_ONLY,
    },
    async input =>
      jsonToolResult(
        await client.request({
          method: 'GET',
          path: '/v2/expenses',
          query: {
            teamId: resolveTeamId(input.teamId),
            State: input.state,
            Type: input.type,
            PendingUserApproval: input.pendingUserApproval,
            IncludeInactive: input.includeInactive,
            IncludeArchived: input.includeArchived,
            Offset: input.offset,
            Count: input.count,
          },
        }),
      ),
  );

  server.registerTool(
    'corpay_get_expense',
    {
      title: 'Get Corpay One Expense',
      description:
        'Full detail for one expense: vendor, amounts, attachments, lines and current coding. Amounts are in minor units.',
      inputSchema: { expenseId: z.string().trim().min(1) },
      annotations: READ_ONLY,
    },
    async input =>
      jsonToolResult(
        await client.request({
          method: 'GET',
          path: `/v3/expenses/${encodeURIComponent(input.expenseId)}`,
          withTeamId: false,
        }),
      ),
  );

  server.registerTool(
    'corpay_get_expense_activities',
    {
      title: 'Get Corpay One Expense Activity Log',
      description: 'The activity and history trail for an expense, including approvals and edits.',
      inputSchema: { expenseId: z.string().trim().min(1) },
      annotations: READ_ONLY,
    },
    async input =>
      jsonToolResult(
        await client.request({
          method: 'GET',
          path: `/v2/expenses/${encodeURIComponent(input.expenseId)}/activities`,
        }),
      ),
  );

  server.registerTool(
    'corpay_get_expense_approvers',
    {
      title: 'Get Corpay One Expense Approvers',
      description: 'Who must approve an expense, and who already has.',
      inputSchema: { expenseId: z.string().trim().min(1) },
      annotations: READ_ONLY,
    },
    async input =>
      jsonToolResult(
        await client.request({
          method: 'GET',
          path: `/v2/expenses/${encodeURIComponent(input.expenseId)}/approvers`,
        }),
      ),
  );

  // ------------------------------------------------------------ coding vocabulary

  server.registerTool(
    'corpay_list_coding_options',
    {
      title: 'List Corpay One Coding Options',
      description:
        'Every value an expense can be coded to — categories (GL accounts), label lists with their labels, departments and items — in one read. Coding writes take the Corpay internal ids returned here, not GL account or dimension numbers. Sources that are disabled on the team report an error instead of failing the whole call.',
      inputSchema: {
        includeLabels: z.boolean().default(true).describe('Expand each label list into its labels.'),
        teamId: teamIdArg(),
      },
      annotations: READ_ONLY,
    },
    async input => {
      const teamId = resolveTeamId(input.teamId);
      const base = `/v1/teams/${encodeURIComponent(teamId)}`;
      const get = async (path: string): Promise<unknown> =>
        client.request({ method: 'GET', path, withTeamId: false }).catch(error => ({
          error: formatUnknownError(error),
        }));

      const [categories, lists, departments, items] = await Promise.all([
        get(`${base}/categories`),
        get(`${base}/lists`),
        get(`${base}/departments`),
        get(`/v2/teams/${encodeURIComponent(teamId)}/items`),
      ]);

      let labelLists = lists;
      if (input.includeLabels) {
        const ids = extractListIds(lists);
        labelLists = {
          lists,
          labels: Object.fromEntries(
            await Promise.all(
              ids.map(async listId => [
                listId,
                await get(`${base}/lists/${encodeURIComponent(listId)}/labels`),
              ]),
            ),
          ),
        };
      }

      return jsonToolResult({ teamId, categories, lists: labelLists, departments, items });
    },
  );

  // ------------------------------------------------------------------ vendors

  server.registerTool(
    'corpay_list_vendors',
    {
      title: 'List Corpay One Vendors',
      description: 'List vendors (creditors) registered on the team.',
      inputSchema: {
        offset: z.number().int().min(0).optional(),
        count: z.number().int().min(1).max(100).optional(),
        teamId: teamIdArg(),
      },
      annotations: READ_ONLY,
    },
    async input =>
      jsonToolResult(
        await client.request({
          method: 'GET',
          path: `/v2/teams/${encodeURIComponent(resolveTeamId(input.teamId))}/vendors`,
          query: { Offset: input.offset, Count: input.count },
          withTeamId: false,
        }),
      ),
  );

  server.registerTool(
    'corpay_get_vendor',
    {
      title: 'Get Corpay One Vendor',
      description: 'Read one vendor.',
      inputSchema: { vendorId: z.string().trim().min(1), teamId: teamIdArg() },
      annotations: READ_ONLY,
    },
    async input =>
      jsonToolResult(
        await client.request({
          method: 'GET',
          path: `/v2/teams/${encodeURIComponent(resolveTeamId(input.teamId))}/vendors/${encodeURIComponent(input.vendorId)}`,
          withTeamId: false,
        }),
      ),
  );

  // ------------------------------------------------------- cards and payments

  server.registerTool(
    'corpay_list_credit_accounts',
    {
      title: 'List Corpay One Credit Accounts',
      description: 'Credit and card accounts belonging to the team.',
      inputSchema: { teamId: teamIdArg() },
      annotations: READ_ONLY,
    },
    async input =>
      jsonToolResult(
        await client.request({
          method: 'GET',
          path: `/v2/creditaccounts/team/${encodeURIComponent(resolveTeamId(input.teamId))}`,
          withTeamId: false,
        }),
      ),
  );

  server.registerTool(
    'corpay_list_card_transactions',
    {
      title: 'List Corpay One Card Transactions',
      description:
        'Transactions on a credit account, with their bookkeeping state. Find the account id with corpay_list_credit_accounts.',
      inputSchema: {
        creditAccountId: z.string().trim().min(1),
        offset: z.number().int().min(0).optional(),
        count: z.number().int().min(1).max(100).optional(),
        teamId: teamIdArg(),
      },
      annotations: READ_ONLY,
    },
    async input =>
      jsonToolResult(
        await client.request({
          method: 'GET',
          path: `/v2/creditaccounts/${encodeURIComponent(input.creditAccountId)}/team/${encodeURIComponent(resolveTeamId(input.teamId))}/transactions`,
          query: { Offset: input.offset, Count: input.count },
          withTeamId: false,
        }),
      ),
  );

  server.registerTool(
    'corpay_list_payment_methods',
    {
      title: 'List Corpay One Payment Methods',
      description: 'Cards and bank accounts registered as payment methods.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => jsonToolResult(await client.request({ method: 'GET', path: '/v1/payments/methods' })),
  );

  server.registerTool(
    'corpay_list_team_members',
    {
      title: 'List Corpay One Team Members',
      description: 'People on the team and their roles.',
      inputSchema: { teamId: teamIdArg() },
      annotations: READ_ONLY,
    },
    async input =>
      jsonToolResult(
        await client.request({
          method: 'GET',
          path: `/v1/teams/${encodeURIComponent(resolveTeamId(input.teamId))}/members`,
          withTeamId: false,
        }),
      ),
  );

  server.registerTool(
    'corpay_list_webhooks',
    {
      title: 'List Corpay One Webhooks',
      description: 'Webhook subscriptions visible to this grant.',
      inputSchema: { teamId: teamIdArg() },
      annotations: READ_ONLY,
    },
    async input =>
      jsonToolResult(
        await client.request({
          method: 'GET',
          path: '/v1/webhooks',
          query: { teamId: resolveTeamId(input.teamId) },
        }),
      ),
  );

  // ------------------------------------------------------------ generic reads

  server.registerTool(
    'corpay_call_endpoint',
    {
      title: 'Call an Allowlisted Corpay One Endpoint',
      description:
        'Call any allowlisted Corpay One endpoint. Reads execute immediately; writes are refused here and must go through the matching prepare tool and corpay_commit_prepared_operation.',
      inputSchema: {
        method: methodSchema.default('GET'),
        pathTemplate: z.string().trim().min(1).describe('Allowlisted template, e.g. /v2/expenses.'),
        pathParams: pathParamsSchema,
        query: querySchema,
      },
      annotations: READ_ONLY,
    },
    async input => {
      const endpoint = findEndpoint(input.method, input.pathTemplate);
      if (input.method !== 'GET') {
        return errorResult(
          `${input.method} ${input.pathTemplate} is a write. Prepare it with the matching corpay_prepare_* tool, then commit it.`,
        );
      }
      const pathParams = scopePathParams(input.pathTemplate, input.pathParams);
      return jsonToolResult(
        await client.request({
          method: 'GET',
          path: materializePath(endpoint, pathParams),
          query: input.query,
        }),
      );
    },
  );

  // -------------------------------------------------------------- prepare/commit

  server.registerTool(
    'corpay_prepare_expense_coding',
    {
      title: 'Prepare Corpay One Expense Coding',
      description:
        'Dry-run the coding of an expense: category (GL account), labels and departments, set atomically. Reads the expense first and reports its current coding so the change can be checked before committing. Ids come from corpay_list_coding_options. Nothing is written until corpay_commit_prepared_operation.',
      inputSchema: {
        expenseId: z.string().trim().min(1),
        categoryId: z.string().trim().min(1).optional().describe('Corpay category id, not the GL account number.'),
        labelIds: z.array(z.string().trim().min(1)).optional().describe('Replaces the whole label set.'),
        departmentIds: z.array(z.string().trim().min(1)).optional().describe('Replaces the whole department set.'),
        reason: reasonSchema,
      },
      annotations: DRY_RUN,
    },
    async input => jsonToolResult(await prepareExpenseCoding(client, input)),
  );

  server.registerTool(
    'corpay_prepare_expense_amount_lines',
    {
      title: 'Prepare Corpay One Expense Split',
      description:
        'Dry-run splitting an expense into several coded amount lines. Amounts are in minor units (øre for DKK) and must sum to the expense total. Replaces all existing lines.',
      inputSchema: {
        expenseId: z.string().trim().min(1),
        amountLines: z
          .array(
            z.object({
              amount: z.number().describe('Minor units (øre for DKK).'),
              note: z.string().optional(),
              category: z.string().optional().describe('Corpay category id.'),
              department: z.string().optional(),
              labels: z.array(z.string()).optional(),
              itemId: z.string().optional(),
              itemQuantity: z.number().optional(),
            }),
          )
          .min(1),
        reason: reasonSchema,
      },
      annotations: DRY_RUN,
    },
    async input =>
      jsonToolResult(
        prepareOperation({
          capability: 'corpay_prepare_expense_amount_lines',
          method: 'PATCH',
          pathTemplate: '/v2/expenses/{expenseId}/amountlines',
          pathParams: { expenseId: input.expenseId },
          body: { amountLines: input.amountLines },
          reason: input.reason,
        }),
      ),
  );

  server.registerTool(
    'corpay_prepare_card_transaction_coding',
    {
      title: 'Prepare Corpay One Card Transaction Coding',
      description:
        'Dry-run the bookkeeping details of a credit account transaction: category, department, labels, item, vendor and note.',
      inputSchema: {
        creditAccountId: z.string().trim().min(1),
        creditAccountTransactionId: z.string().trim().min(1),
        categoryId: z.string().optional(),
        departmentId: z.string().optional(),
        labels: z.array(z.string()).optional(),
        itemId: z.string().optional(),
        itemQuantity: z.number().optional(),
        vendorId: z.string().optional(),
        note: z.string().optional(),
        teamId: teamIdArg(),
        reason: reasonSchema,
      },
      annotations: DRY_RUN,
    },
    async input => {
      const teamId = resolveTeamId(input.teamId);
      const { reason, teamId: _ignored, creditAccountId, creditAccountTransactionId, ...fields } = input;
      return jsonToolResult(
        prepareOperation({
          capability: 'corpay_prepare_card_transaction_coding',
          method: 'PATCH',
          pathTemplate:
            '/v2/creditaccounts/{creditAccountId}/team/{teamId}/transaction/{creditAccountTransactionId}',
          pathParams: { creditAccountId, teamId, creditAccountTransactionId },
          body: { creditAccountId, creditAccountTransactionId, teamId, ...definedOnly(fields) },
          reason,
        }),
      );
    },
  );

  server.registerTool(
    'corpay_prepare_vendor_change',
    {
      title: 'Prepare Corpay One Vendor Change',
      description:
        'Dry-run creating a vendor, or setting the external id that links an existing vendor to the accounting system.',
      inputSchema: {
        action: z.enum(['create', 'set-external-id']),
        vendorId: z.string().trim().min(1).optional().describe('Required for set-external-id.'),
        body: bodySchema.describe('Vendor payload for create, or { externalId } for set-external-id.'),
        teamId: teamIdArg(),
        reason: reasonSchema,
      },
      annotations: DRY_RUN,
    },
    async input => {
      const teamId = resolveTeamId(input.teamId);
      if (input.action === 'set-external-id' && !input.vendorId) {
        return errorResult('vendorId is required for set-external-id.');
      }
      const isCreate = input.action === 'create';
      return jsonToolResult(
        prepareOperation({
          capability: 'corpay_prepare_vendor_change',
          method: isCreate ? 'POST' : 'PATCH',
          pathTemplate: isCreate
            ? '/v2/teams/{teamId}/vendors'
            : '/v2/teams/{teamId}/vendors/{vendorId}/external-id',
          pathParams: isCreate ? { teamId } : { teamId, vendorId: input.vendorId as string },
          body: input.body,
          reason: input.reason,
        }),
      );
    },
  );

  server.registerTool(
    'corpay_prepare_coding_list_change',
    {
      title: 'Prepare Corpay One Coding List Change',
      description:
        'Dry-run a change to the coding vocabulary — categories, departments, label lists, labels or items. Pass the allowlisted endpoint for the exact operation; find it with corpay_search_capabilities.',
      inputSchema: {
        method: z.enum(['POST', 'PUT', 'PATCH']),
        pathTemplate: z.string().trim().min(1).describe('e.g. /v1/teams/{teamId}/categories'),
        pathParams: pathParamsSchema,
        body: z.unknown().optional().describe('Payload; may be an object or an array.'),
        teamId: teamIdArg(),
        reason: reasonSchema,
      },
      annotations: DRY_RUN,
    },
    async input =>
      jsonToolResult(
        prepareOperation({
          capability: 'corpay_prepare_coding_list_change',
          method: input.method,
          pathTemplate: input.pathTemplate,
          pathParams: { ...(input.pathParams ?? {}), teamId: resolveTeamId(input.teamId) },
          body: input.body,
          reason: input.reason,
        }),
      ),
  );

  server.registerTool(
    'corpay_prepare_webhook_change',
    {
      title: 'Prepare Corpay One Webhook Change',
      description:
        'Dry-run creating, updating or deleting a webhook subscription. Deleting one silently stops an integration, so it is prepared like any other write.',
      inputSchema: {
        action: z.enum(['create', 'update', 'delete']),
        webhookId: z.string().trim().min(1).optional().describe('Required for delete.'),
        url: z.string().url().optional(),
        events: z.array(z.enum(WEBHOOK_EVENTS)).optional(),
        teamId: teamIdArg(),
        reason: reasonSchema,
      },
      annotations: DRY_RUN,
    },
    async input => {
      const teamId = resolveTeamId(input.teamId);
      if (input.action === 'delete') {
        if (!input.webhookId) return errorResult('webhookId is required for delete.');
        return jsonToolResult(
          prepareOperation({
            capability: 'corpay_prepare_webhook_change',
            method: 'DELETE',
            pathTemplate: '/v1/webhooks/{webhookId}',
            pathParams: { webhookId: input.webhookId },
            reason: input.reason,
          }),
        );
      }
      if (!input.url || !input.events?.length) {
        return errorResult('url and events are required when creating or updating a webhook.');
      }
      return jsonToolResult(
        prepareOperation({
          capability: 'corpay_prepare_webhook_change',
          method: input.action === 'create' ? 'POST' : 'PUT',
          pathTemplate: '/v1/webhooks',
          body: { url: input.url, events: input.events, teamId },
          reason: input.reason,
        }),
      );
    },
  );

  server.registerTool(
    'corpay_commit_prepared_operation',
    {
      title: 'Commit a Prepared Corpay One Operation',
      description:
        'Execute a previously prepared write. Pass the prepared operation unchanged, restate its operationHash, and supply an idempotencyKey. Approvals are not accepted here — use corpay_commit_expense_approval.',
      inputSchema: {
        operation: preparedOperationSchema,
        confirmOperationHash: z.string().trim().min(32),
        idempotencyKey: idempotencyKeySchema,
      },
      annotations: WRITE,
    },
    async input => commit(client, input, { allowApproval: false }),
  );

  // -------------------------------------------------------------- approvals

  server.registerTool(
    'corpay_prepare_expense_approval',
    {
      title: 'Prepare Corpay One Expense Approval',
      description:
        'Dry-run approving or declining an expense. Approving releases the bill for payment, so this is gated separately from ordinary coding writes and is committed with corpay_commit_expense_approval.',
      inputSchema: {
        expenseId: z.string().trim().min(1),
        decision: z.enum(['approve', 'decline']),
        note: z.string().trim().min(1).optional().describe('Reason shown in Corpay; used when declining.'),
        reason: reasonSchema,
      },
      annotations: DRY_RUN,
    },
    async input =>
      jsonToolResult(
        prepareOperation({
          capability: 'corpay_prepare_expense_approval',
          method: 'PATCH',
          pathTemplate:
            input.decision === 'approve'
              ? '/v2/expenses/{expenseId}/approve'
              : '/v2/expenses/{expenseId}/decline',
          pathParams: { expenseId: input.expenseId },
          body: input.decision === 'decline' ? { note: input.note ?? input.reason } : undefined,
          reason: input.reason,
        }),
      ),
  );

  server.registerTool(
    'corpay_commit_expense_approval',
    {
      title: 'Commit a Corpay One Expense Approval',
      description:
        'Approve or decline an expense that was prepared with corpay_prepare_expense_approval. Requires CORPAYONE_ENABLE_APPROVALS on the server; approving releases the bill for payment.',
      inputSchema: {
        operation: preparedOperationSchema,
        confirmOperationHash: z.string().trim().min(32),
        idempotencyKey: idempotencyKeySchema,
      },
      annotations: WRITE,
    },
    async input => commit(client, input, { allowApproval: true }),
  );
}

// ------------------------------------------------------------------ internals

interface TeamSummary {
  id?: string;
  name?: string;
  vat?: string;
  countryCode?: string;
}

interface CommitInput {
  operation: unknown;
  confirmOperationHash: string;
  idempotencyKey?: string;
}

/**
 * Shared commit path. Re-checks the policy against the verified operation
 * rather than the caller's copy, so a payload edited between prepare and commit
 * fails the hash check before anything is sent.
 */
async function commit(
  client: CorpayClient,
  input: CommitInput,
  options: { allowApproval: boolean },
) {
  const tool = options.allowApproval
    ? 'corpay_commit_expense_approval'
    : 'corpay_commit_prepared_operation';
  const candidate = input.operation as PreparedOperation;

  try {
    if (candidate.operationHash !== input.confirmOperationHash) {
      throw new Error('confirmOperationHash does not match the prepared operation.');
    }

    const operation = verifyPreparedOperation(candidate);
    const approval = isApprovalCapability(operation.capability);
    if (approval !== options.allowApproval) {
      throw new Error(
        approval
          ? 'Approvals must be committed with corpay_commit_expense_approval.'
          : 'corpay_commit_expense_approval only accepts operations from corpay_prepare_expense_approval.',
      );
    }

    const endpoint = findEndpoint(operation.method, operation.pathTemplate);
    const pathParams = scopePathParams(operation.pathTemplate, operation.pathParams);
    const path = materializePath(endpoint, pathParams);
    const decision = checkPolicy({
      capability: operation.capability,
      method: operation.method,
      path,
      pathTemplate: operation.pathTemplate,
      body: operation.body,
    });

    if (!decision.allowed) {
      await writeAuditEvent({
        tool,
        action: 'blocked',
        teamId: pinnedTeamId(),
        method: operation.method,
        path,
        operationHash: operation.operationHash,
        idempotencyKey: input.idempotencyKey,
        allowed: false,
        reason: decision.reason,
      });
      return errorResult(`Blocked by policy: ${decision.reason}`);
    }

    const result = await client.request({
      method: operation.method,
      path,
      query: operation.query,
      body: operation.body,
      headers: operation.contentType ? { 'Content-Type': operation.contentType } : undefined,
      idempotencyKey: input.idempotencyKey,
    });

    await writeAuditEvent({
      tool,
      action: 'committed',
      teamId: pinnedTeamId(),
      method: operation.method,
      path,
      operationHash: operation.operationHash,
      idempotencyKey: input.idempotencyKey,
      allowed: true,
      reason: operation.reason,
      status: 'ok',
    });

    return jsonToolResult({ committed: true, path, result });
  } catch (error) {
    const message = formatUnknownError(error);
    await writeAuditEvent({
      tool,
      action: 'failed',
      teamId: pinnedTeamId(),
      operationHash: candidate?.operationHash,
      idempotencyKey: input.idempotencyKey,
      allowed: false,
      error: message,
    });
    return errorResult(message);
  }
}

/**
 * The team argument only appears when the server is not pinned to one team.
 * Advertising it on a pinned server would invite callers to set it, and it
 * would then be rejected.
 */
function teamIdArg(): z.ZodOptional<z.ZodString> {
  return z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      isTeamPinned()
        ? 'Ignored: this server is scoped to a single team.'
        : 'Corpay team (company) id. List them with corpay_list_teams.',
    );
}

function extractListIds(lists: unknown): string[] {
  const data = (lists as { data?: { lists?: Array<{ id?: string }> } } | undefined)?.data?.lists;
  if (!Array.isArray(data)) return [];
  return data.map(item => item?.id).filter((id): id is string => typeof id === 'string');
}

function definedOnly<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function jsonToolResult(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

export type { HttpMethod, QueryValue };
