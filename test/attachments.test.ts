import { describe, expect, it } from 'vitest';
import { CorpayClient } from '../src/corpay/client.js';
import { extractAttachments, renderedPages, selectAttachment } from '../src/corpay/attachments.js';
import { registerCorpayTools } from '../src/tools/corpay.js';

const PINNED = 'TEAM_ALPHA';
const CDN = 'https://attachments.corpayone.com/invoices/i/t/T1/abc';
const SIGNED = '?Expires=1792747206&Signature=sig&Key-Pair-Id=K';

// Shape of a live /v3/expenses/{id} response, trimmed to what matters here.
// Pages are listed out of order on purpose.
function expense(team = PINNED, attachments: unknown[] = ATTACHMENTS) {
  return { data: { id: 'E1', owner: { team: { id: team } }, attachments } };
}
const ATTACHMENTS = [
  { id: 'orig', url: `${CDN}/original.pdf${SIGNED}`, created: '2026-10-21T11:32:53Z', isOriginal: true },
  { id: 'p2', attachmentParentId: 'orig', url: `${CDN}/rendered.p2.jpg${SIGNED}`, isOriginal: false },
  { id: 'p1', attachmentParentId: 'orig', url: `${CDN}/rendered.p1.jpg${SIGNED}`, isOriginal: false },
];

interface Call {
  url: string;
  headers: Record<string, string>;
}

function stubFetch(expensePayload: unknown, files: Record<string, { body: string; type: string }> = {}) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.includes('/connect/token')) return json({ access_token: 'token', expires_in: 3600 });
    calls.push({ url, headers: { ...(init.headers as Record<string, string>) } });
    if (url.startsWith('https://api.corpayone.com/')) return json(expensePayload);
    const file = files[new URL(url).pathname.split('/').pop() ?? ''];
    if (!file) return new Response('not found', { status: 404 });
    return new Response(file.body, { status: 200, headers: { 'content-type': file.type } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType: string; blob: string } };
type Handler = (input: Record<string, unknown>) => Promise<{ content: Content[] }>;

function attachmentTool(fetchImpl: typeof fetch): Handler {
  const handlers: Record<string, Handler> = {};
  const client = new CorpayClient({
    clientId: 'id',
    clientSecret: 'secret',
    refreshToken: 'refresh',
    env: 'production',
    teamId: PINNED,
    fetchImpl,
  });
  registerCorpayTools(
    { registerTool: (name: string, _config: unknown, handler: Handler) => (handlers[name] = handler) } as never,
    client,
  );
  return handlers.corpay_get_expense_attachment!;
}

const FILES = {
  'original.pdf': { body: '%PDF-1.7 invoice', type: 'application/pdf' },
  'rendered.p1.jpg': { body: 'page-one', type: 'image/jpeg' },
  'rendered.p2.jpg': { body: 'page-two', type: 'image/jpeg' },
};

describe('expense attachments', () => {
  it('reads the attachment list and picks the original by default', () => {
    const list = extractAttachments(expense());
    expect(list.map(a => a.id)).toEqual(['orig', 'p2', 'p1']);
    expect(selectAttachment(list).id).toBe('orig');
    expect(renderedPages(list, list[0]!).map(a => a.id)).toEqual(['p1', 'p2']);
    expect(() => selectAttachment(list, 'nope')).toThrow(/Available: orig, p2, p1/);
    expect(() => selectAttachment([])).toThrow(/no attachments/);
  });

  it('returns the original PDF as an embedded resource with a download link', async () => {
    const { impl, calls } = stubFetch(expense(), FILES);
    const result = await attachmentTool(impl)({ expenseId: 'E1' });

    const [summary, file] = result.content;
    expect(file).toMatchObject({ type: 'resource', resource: { mimeType: 'application/pdf' } });
    if (file?.type !== 'resource') throw new Error('expected a resource');
    expect(Buffer.from(file.resource.blob, 'base64').toString()).toBe('%PDF-1.7 invoice');
    expect(file.resource.uri).toBe('corpay://expenses/E1/attachments/orig/original.pdf');

    const parsed = JSON.parse((summary as { text: string }).text);
    expect(parsed.files[0]).toMatchObject({
      id: 'orig',
      fileName: 'original.pdf',
      downloadUrl: `${CDN}/original.pdf${SIGNED}`,
      downloadUrlExpiresAt: new Date(1792747206 * 1000).toISOString(),
    });
    expect(parsed.attachments).toHaveLength(3);
    // The CDN gets the signed URL and nothing else — never the API token.
    const download = calls.find(c => c.url.startsWith(CDN))!;
    expect(download.headers.Authorization).toBeUndefined();
  });

  it('returns rendered pages as images in page order', async () => {
    const { impl } = stubFetch(expense(), FILES);
    const result = await attachmentTool(impl)({ expenseId: 'E1', format: 'pages' });

    const images = result.content.filter(c => c.type === 'image');
    expect(images.map(i => Buffer.from(i.data, 'base64').toString())).toEqual(['page-one', 'page-two']);
    expect(images.every(i => i.mimeType === 'image/jpeg')).toBe(true);
  });

  it('returns an image upload itself when there are no rendered pages', async () => {
    const receipt = [{ id: 'r', url: `${CDN}/original.jpg${SIGNED}`, isOriginal: true }];
    const { impl } = stubFetch(expense(PINNED, receipt), {
      'original.jpg': { body: 'receipt', type: 'binary/octet-stream' },
    });
    const result = await attachmentTool(impl)({ expenseId: 'E1', format: 'pages' });
    expect(result.content[1]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
  });

  it('refuses an expense from another team before downloading anything', async () => {
    const { impl, calls } = stubFetch(expense('TEAM_BETA'), FILES);
    await expect(attachmentTool(impl)({ expenseId: 'E1' })).rejects.toThrow(/another team/);
    expect(calls.some(c => c.url.startsWith(CDN))).toBe(false);
  });

  it('refuses to fetch from anywhere but the Corpay attachment host', async () => {
    for (const url of [
      'https://evil.example.com/original.pdf',
      'http://attachments.corpayone.com/original.pdf',
      'https://attachments.corpayone.com:8443/original.pdf',
      'https://attachments.corpayone.com.evil.example/original.pdf',
    ]) {
      const { impl, calls } = stubFetch(expense(PINNED, [{ id: 'x', url, isOriginal: true }]), FILES);
      await expect(attachmentTool(impl)({ expenseId: 'E1' })).rejects.toThrow(/Refusing to fetch/);
      expect(calls.filter(c => !c.url.startsWith('https://api.corpayone.com/'))).toEqual([]);
    }
  });

  it('caps the size of a download', async () => {
    const huge = { body: 'x'.repeat(16 * 1024 * 1024), type: 'application/pdf' };
    const { impl } = stubFetch(expense(), { 'original.pdf': huge });
    await expect(attachmentTool(impl)({ expenseId: 'E1' })).rejects.toThrow(/limit/);
  });

  it('keeps the signature out of a failed download error', async () => {
    const { impl } = stubFetch(expense(), {});
    const error = await attachmentTool(impl)({ expenseId: 'E1' }).catch((e: Error) => e);
    expect(String(error)).toMatch(/HTTP 404/);
    expect(String(error)).not.toMatch(/Signature/);
  });
});
