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

/*
 * What leaves the gateway is scrubbed of bank and card data and of links that carry a key (src/gateway.ts applies it to
 * every final result). The rules are deliberately broad, because a list of known formats is never complete:
 *
 * - A field whose name speaks of a bank, a card, an account number, a routing or clearing code, a security code or a
 *   payment instruction is left out. Below an account, a bank, a card, a payee or a beneficiary, no number is passed on
 *   at any depth.
 * - Every link (any scheme, a "//" host or "www.", also HTML- or percent-encoded) and every word with a query that sets
 *   a value ("?x=y") is removed: a signed link may carry its key in its query or in its path, and the forms providers use
 *   cannot all be known.
 * - A text that is JSON is scrubbed as data. In text (HTML references written out first, also nested), IBANs (by country length and check digits), card numbers (12 to 19 digits that pass the Luhn check,
 *   anywhere in a run of digits with any separators) and numbers named as an account are removed.
 * - A resource's id (`id`, `…Id`, `…_id`, under a name that speaks of no bank, card or account) is kept as it is, so the
 *   tools can address it again.
 */

/** Field names (lower case, without separators) that speak of bank or card data: such a field is left out. */
const HIDDEN_NAME =
  /(iban|bban|bic$|swift|routing(no|nr|number|code)?s?$|^routing|sortcode|clearing(no|nr|number|code)?$|^transit(no|nr|number|code)?$|bsb$|^aba$|^cid$|cvv|cvc|cvn|csc|securitycode|verificationvalue|verificationcode|expiry|expiration|expdate|cardnumber|cardno|creditcard|debitcard|^cards?$|^pans?$|bankaccount|bankdetail|bankinfo|bankdata|banknumber|bankno|banknr|bankcode|bankreg|^bank$|^banks$|accountnumber|accountno|accountnr|^accounts?$|^acct|kontonummer|kontonr|^konto$|registrationnumber|registreringsnummer|^reg(no|nr|number)|paymentinstruction|paymentmethod|paymentdetail)/;
/** The words of a name that speak of money held somewhere: an account, a bank, a card, a payee, a beneficiary. */
const MONEY_WORDS: ReadonlySet<string> = new Set(['bank', 'banks', 'card', 'cards', 'account', 'accounts', 'acct', 'konto', 'payee', 'beneficiary', 'iban', 'pan', 'creditcard', 'debitcard', 'bankaccount']);
/** Names that speak of accounting, not of money held somewhere: the exact names, nothing more. */
const NOT_MONEY: ReadonlySet<string> = new Set(['accounting', 'accounttype', 'accounttypes', 'accountingcategory']);
/** The words of a field name: "bankAccount" is bank and account, "card_details" is card and details. */
function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word !== '');
}
/** Whether a field name speaks of money held somewhere (a bank, a card, an account …), by its words. */
function namesMoney(name: string): boolean {
  if (NOT_MONEY.has(name.toLowerCase().replace(/[-_\s.]/g, ''))) return false;
  return wordsOf(name).some(word => MONEY_WORDS.has(word));
}
/** Separators between the groups of a number: spaces, dots, slashes and dashes of any kind. */
const SEP = '[\\s\\u00a0./\\-\\u2010-\\u2015\\u2212]';
const SEPARATORS = new RegExp(SEP, 'g');
/** A value of digits and separators only, of any length: below money, even a short one (a security code, a month). */
const DIGITS = new RegExp(`^${SEP}*\\d(?:${SEP}*\\d)*${SEP}*$`);
/** A key that names a resource's id. */
const ID_KEY = /^(ids?|[a-z][A-Za-z0-9]*Ids?|[a-z][a-z0-9_]*_ids?)$/;
const ID_VALUE = /^[A-Za-z0-9_-]{1,100}$/;

/** What stands where a link was: every link is removed, since any of them may carry a key. */
export const LINK_REMOVED = '[link removed]';
/** The earlier name of LINK_REMOVED. */
export const SIGNED_LINK_REMOVED = LINK_REMOVED;
export const NUMBER_REMOVED = '[bank or card number removed]';
/** Where an IBAN may start: a country code and check digits, in capitals or not, whatever stands before it. */
const IBAN_START = /[A-Z]{2}\d{2}/gi;
/** The letters and digits that may follow, in groups. */
const IBAN_REST = new RegExp(`^(?:${SEP}*[A-Z0-9]){11,30}`, 'i');
/** A run of 12 or more digits, in groups or not and whatever stands next to it. */
const CARD = new RegExp(`\\d(?:${SEP}*\\d){11,}`, 'g');
/** A number named as an account or a sort code: "Reg.nr. 1234", "Konto 1234567890", "Account number is 12-34-56". */
const LABELLED_ACCOUNT = new RegExp(
  `\\b(reg(?:istrerings)?\\.?\\s*(?:nr|no)\\.?|registreringsnummer|konto(?:\\s*(?:nr\\.?|nummer|no\\.?))?|account(?:\\s*(?:no\\.?|number|nr\\.?|#))?|a\\/c(?:\\s*no\\.?)?|acct\\.?(?:\\s*no\\.?)?|sort\\s*code|routing(?:\\s*(?:no\\.?|number|code))?|bsb|aba)((?:\\s*\\([A-Z]{3}\\))?[\\s\\u00a0:#.=\\-\\u2010-\\u2015\\u2212"'\\u201c\\u201d]*(?:(?:is|er|was|var)[\\s\\u00a0:"'\\u201c\\u201d]+)?)\\d(?:${SEP}*\\d){3,}`,
  'gi',
);

