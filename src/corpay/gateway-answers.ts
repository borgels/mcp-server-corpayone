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
/** Numbers at or above this are no amount or count Corpay One gives, and may be card numbers: they are left out. */
const MAX_NUMBER = 1e12;
export const LINK_REMOVED = '[link removed]';
/**
 * A word of a text: everything up to a space. A link holds no space, so it is always within one word, and is removed
 * as the whole word, quotes and angle brackets in it too.
 */
const WORD = /\S+/g;
/** A scheme (a name that starts with a letter) and a colon with something right after it: https:, mailto:x, sms:1234. */
const SCHEME = /(?:^|[^A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:[^:]/;
/** A query in a word: a question mark and, before the next one, an equals sign. */
const QUERY = /\?[^?]*=/;
/** An IPv6 literal in a word: hex digits, colons, dots and a zone ("%25eth0") in square brackets. */
const IPV6 = /\[[0-9A-Za-z.%]*:[0-9A-Za-z:.%]*\]/;
/** An IPv6 address without brackets: "::", or three colons or more with hex digits between ("2001:db8:0:0:0:0:0:1"). */
const IPV6_BARE = /^[^0-9A-Fa-f:]*(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?:%[0-9A-Za-z]+)?[^0-9A-Za-z:]*$/;
/** Four groups of digits with dots between, also with leading zeros ("0177.0.0.1"), or a hex number ("0x7f000001"). */
const IPV4_OTHER = /^(?:(?:0x[0-9A-Fa-f]*|\d+)\.){3}(?:0x[0-9A-Fa-f]*|\d+)$|^0x[0-9A-Fa-f]{1,8}$/i;
/** An IPv4 address in any spelling (one to four parts, decimal or hex) and a port. */
const IPV4_WITH_PORT = /^(?:0x[0-9A-Fa-f]*|\d+)(?:\.(?:0x[0-9A-Fa-f]*|\d+)){0,3}:\d{1,5}$/i;
/** Two to four dotted parts of which one is a hex number ("0x7f.1", "1.2.3.0xff"): an IPv4 address, no amount. */
const IPV4_HEX_PART = /^(?:(?:0x[0-9A-Fa-f]*|\d+)\.){1,3}(?:0x[0-9A-Fa-f]*|\d+)$/i;

/**
 * Whether a part of a word between slashes is short and plain, so no path: four letters or digits at most, in one run,
 * with no colon or question mark ("A", "S.", "kr", "2026"). A scan, linear in the length of the part.
 */
function isShortPart(part: string): boolean {
  let letters = 0;
  let runs = 0;
  let inRun = false;
  for (const char of part) {
    if (char === ':' || char === '?') return false;
    const letter = /[\p{L}\p{N}]/u.test(char);
    if (letter && !inRun) runs += 1;
    if (letter) letters += 1;
    inRun = letter;
    if (letters > 4 || runs > 1) return false;
  }
  return true;
}
/** A run of letters, digits, dots and dashes in a word (any script): where a host name may stand. */
const HOST_RUN = /[\p{L}\p{N}\p{M}.-]+/gu;
/** The last label of a host name: two letters or more (any script), or an internationalised one ("xn--…"). */
const TOP_LABEL = /^(?:\p{L}[\p{L}\p{M}]+|xn--[a-z0-9-]+)$/iu;

/**
 * Whether a word of a text is, or holds, a link: it holds "//" or "www.", a scheme of any length with something after
 * its colon ("Note: text" and "14:30" are no links), or a host name in any script (labels with dots between, the last of
 * two letters or more or "xn--…": "t.co", "example.com", "customer.finance", "faktura.pdf"; not "bl.a", "1.240" or a
 * common abbreviation such as "f.eks" or "Reg.nr") or an IPv4 address, a query ("?a=b"), an IPv6 literal, or a path
 * (a "/" between parts of which one is longer than four letters or digits or holds a dot or a colon: "localhost/x",
 * "127.1/x", "faktura/kreditnota"; not "A/S", "kr/md" or "27/11/2026"). Full-width and ideographic dots count as dots. A word that only looks like one is removed too: removing too much is the price of never letting a
 * link through. Linear in the length of the word.
 */
function isLink(original: string, joined = false): boolean {
  // Read as a browser would: full-width and ideographic dots are dots, compatibility forms their plain ones.
  const word = original.normalize('NFKC').replace(/[\u3002\uff0e\uff61]/g, '.');
  if (word.includes('//') || word.toLowerCase().includes('www.')) return true;
  // Words joined across a line break are a link by "//", "www." or a known scheme only: "Note:<line break>Please"
  // and "Betalt.<line break>Tak" are no links.
  if (joined) return KNOWN_SCHEME.test(word);
  if (SCHEME.test(word)) return true;
  // A query ("?name=value"), or an IPv6 literal ("[::1]").
  if (QUERY.test(word) || IPV6.test(word)) return true;
  // A path: a word with "/" is a link unless every part is short and plain ("A/S", "kr/md", "27/11/2026").
  if (word.includes('/') && !word.split('/').every(isShortPart)) return true;
  // An IP address in another spelling: IPv6 without brackets, IPv4 with leading zeros or as a hex number.
  for (const candidate of word.matchAll(IP_CANDIDATE)) if (isIpSpelling(candidate[0])) return true;
  for (const run of word.matchAll(HOST_RUN)) {
    // A path, a query or a fragment right after it makes it a host name, whatever it ends in.
    const next = word[(run.index ?? 0) + run[0].length];
    if (isHost(run[0], next === '/' || next === '?' || next === '#')) return true;
  }
  return false;
}

/** Whether a run of letters, digits, dots and dashes is a host name or an IPv4 address, ends' dots and dashes aside. */
function isHost(run: string, withPath: boolean): boolean {
  let from = 0;
  let to = run.length;
  while (from < to && (run[from] === '.' || run[from] === '-')) from += 1;
  while (to > from && (run[to - 1] === '.' || run[to - 1] === '-')) to -= 1;
  const labels = run.slice(from, to).split('.');
  if (labels.length < 2 || labels.some(label => label.length === 0)) return false;
  if (labels.every(label => /^\d{1,3}$/.test(label))) {
    return labels.length === 4 && labels.every(label => Number(label) <= 255 && !(label.length > 1 && label.startsWith('0')));
  }
  const last = labels[labels.length - 1]!;
  if (!TOP_LABEL.test(last)) return false;
  if (withPath) return true;
  const host = labels.join('.').toLowerCase();
  return !ABBREVIATIONS.has(host) && !NOT_A_DOMAIN.has(last.toLowerCase());
}

/**
 * Common Danish abbreviations written with a dot that end in a top-level domain (".nr"): these exact words only, and
 * only without a path. "Reg.nr." stays readable, so the account number after it is still found and removed.
 */
const ABBREVIATIONS = new Set(['reg.nr', 'kto.nr', 'konto.nr', 'cvr.nr', 'se.nr', 'tlf.nr', 'ref.nr', 'fak.nr', 'fakt.nr', 'faktura.nr']);
/** Endings of common abbreviations that are no top-level domain ("f.eks.", "m.fl.", "inkl."). */
const NOT_A_DOMAIN = new Set(['eks', 'inkl', 'ekskl', 'excl', 'evt', 'vedr', 'dvs', 'osv', 'tlf', 'pga', 'iflg', 'ifm', 'mht', 'etc']);
/** Where an IP address may stand in a word: letters, digits, dots, colons and a zone sign in a row. */
const IP_CANDIDATE = /[0-9A-Za-z.:%]+/g;

/**
 * Whether a word, punctuation around it aside, is an IP address in a spelling other than the plain dotted one: IPv6
 * without brackets ("2001:db8::1"; not a time such as "12:34:56"), four dotted groups with leading zeros ("0177.0.0.1")
 * or a hex number ("0x7f000001"). A plain number ("127.1", "2130706433") is never taken for a link: in a text it is an
 * amount, a count or a reference, and as a link it would need a scheme, "//" or a path, which are removed.
 */
function isIpSpelling(word: string): boolean {
  let from = 0;
  let to = word.length;
  while (from < to && /[^\p{L}\p{N}:%]/u.test(word[from]!)) from += 1;
  while (to > from && /[^\p{L}\p{N}:%]/u.test(word[to - 1]!)) to -= 1;
  const core = word.slice(from, to);
  if (IPV4_OTHER.test(core)) return true;
  if (IPV4_HEX_PART.test(core) && /0x/i.test(core)) return true;
  // An IPv4 address in any spelling with a port: "127.1:8080", "0x7f000001:8080", "0x7f.0.0.1:8080" (a time is no
  // address: "12:34").
  if (IPV4_WITH_PORT.test(core) && !/^\d{1,2}:\d{2}$/.test(core)) return true;
  if (!IPV6_BARE.test(core)) return false;
  // A time has two colons at most and no hex letters: "12:34:56" is no address.
  return core.includes('::') || (core.match(/:/g) ?? []).length >= 3 || /[A-Fa-f]/.test(core.replace(/%.*$/, ''));
}

/** A text with every word that is or holds a link replaced by LINK_REMOVED. */
export function removeLinks(text: string): string {
  return text.replace(WIDE_WORD, wide => {
    // A browser drops tabs and line breaks inside a link ("https:<tab>//host"): a run of words joined by them is one
    // link when, joined, it reads as one ("//", "www." or a known scheme such as "https:" or "webcal:").
    if (/[\t\n\r]/.test(wide)) {
      // A known scheme in any of the words before a break ("Hello<line break>webcal:<line break>…"), or the words joined.
      const parts = wide.split(/[\t\n\r]+/);
      if (parts.slice(0, -1).some(part => KNOWN_SCHEME.test(part))) return LINK_REMOVED;
      if (isLink(parts.join(''), true)) return LINK_REMOVED;
    }
    return wide.replace(WORD, word => (isLink(word) ? LINK_REMOVED : word));
  });
}

/** Words with only tabs and line breaks between them: what a browser could read as one link. */
const WIDE_WORD = /\S+(?:[\t\n\r]+\S+)*/g;
/**
 * The schemes of links in use (the special ones, and the registered ones seen in mail, calendars, phones and apps):
 * words joined across a tab or a line break are a link when they hold one ("webcal:<line break>…"). Any other word
 * and a colon at the end of a line is no link ("Note:<line break>Please").
 */
const KNOWN_SCHEME = new RegExp(
  `(?:^|[^A-Za-z0-9+.-])(?:${[
    'https?', 'ftps?', 'sftp', 'wss?', 'file', 'mailto', 'tel', 'sms', 'mms', 'fax', 'callto', 'skype', 'facetime(?:-audio)?',
    'webcal', 'data', 'blob', 'javascript', 'vbscript', 'about', 'chrome', 'ldaps?', 'ssh', 'telnet', 'git', 'svn',
    'ircs?', 'magnet', 'xmpp', 'sips?', 'geo', 'maps', 'news', 'nntp', 'feed', 'rtsp', 'rtmp', 'smb', 'nfs', 'afp',
    'spotify', 'slack', 'zoommtg', 'msteams', 'intent', 'market', 'itms(?:-apps)?', 'whatsapp', 'tg', 'viber', 'bitcoin',
    'ethereum', 'urn', 'ms-[a-z-]+', 'outlook', 'onenote', 'vnc', 'rdp', 'view-source', 'cid', 'mid', 'im', 'jar',
  ].join('|')}):`,
  'i',
);

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
      // Never cut: a cut could leave part of a link, a number or a secret behind, unrecognised.
      return scrubText(removeLinks(value));
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
