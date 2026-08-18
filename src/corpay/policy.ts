import { readFileSync } from 'node:fs';
import type { HttpMethod } from './client.js';
import { findEndpoint, type CapabilityRisk } from './catalog.js';

export interface CorpayPolicy {
  /** Master switch for every mutating call. */
  writesEnabled: boolean;
  /**
   * Gates approving and declining expenses. Approval releases a bill for
   * payment, so it is a separate decision from ordinary coding writes: a
   * server may be allowed to code all day and still never approve anything.
   */
  approvalsEnabled: boolean;
  allowedCapabilities: string[];
  allowedMethods: HttpMethod[];
  deniedPathPatterns: string[];
  maxAmount?: number;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  policy: CorpayPolicy;
}

export interface PolicyCheckInput {
  capability: string;
  method: HttpMethod;
  path: string;
  /** Allowlist template, when known — used to look up the risk tier. */
  pathTemplate?: string;
  body?: unknown;
}

export function loadPolicy(): CorpayPolicy {
  const base: CorpayPolicy = {
    writesEnabled: process.env.CORPAYONE_ENABLE_WRITES === 'true',
    approvalsEnabled: process.env.CORPAYONE_ENABLE_APPROVALS === 'true',
    allowedCapabilities: [],
    allowedMethods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    // Surfaces that move money, hand out access, or destroy shared
    // configuration. Denied for every capability unless a policy file
    // deliberately re-allows them.
    deniedPathPatterns: [
      '^/v1/teams$',
      '^/v1/teams/[^/]+$',
      '/payments/methods',
      '/members',
      '/usage/export',
    ],
  };

  const policyPath = process.env.CORPAYONE_POLICY_PATH;
  if (!policyPath) return base;

  const parsed = JSON.parse(readFileSync(policyPath, 'utf8')) as Partial<CorpayPolicy>;
  return {
    ...base,
    ...parsed,
    writesEnabled: parsed.writesEnabled ?? base.writesEnabled,
    approvalsEnabled: parsed.approvalsEnabled ?? base.approvalsEnabled,
    allowedCapabilities: parsed.allowedCapabilities ?? base.allowedCapabilities,
    allowedMethods: parsed.allowedMethods ?? base.allowedMethods,
    deniedPathPatterns: parsed.deniedPathPatterns ?? base.deniedPathPatterns,
  };
}

export function isMutation(method: HttpMethod): boolean {
  return method !== 'GET';
}

/** The exact endpoints the approval capabilities may target — nothing else. */
const APPROVAL_PATHS = /^\/v2\/expenses\/[^/]+\/(approve|decline)$/;

export function isApprovalCapability(capability: string): boolean {
  return (
    capability === 'corpay_prepare_expense_approval' ||
    capability === 'corpay_commit_expense_approval'
  );
}

/** Risk tier of an allowlisted endpoint, or undefined when it is not one. */
export function endpointRisk(
  method: HttpMethod,
  pathTemplate: string | undefined,
): CapabilityRisk | undefined {
  if (!pathTemplate) return undefined;
  try {
    return findEndpoint(method, pathTemplate).risk;
  } catch {
    return undefined;
  }
}

export function checkPolicy(input: PolicyCheckInput, policy = loadPolicy()): PolicyDecision {
  if (!isMutation(input.method)) {
    return { allowed: true, reason: 'read operation', policy };
  }

  if (!policy.writesEnabled) {
    return { allowed: false, reason: 'writes disabled (CORPAYONE_ENABLE_WRITES)', policy };
  }

  const risk = endpointRisk(input.method, input.pathTemplate);

  // Approval is its own decision. The curated approval capabilities are
  // confined to the approve/decline endpoints and need the approval switch;
  // conversely, nothing else may reach those endpoints.
  if (isApprovalCapability(input.capability) || risk === 'approval') {
    if (!isApprovalCapability(input.capability)) {
      return {
        allowed: false,
        reason: 'approval endpoints are reachable only through corpay_commit_expense_approval',
        policy,
      };
    }
    if (!APPROVAL_PATHS.test(input.path)) {
      return {
        allowed: false,
        reason: `approval capability used outside its endpoints: ${input.path}`,
        policy,
      };
    }
    if (!policy.approvalsEnabled) {
      return { allowed: false, reason: 'approvals disabled (CORPAYONE_ENABLE_APPROVALS)', policy };
    }
    return { allowed: true, reason: 'approval capability enabled by policy', policy };
  }

  if (risk === 'dangerous') {
    return { allowed: false, reason: `endpoint is classified dangerous: ${input.path}`, policy };
  }

  if (
    policy.allowedCapabilities.length > 0 &&
    !policy.allowedCapabilities.includes(input.capability)
  ) {
    return { allowed: false, reason: `capability not allowed: ${input.capability}`, policy };
  }

  if (!policy.allowedMethods.includes(input.method)) {
    return { allowed: false, reason: `method not allowed: ${input.method}`, policy };
  }

  if (policy.deniedPathPatterns.some(pattern => new RegExp(pattern, 'i').test(input.path))) {
    return { allowed: false, reason: `path denied by policy: ${input.path}`, policy };
  }

  if (policy.maxAmount !== undefined && bodyContainsAmountAbove(input.body, policy.maxAmount)) {
    return { allowed: false, reason: `amount exceeds policy maxAmount ${policy.maxAmount}`, policy };
  }

  return { allowed: true, reason: 'matched write policy', policy };
}

/**
 * Corpay reports amounts in minor units (øre), so a policy maxAmount is
 * compared in the same unit the API speaks.
 */
function bodyContainsAmountAbove(value: unknown, maxAmount: number): boolean {
  if (typeof value === 'number') return Math.abs(value) > maxAmount;
  if (Array.isArray(value)) return value.some(item => bodyContainsAmountAbove(item, maxAmount));
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, nested]) => {
    if (/amount|total|price/i.test(key) && typeof nested === 'number') {
      return Math.abs(nested) > maxAmount;
    }
    return bodyContainsAmountAbove(nested, maxAmount);
  });
}
