import { createHash } from 'node:crypto';
import { CorpayClient, type HttpMethod, type QueryValue } from './client.js';
import { findEndpoint, materializePath } from './catalog.js';
import { checkPolicy } from './policy.js';

export interface PreparedOperation {
  capability: string;
  method: HttpMethod;
  pathTemplate: string;
  path: string;
  pathParams?: Record<string, string | number>;
  query?: Record<string, QueryValue>;
  body?: unknown;
  reason: string;
  operationHash: string;
  policyAllowed: boolean;
  policyReason: string;
}

export interface PrepareInput {
  capability: string;
  method: HttpMethod;
  pathTemplate: string;
  pathParams?: Record<string, string | number>;
  query?: Record<string, QueryValue>;
  body?: unknown;
  reason: string;
}

/** Validate against the allowlist + policy and return a dry-run with a hash. */
export function prepareOperation(input: PrepareInput): PreparedOperation {
  const endpoint = findEndpoint(input.method, input.pathTemplate);
  const path = materializePath(endpoint, input.pathParams ?? {});
  const decision = checkPolicy({
    capability: input.capability,
    method: input.method,
    path,
    body: input.body,
  });
  const operationHash = hashOperation(input.method, path, input.body);
  return {
    capability: input.capability,
    method: input.method,
    pathTemplate: input.pathTemplate,
    path,
    pathParams: input.pathParams,
    query: input.query,
    body: input.body,
    reason: input.reason,
    operationHash,
    policyAllowed: decision.allowed,
    policyReason: decision.reason,
  };
}

export async function executePreparedOperation(
  client: CorpayClient,
  operation: PreparedOperation,
  confirmOperationHash: string,
  idempotencyKey: string,
): Promise<unknown> {
  if (confirmOperationHash !== operation.operationHash) {
    throw new Error('confirmOperationHash does not match the prepared operation.');
  }
  const decision = checkPolicy({
    capability: operation.capability,
    method: operation.method,
    path: operation.path,
    body: operation.body,
  });
  if (!decision.allowed) {
    throw new Error(`Blocked by policy: ${decision.reason}`);
  }
  return client.request({
    method: operation.method,
    path: operation.path,
    query: operation.query,
    body: operation.body,
    idempotencyKey,
  });
}

export function hashOperation(method: HttpMethod, path: string, body: unknown): string {
  const canonical = JSON.stringify({ method, path, body: body ?? null });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}
