/**
 * Typed answers of the embedded gateway (src/gateway.ts): each tool passes on only the fields it knows, by an
 * allow-list per answer type. A field that is not in the list is left out, whatever its name or value, so bank details,
 * card numbers, payment methods and payment instructions never leave: none of them is in a list. Links are never passed
 * on either: no field that holds one is listed (attachment URLs, websites), and any link in a free text is removed.
 *
 * Every value is checked for its type: an id must have an id's form, a code a code's, a date a date's, a number must be
 * finite. A value that does not is left out. Free texts (names, notes, comments) are passed on after the pattern scrub
 * (scrub in gateway-tools.ts), which stays as an extra guard only.
 *
 * The lists follow Corpay One's API description (the external API's swagger, v1 to v3); src/gateway.ts applies the
 * pattern scrub once more to the final result.
 */

/** What a field is, and so how its value is checked. */
export type FieldKind = 'id' | 'code' | 'taxId' | 'text' | 'date' | 'number' | 'boolean';
/** An answer type: the fields it may hold, each a kind, a nested type or a list of one. */
export type Shape = FieldKind | { readonly [field: string]: Shape } | readonly [Shape];

/** An id as Corpay One gives them (a GUID, or ASCII letters, digits, "-" and "_"). */
const ID = /^[A-Za-z0-9_-]{1,100}$/;
/** A code: a state, a type, a currency, a country, an account number, a VAT or postal code. No link, no long digits. */
const CODE = /^[\p{L}0-9 ._+-]{0,60}$/u;
/** What a link or a host name looks like in a code ("www.", or a name and a dot and two letters or more). */
const HOST_IN_CODE = /www\.|[\p{L}\p{N}-]\.\p{L}{2,}/iu;
/** A date or a date and time as ISO 8601. */
const DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
/** A company or VAT number: letters, digits, spaces, dots and dashes; at most 12 digits in a row. */
const TAX_ID = /^[A-Za-z0-9 .-]{2,30}$/;
/** Longest free text passed on. */
const MAX_TEXT = 20_000;
/** Numbers at or above this are no amount or count Corpay One gives, and may be card numbers: they are left out. */
const MAX_NUMBER = 1e12;
export const LINK_REMOVED = '[link removed]';
/**
 * A link in a text, up to a space, a quote or an angle bracket (brackets and parentheses are taken with it, so no part
 * of a link is left behind): a scheme (a word that starts with a letter) and a colon with anything but a space, a quote
 * or an angle bracket right after it (https://, mailto:, sms:1234, webcal: …; "Note: text" and "14:30" are no links); a
 * scheme-relative "//host"; or "www.". A word and a colon with no space after it is taken as a link: removing too much
 * is the price of never letting one through.
 */
const LINK = /(?:\b[a-z][a-z0-9+.-]{0,30}:(?=[^\s"'<>])|(?<![\w:/])\/\/(?=[^\s/])|\bwww\.)[^\s"'<>]*/gi;

/** A text with every link replaced by LINK_REMOVED. */
export function removeLinks(text: string): string {
  return text.replace(LINK, LINK_REMOVED);
}

/** A free text as it is passed on: links removed, then the pattern scrub as an extra guard. */
export type TextScrub = (text: string) => string;

/** The value of an answer projected on its shape: only listed fields, each of its kind. Undefined when nothing fits. */
export function project(value: unknown, shape: Shape, scrubText: TextScrub, depth = 0): unknown {
  if (depth > 32 || value === undefined || value === null) return undefined;
  if (typeof shape === 'string') return field(value, shape, scrubText);
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) return undefined;
    const out: unknown[] = [];
    for (const entry of value) {
      const kept = project(entry, (shape as readonly [Shape])[0], scrubText, depth + 1);
      if (kept !== undefined) out.push(kept);
    }
    return out;
  }
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [name, inner] of Object.entries(shape as Record<string, Shape>)) {
    if (!Object.prototype.hasOwnProperty.call(source, name)) continue;
    const kept = project(source[name], inner, scrubText, depth + 1);
    if (kept !== undefined) out[name] = kept;
  }
  return out;
}

function field(value: unknown, kind: FieldKind, scrubText: TextScrub): unknown {
  switch (kind) {
    case 'id':
      // A number id below a trillion, or a string id that is no account, card or bank number (13 digits or more in a
      // row, or what the pattern scrub would take out).
      if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 && value < 1e12 ? value : undefined;
      if (typeof value !== 'string' || !ID.test(value) || /\d{13}/.test(value)) return undefined;
      return scrubText(value) === value ? value : undefined;
    case 'code':
      if (typeof value !== 'string' || !CODE.test(value) || HOST_IN_CODE.test(value)) return undefined;
      // Nine digits or more in a row, also across spaces, dots and dashes, is no code but an account or card number.
      return /\d{9}/.test(value.replace(/[\s.-]/g, '')) ? undefined : value;
    case 'taxId':
      // A company or VAT number keeps its digits (up to 12 in a row, separators left out), unless it holds a host name or
      // the pattern scrub would take something out of it (an IBAN, a card number).
      if (typeof value !== 'string' || !TAX_ID.test(value) || HOST_IN_CODE.test(value)) return undefined;
      if (/\d{13}/.test(value.replace(/[\s.-]/g, ''))) return undefined;
      return scrubText(value) === value ? value : undefined;
    case 'date':
      return typeof value === 'string' && DATE.test(value) ? value : undefined;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < MAX_NUMBER ? value : undefined;
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    case 'text':
      if (typeof value !== 'string') return undefined;
      // Cut only after links and numbers are removed, so a cut never leaves part of one behind unrecognised.
      return scrubText(removeLinks(value)).slice(0, MAX_TEXT);
  }
}

