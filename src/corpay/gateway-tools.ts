import { z } from 'zod/v4';
import type { GatewayQueryValue, GatewayWriteMethod } from './gateway-client.js';

/** What a tool may use of the client: reads, and (for a write tool) changes. */
export interface GatewayClientView {
  get<T>(path: string, query?: Record<string, GatewayQueryValue>): Promise<T>;
  send<T>(method: GatewayWriteMethod, path: string, body?: unknown, contentType?: string): Promise<T>;
}

/**
 * The tools of the embedded gateway (src/gateway.ts): narrow inputs, one
 * company (team) per instance, and every answer scrubbed of bank and card
 * numbers and of signed attachment links before it leaves.
 *
 * Reads: the team, expenses (bills, receipts, credit notes) with their
 * activity log and approvers, the coding vocabulary and vendors.
 *
 * Changes: coding an expense (category and labels), splitting it into coded
 * amount lines, a comment on an expense, a new vendor and a vendor's link to
 * the accounting system, and approving or declining an expense that awaits
 * the caller's approval. Approving releases the bill for payment, so it is
 * the one tool marked `requiresConfirmation`.
 *
 * Left out on purpose: payment methods and bank accounts, team members and
 * users, teams, the category list itself (the chart of accounts), label lists,
 * departments and items, webhooks, uploading or deleting expenses, and any
 * deletion. The MCP server's own tools (src/tools/corpay.ts) are unchanged.
 */

export type GatewayUpstreamMethod = 'GET' | 'POST' | 'PUT' | 'PATCH';

export interface GatewayUpstream {
  readonly method: GatewayUpstreamMethod;
  /** Path template relative to https://api.corpayone.com/external. */
  readonly path: string;
}

export interface ToolContext {
  /** The instance's team: the hard boundary of every call. */
  readonly teamId: string;
  /** The tools the instance offers, for search_capabilities. */
  readonly offered: readonly GatewayTool[];
}

export interface GatewayTool {
  /** Without the `corpay_` prefix. */
  name: string;
  title: string;
  description: string;
  riskLevel: 'read' | 'write';
  /** True for a change a person should confirm outside the chat: approving a bill releases it for payment. */
  requiresConfirmation?: boolean;
  /** The first line of a successful result's text. */
  summary: string;
  upstream: readonly GatewayUpstream[];
  broad?: boolean;
  input: z.ZodRawShape;
  run(client: GatewayClientView, input: Record<string, unknown>, context: ToolContext): Promise<unknown>;
}

/** Thrown when a resource addressed by id is not the instance's team's, or its team cannot be read. */
export class TeamBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamBoundaryError';
  }
}

const get = (path: string): GatewayUpstream => ({ method: 'GET', path });
const write = (method: GatewayUpstreamMethod, path: string): GatewayUpstream => ({ method, path });

// ---------------------------------------------------------------- inputs

/** A Corpay id: one path segment of letters, digits, `-` and `_`. */
const id = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,100}$/, 'a Corpay id');
const EXPENSE_STATES = ['Pending', 'Booked', 'Paid', 'Cancelled', 'Awaiting', 'Paused', 'Duplicate', 'Refunded', 'Initialized'] as const;
const EXPENSE_TYPES = ['Bill', 'Receipt', 'Creditnote', 'Reimbursement', 'FuelBill'] as const;
const shortText = (max: number) => z.string().trim().min(1).max(max);

// ------------------------------------------------------------- answers

