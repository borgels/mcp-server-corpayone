import { createHash } from 'node:crypto';
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

/**
 * Validate an intended write against the allowlist and the policy, and return
 * it as a dry run stamped with a hash. Nothing is sent to Corpay here.
 */
export function prepareOperation(input: PrepareOperationInput): PreparedOperation {
  const endpoint = findEndpoint(input.method, input.pathTemplate);
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
  };

  return {
    ...operationBase,
    dryRun: true,
    operationHash: stableHash(operationBase),
    policyDecision,
  };
}

/**
 * Verify the hash and return the operation with its body normalized back to an
 * object or array, in case the round trip through the MCP client re-stringified
 * it. Callers must use the returned operation — not their input — for the
 * policy check and the dispatch.
 */
export function verifyPreparedOperation(operation: PreparedOperation): PreparedOperation {
  const body = normalizeJsonBody(operation.body);
  const expected = stableHash({
    capability: operation.capability,
    method: operation.method,
    pathTemplate: operation.pathTemplate,
    pathParams: operation.pathParams,
    query: operation.query,
    body,
    contentType: operation.contentType,
    reason: operation.reason,
  });

  if (expected !== operation.operationHash) {
    throw new Error(
      'Prepared operation hash does not match the operation payload. Re-run the prepare tool and commit the result unchanged.',
    );
  }

  return { ...operation, body };
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}
