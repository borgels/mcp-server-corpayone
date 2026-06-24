# Changelog

## Unreleased

- Initial scaffold: policy-aware MCP server skeleton for the Corpay One API.
  Credentials are read only from the server environment; writes are blocked
  unless explicitly enabled and go through a prepare → commit flow with policy
  checks and an operation hash. Includes discovery, an allowlisted endpoint
  caller, and a Borgels gateway contract export. The Corpay One endpoint map is
  provisional and verified against the live API (read-first) during connector
  bring-up before write tools are enabled.
