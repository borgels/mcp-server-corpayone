import type { CorpayClient } from './client.js';
import { prepareOperation, type PreparedOperation } from './operations.js';

/**
 * Expense coding.
 *
 * Corpay exposes single-field setters (`PATCH /v2/expenses/{id}/category`,
 * `POST /v2/expenses/{id}/labels`), but they take one value per call, so
 * coding an expense across category, labels and department would be several
 * unrelated writes with no way to undo the first if the third fails.
 *
 * `PATCH /v2/expenses/{id}` with RFC 6902 JSON Patch sets all of them in one
 * request. It is absent from the published OpenAPI documents but is the
 * contract Corpay's own UI uses, and it is the only atomic option, so it is
 * what this module builds. Two details are load-bearing:
 *
 *  - The writable paths are `/categoryId` (scalar) and `/labels` and
 *    `/departments` (plain arrays of ids) — not `/labelIds`, and not objects.
 *  - The op must match what is already there. Corpay rejects `add` on a field
 *    that already holds a value, and `replace` on one that does not, so the
 *    current expense is read first and each op chosen per field.
 *
 * Values are Corpay's internal ids, not GL account or dimension numbers;
 * resolve them with corpay_list_coding_options first.
 */

export interface JsonPatchOperation {
  op: 'add' | 'replace' | 'remove';
  path: string;
  value?: unknown;
}

export interface ExpenseCodingInput {
  expenseId: string;
  /** Corpay category id (the GL account). */
  categoryId?: string;
  /** Corpay label ids. Replaces the whole set. */
  labelIds?: string[];
  /** Corpay department ids. Replaces the whole set. */
  departmentIds?: string[];
  reason: string;
}

export interface ExpenseCodingPreparation {
  operation: PreparedOperation;
  /** What the expense is coded to right now, for the caller to compare. */
  current: {
    state?: string;
    amount?: number;
    currency?: string;
    vendor?: string;
    category?: { id?: string; name?: string; number?: string } | null;
    labels?: Array<{ id?: string; value?: string; listId?: string }>;
    departments?: Array<{ id?: string; name?: string }>;
  };
  patch: JsonPatchOperation[];
}

interface ExpenseReadModel {
  state?: string;
  amount?: number;
  currency?: string;
  vendor?: { name?: string } | null;
  category?: { id?: string; name?: string; number?: string } | null;
  labels?: Array<{ id?: string; value?: string; listId?: string }> | null;
  departments?: Array<{ id?: string; name?: string }> | null;
}

export async function prepareExpenseCoding(
  client: CorpayClient,
  input: ExpenseCodingInput,
): Promise<ExpenseCodingPreparation> {
  if (
    input.categoryId === undefined &&
    input.labelIds === undefined &&
    input.departmentIds === undefined
  ) {
    throw new Error('Nothing to code: pass at least one of categoryId, labelIds or departmentIds.');
  }

  const current = await readExpense(client, input.expenseId);
  const patch: JsonPatchOperation[] = [];

  if (input.categoryId !== undefined) {
    patch.push({
      op: current.category?.id ? 'replace' : 'add',
      path: '/categoryId',
      value: input.categoryId,
    });
  }
  if (input.labelIds !== undefined) {
    patch.push({
      op: current.labels && current.labels.length > 0 ? 'replace' : 'add',
      path: '/labels',
      value: input.labelIds,
    });
  }
  if (input.departmentIds !== undefined) {
    patch.push({
      op: current.departments && current.departments.length > 0 ? 'replace' : 'add',
      path: '/departments',
      value: input.departmentIds,
    });
  }

  const operation = prepareOperation({
    capability: 'corpay_prepare_expense_coding',
    method: 'PATCH',
    pathTemplate: '/v2/expenses/{expenseId}',
    pathParams: { expenseId: input.expenseId },
    body: patch,
    contentType: 'application/json-patch+json',
    reason: input.reason,
  });

  return {
    operation,
    current: {
      state: current.state,
      amount: current.amount,
      currency: current.currency,
      vendor: current.vendor?.name,
      category: current.category ?? null,
      labels: current.labels ?? [],
      departments: current.departments ?? [],
    },
    patch,
  };
}

async function readExpense(client: CorpayClient, expenseId: string): Promise<ExpenseReadModel> {
  const response = await client.request<{ data?: ExpenseReadModel }>({
    method: 'GET',
    path: `/v3/expenses/${encodeURIComponent(expenseId)}`,
    // The v3 read addresses the expense by id and needs no team parameter.
    withTeamId: false,
  });
  const data = response?.data;
  if (!data) {
    throw new Error(`Expense ${expenseId} was not found, or is not visible to this team.`);
  }
  return data;
}
