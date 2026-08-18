import { afterEach, describe, expect, it } from 'vitest';
import {
  availableCapabilities,
  availableEndpoints,
  endpointAvailable,
  ENDPOINT_OPERATIONS,
  findEndpoint,
  searchCapabilities,
} from '../src/corpay/catalog.js';
import { grantedScopes, hasScope, STANDARD_SCOPES } from '../src/corpay/scopes.js';

afterEach(() => {
  delete process.env.CORPAYONE_SCOPE;
});

describe('granted scopes', () => {
  it('defaults to what a standard Corpay app can obtain', () => {
    expect(grantedScopes()).toEqual(new Set(STANDARD_SCOPES));
    expect(hasScope('expenses.all')).toBe(true);
    expect(hasScope('departments.all')).toBe(false);
    expect(hasScope(undefined)).toBe(true);
  });

  it('accepts a configured set, space- or comma-separated', () => {
    process.env.CORPAYONE_SCOPE = 'expenses.all, departments.all';
    expect(hasScope('departments.all')).toBe(true);
    expect(hasScope('teams.all')).toBe(false);
  });
});

describe('endpoint availability', () => {
  it('hides endpoints the grant cannot reach', () => {
    const available = availableEndpoints();
    expect(available.length).toBeLessThan(ENDPOINT_OPERATIONS.length);
    for (const op of available) {
      expect(op.requiresScope).toBeUndefined();
    }
  });

  it('keeps the endpoints measured to work on a standard grant', () => {
    // These returned 200 live, so gating them off would be a regression.
    for (const [method, path] of [
      ['GET', '/v2/expenses'],
      ['GET', '/v3/expenses/{expenseId}'],
      ['GET', '/v1/teams/{teamId}/modules'],
      ['GET', '/v2/expenses/{expenseId}/approvers'],
      ['GET', '/v2/expenses/{expenseId}/activities'],
      ['GET', '/v1/teams/{teamId}/categories'],
      ['GET', '/v1/teams/{teamId}/lists/{listId}/labels'],
      ['GET', '/v2/teams/{teamId}/vendors'],
      ['GET', '/v1/webhooks'],
    ] as const) {
      expect(endpointAvailable(method, path)).toBe(true);
    }
  });

  it('gates the endpoints measured to 403 on a standard grant', () => {
    for (const [method, path] of [
      ['GET', '/v1/teams/{teamId}/departments'],
      ['GET', '/v1/teams/{teamId}/members'],
      ['GET', '/v1/payments/methods'],
      ['GET', '/v2/teams/{teamId}/items'],
      ['GET', '/v2/creditaccounts/team/{teamId}'],
      ['GET', '/v1/users/me'],
    ] as const) {
      expect(endpointAvailable(method, path)).toBe(false);
    }
  });

  it('drops the usage export, which fails server-side rather than on scope', () => {
    expect(
      ENDPOINT_OPERATIONS.some(op => op.pathTemplate.includes('/usage/export')),
    ).toBe(false);
  });

  it('explains a gated endpoint instead of reporting it as unknown', () => {
    expect(() => findEndpoint('GET', '/v1/teams/{teamId}/departments')).toThrow(
      /needs the Corpay OAuth scope "departments\.all"/,
    );
  });

  it('reaches a gated endpoint once the scope is configured', () => {
    process.env.CORPAYONE_SCOPE = [...STANDARD_SCOPES, 'departments.all'].join(' ');
    expect(endpointAvailable('GET', '/v1/teams/{teamId}/departments')).toBe(true);
    expect(() => findEndpoint('GET', '/v1/teams/{teamId}/departments')).not.toThrow();
  });
});

describe('capability discovery', () => {
  it('hides tools that cannot work on this grant', () => {
    const ids = availableCapabilities().map(c => c.id);
    expect(ids).not.toContain('corpay_list_credit_accounts');
    expect(ids).not.toContain('corpay_list_payment_methods');
    expect(ids).not.toContain('corpay_list_team_members');
    expect(ids).toContain('corpay_list_expenses');
    expect(ids).toContain('corpay_prepare_expense_coding');
  });

  it('does not surface a gated tool through search', () => {
    expect(searchCapabilities('credit', 100).some(c => c.id === 'corpay_list_credit_accounts')).toBe(
      false,
    );
  });

  it('surfaces it once the scope is configured', () => {
    process.env.CORPAYONE_SCOPE = [...STANDARD_SCOPES, 'cardtransactions.all'].join(' ');
    expect(availableCapabilities().map(c => c.id)).toContain('corpay_list_credit_accounts');
  });
});
