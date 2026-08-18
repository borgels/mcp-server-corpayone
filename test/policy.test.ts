import { afterEach, describe, expect, it } from 'vitest';
import { checkPolicy, loadPolicy, isApprovalCapability } from '../src/corpay/policy.js';

afterEach(() => {
  delete process.env.CORPAYONE_ENABLE_WRITES;
  delete process.env.CORPAYONE_ENABLE_APPROVALS;
});

function enableWrites(): void {
  process.env.CORPAYONE_ENABLE_WRITES = 'true';
}

const codingWrite = {
  capability: 'corpay_prepare_expense_coding',
  method: 'PATCH' as const,
  path: '/v2/expenses/E1',
  pathTemplate: '/v2/expenses/{expenseId}',
};

const approve = {
  capability: 'corpay_commit_expense_approval',
  method: 'PATCH' as const,
  path: '/v2/expenses/E1/approve',
  pathTemplate: '/v2/expenses/{expenseId}/approve',
};

describe('write gating', () => {
  it('always allows reads', () => {
    const decision = checkPolicy({ capability: 'x', method: 'GET', path: '/v2/expenses' });
    expect(decision.allowed).toBe(true);
  });

  it('blocks every write until writes are enabled', () => {
    expect(checkPolicy(codingWrite).allowed).toBe(false);
    enableWrites();
    expect(checkPolicy(codingWrite).allowed).toBe(true);
  });

  it('blocks endpoints classified dangerous even with writes on', () => {
    enableWrites();
    const decision = checkPolicy({
      capability: 'corpay_prepare_coding_list_change',
      method: 'DELETE',
      path: '/v1/teams/T1/categories/C1',
      pathTemplate: '/v1/teams/{teamId}/categories/{categoryId}',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/dangerous/);
  });

  it('denies team and member management by path pattern', () => {
    enableWrites();
    for (const path of ['/v1/teams', '/v1/teams/T1', '/v1/teams/T1/members', '/v1/payments/methods']) {
      expect(checkPolicy({ capability: 'corpay_call_endpoint', method: 'POST', path }).allowed).toBe(
        false,
      );
    }
  });

  it('enforces maxAmount against minor units', () => {
    enableWrites();
    const policy = { ...loadPolicy(), maxAmount: 500_000 };
    const under = checkPolicy({ ...codingWrite, body: { amount: 400_000 } }, policy);
    const over = checkPolicy({ ...codingWrite, body: { amount: 930_000 } }, policy);
    expect(under.allowed).toBe(true);
    expect(over.allowed).toBe(false);
    expect(over.reason).toMatch(/maxAmount/);
  });
});

describe('approval gating', () => {
  it('recognises the approval capabilities', () => {
    expect(isApprovalCapability('corpay_commit_expense_approval')).toBe(true);
    expect(isApprovalCapability('corpay_commit_prepared_operation')).toBe(false);
  });

  it('needs its own switch on top of writes', () => {
    enableWrites();
    expect(checkPolicy(approve).allowed).toBe(false);
    expect(checkPolicy(approve).reason).toMatch(/approvals disabled/);

    process.env.CORPAYONE_ENABLE_APPROVALS = 'true';
    expect(checkPolicy(approve).allowed).toBe(true);
  });

  it('keeps other capabilities off the approval endpoints', () => {
    enableWrites();
    process.env.CORPAYONE_ENABLE_APPROVALS = 'true';
    const decision = checkPolicy({ ...approve, capability: 'corpay_call_endpoint' });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/only through corpay_commit_expense_approval/);
  });

  it('keeps the approval capability off other endpoints', () => {
    enableWrites();
    process.env.CORPAYONE_ENABLE_APPROVALS = 'true';
    const decision = checkPolicy({
      capability: 'corpay_commit_expense_approval',
      method: 'PATCH',
      path: '/v2/expenses/E1',
      pathTemplate: '/v2/expenses/{expenseId}',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/outside its endpoints/);
  });

  it('allows declining as well as approving', () => {
    enableWrites();
    process.env.CORPAYONE_ENABLE_APPROVALS = 'true';
    const decision = checkPolicy({
      capability: 'corpay_commit_expense_approval',
      method: 'PATCH',
      path: '/v2/expenses/E1/decline',
      pathTemplate: '/v2/expenses/{expenseId}/decline',
    });
    expect(decision.allowed).toBe(true);
  });
});
