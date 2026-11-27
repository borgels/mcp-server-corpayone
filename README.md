# mcp-server-corpayone

An MCP server for the [Corpay One](https://www.corpayone.com/) accounts-payable
API: read bills and receipts, code them, manage the coding vocabulary, and — when
explicitly enabled — approve or decline them.

Reads work out of the box. Every write is refused unless the server is
configured to allow it, and each one goes through a prepare/commit ceremony so a
change is reviewed before it happens.

This is an independent, unofficial project. It is not developed, endorsed or supported by Corpay.

## What it can do

**Read** — expenses (bills, receipts, credit notes) with their state, vendor,
amounts, attachments and coding; the attachment files themselves; the activity
log and approver list for an expense; the coding vocabulary (categories, label lists and labels); vendors;
webhook subscriptions. With broader scopes also credit accounts and card
transactions, payment methods, team members, departments and items — see below.

**Write** — code an expense (category and labels, set atomically); split an
expense into coded amount lines; create vendors and set their external ids;
maintain categories and label lists; manage webhook subscriptions.

**Approve** — approve or decline an expense awaiting approval. Gated separately;
see below.

Start with `corpay_search_capabilities` to discover the tools and the
allowlisted endpoints.

## Two things that will bite you

**Amounts are in minor units.** An amount of `930000` is 9,300.00 DKK. This
applies to everything the API returns and everything you send it.

**Coding uses Corpay's internal ids, not accounting numbers.** A category has
both an `id` and a `number`; the write takes the `id`, while the number is what
a bookkeeper recognises. Always resolve ids with `corpay_list_coding_options`
before coding, and match on the number or name found there.

## Configuration

Copy `.env.example` and fill it in. Credentials are read from the environment
only — never from tool arguments.

```
CORPAYONE_CLIENT_ID=...
CORPAYONE_CLIENT_SECRET=...
CORPAYONE_REFRESH_TOKEN=...
CORPAYONE_ENV=production
```

Create an app at `https://app.corpayone.com/developers`, then run the grant once
to capture a refresh token:

```bash
npm run auth:grant
```

### What the grant can reach

A standard Corpay app registration can obtain exactly these scopes, and
`auth:grant` requests them: `expenses.all`, `teams.all`,
`teams.categories.all`, `teams.lists.all`, `teams.vendors.all`,
`webhooks.all`, `offline_access`.

Some endpoints need more than that, and it is not obtainable self-service:
asking for such a scope makes the authorize call fail outright, and adding it
to the app in the developer portal is not enough either — verified against the
live service, `identity.corpayone.com` keeps its own client allowlist and still
refuses it. Enabling those needs Corpay support.

**So the server does not offer tools that cannot work.** With a standard grant
these are simply absent, rather than present and failing:

| Needs scope | Hidden tools / fields |
|---|---|
| `cardtransactions.all` | `corpay_list_credit_accounts`, `corpay_list_card_transactions`, `corpay_prepare_card_transaction_coding` |
| `payments.all` | `corpay_list_payment_methods` |
| `teams.members.list` | `corpay_list_team_members` |
| `departments.all` | departments in `corpay_list_coding_options`, `departmentIds` on coding |
| `items.read` / `items.write` | items in `corpay_list_coding_options`, item fields on amount lines |

If Corpay grants more, list the scopes in `CORPAYONE_SCOPE` and the matching
tools appear — the gate is configuration, not a code change.

Everything central to accounts payable works on a standard grant: expenses and
their full detail, activity log, **approvers**, categories, label lists and
labels, vendors, webhooks, coding, and approvals. The scope map is measured
against the live API rather than inferred from the OpenAPI documents, because
the real behaviour does not follow the obvious pattern — `teams.all` covers
`/teams/{id}/modules` but not `/teams/{id}/departments` or `/members`, and
`expenses.all` covers `/expenses/{id}/approvers`. Re-run `npm run smoke:live`
after changing a grant; it skips what the grant cannot reach instead of
reporting it as a failure.

### Scoping the server to one company

One Corpay grant reaches **every team the user belongs to**, and the team is
chosen per request. If you run one instance per company, set:

```
CORPAYONE_TEAM_ID=<team id>
```

The team then becomes a hard boundary: it is injected into every path, query and
body, and a request naming a different team is rejected rather than quietly
redirected. Without it, callers choose the team themselves — appropriate when
the grant belongs to the person using it, but not when several people share one
endpoint.

Endpoints that address a resource by id alone (`/v3/expenses/{id}`,
`/v2/expenses/{id}/…`, `/v1/webhooks/{id}`) are checked too: on a pinned
server the resource is read first and its team compared with
`CORPAYONE_TEAM_ID`, both when preparing and again when committing. If the
team of a resource cannot be determined the call is refused.

Find team ids with `corpay_list_teams`.

### Write policy

Writes are off by default and are enabled in two independent steps:

```
CORPAYONE_ENABLE_WRITES=true      # coding, vendors, lists, webhooks
CORPAYONE_ENABLE_APPROVALS=true   # approve / decline an expense
```

Approval is separate because approving a bill releases it for payment. A server
can be allowed to code all day without ever being able to approve anything.

Some endpoints are refused regardless: creating or deleting teams, managing
members, and payment methods. Deleting a category, department, list or webhook
is classified dangerous and is likewise refused. `CORPAYONE_POLICY_PATH` can
point at a JSON file to narrow the policy further (or, deliberately, to widen
it) — including `maxAmount`, compared in minor units.

Set `CORPAYONE_AUDIT_LOG` to a file path to record one JSON line per write
attempt. Idempotency keys are hashed rather than stored.

### Preparing and committing

No write tool sends anything. Each `corpay_prepare_*` tool validates the change
against the allowlist and the policy and returns it with an `operationHash`.
Pass that operation back to `corpay_commit_prepared_operation` — unchanged, with
the hash restated and an `idempotencyKey` — to execute it. Editing the payload
in between invalidates the hash.

The `operationHash` is an HMAC-SHA256 keyed by `CORPAYONE_PREPARE_SECRET`
(a random per-process key when unset — set it when running several replicas,
or when a prepare must survive a restart). A prepared operation expires after
15 minutes, and each prepare tool can only target its own endpoints, which is
re-checked at commit.

Approvals are committed with `corpay_commit_expense_approval` instead; the two
commit tools will not accept each other's operations.

`corpay_prepare_expense_coding` reads the expense first and reports its current
coding alongside the proposed change, so the difference is visible before
anything is committed.

## Running it

```bash
npm install
npm run build

npm run dev        # stdio, for a desktop MCP client
npm run dev:http   # Streamable HTTP on 127.0.0.1:3000/mcp
```

A container image is published to
`ghcr.io/borgels/mcp-server-corpayone`. It runs the HTTP transport:

```bash
docker run --rm -p 3000:3000 --env-file corpayone.env \
  ghcr.io/borgels/mcp-server-corpayone:latest
```

The container binds `0.0.0.0`, so it needs `MCP_HTTP_TOKEN` (at least 32
characters); callers send it as `Authorization: Bearer <token>`. The token is
compared in constant time. If any `*_TRUST_FORWARDED_USER` variable is `true`,
the HTTP transport also refuses to start without `MCP_HTTP_TOKEN` on loopback.

### HTTP transport settings

The HTTP transport serves `POST /mcp` (stateless Streamable HTTP) and an
unauthenticated `GET /healthz`. It binds to `127.0.0.1` unless told otherwise.

| Variable | Default | Meaning |
|---|---|---|
| `MCP_HTTP_HOST` / `HOST` | `127.0.0.1` | Bind address. |
| `PORT` | `3000` | Listen port (1-65535). |
| `MCP_HTTP_TOKEN` | – | Bearer token for `/mcp`: at least 32 printable ASCII characters, e.g. `openssl rand -hex 32`. **Required** on a non-loopback bind and with `MCP_ALLOW_ANY_ORIGIN=true`; the server refuses to start otherwise. |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Start without a token where one would be required. Only for setups where access is restricted by other means; logs a warning. |
| `MCP_ALLOWED_ORIGINS` | – | Comma-separated browser origins allowed to call `/mcp`. Default: localhost origins. Requests without an `Origin` header (server-to-server) are not affected. |
| `MCP_ALLOW_ANY_ORIGIN` | `false` | Allow any browser origin. Requires `MCP_HTTP_TOKEN`. |
| `MCP_ALLOWED_HOSTS` | – | Comma-separated host names accepted in the `Host` header. Default: on a loopback bind only `localhost`, `127.0.0.1`, `[::1]` and the bind address; no check on other binds. |
| `MCP_MAX_BODY_BYTES` | `10485760` | Request body limit; larger requests get 413. |
| `MCP_AUTH_FAILURE_LIMIT` | `20` | Failed authentication attempts per client address within the window before further failures get 429. `0` disables. Requests with a valid token are never throttled. |
| `MCP_AUTH_FAILURE_WINDOW_MS` | `60000` | Window for `MCP_AUTH_FAILURE_LIMIT`. |

Invalid values (a non-numeric `PORT`, a misspelt boolean) stop the server at
startup with a message naming the variable. Rejected requests get a JSON error
(401 with `WWW-Authenticate: Bearer`, 400 for invalid JSON, 413 for oversized
bodies) and one log line on stderr. The server shuts down gracefully on
SIGTERM/SIGINT.

## Security model

- The server acts with one shared Corpay One identity: the credentials in its
  environment. Everyone who can call it acts with the same rights.
- `MCP_HTTP_TOKEN` decides who may call the server at all. It does not tell
  users apart. Per-user authorization belongs in an identity-aware gateway in
  front of the server.
- Tool access is not data access. Disabling or hiding tools limits what a
  client can call, but the upstream credentials decide what data the server can
  reach. Scope those credentials as narrowly as the use case allows.
- The HTTP server does not terminate TLS. Run it behind a reverse proxy that
  does, or keep it on a private network.

## Verifying a deployment

```bash
npm run typecheck && npm test        # offline
CORPAYONE_TEAM_ID=<team> npm run smoke:live   # read-only, hits the real API
```

The live smoke test also asserts that a cross-team read is refused, so it
doubles as a check that the boundary is actually in force.

## Embedding (`./gateway`)

`mcp-server-corpayone/gateway` is for hosts that serve several companies from
one process and do their own per-user authorization. One instance per
company (Corpay One team):

```ts
import { createCorpayGateway, corpayToolCatalog } from 'mcp-server-corpayone/gateway';

const gateway = createCorpayGateway({
  clientId, clientSecret,        // the host's app at app.corpayone.com/developers
  refreshToken, teamId,          // from the company's consent
  onRefreshToken: token => save(token),
  policy: { enableWrites: true },
});
await gateway.callTool('list_expenses', { state: 'Awaiting' }, { caller: 'user-1' });
```

- Reads no `CORPAYONE_*` variable; the addresses are fixed (production by
  default, `environment: 'staging'` for Corpay's test service).
- The team is a hard boundary; an expense addressed by id is refused unless it
  belongs to the team.
- A renewed refresh token is handed to `onRefreshToken` before anything else is
  sent. Without `onRefreshToken`, or when it fails, the instance stops and
  sends nothing more: a token the host has not kept would be lost.
- `corpayToolCatalog` lists every tool with its risk level, the requests it may
  make and `requiresConfirmation` (only `approve_expense`: approving releases
  the bill for payment).
- Changes run directly when the policy enables writes. There is no
  prepare/commit step in the gateway: the host decides who may change what.
- Answers are typed: each tool passes on only the fields of its answer type
  (`src/corpay/gateway-answers.ts`), each checked for its kind (id, code,
  text, date, number, true/false). No bank or card field is in any list, and
  no link is passed on: attachment and website fields are not listed, and a
  link in a free text is replaced by `[link removed]`. Free text is also
  scrubbed of bank and card numbers, as an extra guard. A change answers with
  what was done, from its own input, never Corpay One's body.
- Errors are fixed texts by HTTP status, with
  `failure: { httpStatus, requestId }`.
- Secrets must be printable ASCII of at least 16 characters; nothing that
  leaves an instance holds a piece of one.

## Attachments

`corpay_get_expense_attachment` returns the invoice or receipt file itself.
Corpay has no endpoint that serves the file: `/v3/expenses/{id}` lists each
attachment with a CloudFront URL signed for about an hour — the original
upload (`isOriginal`, usually a PDF) plus one rendered JPG per page. The server
downloads from that URL and returns the content:

- `format: "file"` (default) — the original, as an embedded resource (PDF) or
  an image.
- `format: "pages"` — the rendered pages as images, which every MCP client can
  show to the model. Use this to read what an invoice says.

Each result also carries the signed `downloadUrl` and when it expires. The
expense is team-checked first, only `https://attachments.corpayone.com` is
fetched, no credentials are sent to it, redirects are refused, and a call
returns at most 15 MB and 10 pages.

## Webhooks

`validateWebhookSignature` (exported from `./gateway`) verifies the
`X-Roger-Signature` header — `t=<epochSeconds>;v1=<hex>`, HMAC-SHA512 of
`<t>.<rawBody>` keyed by `CORPAYONE_WEBHOOK_SECRET`. Pass the raw, unparsed
body.

## Notes on the API

Built against the published OpenAPI documents at `api.corpayone.com/docs`
(public-v1, v2 and v3). The endpoint allowlist is generated from them, so an
unlisted path fails locally instead of reaching Corpay.

One endpoint is not in those documents: `PATCH /v2/expenses/{id}` with
`application/json-patch+json`. It is the only way to set category, labels and
departments in a single atomic request, so it is used for coding and marked
`provisional` in the catalog. Its writable paths are `/categoryId` (scalar) and
`/labels` and `/departments` (plain id arrays); the JSON Patch op must be `add`
when the field is empty and `replace` when it is not, which is why the expense
is read before the patch is built.

## License

The code is source-available under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE) (FSL-1.1-ALv2).

In plain words:

- **Allowed:** reading the code, running it, changing it, using it inside your own organisation (also commercially), using it for non-commercial education and research, and contributing changes back.
- **Not allowed:** making it, or something built from it, available to others as a commercial product or service that competes with it, for example a hosted service with the same functionality.
- **Becomes Apache-2.0:** each version is also licensed under the Apache License 2.0 from two years after it is released.
- **Earlier versions:** versions released before 1.2.0 were licensed under Apache-2.0 and remain so.

The terms in [LICENSE](LICENSE) are what apply; this summary does not replace them. See also [NOTICE](NOTICE).
