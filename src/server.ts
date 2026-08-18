import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CorpayClient } from './corpay/client.js';
import { registerCorpayTools } from './tools/corpay.js';
import { isTeamPinned } from './corpay/team.js';

export interface CreateServerOptions {
  client?: CorpayClient;
}

const INSTRUCTIONS = `Corpay One accounts-payable data: bills and receipts, their coding, and the
approval queue.

Amounts are always in minor units — an amount of 930000 is 9,300.00 DKK. Convert
before showing a figure to anyone, and convert back before writing one.

Coding an expense means setting its category (the GL account) and, where the
team uses them, labels and departments. These are written as Corpay's internal
ids, which are not the GL account or dimension numbers a bookkeeper would
recognise: always resolve them with corpay_list_coding_options first, and match
on the number or name found there.

Every write is two steps. A corpay_prepare_* tool validates the change and
returns it with an operationHash; nothing reaches Corpay until that operation is
passed back to corpay_commit_prepared_operation with the hash restated. Show the
prepared change before committing it.

Approving an expense releases the bill for payment. It is a separate decision
from coding, has its own tools (corpay_prepare_expense_approval and
corpay_commit_expense_approval), and may be switched off on this server even
when coding is allowed. Never approve an expense unless the user asked for that
specific expense to be approved.${
  isTeamPinned()
    ? '\n\nThis server acts for one company. It ignores any team argument, and cannot\nread or write another company\'s data.'
    : ''
}`;

/** Build an MCP server instance with the Corpay One tools registered. */
export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'mcp-server-corpayone', version: '1.0.0' },
    { instructions: INSTRUCTIONS },
  );
  const client = options.client ?? new CorpayClient();
  registerCorpayTools(server, client);
  return server;
}
