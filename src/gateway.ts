import { CorpayClient, type QueryValue } from './corpay/client.js';
import { prepareOperation, executePreparedOperation } from './corpay/operations.js';
import { formatUnknownError } from './errors.js';

// Re-exported so Borgels control-plane runtimes can validate inbound Corpay One
// webhooks and filter event types without reaching into package internals.
export { validateWebhookSignature } from './corpay/webhooks.js';
export { WEBHOOK_EVENTS } from './corpay/catalog.js';

/**
 * Borgels gateway contract for Corpay One.
 *
 * Mirrors the e-conomic gateway: stable, unprefixed, read-first tool definitions
 * plus a factory the Borgels control plane (mcp.borgels.com) uses to wrap Corpay
 * One without copying connector logic. All gateway tools are read-only; write
 * preparation/commit remain on the full MCP server surface behind write policy.
 */
export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  risk: 'read' | 'write';
  defaultEnabled: boolean;
  inputSchema: Record<string, unknown>;
}

export const corpayGatewayTools: GatewayToolDefinition[] = [
  {
    name: 'check_connection',
    title: 'Check Corpay One connection',
    description: 'Validate OAuth credentials and list accessible teams.',
    risk: 'read',
    defaultEnabled: true,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_expenses',
    title: 'List expenses',
    description: 'List expenses (bills/documents), filterable by status (e.g. pending approval).',
    risk: 'read',
    defaultEnabled: true,
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' }, limit: { type: 'number' } },
    },
  },
  {
    name: 'get_expense',
    title: 'Get expense',
    description: 'Read one expense including vendor, amounts, line items, and coding.',
    risk: 'read',
    defaultEnabled: true,
    inputSchema: {
      type: 'object',
      properties: { id: { type: ['string', 'number'] } },
      required: ['id'],
    },
  },
  {
    name: 'write_expense_coding',
    title: 'Write expense coding',
    description:
      'Set an expense’s coding: category (GL account), labels (project/cost type), and department. Write — disabled by default; requires CORPAYONE_ENABLE_WRITES and the live PATCH endpoint to be confirmed.',
    risk: 'write',
    defaultEnabled: false,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['string', 'number'] },
        category: {},
        labels: {},
        department: {},
        idempotencyKey: { type: 'string' },
      },
      required: ['id'],
    },
  },
];

export interface CorpayGatewayOptions {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  teamId?: string;
  env?: 'staging' | 'production';
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Deterministic, no-network fixture mode for review/demo automation. */
  contractMode?: boolean;
}

export interface CorpayGateway {
  tools: GatewayToolDefinition[];
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
}

export function createCorpayGateway(options: CorpayGatewayOptions = {}): CorpayGateway {
  if (options.contractMode) {
    return { tools: corpayGatewayTools, callTool: callContractTool };
  }
  const client = new CorpayClient({
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    refreshToken: options.refreshToken,
    teamId: options.teamId,
    env: options.env,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  return {
    tools: corpayGatewayTools,
    async callTool(name, args = {}) {
      try {
        switch (name) {
          case 'check_connection':
            return await client.request({ method: 'GET', path: '/v1/teams', withTeamId: false });
          case 'list_expenses':
            return await client.request({
              method: 'GET',
              path: '/v2/expenses',
              query: args as Record<string, QueryValue>,
            });
          case 'get_expense':
            return await client.request({ method: 'GET', path: `/v3/expenses/${String(args.id)}` });
          case 'write_expense_coding': {
            // Route through the connector's prepare -> commit so its allowlist,
            // policy (writes-gated), and operation hash apply. The PATCH path is
            // provisional until confirmed against the live Swagger.
            const body = codingBody(args);
            const op = prepareOperation({
              capability: 'corpay_write_expense_coding',
              method: 'PATCH',
              pathTemplate: '/v2/expenses/{id}',
              pathParams: { id: String(args.id) },
              body,
              reason: 'gateway write_expense_coding',
            });
            if (!op.policyAllowed) {
              throw new Error(`Blocked by policy: ${op.policyReason}`);
            }
            return await executePreparedOperation(
              client,
              op,
              op.operationHash,
              typeof args.idempotencyKey === 'string' ? args.idempotencyKey : op.operationHash,
            );
          }
          default:
            throw new Error(`Unknown gateway tool: ${name}`);
        }
      } catch (error) {
        throw new Error(formatUnknownError(error));
      }
    },
  };
}

function callContractTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  switch (name) {
    case 'check_connection':
      return Promise.resolve({ ok: true, teams: [{ id: 'nBvY6dLQ', name: 'Contract Fixture ApS' }] });
    case 'list_expenses':
      return Promise.resolve({ items: [{ id: 'exp_1', state: 'booked', type: 'bill', amount: 1234.56 }] });
    case 'get_expense':
      return Promise.resolve({ id: String(args.id ?? 'exp_1'), state: 'booked', type: 'bill', amount: 1234.56, category: null, labels: [], lines: [] });
    case 'write_expense_coding':
      return Promise.resolve({ id: String(args.id ?? 'exp_1'), updated: true, ...codingBody(args) });
    default:
      return Promise.reject(new Error(`Unknown gateway tool: ${name}`));
  }
}

/** Build the coding payload from gateway args, including only provided fields. */
function codingBody(args: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (args.category !== undefined) body.category = args.category;
  if (args.labels !== undefined) body.labels = args.labels;
  if (args.department !== undefined) body.department = args.department;
  return body;
}