/** Field names whose values are never passed on: bank and card numbers, and payment instructions. */
const HIDDEN_FIELD = /^(iban|bban|bic|swift|swiftcode|bankaccount|bankaccountnumber|accountnumber|registrationnumber|regnumber|cardnumber|pan|cvc|cvv|paymentinstructions?|paymentmethod|paymentmethods|bankdetails|bankinformation)$/;
/** A link in a text: up to a space, a quote or an angle bracket. */
const LINK = /https?:\/\/[^\s"'<>]+/gi;
/** A signed link opens a file for anyone who holds it, so it is not passed on, also inside a longer text. */
const SIGNED = /Signature=|X-Amz-|Key-Pair-Id=|[?&]sig=|[?&]token=/i;
export const SIGNED_LINK_REMOVED = '[signed link removed]';
/** An IBAN in a text: country code, check digits and 11 to 30 more letters or digits, in groups or not. */
const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g;
/** A run of 13 or more digits, in groups or not: it holds a card number when part of it passes the Luhn check. */
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;
export const NUMBER_REMOVED = '[bank or card number removed]';

/** Whether a run of digits passes the Luhn check, as every card number does. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** A text with signed links, IBANs and card numbers removed; everything else as it is. */
function scrubText(value: string): string {
  return value
    .replace(LINK, link => (SIGNED.test(link) ? SIGNED_LINK_REMOVED : link))
    .replace(IBAN, NUMBER_REMOVED)
    .replace(CARD, run => (holdsCardNumber(run) ? NUMBER_REMOVED : run));
}

/**
 * Whether a run of digits holds a card number: 13 to 19 digits that pass the Luhn check, starting where the run or one
 * of its groups starts and ending where a group ends (or, in a run without separators, starting where it starts). The
 * whole run is removed then, also what follows the card number in it.
 */
function holdsCardNumber(run: string): boolean {
  const groups = run.split(/[ -]/);
  if (groups.length === 1) {
    for (let length = 13; length <= Math.min(19, run.length); length += 1) if (luhn(run.slice(0, length))) return true;
    return false;
  }
  for (let start = 0; start < groups.length; start += 1) {
    let digits = '';
    for (let end = start; end < groups.length; end += 1) {
      digits += groups[end];
      if (digits.length > 19) break;
      if (digits.length >= 13 && luhn(digits)) return true;
    }
  }
  return false;
}

/** A copy of Corpay's answer with bank and card fields, IBANs and card numbers in texts, and signed links left out. */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 64) return undefined;
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map(entry => scrub(entry, depth + 1)).filter(entry => entry !== undefined);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (HIDDEN_FIELD.test(key.toLowerCase().replace(/[-_\s]/g, ''))) continue;
    const kept = scrub(entry, depth + 1);
    if (kept !== undefined) out[key] = kept;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The team a by-id resource belongs to, from Corpay's answer: `teamId` or `team.id` on the resource, its `owner`, or
 * the `data` wrapper. Undefined when none is there or the candidates disagree.
 */
