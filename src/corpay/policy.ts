import { readFileSync } from 'node:fs';
import type { HttpMethod } from './client.js';

export interface CorpayPolicy {
  writesEnabled: boolean;
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
  body?: unknown;
}

export function loadPolicy(): CorpayPolicy {
  const base: CorpayPolicy = {
    writesEnabled: process.env.CORPAYONE_ENABLE_WRITES === 'true',
    allowedCapabilities: [],
    allowedMethods: ['POST', 'PUT', 'PATCH'],
    // Default-deny the most consequential money-movement surfaces unless a
    // policy file explicitly re-allows them.
    deniedPathPatterns: ['/payments', '/pay', '/approvals?/.*/approve', '/webhooks'],
  };

  const policyPath = process.env.CORPAYONE_POLICY_PATH;
  if (!policyPath) return base;

  const parsed = JSON.parse(readFileSync(policyPath, 'utf8')) as Partial<CorpayPolicy>;
  return {
    ...base,
    ...parsed,
    writesEnabled: parsed.writesEnabled ?? base.writesEnabled,
    allowedCapabilities: parsed.allowedCapabilities ?? base.allowedCapabilities,
    allowedMethods: parsed.allowedMethods ?? base.allowedMethods,
    deniedPathPatterns: parsed.deniedPathPatterns ?? base.deniedPathPatterns,
  };
}

export function isMutation(method: HttpMethod): boolean {
  return method !== 'GET';
}

export function checkPolicy(input: PolicyCheckInput, policy = loadPolicy()): PolicyDecision {
  if (!isMutation(input.method)) {
    return { allowed: true, reason: 'read operation', policy };
  }
  if (!policy.writesEnabled) {
    return { allowed: false, reason: 'writes disabled', policy };
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
