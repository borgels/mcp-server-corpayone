# Changelog

## Unreleased

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
