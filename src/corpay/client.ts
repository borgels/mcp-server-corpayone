import { CorpayHttpError } from '../errors.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type QueryValue = string | number | boolean | null | undefined;

export interface CorpayClientOptions {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  teamId?: string;
  env?: 'staging' | 'production';
  apiBaseUrl?: string;
  identityBaseUrl?: string;
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
  /** Set false to omit the default teamId query parameter. */
  withTeamId?: boolean;
}

const HOSTS = {
  staging: {
    api: 'https://api.staging.corpayone.com/external',
    identity: 'https://identity.staging.corpayone.com',
  },
  production: {
    api: 'https://api.corpayone.com/external',
    identity: 'https://identity.corpayone.com',
  },
} as const;

/**
 * Corpay One API client.
 *
 * Auth is OAuth 2.0 (authorization_code + refresh_token). Credentials are read
 * only from the server environment, never tool arguments. Access tokens are
 * short-lived (~1h) and refreshed automatically using the stored refresh token.
 */
export class CorpayClient {
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly refreshToken?: string;
  private readonly teamId?: string;
  private readonly apiBaseUrl: string;
  private readonly identityBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  private accessToken?: string;
  private accessTokenExpiresAt = 0;

  constructor(options: CorpayClientOptions = {}) {
    const env = options.env ?? (process.env.CORPAYONE_ENV === 'production' ? 'production' : 'staging');
    this.clientId = options.clientId ?? process.env.CORPAYONE_CLIENT_ID;
    this.clientSecret = options.clientSecret ?? process.env.CORPAYONE_CLIENT_SECRET;
    this.refreshToken = options.refreshToken ?? process.env.CORPAYONE_REFRESH_TOKEN;
    this.teamId = options.teamId ?? process.env.CORPAYONE_TEAM_ID;
    this.apiBaseUrl = trimTrailingSlash(
      options.apiBaseUrl ?? process.env.CORPAYONE_API_BASE_URL ?? HOSTS[env].api,
    );
    this.identityBaseUrl = trimTrailingSlash(
      options.identityBaseUrl ?? process.env.CORPAYONE_IDENTITY_BASE_URL ?? HOSTS[env].identity,
    );
    assertSafeBaseUrl(this.apiBaseUrl, 'CORPAYONE_API_BASE_URL');
    assertSafeBaseUrl(this.identityBaseUrl, 'CORPAYONE_IDENTITY_BASE_URL');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.CORPAYONE_TIMEOUT_MS ?? 30_000);
  }

  /** Exchange the refresh token for a fresh access token (cached until expiry). */
  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now < this.accessTokenExpiresAt - 60_000) {
      return this.accessToken;
    }
    if (!this.clientId || !this.clientSecret || !this.refreshToken) {
      throw new Error(
        'Missing Corpay One OAuth credentials. Set CORPAYONE_CLIENT_ID, CORPAYONE_CLIENT_SECRET, and CORPAYONE_REFRESH_TOKEN in the server environment (run `npm run auth:grant`).',
      );
    }
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const response = await this.fetchImpl(`${this.identityBaseUrl}/connect/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        refresh_token: this.refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const payload = (await readResponseBody(response)) as
      | { access_token?: string; expires_in?: number }
      | string
      | null;
    if (!response.ok || typeof payload !== 'object' || payload === null || !payload.access_token) {
      throw new CorpayHttpError({
        status: response.status,
        method: 'POST',
        url: `${this.identityBaseUrl}/connect/token`,
        payload,
        fallbackMessage: 'token refresh failed',
      });
    }
    this.accessToken = payload.access_token;
    this.accessTokenExpiresAt = now + (payload.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  async request<T>(options: CorpayRequestOptions): Promise<T> {
    const method = options.method ?? 'GET';
    const token = await this.getAccessToken();

    const query = { ...options.query };
    if ((options.withTeamId ?? true) && this.teamId && query.teamId === undefined) {
      query.teamId = this.teamId;
    }
    const url = appendQuery(
      options.url ?? `${this.apiBaseUrl}${normalizePath(options.path ?? '/')}`,
      query,
    );

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    };
    // Default to JSON, but respect a caller-provided Content-Type (e.g.
    // application/json-patch+json for RFC 6902 expense updates).
    if (options.body !== undefined && !headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

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
