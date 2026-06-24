import type { HttpMethod } from './client.js';

export type CapabilityRisk = 'read' | 'draft' | 'commit' | 'dangerous';

export interface EndpointOperation {
  id: string;
  method: HttpMethod;
  pathTemplate: string;
  summary: string;
  risk: CapabilityRisk;
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
 * Provisional Corpay One resource map.
 *
 * Corpay One exposes a REST API at https://api.corpayone.com (Swagger at /docs).
 * These resource names reflect the product's documented accounts-payable domain.
 * Exact paths, casing, and writable fields are VERIFIED during connector
 * bring-up via read-first live introspection before the write tools are enabled.
 * Treat this list as the allowlist seed, not a guarantee of upstream shape.
 */
export const CORPAY_RESOURCES: Array<{ resource: string; writable: boolean }> = [
  { resource: 'bills', writable: true }, // documents/invoices awaiting coding & approval
  { resource: 'vendors', writable: true },
  { resource: 'categories', writable: false }, // GL accounts synced from the ledger
  { resource: 'projects', writable: false },
  { resource: 'cost-types', writable: false },
  { resource: 'documents', writable: true },
  { resource: 'payments', writable: false },
  { resource: 'webhooks', writable: true },
];

export const ENDPOINT_OPERATIONS: EndpointOperation[] = buildEndpointOperations();

export const CURATED_CAPABILITIES: Capability[] = [
  tool('corpay_check_connection', 'Check Corpay One connection', 'Validate credentials and return account context.', 'read', ['auth', 'setup']),
  tool('corpay_search_capabilities', 'Search capabilities', 'Find supported tools and allowlisted endpoint operations.', 'read', ['discovery']),
  tool('corpay_list_bills', 'List bills', 'List bills/documents, filterable by approval status.', 'read', ['bill', 'approval']),
  tool('corpay_get_bill', 'Get bill', 'Read one bill including vendor, amounts, and line coding.', 'read', ['bill']),
  tool('corpay_prepare_bill_coding', 'Prepare bill coding', 'Dry-run set of a bill’s project, cost type, and category/account.', 'draft', ['bill', 'coding', 'project', 'write']),
  tool('corpay_commit_prepared_operation', 'Commit prepared operation', 'Execute a prepared, policy-checked write with a confirmation hash.', 'commit', ['write']),
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

function buildEndpointOperations(): EndpointOperation[] {
  const operations: EndpointOperation[] = [];
  for (const { resource, writable } of CORPAY_RESOURCES) {
    operations.push(
      { id: id('GET', `/${resource}`), method: 'GET', pathTemplate: `/${resource}`, summary: `List ${resource}.`, risk: 'read' },
      { id: id('GET', `/${resource}/{id}`), method: 'GET', pathTemplate: `/${resource}/{id}`, summary: `Get one ${resource} item.`, risk: 'read' },
    );
    if (writable) {
      operations.push(
        { id: id('POST', `/${resource}`), method: 'POST', pathTemplate: `/${resource}`, summary: `Create ${resource}.`, risk: 'commit' },
        { id: id('PATCH', `/${resource}/{id}`), method: 'PATCH', pathTemplate: `/${resource}/{id}`, summary: `Update one ${resource} item.`, risk: 'commit' },
      );
    }
  }
  return operations;
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
