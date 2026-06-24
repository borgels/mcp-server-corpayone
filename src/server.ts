import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CorpayClient } from './corpay/client.js';
import { registerCorpayTools } from './tools/corpay.js';

export interface CreateServerOptions {
  client?: CorpayClient;
}

/** Build an MCP server instance with the Corpay One tools registered. */
export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'mcp-server-corpayone',
    version: '0.0.1',
  });
  const client = options.client ?? new CorpayClient();
  registerCorpayTools(server, client);
  return server;
}
