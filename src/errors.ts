import type { HttpMethod } from './corpay/client.js';

export interface CorpayHttpErrorInit {
  status: number;
  method: HttpMethod;
  url: string;
  payload?: unknown;
  retryAfter?: string;
  fallbackMessage?: string;
}

/** Error for non-2xx responses from the Corpay One API, with redaction-friendly fields. */
export class CorpayHttpError extends Error {
  readonly status: number;
  readonly method: HttpMethod;
  readonly url: string;
  readonly payload: unknown;
  readonly retryAfter?: string;

  constructor(init: CorpayHttpErrorInit) {
    const summary =
      typeof init.payload === 'object' && init.payload !== null
        ? JSON.stringify(init.payload)
        : (init.fallbackMessage ?? '');
    super(
      `Corpay One API request failed with HTTP ${init.status}` +
        ` | ${init.method} ${redactUrl(init.url)}` +
        (summary ? ` | ${summary}` : ''),
    );
    this.name = 'CorpayHttpError';
    this.status = init.status;
    this.method = init.method;
    this.url = redactUrl(init.url);
    this.payload = init.payload;
    this.retryAfter = init.retryAfter;
  }
}

/** Strip query strings so tokens passed as query params never reach logs. */
export function redactUrl(urlValue: string): string {
  try {
    const url = new URL(urlValue);
    return `${url.origin}${url.pathname}`;
  } catch {
    return urlValue.split('?')[0] ?? urlValue;
  }
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof CorpayHttpError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
