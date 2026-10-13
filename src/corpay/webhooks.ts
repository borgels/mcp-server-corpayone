import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Validate a Corpay One webhook signature.
 *
 * Corpay sends the signature in the `X-Roger-Signature` header in the form
 * `t=<epochSeconds>;v1=<hex>`, where the hex is HMAC-SHA512 of `<t>.<rawBody>`
 * keyed by the app's webhook secret. Pass the raw (unparsed) request body.
 */
export function validateWebhookSignature(
  signatureHeader: string,
  rawBody: string,
  webhookSecret: string,
): boolean {
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return false;
  const timestamp = Number(parsed.t);
  if (!Number.isFinite(timestamp)) return false;
  const provided = parsed.v1.toLowerCase();
  if (!/^[0-9a-f]+$/.test(provided)) return false;
  const expected = createHmac('sha512', webhookSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

/**
 * Split `t=<epochSeconds>;v1=<hex>` without a backtracking regex. Parts are
 * `;`-separated `key=value` pairs; keys are matched case-insensitively.
 */
function parseSignatureHeader(header: string): { t: string; v1: string } | undefined {
  if (typeof header !== 'string' || header.length > 4096) return undefined;
  let t: string | undefined;
  let v1: string | undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (key === 't' && t === undefined) t = value;
    else if (key === 'v1' && v1 === undefined) v1 = value;
  }
  return t && v1 ? { t, v1 } : undefined;
}
