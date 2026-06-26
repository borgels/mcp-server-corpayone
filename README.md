# mcp-server-corpayone

TypeScript MCP server for the Corpay One API. Intentionally boring good: typed,
documented, read-first, policy-aware, credential-sane, and audit-friendly. Same
shape and security posture as the other Borgels `mcp-server-*` connectors.

> **Disclaimer:** This is an independent, unofficial project by Borgels. Borgels
> is not affiliated with, endorsed by, or supported by Corpay or Corpay One.
> "Corpay" and "Corpay One" are referenced only to describe what this server
> talks to. You need your own Corpay One credentials, and use of the Corpay One
> API is subject to Corpay's own terms.

> **Status:** Scaffold. The endpoint map in `src/corpay/catalog.ts` is
> provisional and gets verified against the live Corpay One API (read-first)
> during connector bring-up before any write tools are enabled.

## Scope

- Curated MCP tools for common accounts-payable workflows (bills, coding).
- Discovery tools so clients can find supported resources and endpoint shapes.
- A validated, allowlisted endpoint caller for long-tail coverage.

Default install mode is read-only. Writes require explicit environment opt-in,
policy approval, a prepared operation hash, a reason, and an idempotency key.

## Setup

```sh
npm install
npm run build
```

Auth is OAuth 2.0 (authorization_code + refresh_token). Create an app at
`https://web.<env>.corpayone.com/developers` with scopes `expenses.all`,
`webhooks.all`, `teams.all` (reads the category list for coding writes),
`offline_access` and a redirect URI matching `CORPAYONE_REDIRECT_URI`. Then
capture a refresh token once:

```sh
export CORPAYONE_ENV=staging   # or production
export CORPAYONE_CLIENT_ID="..."
export CORPAYONE_CLIENT_SECRET="..."
export CORPAYONE_REDIRECT_URI="http://localhost:53682/corpayone/callback"
npm run auth:grant             # prints CORPAYONE_REFRESH_TOKEN
```

The server reads all credentials from the environment only and never accepts
them as tool arguments. Access tokens (~1h) are refreshed automatically.

```sh
export CORPAYONE_REFRESH_TOKEN="..."
export CORPAYONE_WEBHOOK_SECRET="..."   # to validate inbound webhooks
export CORPAYONE_TEAM_ID="..."          # company slug; see GET /v1/teams
```

Hosts are selected by `CORPAYONE_ENV`: staging uses
`api.staging.corpayone.com/external` + `identity.staging.corpayone.com`;
production uses `api.corpayone.com/external` + `identity.corpayone.com`.

## Domain model

Corpay One's core entity is the **expense** (an incoming bill/document awaiting
coding and approval). Coding is split into a **category** (the GL account) and
**labels** (configurable dimensions such as project and cost type). The connector
follows this model; exact REST paths and field names are verified live during
bring-up.

Webhook events drive integrations: expense state transitions
(`expense.state.pending|awaiting|booked|initialized|paid|paused|refunded|cancelled`)
and field/action events (`expense.category.updated`, `expense.label.updated`,
`expense.approval.approved`, `payment.updated`, …). Inbound webhook payloads are
signed with `X-Roger-Signature`; validate them with `validateWebhookSignature`
from `src/corpay/webhooks.ts` using your `CORPAYONE_WEBHOOK_SECRET`.

## Tools

- `corpay_check_connection`
- `corpay_search_capabilities`
- `corpay_list_expenses`
- `corpay_prepare_expense_coding` → `corpay_commit_prepared_operation`
- `corpay_call_endpoint` (allowlisted; read-only unless write policy permits)

## Write Policy

Writes are blocked unless explicitly enabled:

```sh
export CORPAYONE_ENABLE_WRITES=true
export CORPAYONE_POLICY_PATH="/absolute/path/to/corpayone-policy.json"
export CORPAYONE_AUDIT_LOG="/absolute/path/to/corpayone-audit.jsonl"
```

Money-movement surfaces (payments, approvals, webhooks) are denied by default and
must be re-allowed explicitly in a policy file.

## Borgels Gateway Contract

`mcp-server-corpayone/gateway` exports `corpayGatewayTools` and
`createCorpayGateway(options)` so the Borgels control plane (mcp.borgels.com) can
wrap Corpay One as a provider without copying connector logic, exactly like the
e-conomic gateway. All gateway tools are read-only. `contractMode: true` returns
deterministic fixtures with no network calls.

## Verification

```sh
npm run typecheck
npm test
npm run build
```

## License

Apache-2.0. See [LICENSE](LICENSE).
