import { randomUUID } from 'node:crypto';
import { fixedOutputs } from '../fallbacks.js';
import { SecretRedactor } from '../gateway-redactor.js';
import { leaksSecret } from '../key-admission.js';
import { CorpayAnswerError, requestIdFrom } from './gateway-errors.js';

/**
 * The client of the embedded gateway (src/gateway.ts). Unlike CorpayClient
 * (the MCP server's), it reads no CORPAYONE_* variable: the app (client id
 * and secret), the company's refresh token, the team and the time limit come
 * from the host only; the addresses are fixed per environment; every secret
 * goes to the instance's redactor; redirects are never followed; the body of
 * an error answer is never read; and an answer that is not JSON is refused.
 *
 * Corpay One's identity service may hand out a new refresh token each time
 * the access is renewed. The client then uses the new one at once and gives
 * it to the host (`onRefreshToken`) before it sends anything else, so a host
 * that stores tokens never keeps one Corpay no longer accepts.
 */

export type CorpayEnvironment = 'production' | 'staging';

/** The only addresses an embedded client talks to. */
export const CORPAY_ORIGINS: Readonly<Record<CorpayEnvironment, { api: string; identity: string }>> = Object.freeze({
  production: Object.freeze({ api: 'https://api.corpayone.com', identity: 'https://identity.corpayone.com' }),
  staging: Object.freeze({ api: 'https://api.staging.corpayone.com', identity: 'https://identity.staging.corpayone.com' }),
});

/** Every API path is under this prefix on the API origin. */
const API_PREFIX = '/external';
const TOKEN_PATH = '/connect/token';

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_TIMEOUT_MS = 30_000;

export type GatewayQueryValue = string | number | boolean | null | undefined;
export type GatewayWriteMethod = 'POST' | 'PUT' | 'PATCH';

/** Our own guidance per HTTP status. */
const STATUS_HINTS: Record<number, string> = {
  400: 'Corpay One refused the values. Check the ids and values.',
  401: 'Corpay One refused the access (expired or revoked). Retrying will not help.',
  403: 'The access does not cover this, or the app lacks the scope for it. Retrying will not help.',
  404: 'Corpay One found nothing with this id. Check the ids.',
  409: 'Corpay One refused the change in the current state of the expense.',
  422: 'Corpay One refused the values. Check the ids and values.',
  429: 'Corpay One is throttling requests. Wait and retry later.',
};

/** System error codes a network error may name: a fixed list, so no other text from a cause is ever shown. */
const SHOWN_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** An HTTP error from the Corpay One API in our own words: the status, our hint and a retry-after; never its body. */
export class CorpayGatewayHttpError extends CorpayAnswerError {
  constructor(status: number, method: string, retryAfter?: string, requestId?: string) {
    const hint = Object.hasOwn(STATUS_HINTS, status) ? ` ${STATUS_HINTS[status]}` : '';
    const wait = retryAfter ? ` Retry after ${retryAfter} seconds.` : '';
    super(`Corpay One API request failed with HTTP ${status} (${method}).${hint}${wait}`, status, requestId);
    this.name = 'CorpayGatewayHttpError';
  }
}

/** The identity service refused to renew the access: the refresh token or the app is no longer accepted. */
export class CorpayAccessRefusedError extends CorpayAnswerError {
  constructor(status: number, requestId?: string) {
    super(`Corpay One refused the app's access (HTTP ${status}) when renewing it. Retrying will not help; give access again.`, status, requestId);
    this.name = 'CorpayAccessRefusedError';
  }
}

export interface CorpayGatewayClientOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  environment: CorpayEnvironment;
  redactor: SecretRedactor;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onRefreshToken?: (refreshToken: string) => void | Promise<void>;
  /** What the gateway shows as it is, besides the fixed outputs (its tool list): an issued token may share no piece with it. */
  exposed?: unknown;
}