export function teamOf(payload: unknown): string | undefined {
  const found = new Set<string>();
  const visit = (node: unknown) => {
    if (!isRecord(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (key.toLowerCase() === 'teamid' && typeof value === 'string' && value.trim()) found.add(value.trim());
      if (key.toLowerCase() === 'team' && isRecord(value) && typeof value.id === 'string' && value.id.trim()) found.add(value.id.trim());
    }
  };
  const data = isRecord(payload) ? payload.data : undefined;
  visit(payload);
  visit(data);
  if (isRecord(data)) {
    visit(data.owner);
    if (isRecord(data.expense)) {
      visit(data.expense);
      visit(data.expense.owner);
    }
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/** Reads an expense and refuses it unless it belongs to the instance's team. */
async function expenseInTeam(client: GatewayClientView, expenseId: string, teamId: string): Promise<Record<string, unknown>> {
  const payload = await client.get<unknown>(`/v3/expenses/${encodeURIComponent(expenseId)}`);
  const team = teamOf(payload);
  if (team === undefined) throw new TeamBoundaryError('The team of the expense could not be read; nothing was done with it.');
  if (team !== teamId) throw new TeamBoundaryError('The expense belongs to another Corpay One team; nothing was done with it.');
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : {};
  return isRecord(data.expense) ? data.expense : data;
}

const teamPath = (teamId: string) => `/v1/teams/${encodeURIComponent(teamId)}`;

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length >= 3);
}

// ---------------------------------------------------------------- tools

export const GATEWAY_TOOLS: readonly GatewayTool[] = [
  {
    name: 'search_capabilities',
    title: 'Search Corpay One tools',
    description: 'Find the Corpay One tools of this connection by a few words, such as "approve bill" or "vendor".',
    riskLevel: 'read',
    summary: 'Corpay One tools that match.',
    upstream: [],
    input: {
      query: z.string().trim().max(200).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async run(_client, input, context) {
      const asked = words(String(input.query ?? ''));
      const limit = typeof input.limit === 'number' ? input.limit : 20;
      const scored = context.offered
        .filter(tool => tool.name !== 'search_capabilities')
        .map(tool => {
          const own = words(`${tool.name} ${tool.title} ${tool.description}`);
          return { tool, score: asked.filter(word => own.some(o => o.startsWith(word) || word.startsWith(o))).length };
        });
      const hits = asked.length === 0 ? scored : scored.filter(entry => entry.score > 0).sort((a, b) => b.score - a.score);
      return {
        tools: hits.slice(0, limit).map(({ tool }) => ({ name: `corpay_${tool.name}`, title: tool.title, riskLevel: tool.riskLevel })),
      };
    },
  },
  {
    name: 'check_connection',
    title: 'Check the Corpay One connection',
    description: 'Whether the access works, and the name of the Corpay One team (company) this connection is for.',
    riskLevel: 'read',
    summary: 'Corpay One connection checked.',
    upstream: [get('/v1/teams')],
    input: {},
    async run(client, _input, context) {
      const answer = await client.get<unknown>('/v1/teams');
      const data = isRecord(answer) ? answer.data : undefined;
      const teams = isRecord(data) && Array.isArray(data.teams) ? data.teams : Array.isArray(data) ? data : [];
      const team = teams.find(entry => isRecord(entry) && entry.id === context.teamId);
      return {
        teamFound: team !== undefined,
        team: isRecord(team) ? { id: context.teamId, name: typeof team.name === 'string' ? team.name : null } : null,
      };
    },
  },
  {
    name: 'get_company',
    title: 'Get the company',
    description: 'The Corpay One team (company) of this connection: name, country and VAT number. Amounts in Corpay are in minor units (øre for DKK).',
    riskLevel: 'read',
    summary: 'The Corpay One team.',
    upstream: [get('/v1/teams/{teamId}')],
    input: {},
    async run(client, _input, context) {
      return scrub(await client.get(teamPath(context.teamId)));
    },
  },
  {
    name: 'list_expenses',
    title: 'List expenses',
    description:
      'Bills, receipts and credit notes of the company, filtered by state (Awaiting means waiting for approval) or type. Amounts are in minor units (øre for DKK). At most 100 per page.',
    riskLevel: 'read',
    summary: 'Corpay One expenses.',
    upstream: [get('/v2/expenses')],
    input: {
      state: z.enum(EXPENSE_STATES).optional(),
      type: z.enum(EXPENSE_TYPES).optional(),
      pendingMyApproval: z.boolean().optional().describe('Only expenses waiting for the approval of the connected user.'),
      includeArchived: z.boolean().optional(),
      offset: z.number().int().min(0).max(100_000).optional(),
      count: z.number().int().min(10).max(100).optional().describe('Corpay requires 10 to 100.'),
    },
    async run(client, input, context) {
      const query: Record<string, GatewayQueryValue> = {
        TeamId: context.teamId,
        State: input.state as string | undefined,
        Type: input.type as string | undefined,
        PendingUserApproval: input.pendingMyApproval as boolean | undefined,
        IncludeArchived: input.includeArchived as boolean | undefined,
        Offset: input.offset as number | undefined,
        Count: (input.count as number | undefined) ?? 25,
      };
      return scrub(await client.get('/v2/expenses', query));
    },
  },
  {
    name: 'get_expense',
    title: 'Get an expense',
    description: 'One expense in full: vendor, amounts, due date, lines, attachments and current coding. Amounts are in minor units.',
    riskLevel: 'read',
    summary: 'The Corpay One expense.',
    upstream: [get('/v3/expenses/{expenseId}')],
    input: { expenseId: id },
    async run(client, input, context) {
      return scrub(await expenseInTeam(client, String(input.expenseId), context.teamId));
    },
  },
  {
    name: 'get_expense_activities',
    title: 'Get the activity log of an expense',
    description: 'What has happened to an expense: approvals, declines, comments and edits.',
    riskLevel: 'read',
    summary: 'The activity log of the expense.',
    upstream: [get('/v3/expenses/{expenseId}'), get('/v2/expenses/{expenseId}/activities')],
    input: { expenseId: id },
    async run(client, input, context) {
      const expenseId = String(input.expenseId);
      await expenseInTeam(client, expenseId, context.teamId);
      return scrub(await client.get(`/v2/expenses/${encodeURIComponent(expenseId)}/activities`));
    },
  },
  {
    name: 'get_expense_approvers',
    title: 'Get the approvers of an expense',
    description: 'Who must approve an expense, and who already has.',
    riskLevel: 'read',
    summary: 'The approvers of the expense.',
    upstream: [get('/v3/expenses/{expenseId}'), get('/v2/expenses/{expenseId}/approvers')],
    input: { expenseId: id },
    async run(client, input, context) {
      const expenseId = String(input.expenseId);
      await expenseInTeam(client, expenseId, context.teamId);
      return scrub(await client.get(`/v2/expenses/${encodeURIComponent(expenseId)}/approvers`));
    },
  },
  {
    name: 'list_coding_options',
    title: 'List coding options',
    description:
      'Everything an expense can be coded to: categories (accounts) with their Corpay id and number, and label lists (such as projects or cost types) with each label. Coding takes the Corpay ids found here, not account numbers.',
    riskLevel: 'read',
    summary: 'Corpay One coding options.',
    upstream: [get('/v1/teams/{teamId}/categories'), get('/v1/teams/{teamId}/lists'), get('/v1/teams/{teamId}/lists/{listId}/labels')],
    input: {},
    async run(client, _input, context) {
      const base = teamPath(context.teamId);
      const [categories, lists] = await Promise.all([client.get<unknown>(`${base}/categories`), client.get<unknown>(`${base}/lists`)]);
      const catData = isRecord(categories) && isRecord(categories.data) ? categories.data.categories : undefined;
      const listData = isRecord(lists) && isRecord(lists.data) ? lists.data.lists : undefined;
      const summaries = Array.isArray(listData) ? listData.filter(isRecord) : [];
      const withLabels = [];
      for (const list of summaries.slice(0, 50)) {
        const listId = typeof list.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(list.id) ? list.id : undefined;
        if (!listId) continue;
        const labels = await client.get<unknown>(`${base}/lists/${encodeURIComponent(listId)}/labels`);
        const labelData = isRecord(labels) && isRecord(labels.data) ? (labels.data.labels ?? labels.data) : labels;
        withLabels.push({ id: listId, name: list.name ?? null, type: list.type ?? null, labels: labelData ?? [] });
      }
      return scrub({ categories: Array.isArray(catData) ? catData : [], lists: withLabels });
    },
  },
  {
    name: 'list_vendors',
    title: 'List vendors',
    description: 'The vendors (suppliers) registered in Corpay One for the company.',
    riskLevel: 'read',
    summary: 'Corpay One vendors.',
    upstream: [get('/v2/teams/{teamId}/vendors')],
    input: {
      offset: z.number().int().min(0).max(100_000).optional(),
      count: z.number().int().min(1).max(100).optional(),
    },
    async run(client, input, context) {
      return scrub(
        await client.get(`/v2/teams/${encodeURIComponent(context.teamId)}/vendors`, {
          Offset: input.offset as number | undefined,
          Count: input.count as number | undefined,
        }),
      );
    },
  },
  {
    name: 'get_vendor',
    title: 'Get a vendor',
    description: 'One vendor of the company.',
    riskLevel: 'read',
    summary: 'The Corpay One vendor.',
    upstream: [get('/v2/teams/{teamId}/vendors/{vendorId}')],
    input: { vendorId: id },
    async run(client, input, context) {
      return scrub(await client.get(`/v2/teams/${encodeURIComponent(context.teamId)}/vendors/${encodeURIComponent(String(input.vendorId))}`));
    },
  },
  {
    name: 'set_expense_coding',
    title: 'Code an expense',
    description:
      'Set the category (account) and labels of an expense in one change. Ids come from list_coding_options. Given labels replace all labels on the expense.',
    riskLevel: 'write',
    summary: 'The expense was coded.',
    upstream: [get('/v3/expenses/{expenseId}'), write('PATCH', '/v2/expenses/{expenseId}')],
    input: {
      expenseId: id,
      categoryId: id.optional(),
      labelIds: z.array(id).min(1).max(50).optional(),
    },
    async run(client, input, context) {
      const expenseId = String(input.expenseId);
      if (input.categoryId === undefined && input.labelIds === undefined) {
        throw new Error('Nothing to code: give categoryId, labelIds or both.');
      }
      const current = await expenseInTeam(client, expenseId, context.teamId);
      const has = (value: unknown) => (Array.isArray(value) ? value.length > 0 : isRecord(value) ? Boolean(value.id) : Boolean(value));
      const patch: Array<{ op: 'add' | 'replace'; path: string; value: unknown }> = [];
      // Corpay refuses `add` on a field that holds a value and `replace` on one that does not.
      if (input.categoryId !== undefined) patch.push({ op: has(current.category) ? 'replace' : 'add', path: '/categoryId', value: input.categoryId });
      if (input.labelIds !== undefined) patch.push({ op: has(current.labels) ? 'replace' : 'add', path: '/labels', value: input.labelIds });
      const answer = await client.send('PATCH', `/v2/expenses/${encodeURIComponent(expenseId)}`, patch, 'application/json-patch+json');
      return scrub(answer ?? { updated: true });
    },
  },
  {
    name: 'set_expense_amount_lines',
    title: 'Split an expense into lines',
    description:
      'Replace the amount lines of an expense, each with its own category and labels. Amounts are in minor units (øre for DKK) and must add up to the expense total.',
    riskLevel: 'write',
    summary: 'The amount lines of the expense were set.',
    upstream: [get('/v3/expenses/{expenseId}'), write('PATCH', '/v2/expenses/{expenseId}/amountlines')],
    input: {
      expenseId: id,
      amountLines: z
        .array(
          z.strictObject({
            amount: z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000),
            note: z.string().trim().max(500).optional(),
            categoryId: id.optional(),
            labels: z.array(z.strictObject({ listId: id, labelId: id })).max(50).optional(),
          }),
        )
        .min(1)
        .max(100),
    },
    async run(client, input, context) {
      const expenseId = String(input.expenseId);
      await expenseInTeam(client, expenseId, context.teamId);
      const lines = (input.amountLines as Array<{ amount: number; note?: string; categoryId?: string; labels?: unknown[] }>).map(line => ({
        amount: line.amount,
        ...(line.note !== undefined ? { note: line.note } : {}),
        ...(line.categoryId !== undefined ? { category: line.categoryId } : {}),
        labels: line.labels ?? [],
      }));
      const answer = await client.send('PATCH', `/v2/expenses/${encodeURIComponent(expenseId)}/amountlines`, { amountLines: lines });
      return scrub(answer ?? { updated: true });
    },
  },
  {
    name: 'comment_on_expense',
    title: 'Comment on an expense',
    description: 'Write a comment in the activity log of an expense, for colleagues and approvers to see.',
    riskLevel: 'write',
    summary: 'The comment was added to the expense.',
    upstream: [get('/v3/expenses/{expenseId}'), write('POST', '/v2/expenses/{expenseId}/activities')],
    input: { expenseId: id, comment: shortText(2000) },
    async run(client, input, context) {
      const expenseId = String(input.expenseId);
      await expenseInTeam(client, expenseId, context.teamId);
      const answer = await client.send('POST', `/v2/expenses/${encodeURIComponent(expenseId)}/activities`, { body: input.comment, type: 'Text' });
      return scrub(answer ?? { added: true });
    },
  },
  {
    name: 'create_vendor',
    title: 'Create a vendor',
    description:
      'Register a new vendor (supplier) for the company: name, and optionally its company number, country, address, email, website, default category and the id it has in the accounting system. Bank details are not taken.',
    riskLevel: 'write',
    summary: 'The vendor was created.',
    upstream: [write('POST', '/v2/teams/{teamId}/vendors')],
    input: {
      name: shortText(200),
      identification: shortText(50).optional().describe('Company or VAT number.'),
      country: z.string().trim().regex(/^[A-Za-z]{2}$/, 'a country code such as DK').optional(),
      email: z.email().max(200).optional(),
      website: shortText(200).optional(),
      address: shortText(200).optional(),
      postal: shortText(20).optional(),
      city: shortText(100).optional(),
      defaultCategoryId: id.optional(),
      externalId: shortText(100).optional(),
      source: shortText(50).optional().describe('The accounting system the external id is from.'),
    },
    async run(client, input, context) {
      const vendor = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
      if (typeof vendor.country === 'string') vendor.country = vendor.country.toUpperCase();
      return scrub((await client.send('POST', `/v2/teams/${encodeURIComponent(context.teamId)}/vendors`, { vendors: [vendor] })) ?? { created: true });
    },
  },
  {
    name: 'set_vendor_external_id',
    title: "Link a vendor to the accounting system",
    description: "Set the id a vendor has in the accounting system (for example its supplier number), and which system that is.",
    riskLevel: 'write',
    summary: "The vendor's link to the accounting system was set.",
    upstream: [write('PATCH', '/v2/teams/{teamId}/vendors/{vendorId}/external-id')],
    input: { vendorId: id, externalId: shortText(100), source: shortText(50) },
    async run(client, input, context) {
      const path = `/v2/teams/${encodeURIComponent(context.teamId)}/vendors/${encodeURIComponent(String(input.vendorId))}/external-id`;
      return scrub((await client.send('PATCH', path, { externalId: input.externalId, source: input.source })) ?? { updated: true });
    },
  },
  {
    name: 'decline_expense',
    title: 'Decline an expense',
    description: 'Decline an expense that waits for the approval of the connected user, with a note on why. Nothing is paid.',
    riskLevel: 'write',
    summary: 'The expense was declined.',
    upstream: [get('/v3/expenses/{expenseId}'), write('PATCH', '/v2/expenses/{expenseId}/decline')],
    input: { expenseId: id, note: shortText(1000) },
    async run(client, input, context) {
      const expenseId = String(input.expenseId);
      await expenseInTeam(client, expenseId, context.teamId);
      return scrub((await client.send('PATCH', `/v2/expenses/${encodeURIComponent(expenseId)}/decline`, { note: input.note })) ?? { declined: true });
    },
  },
  {
    name: 'approve_expense',
    title: 'Approve an expense',
    description:
      'Approve an expense that waits for the approval of the connected user. When it is the last approval, Corpay One releases the bill for payment, so the money can leave the account.',
    riskLevel: 'write',
    requiresConfirmation: true,
    summary: 'The expense was approved.',
    upstream: [get('/v3/expenses/{expenseId}'), write('PATCH', '/v2/expenses/{expenseId}/approve')],
    input: { expenseId: id },
    async run(client, input, context) {
      const expenseId = String(input.expenseId);
      await expenseInTeam(client, expenseId, context.teamId);
      return scrub((await client.send('PATCH', `/v2/expenses/${encodeURIComponent(expenseId)}/approve`)) ?? { approved: true });
    },
  },
];
