import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CorpayClient, type HttpMethod } from '../corpay/client.js';
import { searchCapabilities } from '../corpay/catalog.js';
import {
  prepareOperation,
  executePreparedOperation,
  type PreparedOperation,
} from '../corpay/operations.js';
import { formatUnknownError } from '../errors.js';

const pathParamsSchema = z.record(z.string(), z.union([z.string(), z.number()])).optional();
const querySchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional();

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(error: unknown) {
  return {
    content: [{ type: 'text' as const, text: formatUnknownError(error) }],
    isError: true,
  };
}

export function registerCorpayTools(server: McpServer, client: CorpayClient): void {
  server.registerTool(
    'corpay_search_capabilities',
    {
      title: 'Search Corpay One capabilities',
      description: 'Find supported tools and allowlisted endpoint operations.',
      inputSchema: { query: z.string().trim().default('') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query }) => jsonResult(searchCapabilities(query)),
  );

  server.registerTool(
    'corpay_check_connection',
    {
      title: 'Check Corpay One connection',
      description: 'Validate OAuth credentials by acquiring an access token (does not require a teamId).',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        // /v1/teams is forbidden with the expenses/webhooks scopes; validate by
        // acquiring an OAuth token instead. teamId (from the Corpay One URL or a
        // webhook payload) is needed for expense/webhook reads.
        await client.getAccessToken();
        return jsonResult({ ok: true, note: 'Set teamId to read expenses or manage webhooks.' });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'corpay_call_endpoint',
    {
      title: 'Call allowlisted Corpay One endpoint',
      description:
        'Call a validated, allowlisted endpoint. Read-only unless write policy permits the call.',
      inputSchema: {
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
        pathTemplate: z.string().trim().min(1),
        pathParams: pathParamsSchema,
        query: querySchema,
        body: z.unknown().optional(),
        idempotencyKey: z.string().trim().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async input => {
      try {
        const operation = prepareOperation({
          capability: 'corpay_call_endpoint',
          method: input.method as HttpMethod,
          pathTemplate: input.pathTemplate,
          pathParams: input.pathParams,
          query: input.query,
          body: input.body,
          reason: 'corpay_call_endpoint',
        });
        if (!operation.policyAllowed) {
          return errorResult(new Error(`Blocked by policy: ${operation.policyReason}`));
        }
        const data = await client.request({
          method: operation.method,
          path: operation.path,
          query: operation.query,
          body: operation.body,
          idempotencyKey:
            input.method === 'GET' ? undefined : (input.idempotencyKey ?? operation.operationHash),
        });
        return jsonResult(data);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'corpay_prepare_expense_coding',
    {
      title: 'Prepare expense coding',
      description:
        'Dry-run update of an expense’s coding — category (GL account) and labels (project, cost type, ...). Returns an operationHash to commit. Does not call Corpay One until committed.',
      inputSchema: {
        expenseId: z.union([z.string(), z.number()]),
        body: z.unknown(),
        reason: z.string().trim().min(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ expenseId, body, reason }) =>
      jsonResult(
        prepareOperation({
          capability: 'corpay_prepare_expense_coding',
          method: 'PATCH',
          pathTemplate: '/v2/expenses/{id}',
          pathParams: { id: expenseId },
          body,
          reason,
        }),
      ),
  );

  server.registerTool(
    'corpay_prepare_webhook_change',
    {
      title: 'Prepare webhook change',
      description:
        'Dry-run create (POST), update (PUT), or delete (DELETE) of a webhook subscription. Returns an operationHash to commit.',
      inputSchema: {
        method: z.enum(['POST', 'PUT', 'DELETE']).default('POST'),
        webhookId: z.union([z.string(), z.number()]).optional(),
        body: z.unknown().optional(),
        reason: z.string().trim().min(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ method, webhookId, body, reason }) =>
      jsonResult(
        prepareOperation({
          capability: 'corpay_prepare_webhook_change',
          method,
          pathTemplate: method === 'DELETE' ? '/v1/webhooks/{id}' : '/v1/webhooks',
          pathParams: method === 'DELETE' ? { id: webhookId ?? '' } : undefined,
          body,
          reason,
        }),
      ),
  );

  server.registerTool(
    'corpay_list_webhooks',
    {
      title: 'List webhooks',
      description: 'List active webhook subscriptions for the configured team.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return jsonResult(await client.request({ method: 'GET', path: '/v1/webhooks' }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'corpay_commit_prepared_operation',
    {
      title: 'Commit prepared operation',
      description:
        'Execute a prepared, policy-checked write. Requires the full prepared operation, a matching confirmOperationHash, and an idempotencyKey.',
      inputSchema: {
        operation: z.unknown(),
        confirmOperationHash: z.string().trim().min(1),
        idempotencyKey: z.string().trim().min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ operation, confirmOperationHash, idempotencyKey }) => {
      try {
        const data = await executePreparedOperation(
          client,
          operation as PreparedOperation,
          confirmOperationHash,
          idempotencyKey,
        );
        return jsonResult(data ?? { ok: true });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // Read helpers over the allowlisted endpoints, for ergonomic discovery.
  server.registerTool(
    'corpay_list_expenses',
    {
      title: 'List expenses',
      description:
        'List expenses (bills/documents). Filter via query (e.g. status=pending_approval).',
      inputSchema: { query: querySchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query }) => {
      try {
        return jsonResult(await client.request({ method: 'GET', path: '/v2/expenses', query }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
