# Changelog

## Unreleased

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
