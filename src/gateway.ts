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
    description: 'Validate credentials and return account context.',
    risk: 'read',
    defaultEnabled: true,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
  {
    name: 'list_bills',
    title: 'List bills',
    description: 'List bills/documents, filterable by status (e.g. pending approval).',
    risk: 'read',
    defaultEnabled: true,
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' }, limit: { type: 'number' } },
    },
  },
  {
    name: 'get_bill',
    title: 'Get bill',
    description: 'Read one bill including vendor, amounts, and line coding.',
    risk: 'read',
    defaultEnabled: true,
    inputSchema: {
      type: 'object',
      properties: { id: { type: ['string', 'number'] } },
      required: ['id'],
    },
  },
  {
    name: 'list_coding_options',
    title: 'List coding options',
    description: 'List categories (accounts), projects, and cost types available for coding.',
    risk: 'read',
    defaultEnabled: true,
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['categories', 'projects', 'cost-types'] } },
    },
  },
];

export interface CorpayGatewayOptions {
  apiToken?: string;
  baseUrl?: string;
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
    apiToken: options.apiToken,
    baseUrl: options.baseUrl,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  return {
    tools: corpayGatewayTools,
    async callTool(name, args = {}) {
      try {
        switch (name) {
          case 'check_connection':
            return await client.request({ method: 'GET', path: String(args.path ?? '/') });
          case 'list_bills':
            return await client.request({
              method: 'GET',
              path: '/bills',
              query: args as Record<string, QueryValue>,
            });
          case 'get_bill':
            return await client.request({ method: 'GET', path: `/bills/${String(args.id)}` });
          case 'list_coding_options':
            return await client.request({ method: 'GET', path: `/${String(args.kind ?? 'categories')}` });
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
      return Promise.resolve({ ok: true, account: 'contract-fixture' });
    case 'list_bills':
      return Promise.resolve({ items: [{ id: 'bill_1', vendor: 'Acme ApS', status: 'pending_approval', amount: 1234.56 }] });
    case 'get_bill':
      return Promise.resolve({ id: String(args.id ?? 'bill_1'), vendor: 'Acme ApS', amount: 1234.56, lines: [] });
    case 'list_coding_options':
      return Promise.resolve({ kind: args.kind ?? 'categories', items: [] });
    default:
      return Promise.reject(new Error(`Unknown gateway tool: ${name}`));
  }
}
