import { CorpayHttpError } from '../errors.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type QueryValue = string | number | boolean | null | undefined;

export interface CorpayClientOptions {
  apiToken?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface CorpayRequestOptions {
  method?: HttpMethod;
  path?: string;
  url?: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
  idempotencyKey?: string;
}

const DEFAULT_BASE_URL = 'https://api.corpayone.com';

/**
 * Minimal Corpay One HTTP client.
 *
 * Credentials are read only from the server environment (never tool arguments).
 * The exact auth header is confirmed during connector bring-up; Corpay One uses
 * a bearer API token by default (`Authorization: Bearer <token>`).
 */
export class CorpayClient {
  private readonly apiToken?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: CorpayClientOptions = {}) {
    this.apiToken = options.apiToken ?? process.env.CORPAYONE_API_TOKEN;
    this.baseUrl = trimTrailingSlash(
      options.baseUrl ?? process.env.CORPAYONE_BASE_URL ?? DEFAULT_BASE_URL,
    );
    assertSafeBaseUrl(this.baseUrl, 'CORPAYONE_BASE_URL');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.CORPAYONE_TIMEOUT_MS ?? 30_000);
  }

  async request<T>(options: CorpayRequestOptions): Promise<T> {
    this.assertConfigured();
    const method = options.method ?? 'GET';
    const url = appendQuery(
      options.url ?? `${this.baseUrl}${normalizePath(options.path ?? '/')}`,
      options.query,
    );

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.apiToken ?? ''}`,
      ...options.headers,
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (options.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }

    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const payload = await readResponseBody(response);
    if (!response.ok) {
      throw new CorpayHttpError({
        status: response.status,
        method,
        url,
        payload,
        retryAfter: response.headers.get('retry-after') ?? undefined,
        fallbackMessage: typeof payload === 'string' ? payload : undefined,
      });
    }
    return payload as T;
  }

  private assertConfigured(): void {
    if (!this.apiToken) {
      throw new Error(
        'Missing Corpay One credentials. Set CORPAYONE_API_TOKEN in the MCP server environment.',
      );
    }
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function appendQuery(urlValue: string, query?: Record<string, QueryValue>): string {
  const url = new URL(urlValue);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function normalizePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function assertSafeBaseUrl(baseUrl: string, envName: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`${envName} is not a valid URL: ${baseUrl}`);
  }
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol === 'http:' && isLocalHost(parsed.hostname)) return;
  throw new Error(
    `Refusing to send Corpay One credentials over ${parsed.protocol}//. Use https:// (loopback http:// is allowed for local mocks).`,
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
