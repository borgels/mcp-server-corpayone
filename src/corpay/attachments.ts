/**
 * Expense attachments.
 *
 * `/v3/expenses/{id}` lists an expense's files under `data.attachments`: the
 * original upload (`isOriginal: true`, usually a PDF) and, for a PDF, one
 * rendered JPG per page whose `attachmentParentId` names the original. Each
 * carries a CloudFront URL signed for about an hour — there is no API endpoint
 * that serves the file itself.
 *
 * The server downloads the file rather than handing the URL to the caller, so
 * the content reaches the model even where the client cannot fetch URLs. Only
 * Corpay's attachment hosts are fetched: the URL comes from an API response,
 * but it is still checked rather than trusted.
 */

export interface ExpenseAttachment {
  id: string;
  url: string;
  created?: string;
  isOriginal: boolean;
  parentId?: string;
}

const ATTACHMENT_HOSTS = new Set(['attachments.corpayone.com', 'attachments.staging.corpayone.com']);

/** Largest single file returned, in bytes. Base64 adds a third on top. */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
/** Most rendered pages returned in one call. */
export const MAX_ATTACHMENT_PAGES = 10;

const EXTENSION_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  xml: 'application/xml',
};

/** The attachments of an expense payload, in the order Corpay lists them. */
export function extractAttachments(payload: unknown): ExpenseAttachment[] {
  const data = isRecord(payload) ? payload.data : undefined;
  const expense = isRecord(data) && isRecord(data.expense) ? data.expense : data;
  const list = isRecord(expense) ? expense.attachments : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap(item => {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.url !== 'string') return [];
    return [
      {
        id: item.id,
        url: item.url,
        created: typeof item.created === 'string' ? item.created : undefined,
        isOriginal: item.isOriginal === true,
        parentId: typeof item.attachmentParentId === 'string' ? item.attachmentParentId : undefined,
      },
    ];
  });
}

/**
 * The attachment to return: the one named, or else the first original.
 * Throws with the ids on offer when the requested one is not there.
 */
export function selectAttachment(attachments: ExpenseAttachment[], attachmentId?: string): ExpenseAttachment {
  if (attachments.length === 0) {
    throw new Error('This expense has no attachments.');
  }
  if (attachmentId) {
    const found = attachments.find(a => a.id === attachmentId);
    if (!found) {
      throw new Error(
        `Attachment "${attachmentId}" is not on this expense. Available: ${attachments.map(a => a.id).join(', ')}.`,
      );
    }
    return found;
  }
  return attachments.find(a => a.isOriginal) ?? (attachments[0] as ExpenseAttachment);
}

/** Rendered page images of an original, in page order. */
export function renderedPages(attachments: ExpenseAttachment[], original: ExpenseAttachment): ExpenseAttachment[] {
  return attachments
    .filter(a => a.parentId === original.id)
    .sort((a, b) => pageNumber(a) - pageNumber(b));
}

/** Refuse anything but https on Corpay's attachment hosts. */
export function assertAttachmentUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Attachment URL is not a valid URL.');
  }
  if (parsed.protocol !== 'https:' || !ATTACHMENT_HOSTS.has(parsed.hostname) || parsed.port) {
    throw new Error(`Refusing to fetch an attachment from ${parsed.protocol}//${parsed.host}.`);
  }
}

/** File name from the URL path, e.g. `original.pdf` or `rendered.p2.jpg`. */
export function attachmentFileName(attachment: ExpenseAttachment): string {
  try {
    return decodeURIComponent(new URL(attachment.url).pathname.split('/').pop() || attachment.id);
  } catch {
    return attachment.id;
  }
}

/** Media type from the response, falling back to the file extension. */
export function attachmentMimeType(attachment: ExpenseAttachment, contentType?: string): string {
  if (contentType && contentType !== 'application/octet-stream' && contentType !== 'binary/octet-stream') {
    return contentType;
  }
  const ext = attachmentFileName(attachment).split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_TYPES[ext] ?? 'application/octet-stream';
}

/** When the signed URL stops working, from its `Expires` parameter. */
export function attachmentUrlExpiry(attachment: ExpenseAttachment): string | undefined {
  try {
    const expires = Number(new URL(attachment.url).searchParams.get('Expires'));
    return Number.isFinite(expires) && expires > 0 ? new Date(expires * 1000).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

function pageNumber(attachment: ExpenseAttachment): number {
  const match = /\.p(\d+)\.[a-z]+$/i.exec(attachmentFileName(attachment));
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