/** The data of an answer: Corpay One wraps it in `data`, and sometimes once more in a named field. */
export function dataOf(answer: unknown, name?: string): unknown {
  const data = isRecord(answer) && 'data' in answer ? answer.data : answer;
  if (name && isRecord(data) && name in data) return data[name];
  return data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------- the answer types

const USER_OR_TEAM = { id: 'id' } as const;
const OWNER = { user: USER_OR_TEAM, team: USER_OR_TEAM } as const;

const CATEGORY_REF = { id: 'id', name: 'text', number: 'code', externalId: 'text', parent: { id: 'id' } } as const;
const LABEL = { id: 'id', value: 'text', parentId: 'id', listId: 'id', externalId: 'text' } as const;
const ITEM = { id: 'id', name: 'text', externalId: 'text', quantity: 'number' } as const;
const DEPARTMENT = { id: 'id', name: 'text', externalId: 'text' } as const;
const VENDOR_REF = { id: 'id', name: 'text', externalId: 'text' } as const;

/** A team (company): name, address, country, VAT number, currency and which modules are on. No owner, no agreement. */
export const TEAM: Shape = {
  id: 'id',
  name: 'text',
  vat: 'taxId',
  address: 'text',
  city: 'text',
  postalCode: 'code',
  countryCode: 'code',
  currency: 'code',
  modules: {
    pay: { isActive: 'boolean' },
    recognize: { isActive: 'boolean' },
    integrate: { isActive: 'boolean' },
    approval: { isActive: 'boolean' },
    workflow: { isActive: 'boolean' },
    accrue: { isActive: 'boolean' },
  },
};

/** An expense in a list (v2 bills): no attachments, no payment method, no creditor. */
export const EXPENSE_IN_LIST: Shape = {
  id: 'id',
  type: 'code',
  number: 'number',
  amount: 'number',
  currency: 'code',
  state: 'code',
  referenceDate: 'date',
  issueDate: 'date',
  dueDate: 'date',
  originalDueDate: 'date',
  isDueDateOverwritten: 'boolean',
  initializedDate: 'date',
  paymentDate: 'date',
  category: CATEGORY_REF,
  vendor: VENDOR_REF,
  owner: OWNER,
};

/** A page of expenses. */
export const EXPENSE_PAGE: Shape = { total: 'number', offset: 'number', count: 'number', bills: [EXPENSE_IN_LIST] };

/** One expense in full (v3): attachments by id only (never their links), no payment method, creditor or instruction. */
export const EXPENSE: Shape = {
  id: 'id',
  type: 'code',
  reference: 'text',
  number: 'number',
  amount: 'number',
  originalAmount: 'number',
  currency: 'code',
  originalCurrency: 'code',
  state: 'code',
  friendlyStatus: 'code',
  referenceDate: 'date',
  issueDate: 'date',
  dueDate: 'date',
  originalDueDate: 'date',
  isDueDateOverwritten: 'boolean',
  initializedDate: 'date',
  paymentDate: 'date',
  isPayable: 'boolean',
  declineReason: 'text',
  attachments: [{ id: 'id', created: 'date', isOriginal: 'boolean' }],
  notes: [{ id: 'id', value: 'text', created: 'date' }],
  category: CATEGORY_REF,
  item: ITEM,
  departments: [DEPARTMENT],
  labels: [LABEL],
  fx: { homeAmount: 'number', foreignAmount: 'number', homeCurrency: 'code', foreignCurrency: 'code', exchangeRate: 'number' },
  lines: [
    {
      id: 'id',
      category: CATEGORY_REF,
      departmentId: 'id',
      department: DEPARTMENT,
      created: 'date',
      amount: 'number',
      note: 'text',
      labels: [LABEL],
      item: ITEM,
    },
  ],
  vendor: VENDOR_REF,
  owner: OWNER,
};

/** What has happened to an expense. */
export const ACTIVITY: Shape = { activityType: 'code', body: 'text', userId: 'id', created: 'date' };

/** Who must approve an expense, and who has. */
export const APPROVER: Shape = {
  id: 'id',
  userId: 'id',
  name: 'text',
  status: 'code',
  state: 'code',
  approved: 'boolean',
  hasApproved: 'boolean',
  approvedDate: 'date',
  approvedAt: 'date',
  order: 'number',
  step: 'number',
};

/** A category (an account to code on): its Corpay id, name and account number. */
export const CATEGORY: Shape = { id: 'id', name: 'text', number: 'code', externalId: 'text', parentId: 'id', selectable: 'boolean' };

/** A label list (projects, cost types …) and its labels. */
export const LABEL_LIST: Shape = { id: 'id', name: 'text', type: 'code', dataType: 'code', labels: [LABEL] };

/** What a change answers: what was done, from its own input, typed like any answer. */
export const CHANGED: Shape = {
  coded: 'boolean',
  linesSet: 'boolean',
  commented: 'boolean',
  declined: 'boolean',
  approved: 'boolean',
  linked: 'boolean',
  expenseId: 'id',
  categoryId: 'id',
  labelIds: ['id'],
  lines: 'number',
  total: 'number',
  vendorId: 'id',
  externalId: 'text',
  source: 'text',
};

/** A vendor: name, company number, address and its link to the accounting system. No website, no bank details. */
export const VENDOR: Shape = {
  id: 'id',
  teamVendorId: 'id',
  name: 'text',
  identification: 'taxId',
  email: 'text',
  address: 'text',
  postal: 'code',
  city: 'text',
  stateProvince: 'text',
  country: 'code',
  externalId: 'text',
  source: 'code',
};
