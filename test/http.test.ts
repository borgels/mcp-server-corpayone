import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  assertAuthorized,
  getHttpConfig,
  HttpRequestError,
  isOriginAllowed,
  readJsonBody,
} from '../src/transports/http-helpers.js';

const TOKEN = 's'.repeat(32);

function body(chunks: string[]): never {
  return Object.assign(Readable.from(chunks), { headers: {} }) as never;
}

describe('HTTP transport hardening', () => {
  it('binds to loopback and uses a 10 MiB request limit by default', () => {
    expect(getHttpConfig({})).toMatchObject({
      host: '127.0.0.1',
      maxBodyBytes: 10_485_760,
    });
  });

  it('allows loopback origins by default and supports explicit origin allowlists', () => {
    expect(isOriginAllowed('http://localhost:5173', {})).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:3000', {})).toBe(true);
    expect(isOriginAllowed('https://evil.example', {})).toBe(false);

    const config = getHttpConfig({ MCP_ALLOWED_ORIGINS: 'https://app.example' });
    expect(isOriginAllowed('https://app.example', config)).toBe(true);
    expect(isOriginAllowed('http://localhost:5173', config)).toBe(false);
  });

  it('requires the HTTP token when configured', () => {
    const config = getHttpConfig({ MCP_HTTP_TOKEN: TOKEN });
    expect(() => assertAuthorized({ headers: {} } as never, config)).toThrow(HttpRequestError);
    expect(() =>
      assertAuthorized({ headers: { authorization: `Bearer ${TOKEN}` } } as never, config),
    ).not.toThrow();
  });

  it('rejects oversized JSON request bodies', async () => {
    await expect(readJsonBody(body(['{"ok":true}']), 4)).rejects.toMatchObject({
      status: 413,
    });
  });

  it('rejects invalid JSON with 400', async () => {
    await expect(readJsonBody(body(['{nope']), 1024)).rejects.toMatchObject({
      status: 400,
    });
  });
});
