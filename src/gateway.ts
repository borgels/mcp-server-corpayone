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
 * Matches the e-conomic gateway shape exactly so the Borgels control plane
 * (mcp.borgels.com) can wrap Corpay One as a provider without copying connector
 * logic: stable, unprefixed tool definitions (`riskLevel`/`enabledByDefault`) and
 * a `callTool` returning a `GatewayToolResult`. Reads are enabled by default; the
 * coding write is disabled by default and gated by the connector's write policy.
 */
export type GatewayRiskLevel = 'read' | 'write' | 'destructive';
// Structurally identical to the other Borgels connector gateways (e-conomic et al.)
// so this gateway plugs into the control plane's shared connector typing.
export type GatewayJsonValue =
  | string
  | number
  | boolean
  | null
  | GatewayJsonValue[]
  | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  enabledByDefault: boolean;
  inputSchema: GatewayJsonObject;
}

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
}

export const corpayGatewayTools: GatewayToolDefinition[] = [
  {
    name: 'check_connection',
    title: 'Check Corpay One connection',
    description: 'Validate OAuth credentials and list accessible teams.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_expenses',
    title: 'List expenses',
    description: 'List expenses (bills/documents), filterable by status (e.g. pending approval).',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' }, limit: { type: 'number' } },
      additionalProperties: true,
    },
  },
  {
    name: 'get_expense',
    title: 'Get expense',
    description: 'Read one expense including vendor, amounts, line items, and coding.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      properties: { id: { type: ['string', 'number'] } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_expense_coding',
    title: 'Write expense coding',
    description:
      'Set an expense’s coding: category (GL account), labels (project/cost type), and department. Write — disabled by default; requires CORPAYONE_ENABLE_WRITES and the live PATCH endpoint to be confirmed.',
    riskLevel: 'write',
    enabledByDefault: false,
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
      additionalProperties: false,
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
  callTool(name: string, args?: GatewayJsonObject): Promise<GatewayToolResult>;
}

export function createCorpayGateway(options: CorpayGatewayOptions = {}): CorpayGateway {
  if (options.contractMode) {
    return { tools: corpayGatewayTools, callTool: (name, args = {}) => Promise.resolve(contractToolResult(name, args)) };
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
            return jsonResult(
              'Corpay One connection is available.',
              await client.request({ method: 'GET', path: '/v1/teams', withTeamId: false }),
            );
          case 'list_expenses':
            return jsonResult(
              'Listed Corpay One expenses.',
              await client.request({ method: 'GET', path: '/v2/expenses', query: toQuery(args) }),
            );
          case 'get_expense':
            return jsonResult(
              'Fetched Corpay One expense.',
              await client.request({ method: 'GET', path: `/v3/expenses/${String(args.id)}` }),
            );
          case 'write_expense_coding': {
            // Route through the connector's prepare -> commit so its allowlist,
            // write policy, and operation hash apply. PATCH path is provisional
            // until confirmed against the live Swagger.
            const op = prepareOperation({
              capability: 'corpay_write_expense_coding',
              method: 'PATCH',
              pathTemplate: '/v2/expenses/{id}',
              pathParams: { id: String(args.id) },
              body: codingBody(args),
              reason: 'gateway write_expense_coding',
            });
            if (!op.policyAllowed) {
              return errorResult(`Blocked by policy: ${op.policyReason}`);
            }
            const result = await executePreparedOperation(
              client,
              op,
              op.operationHash,
              typeof args.idempotencyKey === 'string' ? args.idempotencyKey : op.operationHash,
            );
            return jsonResult('Updated Corpay One expense coding.', result ?? { ok: true });
          }
          default:
            return errorResult(`Unsupported Corpay One gateway tool: ${name}`);
        }
      } catch (error) {
        return errorResult(formatUnknownError(error));
      }
    },
  };
}

function contractToolResult(name: string, args: GatewayJsonObject): GatewayToolResult {
  switch (name) {
    case 'check_connection':
      return jsonResult('Corpay One connection is available.', {
        ok: true,
        teams: [{ id: 'nBvY6dLQ', name: 'Contract Fixture ApS' }],
      });
    case 'list_expenses':
      return jsonResult('Listed Corpay One expenses.', {
        items: [{ id: 'exp_1', state: 'booked', type: 'bill', amount: 1234.56 }],
      });
    case 'get_expense':
      return jsonResult('Fetched Corpay One expense.', {
        id: String(args.id ?? 'exp_1'),
        state: 'booked',
        type: 'bill',
        amount: 1234.56,
        category: null,
        labels: [],
        lines: [],
      });
    case 'write_expense_coding':
      return jsonResult('Updated Corpay One expense coding.', {
        id: String(args.id ?? 'exp_1'),
        updated: true,
        ...codingBody(args),
      });
    default:
      return errorResult(`Unsupported Corpay One gateway tool: ${name}`);
  }
}

/** Coerce gateway args into query parameters (drops non-scalar values). */
function toQuery(args: GatewayJsonObject): Record<string, QueryValue> {
  const query: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(args)) {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      query[key] = value;
    }
  }
  return query;
}

/** Build the coding payload from gateway args, including only provided fields. */
function codingBody(args: GatewayJsonObject): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (args.category !== undefined) body.category = args.category;
  if (args.labels !== undefined) body.labels = args.labels;
  if (args.department !== undefined) body.department = args.department;
  return body;
}

function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  return { content: [{ type: 'text', text }], structuredContent: toGatewayJson(structuredContent) };
}

/** Coerce an arbitrary value into a JSON-safe GatewayJsonValue. */
function toGatewayJson(value: unknown): GatewayJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as GatewayJsonValue;
}

function errorResult(text: string): GatewayToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}
