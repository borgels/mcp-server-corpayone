import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Helpers for the one-time OAuth capture (`npm run auth:grant`): a CSRF
 * `state` value and an RFC 7636 PKCE pair (S256).
 */
export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

export function createState(): string {
  return randomBytes(32).toString('base64url');
}

export function createPkcePair(): PkcePair {
  // 32 random bytes -> 43 base64url chars, within RFC 7636's 43..128.
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier), method: 'S256' };
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function buildAuthorizeUrl(input: {
  identityBase: string;
  clientId: string;
  scope: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  return (
    `${input.identityBase}/connect/authorize?` +
    new URLSearchParams({
      client_id: input.clientId,
      scope: input.scope,
      response_type: 'code',
      redirect_uri: input.redirectUri,
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    }).toString()
  );
}

/** Constant-time check of the `state` returned on the redirect. */
export function stateMatches(expected: string, received: string | null | undefined): boolean {
  if (typeof received !== 'string' || received.length === 0) return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(received).digest();
  return timingSafeEqual(a, b);
}
