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
  const match = /t=(.*?);v1=(.*)/i.exec(signatureHeader);
  if (!match || !match[1] || !match[2]) return false;
  const timestamp = Number(match[1]);
  if (!Number.isFinite(timestamp)) return false;
  const provided = match[2].toLowerCase();
  const expected = createHmac('sha512', webhookSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
