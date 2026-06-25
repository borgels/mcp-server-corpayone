import { CorpayClient, type QueryValue } from './corpay/client.js';
import { formatUnknownError } from './errors.js';

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
    default:
      return Promise.reject(new Error(`Unknown gateway tool: ${name}`));
  }
}