/** A card's security code named in text: "CVV: 123", "CVC2 456", "security code 1234". */
const SECURITY_CODE = /\b(cvv2?|cvc2?|cvn|csc|cid|security\s*code|sikkerhedskode|kontrolcifre)([\s\u00a0:#.=\-"']*(?:(?:is|er)[\s\u00a0:"']+)?)\d{3,4}\b/gi;
/** A card's expiry named in text: "Expiry: 12/28", "exp. 12-2028", "udløb 12/28". */
const EXPIRY = /\b(expiry|expiration|exp\.?|udløb(?:sdato)?|gyldig til)([\s\u00a0:#.=\-"']*(?:(?:is|er)[\s\u00a0:"']+)?)\d{1,2}\s*[/.\-]\s*\d{2,4}\b/gi;

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

/** Whether a run of digits holds a card number: 12 to 19 digits in a row in it (separators left out) that pass Luhn. */
function holdsCardNumber(run: string): boolean {
  const digits = run.replace(SEPARATORS, '');
  for (let start = 0; start + 12 <= digits.length; start += 1) {
    for (let length = 12; length <= 19 && start + length <= digits.length; length += 1) {
      if (luhn(digits.slice(start, start + length))) return true;
    }
  }
  return false;
}

/** IBAN length by country code (SWIFT IBAN registry). */
const IBAN_LENGTHS: Readonly<Record<string, number>> = Object.freeze({
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28,
  CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FK: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23,
  GL: 18, GR: 27, GT: 28, HN: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28,
  LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20, MR: 27, MT: 31, MU: 30, NI: 28,
  NL: 18, NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, RU: 33, SA: 24, SC: 31, SD: 18, SE: 24,
  SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20, YE: 30,
});

/** How many letters and digits from the start of a candidate make an IBAN (its country's length, check digits right), or 0. */
function ibanLength(candidate: string): number {
  const compact = candidate.replace(SEPARATORS, '').toUpperCase();
  const length = IBAN_LENGTHS[compact.slice(0, 2)];
  if (length === undefined || compact.length < length) return 0;
  const iban = compact.slice(0, length);
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const char of moved) {
    const value = char >= 'A' ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of value) rest = (rest * 10 + Number(digit)) % 97;
  }
  return rest === 1 ? length : 0;
}

/** A text with every IBAN removed: every place one may start is tried, and overlapping finds are merged. */
function withoutIbans(value: string): string {
  const marks: Array<[number, number]> = [];
  IBAN_START.lastIndex = 0;
  for (let found = IBAN_START.exec(value); found !== null; found = IBAN_START.exec(value)) {
    const start = found.index;
    IBAN_START.lastIndex = start + 1;
    const rest = IBAN_REST.exec(value.slice(start + 4));
    const length = rest ? ibanLength(value.slice(start, start + 4 + rest[0].length)) : 0;
    if (length === 0) continue;
    let end = start;
    for (let seen = 0; seen < length; end += 1) if (!new RegExp(SEP).test(value[end]!)) seen += 1;
    const last = marks[marks.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else marks.push([start, end]);
  }
  let out = '';
  let from = 0;
  for (const [start, end] of marks) {
    out += value.slice(from, start) + NUMBER_REMOVED;
    from = end;
  }
  return out + value.slice(from);
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', equals: '=', quest: '?', sol: '/', colon: ':', num: '#', percnt: '%', semi: ';', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: '\u00a0', ensp: ' ', emsp: ' ', thinsp: ' ', numsp: ' ', puncsp: ' ', hairsp: ' ', tab: '\t', newline: '\n',
  period: '.', comma: ',', hyphen: '-', dash: '-', ndash: '-', mdash: '-', minus: '-', lpar: '(', rpar: ')', plus: '+', excl: '!',
};

/** A text with its HTML character references written out: numeric ones and the named ones a link's syntax uses. */
function htmlDecoded(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});?/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/**
 * Whether a word holds a query that sets a value ("?" and then "="), once it is decoded: HTML references and
 * percent-encoding, also nested and with each hex digit encoded on its own, up to eight rounds, each in linear time. A
 * word still changing after that is taken as holding one: it is removed rather than looked at further.
 */
function holdsQuery(word: string): boolean {
  let text = word;
  for (let round = 0; round < 8; round += 1) {
    const question = text.indexOf('?');
    if (question >= 0 && text.indexOf('=', question + 1) > question) return true;
    const decoded = htmlDecoded(text).replace(/%([0-9a-f]{2})/gi, (_whole, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (decoded === text) return false;
    text = decoded;
  }
  return true;
}

/** Whether a word is a link to somewhere: a scheme and "//", a "//" host, or "www.", also once decoded. */
function isLink(word: string): boolean {
  let text = word;
  for (let round = 0; round < 8; round += 1) {
    if (/^[a-z][a-z0-9+.-]*:\/\/|\/\/[a-z0-9-]|^www\./i.test(text) || /:\/\//.test(text)) return true;
    const decoded = htmlDecoded(text).replace(/%([0-9a-f]{2})/gi, (_whole, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (decoded === text) return false;
    text = decoded;
  }
  return true;
}

/**
 * A text without links and without words with a query that sets a value. A link may carry its key anywhere (in the
 * query, or in its path, as Cloudinary's signed links do), so every link is removed, signed or not; and a browser drops
 * tabs and line breaks inside a link, so the text is looked at with them dropped too.
 */
function withoutQueries(value: string): string {
  return value
    .split(/([\s"<>]+)/)
    .map(part => (part.length > 1 && (isLink(part) || holdsQuery(part)) ? SIGNED_LINK_REMOVED : part))
    .join('');
}

/** A text with links that carry a query, IBANs, named account numbers and card numbers removed. */
function scrubText(original: string, depth = 0): string {
  // A text that is JSON is scrubbed as data, field names and all, and written out again.
  const trimmed = original.trim();
  if (depth < 4 && (trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length <= 1_000_000) {
    try {
      return JSON.stringify(scrub(JSON.parse(trimmed), depth + 1));
    } catch {
      // Not JSON: a text as any other.
    }
  }
  // HTML character references are written out first (also nested), so nothing hides behind them.
  let value = original;
  for (let round = 0; round < 8; round += 1) {
    const decoded = htmlDecoded(value);
    if (decoded === value) break;
    value = decoded;
  }
  return withoutIbans(withoutQueries(value))
    .replace(LABELLED_ACCOUNT, (_match, label: string, gap: string) => `${label}${gap}${NUMBER_REMOVED}`)
    .replace(SECURITY_CODE, (_match, label: string, gap: string) => `${label}${gap}${NUMBER_REMOVED}`)
    .replace(EXPIRY, (_match, label: string, gap: string) => `${label}${gap}${NUMBER_REMOVED}`)
    .replace(CARD, run => (holdsCardNumber(run) ? NUMBER_REMOVED : run));
}

/** A copy of Corpay's answer with bank and card data and links with a query left out, as described above. */
export function scrub(value: unknown, depth = 0, key = '', inMoney = false): unknown {
  if (depth > 64) return undefined;
  if (typeof value === 'string') {
    if (ID_KEY.test(key) && !namesMoney(key) && !inMoney && ID_VALUE.test(value)) return value;
    if (inMoney && (DIGITS.test(value) || /\d(?:[\s\u00a0./\-]*\d){3}/.test(value))) return undefined;
    return scrubText(value, depth);
  }
  if (Array.isArray(value)) return value.map(entry => scrub(entry, depth + 1, key, inMoney)).filter(entry => entry !== undefined);
  if (typeof value === 'number') {
    if (ID_KEY.test(key) && !namesMoney(key) && !inMoney && Number.isSafeInteger(value)) return value;
    if (inMoney) return undefined;
    // A card number may also come as a number. Above the safe integers the digits are no longer the ones that were
    // sent, so such a number is removed as it is.
    if (!Number.isFinite(value) || Math.abs(value) < 1e11) return value;
    return Math.abs(value) > Number.MAX_SAFE_INTEGER || holdsCardNumber(Math.abs(value).toFixed(0)) ? NUMBER_REMOVED : value;
  }
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(value)) {
    // Names are compared without case, spaces, dashes, underscores or dots: "account.number" is "accountnumber".
    const plain = name.toLowerCase().replace(/[-_\s.]/g, '');
    if (HIDDEN_NAME.test(plain)) continue;
    // A key that holds a number or a link the texts may not hold is left out with its value.
    if (scrubText(name) !== name) continue;
    const money = inMoney || (namesMoney(name) && !ID_KEY.test(name));
    const kept = scrub(entry, depth + 1, name, money);
    if (kept !== undefined) out[name] = kept;
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
