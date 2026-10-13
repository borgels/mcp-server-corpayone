# Changelog

## Unreleased

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
  Borgels control plane can validate inbound webhooks without package internals.
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
  caller, and a Borgels gateway contract export. The Corpay One endpoint map is
  provisional and verified against the live API (read-first) during connector
  bring-up before write tools are enabled.
