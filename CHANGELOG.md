# Changelog

## 1.3.0

The embeddable gateway (`./gateway`) is rebuilt for hosts that serve several
companies from one process. The MCP server and its tools are unchanged.

- One instance per company: `createCorpayGateway` takes the app's `clientId`
  and `clientSecret`, the company's `refreshToken` and `teamId`, and reads no
  `CORPAYONE_*` variable. The team is a hard boundary: lists are asked for it,
  and an expense addressed by id is read first and refused unless it belongs
  to the team.
- When Corpay One renews the access with a new refresh token, the instance
  uses it at once and hands it to the host (`onRefreshToken`) before anything
  else is sent; a host that cannot keep it stops the call.
- A frozen tool catalog (`corpayToolCatalog`) with each tool's risk level, the
  Corpay One requests it may make, the broad mark (none is broad) and
  `requiresConfirmation` (only `approve_expense`, which releases a bill for
  payment).
- Tools: the team, expenses with their activity log and approvers, coding
  options and vendors; coding an expense, splitting it into amount lines, a
  comment, a new vendor (no bank details), a vendor's external id, and
  approving or declining an expense. Changes are sent directly when the
  host's policy enables writes; there is no prepare and commit step in the
  gateway.
- Answers leave out bank and card numbers and signed attachment links.
- Errors are our own texts by HTTP status, with the status and Corpay's
  request id as `failure` metadata; a refused renewal says so.
- Secrets are admitted only as printable ASCII of 16 characters or more that
  share no piece with the server's own texts, and nothing that leaves an
  instance (results, errors, the tool list, audit records) holds a piece of
  one.

Upgrade notes: the 1.2 gateway options (`enableWrites`, `env`, `contractMode`)
and tools (`list_categories`, `write_expense_coding`) are replaced by the ones
above; `validateWebhookSignature` and `WEBHOOK_EVENTS` are still exported.

## 1.2.0

- License changed from Apache-2.0 to the Functional Source License, Version 1.1,
  ALv2 Future License (FSL-1.1-ALv2). You may read, run, modify and use the code
  internally and contribute changes; offering it as a competing commercial
  product or service is not allowed. Each version becomes Apache-2.0 two years
  after its release. Versions released before 1.2.0 remain under Apache-2.0
  (see `NOTICE`).

## 1.1.0

HTTP transport, upstream client and supply chain.

- HTTP transport fails closed: it refuses to start on a non-loopback bind, or
  with `MCP_ALLOW_ANY_ORIGIN=true`, unless `MCP_HTTP_TOKEN` is set.
  `MCP_HTTP_ALLOW_UNAUTHENTICATED=true` is an explicit escape hatch.
- `MCP_HTTP_TOKEN` must be at least 32 printable ASCII characters without
  whitespace.
- Failed authentication is limited per client address (429 with
  `Retry-After`; `MCP_AUTH_FAILURE_LIMIT`, `MCP_AUTH_FAILURE_WINDOW_MS`).
  Requests with a valid token are never throttled.
- `Host` header check on loopback binds (`MCP_ALLOWED_HOSTS` to override).
- 401 responses carry `WWW-Authenticate: Bearer`; invalid JSON gets 400
  instead of 500; oversized bodies get 413 before they are read.
- `GET /healthz` (unauthenticated) and graceful shutdown on SIGTERM/SIGINT.
- `PORT`, `MCP_MAX_BODY_BYTES` and boolean flags are validated at startup.
- CI runs on pull requests and before every image publish; images are only
  published from `main` and `v*` tags, with SBOM and provenance attestations.
  GitHub Actions are pinned to commit SHAs.
- Dependency updates; `npm audit --omit=dev` is clean.
- Upstream requests no longer follow redirects, so the OAuth client secret
  and bearer token are never resent to a redirect target; a redirect is
  reported as an error. Upstream error bodies are read up to 64 KB.
- `CORPAYONE_TIMEOUT_MS` is validated (1-600000) instead of becoming `NaN`.
- The server reports the package version.

### Upgrade notes

- A deployment that binds a non-loopback address (for example `0.0.0.0` in a
  container) now needs `MCP_HTTP_TOKEN` of at least 32 characters, or the
  server exits at startup. A 64-character hex token (`openssl rand -hex 32`)
  works unchanged.
- Shorter tokens, tokens with whitespace or a trailing newline, and
  non-numeric or out-of-range numeric settings are rejected at startup.
- New optional variables: `MCP_HTTP_ALLOW_UNAUTHENTICATED`,
  `MCP_ALLOWED_HOSTS`, `MCP_AUTH_FAILURE_LIMIT`, `MCP_AUTH_FAILURE_WINDOW_MS`.
- `CORPAYONE_TIMEOUT_MS` must be an integer between 1 and 600000.

Also in this release:

- `corpay_get_expense_attachment` returns an expense's attachment — the
  original file (usually PDF) or its rendered pages as images — with a signed
  download link. Fetched only from Corpay's attachment host, without
  credentials, capped at 15 MB and 10 pages.

Security hardening.

- On a server pinned with `CORPAYONE_TEAM_ID`, by-id expense and webhook
  reads and writes now verify the resource belongs to the pinned team (at
  prepare and again at commit), failing closed when it cannot be determined.
- Prepared operations are signed with HMAC-SHA256 (`CORPAYONE_PREPARE_SECRET`,
  random per process when unset), expire after 15 minutes, and are bound to
  the endpoints of the capability that prepared them.
  `corpay_prepare_coding_list_change` accepts only coding-list endpoints.
