#!/usr/bin/env node
/**
 * One-time Corpay One OAuth token capture.
 *
 * Prints the authorize URL, listens on the registered redirect URI, captures the
 * authorization code, exchanges it for access + refresh tokens, and prints the
 * refresh token to store as CORPAYONE_REFRESH_TOKEN. Run: `npm run auth:grant`.
 *
 * Requires in the environment: CORPAYONE_CLIENT_ID, CORPAYONE_CLIENT_SECRET,
 * CORPAYONE_REDIRECT_URI, and CORPAYONE_ENV (staging|production).
 */
import { createServer } from 'node:http';

const env = process.env.CORPAYONE_ENV === 'production' ? 'production' : 'staging';
const identityBase =
  process.env.CORPAYONE_IDENTITY_BASE_URL ??
  (env === 'production'
    ? 'https://identity.corpayone.com'
    : 'https://identity.staging.corpayone.com');
const clientId = process.env.CORPAYONE_CLIENT_ID;
const clientSecret = process.env.CORPAYONE_CLIENT_SECRET;
const redirectUri = process.env.CORPAYONE_REDIRECT_URI ?? 'http://localhost:53682/corpayone/callback';
const scope = 'expenses.all webhooks.all offline_access';

if (!clientId || !clientSecret) {
  console.error('Set CORPAYONE_CLIENT_ID and CORPAYONE_CLIENT_SECRET first.');
  process.exit(1);
}

const authorizeUrl =
  `${identityBase}/connect/authorize?` +
  new URLSearchParams({
    client_id: clientId,
    scope,
    response_type: 'code',
    redirect_uri: redirectUri,
  }).toString();

const redirect = new URL(redirectUri);
const port = Number(redirect.port || 80);

async function exchange(code: string): Promise<void> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch(`${identityBase}/connect/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      scope,
      redirect_uri: redirectUri,
    }).toString(),
  });
  const data = (await response.json()) as { refresh_token?: string; access_token?: string };
  if (!response.ok || !data.refresh_token) {
    console.error('Token exchange failed:', response.status, JSON.stringify(data));
    process.exit(1);
  }
  console.log('\nStore this in your environment:\n');
  console.log(`CORPAYONE_REFRESH_TOKEN=${data.refresh_token}\n`);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (url.pathname !== redirect.pathname) {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get('code');
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(code ? 'Authorization captured. You can close this tab.' : 'No authorization code.');
  if (code) {
    exchange(code)
      .catch(error => console.error(error))
      .finally(() => server.close(() => process.exit(0)));
  }
});

server.listen(port, () => {
  console.log('Open this URL, log in, and approve access:\n');
  console.log(authorizeUrl);
  console.log(`\nListening for the redirect on ${redirectUri} ...`);
});