export class CorpayGatewayClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private refreshToken: string;
  private readonly origins: { api: string; identity: string };
  private readonly redactor: SecretRedactor;
  private readonly exposed: unknown;
  private readonly fetchImpl: typeof fetch;
  private readonly onRefreshToken?: (refreshToken: string) => void | Promise<void>;
  private access?: { token: string; expiresAt: number };
  private pending?: Promise<string>;
  /** Set when a renewed token could not be kept, or cannot be kept safely: nothing more is sent from this client. */
  private stopped = false;
  readonly timeoutMs: number;

  constructor(options: CorpayGatewayClientOptions) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.refreshToken = options.refreshToken;
    this.origins = CORPAY_ORIGINS[options.environment];
    this.redactor = options.redactor;
    this.redactor.addSecret(this.clientSecret).addSecret(this.refreshToken).addSecret(basicCredentials(this.clientId, this.clientSecret));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onRefreshToken = options.onRefreshToken;
    this.exposed = options.exposed;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > MAX_TIMEOUT_MS) {
      throw new Error(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
    }
  }

  get<T>(path: string, query?: Record<string, GatewayQueryValue>): Promise<T> {
    return this.request<T>('GET', path, query);
  }

  send<T>(method: GatewayWriteMethod, path: string, body?: unknown, contentType = 'application/json'): Promise<T> {
    return this.request<T>(method, path, undefined, body, contentType);
  }

  /** A valid access token: renewed with the refresh token when needed, one renewal at a time. */
  accessToken(): Promise<string> {
    if (this.stopped) return Promise.reject(new Error(STOPPED));
    if (this.access && Date.now() < this.access.expiresAt - 60_000) return Promise.resolve(this.access.token);
    this.pending ??= this.renew().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  /** The URL of a versioned API path on the fixed address. */
  buildUrl(path: string, query?: Record<string, GatewayQueryValue>): string {
    if (!/^\/v[123]\/[A-Za-z0-9/_.~%-]+$/.test(path) || /(^|\/)\.\.?(\/|$)/.test(path)) {
      throw new Error('Refusing to call a path outside the Corpay One API.');
    }
    const url = new URL(`${this.origins.api}${API_PREFIX}${path}`);
    if (url.origin !== this.origins.api || url.pathname !== `${API_PREFIX}${path}`) {
      throw new Error('Refusing to call a path outside the Corpay One API.');
    }
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * Registers a token Corpay One issued with the instance's redactor. A token that shares a piece with one of the fixed
   * outputs (src/fallbacks.ts) could not be kept out of them, so the client stops instead of using it.
   */
  private admitIssued(token: string): void {
    // Checked on its own first: a token that collides is never registered, so no output is withheld over it either.
    const alone = new SecretRedactor().addSecret(token);
    if (leaksSecret(fixedOutputs(), alone) || (this.exposed !== undefined && leaksSecret(this.exposed, alone))) {
      this.stopped = true;
      throw new Error(UNSAFE_TOKEN);
    }
    this.redactor.addSecret(token);
  }

  private async renew(): Promise<string> {
    const url = `${this.origins.identity}${TOKEN_PATH}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicCredentials(this.clientId, this.clientSecret)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.refreshToken }).toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw this.transportError('POST', error);
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      await discard(response);
      throw new CorpayAnswerError(
        `Corpay One's identity service responded with a redirect (HTTP ${response.status}); redirects are not followed.`,
        response.status,
        requestIdFrom(response.headers),
      );
    }
    if (response.status === 400 || response.status === 401) {
      // invalid_grant or invalid_client: the token or the app is no longer accepted. The body is never read.
      await discard(response);
      throw new CorpayAccessRefusedError(response.status, requestIdFrom(response.headers));
    }
    if (!response.ok) {
      await discard(response);
      throw new CorpayGatewayHttpError(response.status, 'POST', wholeNumber(response.headers.get('retry-after')), requestIdFrom(response.headers));
    }
    const answer = (await this.readJson(response, 'POST')) as { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown } | null;
    const next = answer?.refresh_token;
    if (next !== undefined && next !== null && next !== this.refreshToken) {
      // A new token may already have retired the old one: if it cannot be kept as it came, nothing more is sent.
      if (typeof next !== 'string' || !/^[\x21-\x7e]{16,8192}$/.test(next)) {
        this.stopped = true;
        throw new Error(NOT_KEPT);
      }
      this.admitIssued(next);
      // Corpay One may already have retired the old token. Until the host has kept the new one, nothing else is sent;
      // if it cannot, this client sends nothing more at all (a new instance starts from what the host has kept).
      this.refreshToken = next;
      // Without a host to keep it, the new token would be lost with this instance: nothing more is sent.
      if (!this.onRefreshToken) {
        this.stopped = true;
        throw new Error(NOT_KEPT);
      }
      try {
        await this.onRefreshToken(next);
      } catch {
        this.stopped = true;
        throw new Error(NOT_KEPT);
      }
    }
    // The access token is looked at only after a new refresh token has been kept: a bad access token never loses it.
    const token = answer?.access_token;
    if (typeof token !== 'string' || !/^[\x21-\x7e]{16,8192}$/.test(token)) {
      throw new Error("Corpay One's identity service answered without a usable access token; nothing of it is passed on.");
    }
    this.admitIssued(token);
    const seconds = typeof answer?.expires_in === 'number' && answer.expires_in > 0 ? Math.min(answer.expires_in, 86_400) : 3600;
    this.access = { token, expiresAt: Date.now() + seconds * 1000 };
    return token;
  }

  private async request<T>(
    method: 'GET' | GatewayWriteMethod,
    path: string,
    query?: Record<string, GatewayQueryValue>,
    body?: unknown,
    contentType = 'application/json',
  ): Promise<T> {
    if (this.stopped) throw new Error(STOPPED);
    const url = this.buildUrl(path, query);
    const token = await this.accessToken();
    const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${token}` };
    if (method !== 'GET') headers['Idempotency-Key'] = randomUUID();
    const init: RequestInit = { method, headers, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) };
    if (body !== undefined) {
      headers['Content-Type'] = contentType;
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      throw this.transportError(method, error);
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      await discard(response);
      throw new CorpayAnswerError(
        `Corpay One API responded with a redirect (HTTP ${response.status}) for ${method}; redirects are not followed.`,
        response.status,
        requestIdFrom(response.headers),
      );
    }
    if (!response.ok) {
      await discard(response);
      throw new CorpayGatewayHttpError(response.status, method, wholeNumber(response.headers.get('retry-after')), requestIdFrom(response.headers));
    }
    return (await this.readJson(response, method)) as T;
  }

  private async readJson(response: Response, method: string): Promise<unknown> {
    let read: { bytes: Uint8Array; exceeded: boolean };
    try {
      read = await readUpTo(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      throw this.transportError(method, error);
    }
    if (read.exceeded) throw new Error(`The Corpay One answer exceeds the ${MAX_RESPONSE_BYTES} byte limit (${method}).`);
    const text = new TextDecoder().decode(read.bytes);
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Corpay One answered with something that is not JSON (${method}); nothing of it is passed on.`);
    }
  }

  /** A network failure or timeout in our own words: no cause text, only a code from a fixed list. */
  private transportError(method: string, error: unknown): Error {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return Object.assign(new Error(`Corpay One request timed out after ${this.timeoutMs} ms (${method}).`), { name: 'TimeoutError' });
    }
    const shown = causeCodes(error).find(code => SHOWN_NETWORK_CODES.has(code));
    return new Error(`Network error calling Corpay One (${method})${shown ? ` (${shown})` : ''}.`);
  }
}

const NOT_KEPT = 'The renewed refresh token could not be kept by the host; nothing more is sent to Corpay One from this instance.';
const UNSAFE_TOKEN = "Corpay One issued a token that cannot be kept apart from this server's own texts; nothing more is sent from this instance. Try again.";
const STOPPED = 'Nothing more is sent to Corpay One from this instance: a renewed token could not be kept. Create a new instance from the kept token.';

/** The Basic credentials made from the app's id and secret; a secret itself. */
export function basicCredentials(clientId: string, clientSecret: string): string {
  return Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore
  }
}

function causeCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') codes.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}

function wholeNumber(value: string | null): string | undefined {
  return value !== null && /^\d{1,9}$/.test(value.trim()) ? value.trim() : undefined;
}

async function readUpTo(response: Response, limit: number): Promise<{ bytes: Uint8Array; exceeded: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(0), exceeded: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > limit) {
      exceeded = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, exceeded };
}
