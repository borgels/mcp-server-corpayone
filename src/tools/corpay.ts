import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CorpayClient, type HttpMethod } from '../corpay/client.js';
import { searchCapabilities } from '../corpay/catalog.js';
import {
  prepareOperation,
  executePreparedOperation,
  type PreparedOperation,
} from '../corpay/operations.js';
import { checkPolicy } from '../corpay/policy.js';
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
      description:
        'Validate credentials by issuing a read against a configurable path (default "/").',
      inputSchema: { path: z.string().trim().default('/') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ path }) => {
      try {
        const data = await client.request({ method: 'GET', path });
        return jsonResult({ ok: true, path, data });
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
    'corpay_prepare_bill_coding',
    {
      title: 'Prepare bill coding',
      description:
        'Dry-run update of a bill’s coding (project, cost type, category/account). Returns an operationHash to commit. Does not call Corpay One until committed.',
      inputSchema: {
        billId: z.union([z.string(), z.number()]),
        body: z.unknown(),
        reason: z.string().trim().min(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ billId, body, reason }) =>
      jsonResult(
        prepareOperation({
          capability: 'corpay_prepare_bill_coding',
          method: 'PATCH',
          pathTemplate: '/bills/{id}',
          pathParams: { id: billId },
          body,
          reason,
        }),
      ),
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
    'corpay_list_bills',
    {
      title: 'List bills',
      description: 'List bills/documents. Filter via query (e.g. status=pending_approval).',
      inputSchema: { query: querySchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query }) => {
      try {
        const decision = checkPolicy({ capability: 'corpay_list_bills', method: 'GET', path: '/bills' });
        if (!decision.allowed) return errorResult(new Error(decision.reason));
        return jsonResult(await client.request({ method: 'GET', path: '/bills', query }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
