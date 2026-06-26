import { CorpayClient, type QueryValue } from './corpay/client.js';
import { checkPolicy, loadPolicy } from './corpay/policy.js';
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
    name: 'list_categories',
    title: 'List categories',
    description:
      'List the team’s coding categories (GL accounts) with their Corpay category id, number, and name — the writable coding options.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_coding_options',
    title: 'List coding options',
    description:
      'List every writable coding option for expenses in one call: categories (GL accounts) with their Corpay id + GL number, and label lists (e.g. project, cost type) with each label’s Corpay id and externalId (the source-system number). These ids are what write_expense_coding consumes.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'write_expense_coding',
    title: 'Write expense coding',
    description:
      'Set an expense’s coding via RFC 6902 JSON Patch: categoryId (the Corpay category id from list_categories), labelIds, and departmentIds. Write — disabled by default; enable via the gateway’s enableWrites option or the CORPAYONE_ENABLE_WRITES env flag.',
    riskLevel: 'write',
    enabledByDefault: false,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['string', 'number'] },
        categoryId: { type: ['string', 'null'] },
        labelIds: { type: 'array', items: { type: 'string' } },
        departmentIds: { type: 'array', items: { type: 'string' } },
        idempotencyKey: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

// Minimal upstream shapes used when assembling list_coding_options. Kept local
// to the gateway; the tool returns these straight through as GatewayJsonValue.
interface CorpayCategory {
  id: string;
  number?: string;
  name?: string;
}
interface CorpayListSummary {
  id: string;
  name?: string;
  type?: string;
}
interface CorpayLabel {
  id: string;
  externalId?: string | null;
  value?: string | null;
}

export interface CorpayGatewayOptions {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  teamId?: string;
  env?: 'staging' | 'production';
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Enable coding writes for this gateway instance. A control plane that wraps
   * the gateway and applies its own write governance (scopes, approvals, audit)
   * passes `true` to opt in, instead of relying on the CORPAYONE_ENABLE_WRITES
   * environment flag used by the standalone server. Defaults to the env flag.
   */
  enableWrites?: boolean;
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
  const teamId = options.teamId ?? process.env.CORPAYONE_TEAM_ID ?? '';
  // Writes are permitted when the embedder opts in via `enableWrites` or the
  // standalone CORPAYONE_ENABLE_WRITES env flag; the rest of the write policy
  // (allowed methods/paths/amount) still applies on top.
  const writePolicy = options.enableWrites ? { ...loadPolicy(), writesEnabled: true } : loadPolicy();
  return {
    tools: corpayGatewayTools,
    async callTool(name, args = {}) {
      try {
        switch (name) {
          case 'check_connection': {
            await client.getAccessToken();
            return jsonResult('Corpay One credentials are valid (OAuth token acquired).', { ok: true });
          }
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
          case 'list_categories': {
            // Categories (GL accounts) with their Corpay id/number/name — the
            // writable coding options. Requires the teams.categories scope.
            const data = await client.request<{ data?: { categories?: unknown } }>({
              method: 'GET',
              path: `/v1/teams/${teamId}/categories`,
              withTeamId: false,
            });
            return jsonResult('Listed Corpay One categories.', { categories: data?.data?.categories ?? [] });
          }
          case 'list_coding_options': {
            // One call returns everything writable: categories (GL accounts) plus
            // each label list (project, cost type, …) with its labels. Label/category
            // ids are what write_expense_coding consumes; externalId carries the
            // source-system number so callers can resolve by GL/project number.
            const [catData, listsData] = await Promise.all([
              client.request<{ data?: { categories?: CorpayCategory[] } }>({
                method: 'GET',
                path: `/v1/teams/${teamId}/categories`,
                withTeamId: false,
              }),
              client.request<{ data?: { lists?: CorpayListSummary[] } }>({
                method: 'GET',
                path: `/v1/teams/${teamId}/lists`,
                withTeamId: false,
              }),
            ]);
            const summaries = listsData?.data?.lists ?? [];
            const lists = await Promise.all(
              summaries.map(async (summary) => {
                const detail = await client.request<{ data?: { list?: { labels?: CorpayLabel[] } } }>({
                  method: 'GET',
                  path: `/v1/teams/${teamId}/lists/${summary.id}`,
                  withTeamId: false,
                });
                const labels = (detail?.data?.list?.labels ?? []).map((label) => ({
                  id: label.id,
                  externalId: label.externalId ?? null,
                  value: label.value ?? null,
                }));
                return { id: summary.id, name: summary.name ?? null, type: summary.type ?? null, labels };
              }),
            );
            return jsonResult('Listed Corpay One coding options.', {
              categories: catData?.data?.categories ?? [],
              lists,
            });
          }
          case 'write_expense_coding': {
            // Coding is written via RFC 6902 JSON Patch. categoryId is the Corpay
            // category id (from list_categories), not the GL number.
            const decision = checkPolicy(
              {
                capability: 'corpay_write_expense_coding',
                method: 'PATCH',
                path: `/v2/expenses/${String(args.id)}`,
              },
              writePolicy,
            );
            if (!decision.allowed) return errorResult(`Blocked by policy: ${decision.reason}`);
            const ops = codingPatch(args);
            if (ops.length === 0) return errorResult('No coding fields supplied.');
            const result = await client.request({
              method: 'PATCH',
              path: `/v2/expenses/${String(args.id)}`,
              body: ops,
              headers: { 'Content-Type': 'application/json-patch+json' },
              idempotencyKey: typeof args.idempotencyKey === 'string' ? args.idempotencyKey : undefined,
            });
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
      return jsonResult('Corpay One credentials are valid (OAuth token acquired).', { ok: true });
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
    case 'list_categories':
      return jsonResult('Listed Corpay One categories.', {
        categories: [
          { id: 'cat_1310', number: '1310', name: 'Direkte omkostninger m/moms' },
          { id: 'cat_9900', number: '9900', name: 'Analyse/fejlkonto' },
        ],
      });
    case 'list_coding_options':
      return jsonResult('Listed Corpay One coding options.', {
        categories: [
          { id: 'cat_1310', number: '1310', name: 'Direkte omkostninger m/moms' },
          { id: 'cat_9900', number: '9900', name: 'Analyse/fejlkonto' },
        ],
        lists: [
          {
            id: 'list_projects',
            name: 'Projekter',
            type: 'EconomicProjects',
            labels: [{ id: 'lbl_p1', externalId: '1', value: '1 Demo project' }],
          },
          {
            id: 'list_costtypes',
            name: 'Omkostningstype',
            type: 'EconomicCostNumbers',
            labels: [{ id: 'lbl_c1', externalId: '1', value: '1 Materialer' }],
          },
        ],
      });
    case 'write_expense_coding':
      return jsonResult('Updated Corpay One expense coding.', {
        id: String(args.id ?? 'exp_1'),
        updated: true,
        patch: codingPatch(args),
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

// Build an RFC 6902 JSON Patch from the supplied coding fields. categoryId is the
// Corpay category id (from list_categories); labelIds/departmentIds are id arrays.
function codingPatch(args: GatewayJsonObject): Array<{ op: string; path: string; value: unknown }> {
  const ops: Array<{ op: string; path: string; value: unknown }> = [];
  if (args.categoryId !== undefined) ops.push({ op: 'add', path: '/categoryId', value: args.categoryId });
  if (Array.isArray(args.labelIds)) ops.push({ op: 'add', path: '/labelIds', value: args.labelIds });
  if (Array.isArray(args.departmentIds)) ops.push({ op: 'add', path: '/departmentIds', value: args.departmentIds });
  return ops;
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
