import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { debug } from '../shared/debug.js';

export function createServer(): McpServer {
  return new McpServer(
    { name: 'laminark', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
}

export async function startServer(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  debug('mcp', 'MCP server started on stdio transport');
}