- Path parameters are validated as single segments before encoding, and the
  write policy matches deny patterns against the normalized path.
- `npm run auth:grant` uses `state` and PKCE (S256) and listens on loopback only.
- Webhook signature parsing no longer uses a backtracking regex.
- The HTTP bearer token is compared in constant time; startup is refused when
  forwarded-user trust is enabled without `MCP_HTTP_TOKEN`.
- Dependency updates clearing all `npm audit` findings.

## 1.0.0

First release usable as a hosted, multi-company deployment.

- **Team scoping is now a hard boundary.** One Corpay grant reaches every team
  its user belongs to, and the team is chosen per request, so a server serving
  one company could previously be steered to another by a caller supplying its
  own `teamId`. `CORPAYONE_TEAM_ID` is now forced into every path, query and
  request body, and a request naming a different team is rejected instead of
  silently redirected.
- **Approvals are gated separately from writes** (`CORPAYONE_ENABLE_APPROVALS`).
  Approving an expense releases the bill for payment, so a server can be allowed
  to code expenses without ever being able to approve them. The approve/decline
  endpoints are reachable only through `corpay_commit_expense_approval`, and
  that tool reaches nothing else.
- **Endpoint allowlist generated from the published OpenAPI documents** — all
  three versions, 79 operations, each classified read / commit / approval /
  dangerous. Dangerous endpoints (team and member management, payment methods,
  and every DELETE) are refused even when writes are enabled.
- **Atomic expense coding.** `corpay_prepare_expense_coding` sets category,
  labels and departments in one JSON Patch request, reads the expense first to
  choose `add` or `replace` per field, and reports the current coding next to
  the proposed change.
- **Streamable HTTP transport, Dockerfile and GHCR publish**, so the server can
  be run as a container behind a reverse proxy.
- Prepare/commit ceremony aligned with the house pattern: stable hashing
  independent of key order, a verify step that recovers a body the client
  re-stringified in transit, and a policy re-check against the verified
  operation rather than the caller's copy.
- Curated tool surface expanded to 27 tools, covering expenses, coding options,
  vendors, cards, members and webhooks.
- **Tools are gated on what the grant can actually reach.** Rather than
  offering five tools that always 403, the server hides them unless the scope
  is held; `CORPAYONE_SCOPE` turns them back on if Corpay grants more. The map
  of which endpoint needs which scope is *measured* against the live API, not
  inferred: `teams.all` covers `/teams/{id}/modules` but not `/departments` or
  `/members`, and `expenses.all` covers `/expenses/{id}/approvers` — so
  approvers and modules work on a standard grant after all. Departments and
  items are dropped from the coding tools when unreachable, since their ids
  would be unknowable. `/usage/export/summary` is removed outright: it 500s.
- `npm run auth:grant` requests the seven scopes a Corpay app can actually
  obtain. Establishing that ceiling took probing the live authorize endpoint:
  asking for a scope the client is not allowed fails the whole authorize call
  rather than issuing a narrower token, and adding the scope in the developer
  portal does not help either — identity.corpayone.com keeps its own client
  allowlist and still refuses it, so `departments.all`, `cardtransactions.all`,
  `payments.all`, `items.*`, `teams.members.list`, `teams.modules.list` and
  `expenses.approvers.read` need Corpay support to enable. The reads they gate
  now return an error naming the missing scope instead of a bare 403.
- Added `npm run smoke:live`, a read-only live check that also asserts a
  cross-team read is refused.
- MCP `instructions` tell the client about minor-unit amounts, id-based coding,
  and the two-step write ceremony.

## 0.0.1

- Gateway: added a `write_expense_coding` tool (risk `write`, disabled by default)
  that sets an expense's category/labels/department, routed through the
  connector's prepare → commit (allowlist + write policy + operation hash). The
  PATCH endpoint stays provisional until confirmed live. Re-exported
  `validateWebhookSignature` and `WEBHOOK_EVENTS` from the gateway entry so the
  an embedding host can validate inbound webhooks without package internals.
- Built the client against the official Corpay One API contract: OAuth 2.0
  (authorization_code + refresh_token, auto-refreshed Bearer access tokens),
  `/external` base with version-prefixed endpoints (`GET /v1/teams`,
  `GET /v2/expenses`, `GET /v3/expenses/{id}`, `*/v1/webhooks`), staging/production
  host selection, and `teamId` handling. Added the full documented webhook event
  set, `X-Roger-Signature` validation (`validateWebhookSignature`), a one-time
  `npm run auth:grant` token-capture helper, and webhook tools.
- Modeled the connector on Corpay One's documented domain (public docs): the
  core entity is the **expense**, coded with a **category** (GL account) and
  **labels** (project, cost type, ...). Added the documented webhook event list.
  Tools: `corpay_list_expenses`, `corpay_get_expense`, `corpay_prepare_expense_coding`.
  Exact REST paths/fields and the auth scheme are confirmed via live
  introspection during bring-up (API key required).
- Initial scaffold: policy-aware MCP server skeleton for the Corpay One API.
  Credentials are read only from the server environment; writes are blocked
  unless explicitly enabled and go through a prepare → commit flow with policy
  checks and an operation hash. Includes discovery, an allowlisted endpoint
  caller, and a gateway contract export. The Corpay One endpoint map is
  provisional and verified against the live API (read-first) during connector
  bring-up before write tools are enabled.
