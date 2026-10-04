// tests/fakes/mcp-client-core.mjs - [V2] owner V2-W1-05-wa-toolserver (T2 3.4).
// Plain ESM shared by fake-mcp-client.ts (in-process) and fake-claude-cli.mjs (spawned): SDK 1.30.0 Client +
// StreamableHTTPClientTransport against the app-hosted tool server. Loopback only (T10): any other host is refused before a
// single byte is sent. Imports: only @modelcontextprotocol/sdk (T10 allow-list).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * @typedef {object} McpCoreClient
 * @property {() => Promise<Array<{name: string, description?: string, inputSchema: unknown, annotations?: unknown}>>} listTools
 * @property {(name: string, args: Record<string, unknown>) => Promise<{isError: boolean, content: unknown}>} call
 * @property {() => Promise<void>} close
 * @property {Error[]} errors  every error the SDK client reported through `onerror` (F17: an authenticated GET answered 405 adds none)
 */

/** @param {{url: string, token: string}} opts @returns {Promise<McpCoreClient>} */
export async function connect(opts) {
  const url = new URL(opts.url);
  if (url.hostname !== '127.0.0.1') throw new Error('mcp-client-core: non_loopback_url (T10)');
  /** @type {Error[]} */
  const errors = [];
  const client = new Client({ name: 'wca-fake-mcp-client', version: '0.0.0' });
  client.onerror = (e) => errors.push(e);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${opts.token}` } },
  });
  await client.connect(transport);
  return {
    errors,
    async listTools() {
      const r = await client.listTools();
      return r.tools;
    },
    async call(name, args) {
      const r = await client.callTool({ name, arguments: args });
      return { isError: r.isError === true, content: r.content };
    },
    async close() {
      await client.close();
    },
  };
}
