import { afterEach, describe, expect, it } from 'vitest';
import {
  assertNoForeignTeam,
  assertTeamAllowed,
  isTeamPinned,
  pinnedTeamId,
  resolveTeamId,
  scopePathParams,
  TeamScopeError,
} from '../src/corpay/team.js';

const PINNED = 'TEAM_ALPHA';
const OTHER = 'TEAM_BETA';

afterEach(() => {
  delete process.env.CORPAYONE_TEAM_ID;
});

function pin(value = PINNED): void {
  process.env.CORPAYONE_TEAM_ID = value;
}

describe('team pinning', () => {
  it('reports whether a team is pinned', () => {
    expect(isTeamPinned()).toBe(false);
    pin();
    expect(isTeamPinned()).toBe(true);
    expect(pinnedTeamId()).toBe(PINNED);
  });

  it('treats a blank env value as unpinned', () => {
    process.env.CORPAYONE_TEAM_ID = '   ';
    expect(isTeamPinned()).toBe(false);
  });

  it('ignores a matching request and returns the pinned team', () => {
    pin();
    expect(resolveTeamId(PINNED)).toBe(PINNED);
    expect(resolveTeamId(undefined)).toBe(PINNED);
  });

  it('refuses a request for a different team', () => {
    pin();
    expect(() => resolveTeamId(OTHER)).toThrow(TeamScopeError);
    expect(() => assertTeamAllowed(OTHER)).toThrow(/cannot act on team/);
  });

  it('lets the caller choose when nothing is pinned', () => {
    expect(resolveTeamId(OTHER)).toBe(OTHER);
    expect(() => resolveTeamId(undefined)).toThrow(/No team selected/);
  });
});

describe('assertNoForeignTeam', () => {
  it('matches the team key case-insensitively', () => {
    pin();
    // Corpay spells it teamId in most places and TeamId on the v2 expense list.
    expect(() => assertNoForeignTeam({ TeamId: OTHER })).toThrow(TeamScopeError);
    expect(() => assertNoForeignTeam({ teamid: OTHER })).toThrow(TeamScopeError);
    expect(() => assertNoForeignTeam({ TeamId: PINNED })).not.toThrow();
  });

  it('ignores unrelated keys', () => {
    pin();
    expect(() => assertNoForeignTeam({ vendorId: OTHER, state: 'Awaiting' })).not.toThrow();
  });

  it('does nothing when unpinned', () => {
    expect(() => assertNoForeignTeam({ teamId: OTHER })).not.toThrow();
  });
});

describe('scopePathParams', () => {
  it('injects the pinned team into templates that need one', () => {
    pin();
    expect(scopePathParams('/v1/teams/{teamId}/categories', undefined)).toEqual({ teamId: PINNED });
  });

  it('overwrites a supplied team that matches', () => {
    pin();
    expect(scopePathParams('/v1/teams/{teamId}/lists/{listId}', { listId: 'L1', teamId: PINNED })).toEqual({
      listId: 'L1',
      teamId: PINNED,
    });
  });

  it('refuses a supplied team that does not match', () => {
    pin();
    expect(() => scopePathParams('/v1/teams/{teamId}/categories', { teamId: OTHER })).toThrow(
      TeamScopeError,
    );
  });

  it('leaves templates without a team segment alone', () => {
    pin();
    expect(scopePathParams('/v3/expenses/{expenseId}', { expenseId: 'E1' })).toEqual({
      expenseId: 'E1',
    });
  });

  it('passes params through untouched when unpinned', () => {
    expect(scopePathParams('/v1/teams/{teamId}/categories', { teamId: OTHER })).toEqual({
      teamId: OTHER,
    });
  });
});
