import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { HttpMethod, QueryValue } from './client.js';
import { findEndpoint, materializePath } from './catalog.js';
import { normalizeJsonBody } from './json.js';
import { checkPolicy, type PolicyDecision } from './policy.js';
import { scopePathParams } from './team.js';

export interface PreparedOperation {
  capability: string;
  method: HttpMethod;
  pathTemplate: string;
  pathParams?: Record<string, string | number>;
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Content-Type override, for the JSON Patch coding endpoint. */
  contentType?: string;
  dryRun: true;
  reason: string;
  preparedAt: string;
  /** The operation can no longer be committed after this instant. */
  expiresAt: string;
  /** HMAC-SHA256 over the operation, keyed by a server-side secret. */
  operationHash: string;
  policyDecision: PolicyDecision;
}

export interface PrepareOperationInput {
  capability: string;
  method: HttpMethod;
  pathTemplate: string;
  pathParams?: Record<string, string | number>;
  query?: Record<string, QueryValue>;
  body?: unknown;
  contentType?: string;
  reason: string;
}

/** How long a prepared operation stays committable. */
export const PREPARED_OPERATION_TTL_MS = 15 * 60 * 1000;

/**
 * The endpoints each prepare capability may target, as `METHOD template`.
 * Enforced when preparing and again when committing, so an operation cannot
 * borrow a capability (and the policy that capability is granted) to reach an
 * endpoint it was never meant for.
 */
export const CAPABILITY_ENDPOINTS: Readonly<Record<string, readonly string[]>> = {
  corpay_prepare_expense_coding: ['PATCH /v2/expenses/{expenseId}'],
  corpay_prepare_expense_amount_lines: ['PATCH /v2/expenses/{expenseId}/amountlines'],
  corpay_prepare_card_transaction_coding: [
    'PATCH /v2/creditaccounts/{creditAccountId}/team/{teamId}/transaction/{creditAccountTransactionId}',
  ],
  corpay_prepare_vendor_change: [
    'POST /v2/teams/{teamId}/vendors',
    'PATCH /v2/teams/{teamId}/vendors/{vendorId}/external-id',
  ],
  corpay_prepare_coding_list_change: [
    'POST /v1/teams/{teamId}/categories',
    'PUT /v1/teams/{teamId}/categories',
    'POST /v1/teams/{teamId}/categories/async',
    'PUT /v1/teams/{teamId}/categories/async',
    'PUT /v1/teams/{teamId}/categories/{categoryId}',
    'POST /v1/teams/{teamId}/departments',
    'PUT /v1/teams/{teamId}/departments',
    'POST /v1/teams/{teamId}/lists',
    'PATCH /v1/teams/{teamId}/lists/{listId}',
    'POST /v1/teams/{teamId}/lists/{listId}/labels',
    'PUT /v1/teams/{teamId}/lists/{listId}/labels',
    'POST /v1/teams/{teamId}/lists/{listId}/labels/async',
    'PUT /v1/teams/{teamId}/lists/{listId}/labels/async',
    'POST /v2/teams/{teamId}/items',
    'PUT /v2/teams/{teamId}/items',
  ],
  corpay_prepare_webhook_change: [
    'POST /v1/webhooks',
    'PUT /v1/webhooks',
    'DELETE /v1/webhooks/{webhookId}',
  ],
  corpay_prepare_expense_approval: [
    'PATCH /v2/expenses/{expenseId}/approve',
    'PATCH /v2/expenses/{expenseId}/decline',
  ],
};

/** Throw unless `capability` is allowed to target `method pathTemplate`. */
export function assertCapabilityEndpoint(
  capability: string,
  method: HttpMethod,
  pathTemplate: string,
): void {
  const allowed = Object.hasOwn(CAPABILITY_ENDPOINTS, capability)
    ? CAPABILITY_ENDPOINTS[capability]
    : undefined;
  if (!allowed) {
    throw new Error(`Unknown prepare capability: ${capability}`);
  }
  if (!allowed.includes(`${method} ${pathTemplate}`)) {
    throw new Error(`${capability} cannot target ${method} ${pathTemplate}.`);
  }
}

// One random key per process unless CORPAYONE_PREPARE_SECRET is set. With
// several replicas (or across a restart), set it so a prepare on one instance
// can be committed on another.
const processSecret = randomBytes(32);

function signingKey(): Buffer {
  const configured = process.env.CORPAYONE_PREPARE_SECRET;
  return configured ? Buffer.from(configured, 'utf8') : processSecret;
}

/**
 * Validate an intended write against the allowlist and the policy, and return
 * it as a dry run signed with an HMAC. Nothing is sent to Corpay here.
 */
export function prepareOperation(
  input: PrepareOperationInput,
  now: Date = new Date(),
): PreparedOperation {
  const endpoint = findEndpoint(input.method, input.pathTemplate);
  assertCapabilityEndpoint(input.capability, input.method, input.pathTemplate);
  const pathParams = scopePathParams(input.pathTemplate, input.pathParams);
  const path = materializePath(endpoint, pathParams);
  const body = normalizeJsonBody(input.body);
  const policyDecision = checkPolicy({
    capability: input.capability,
    method: input.method,
    path,
    pathTemplate: input.pathTemplate,
    body,
  });

  const operationBase = {
    capability: input.capability,
    method: input.method,
    pathTemplate: input.pathTemplate,
    pathParams,
    query: input.query,
    body,
    contentType: input.contentType,
    reason: input.reason,
    preparedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PREPARED_OPERATION_TTL_MS).toISOString(),
  };

  return {
    ...operationBase,
    dryRun: true,
    operationHash: sign(operationBase),
    policyDecision,
  };
}

/**
 * Verify the signature and expiry, and return the operation with its body
 * normalized back to an object or array, in case the round trip through the
 * MCP client re-stringified it. Callers must use the returned operation — not
 * their input — for the policy check and the dispatch.
 */
export function verifyPreparedOperation(
  operation: PreparedOperation,
  now: Date = new Date(),
): PreparedOperation {
  const body = normalizeJsonBody(operation.body);
  const expected = Buffer.from(
    sign({
      capability: operation.capability,
      method: operation.method,
      pathTemplate: operation.pathTemplate,
      pathParams: operation.pathParams,
      query: operation.query,
      body,
      contentType: operation.contentType,
      reason: operation.reason,
      preparedAt: operation.preparedAt,
      expiresAt: operation.expiresAt,
    }),
    'hex',
  );
  const given = Buffer.from(
    /^[0-9a-f]{64}$/i.test(String(operation.operationHash ?? '')) ? String(operation.operationHash) : '',
    'hex',
  );

  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new Error(
      'Prepared operation hash does not match the operation payload. Re-run the prepare tool and commit the result unchanged.',
    );
  }

  const expiresAt = Date.parse(String(operation.expiresAt));
  if (!Number.isFinite(expiresAt) || now.getTime() > expiresAt) {
    throw new Error('Prepared operation has expired (15 minutes). Re-run the prepare tool.');
  }

  assertCapabilityEndpoint(operation.capability, operation.method, operation.pathTemplate);

  return { ...operation, body };
}

function sign(value: unknown): string {
  return createHmac('sha256', signingKey()).update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}
