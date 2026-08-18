import { describe, expect, it } from 'vitest';
import {
  CURATED_CAPABILITIES,
  ENDPOINT_OPERATIONS,
  EXPENSE_STATES,
  findEndpoint,
  getCapability,
  materializePath,
  searchCapabilities,
} from '../src/corpay/catalog.js';

describe('endpoint allowlist', () => {
  it('covers all three published API versions', () => {
    for (const version of ['/v1/', '/v2/', '/v3/']) {
      expect(ENDPOINT_OPERATIONS.some(op => op.pathTemplate.startsWith(version))).toBe(true);
    }
  });

  it('has no duplicate operations', () => {
    const ids = ENDPOINT_OPERATIONS.map(op => op.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps every path relative to the /external base url', () => {
    for (const op of ENDPOINT_OPERATIONS) {
      // Version-prefixed, with the base url's /external stripped. Note that
      // /external-id is a real vendor path segment, so only the prefix matters.
      expect(op.pathTemplate).toMatch(/^\/v[123]\//);
      expect(op.pathTemplate.startsWith('/external/')).toBe(false);
    }
  });

  it('classifies every DELETE as dangerous', () => {
    for (const op of ENDPOINT_OPERATIONS.filter(o => o.method === 'DELETE')) {
      expect(op.risk).toBe('dangerous');
    }
  });

  it('classifies approve and decline as approval', () => {
    for (const path of ['/v2/expenses/{expenseId}/approve', '/v2/expenses/{expenseId}/decline']) {
      expect(findEndpoint('PATCH', path).risk).toBe('approval');
    }
  });

  it('marks the undocumented JSON Patch coding endpoint as provisional', () => {
    expect(findEndpoint('PATCH', '/v2/expenses/{expenseId}').provisional).toBe(true);
  });

  it('rejects an endpoint that is not allowlisted', () => {
    expect(() => findEndpoint('POST', '/v2/expenses/{expenseId}/pay')).toThrow(/not allowlisted/);
  });
});

describe('materializePath', () => {
  it('substitutes and encodes path parameters', () => {
    const endpoint = findEndpoint('GET', '/v1/teams/{teamId}/lists/{listId}/labels');
    expect(materializePath(endpoint, { teamId: 'T 1', listId: 'L1' })).toBe(
      '/v1/teams/T%201/lists/L1/labels',
    );
  });

  it('refuses to build a path with a missing parameter', () => {
    const endpoint = findEndpoint('GET', '/v3/expenses/{expenseId}');
    expect(() => materializePath(endpoint, {})).toThrow(/Missing path parameter: expenseId/);
  });
});

describe('capability discovery', () => {
  it('finds tools by keyword', () => {
    const hits = searchCapabilities('coding');
    expect(hits.some(c => c.id === 'corpay_list_coding_options')).toBe(true);
  });

  it('finds endpoints by path fragment', () => {
    const hits = searchCapabilities('vendors', 100);
    expect(hits.some(c => c.id.startsWith('endpoint.GET /v2/teams/{teamId}/vendors'))).toBe(true);
  });

  it('honours the limit', () => {
    expect(searchCapabilities('', 5)).toHaveLength(5);
  });

  it('resolves a curated capability by id', () => {
    expect(getCapability('corpay_commit_expense_approval')?.risk).toBe('approval');
  });

  it('names a prepare tool for every curated commit path', () => {
    const ids = CURATED_CAPABILITIES.map(c => c.id);
    expect(ids).toContain('corpay_commit_prepared_operation');
    expect(ids.filter(id => id.startsWith('corpay_prepare_')).length).toBeGreaterThan(3);
  });

  it('exposes the states Corpay documents', () => {
    expect(EXPENSE_STATES).toContain('Awaiting');
    expect(EXPENSE_STATES).toContain('Booked');
  });
});
