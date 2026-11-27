/**
 * Errors of the embedded gateway (src/gateway.ts): our own texts, the HTTP
 * status and Corpay's request id from a response header (only in the form
 * such ids have). Never a response body, a vendor message or code, or a
 * redirect's Location. The MCP server's own errors live in src/errors.ts.
 */

/** An answer from Corpay One that failed: an HTTP error or a redirect, which is never followed. */
export class CorpayAnswerError extends Error {
  readonly status: number;
  /** Corpay's id for the request, when a response header gives one as a UUID or hex id (never in the message). */
  readonly requestId?: string;

  constructor(message: string, status: number, requestId?: string) {
    super(message);
    this.name = 'CorpayAnswerError';
    this.status = status;
    this.requestId = vendorRequestId(requestId);
  }
}

/** Response headers that carry the vendor's own id for a request, most specific first. */
export const REQUEST_ID_HEADERS: readonly string[] = [
  'x-request-id',
  'request-id',
  'x-correlation-id',
  'correlation-id',
  'traceparent-id',
  'x-amzn-requestid',
];

/** A hex id: one run of hex digits, or groups of at least four joined by single hyphens (a UUID is one). */
const REQUEST_ID_FORM = /^[0-9A-Fa-f]{4,}(?:-[0-9A-Fa-f]{4,})*$/;
/** Six digits and four more: the shape of a Danish personal number. An id that holds it is dropped. */
const PERSONAL_NUMBER_SHAPE = /\d{6}-?\d{4}/;

/** The vendor's request id, only as a UUID or a hex id of 8 to 64 characters; anything else is dropped. */
export function vendorRequestId(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return id.length >= 8 && id.length <= 64 && REQUEST_ID_FORM.test(id) && !PERSONAL_NUMBER_SHAPE.test(id) ? id : undefined;
}

/** The vendor's request id from the first of REQUEST_ID_HEADERS a response has in the right form. */
export function requestIdFrom(headers: Headers): string | undefined {
  for (const name of REQUEST_ID_HEADERS) {
    const id = vendorRequestId(headers.get(name));
    if (id !== undefined) return id;
  }
  return undefined;
}

/**
 * Metadata about a failed call, for a host that counts failures: the HTTP status Corpay answered with and its
 * request id. Never the response body, Corpay's error code or message, or the input.
 */
export interface FailureMetadata {
  httpStatus: number;
  requestId?: string;
}

/** The failure metadata of an error: an answer from Corpay that failed gives its status and request id. */
export function failureMetadata(error: unknown): FailureMetadata | undefined {
  if (!(error instanceof CorpayAnswerError)) return undefined;
  const status = error.status;
  if (!Number.isInteger(status) || status < 100 || status > 599) return undefined;
  const requestId = vendorRequestId(error.requestId);
  return requestId === undefined ? { httpStatus: status } : { httpStatus: status, requestId };
}
