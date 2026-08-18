# mcp-server-corpayone

An MCP server for the [Corpay One](https://www.corpayone.com/) accounts-payable
API: read bills and receipts, code them, manage the coding vocabulary, and — when
explicitly enabled — approve or decline them.

Reads work out of the box. Every write is refused unless the server is
configured to allow it, and each one goes through a prepare/commit ceremony so a
change is reviewed before it happens.

## What it can do

**Read** — expenses (bills, receipts, credit notes) with their state, vendor,
amounts, attachments and coding; the activity log and approver list for an
expense; the coding vocabulary (categories, label lists, departments, items);
vendors; credit accounts and card transactions; payment methods; team members;
webhook subscriptions.

**Write** — code an expense (category, labels, departments, set atomically);
split an expense into coded amount lines; code a card transaction; create
vendors and set their external ids; maintain categories, departments, label
lists and items; manage webhook subscriptions.

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

Create an app at `https://web.corpayone.com/developers`, then run the grant once
to capture a refresh token:

```bash
npm run auth:grant
```

It requests the scopes the server needs. A grant missing `departments.all` or
the card scopes still works for most calls but returns 403 on those specific
reads, which is easy to mistake for a broken endpoint — `npm run smoke:live`
will show you exactly which ones.

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

The HTTP transport binds to loopback by default and expects to sit behind a
reverse proxy that terminates TLS and authenticates callers. `MCP_HTTP_TOKEN`
adds a bearer check; `MCP_ALLOWED_ORIGINS` restricts browser origins.

## Verifying a deployment

```bash
npm run typecheck && npm test        # offline
CORPAYONE_TEAM_ID=<team> npm run smoke:live   # read-only, hits the real API
```

The live smoke test also asserts that a cross-team read is refused, so it
doubles as a check that the boundary is actually in force.

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

## Licence

Apache-2.0.
