// One user-authorized MCP operation per owned process. Official SDK handles
// initialization, sessions and Streamable HTTP; Hub owns scope and approval UI.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { pathToFileURL } from 'node:url';

export function checkedEndpoint(value) {
  const url = new URL(value);
  if (!url.hostname || url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('MCP endpoint must be HTTPS or loopback HTTP without credentials/query/fragment');
  }
  return url;
}
export async function operate(input) {
  if (!['list', 'call'].includes(input.action)) throw new Error('Unsupported action');
  const url = checkedEndpoint(input.url);
  if (input.action === 'call' && (input.confirmed !== true || typeof input.tool !== 'string' || !input.tool ||
      !Array.isArray(input.allowedTools) || !input.allowedTools.includes(input.tool))) throw new Error('Tool is not approved');
  const client = new Client({ name: 'aihub', version: '0.2.0' });
  const headers = input.token ? { Authorization: `Bearer ${input.token}` } : {};
  const controller = new AbortController();
  const timeout = setTimeout(() => { controller.abort(); void client.close(); }, 30_000);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
    fetch: (target, options) => {
      const next = new URL(target);
      if (next.origin !== url.origin || next.pathname !== url.pathname) throw new Error('MCP endpoint changed');
      return fetch(target, { ...options, redirect: 'error', signal: AbortSignal.any([controller.signal, ...(options?.signal ? [options.signal] : [])]) });
    },
  });
  try {
    await client.connect(transport);
    if (input.action === 'list') {
      const response = await client.listTools();
      return { tools: response.tools, ...(response.nextCursor ? { partial: true } : {}) };
    }
    return await client.callTool({ name: input.tool, arguments: input.arguments ?? {} });
  } finally { clearTimeout(timeout); await client.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let data = '';
    for await (const chunk of process.stdin) { data += chunk; if (Buffer.byteLength(data) > 131072) throw new Error('Request too large'); }
    const result = await operate(JSON.parse(data));
    const encoded = JSON.stringify({ ok: true, result });
    if (Buffer.byteLength(encoded) > 4 * 1024 * 1024) throw new Error('Response too large');
    process.stdout.write(encoded + '\n');
  } catch {
    // Do not echo URLs, remote error text, tokens, arguments, or stacks.
    process.stdout.write(JSON.stringify({ ok: false, error: 'MCP operation failed. Check Hub endpoint, authorization and service status.' }) + '\n');
    process.exitCode = 1;
  }
}
