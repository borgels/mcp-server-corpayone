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

Set credentials in the MCP server environment. The server reads these from the
environment only and never accepts credentials as tool arguments.

```sh
export CORPAYONE_API_TOKEN="your-api-token"
```

## Domain model

Corpay One's core entity is the **expense** (an incoming bill/document awaiting
coding and approval). Coding is split into a **category** (the GL account) and
**labels** (configurable dimensions such as project and cost type). The connector
follows this model; exact REST paths and field names are verified live during
bring-up.

Documented webhook events (usable to trigger downstream automation): `expense.added`,
`expense.approved`, `expense.declined`, `expense.paid`, and `*_updated` variants
for amount, line amounts, category, label, note, and date.

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
