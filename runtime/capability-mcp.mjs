// Reuses the installed official MCP SDK for both transports and JSON Schema.
// This module performs no discovery, OAuth login, inherited client config or retry.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { checkedEndpoint } from './mcp-client.mjs';

export function validateMCPArguments(schema, input) {
  // A new provider avoids remote $id collisions reusing another tool's schema.
  const checked = new AjvJsonSchemaValidator().getValidator(schema)(input);
  if (!checked.valid) throw Object.assign(new Error('工具参数不符合已核对的 JSON Schema。'), { code: 'mcp_arguments_invalid', status: 400 });
}

export async function connectCapabilityMCP(config, { home, signal, timeoutMs = 30000, fetchImpl = fetch } = {}) {
  const controller = new AbortController(), bounded = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new Error('MCP operation timeout')), timeoutMs); timer.unref?.();
  const client = new Client({ name: 'aihub-capabilities', version: '0.1.0' });
  let transport, closed = false, stderrBytes = 0;
  if (config.transport === 'stdio') {
    // SDK merges its safe defaults with env. Override every default explicitly,
    // especially HOME, so no other client's profile can be loaded by default.
    const env = Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map(key => [key, '']));
    Object.assign(env, { HOME: home, TMPDIR: home, PATH: '/usr/bin:/bin', USER: 'aihub', LOGNAME: 'aihub', SHELL: '/bin/sh', TERM: 'dumb', LANG: 'en_US.UTF-8' }, config.env || {});
    transport = new StdioClientTransport({ command: config.command, args: config.args, env, cwd: home, stderr: 'pipe', maxBufferSize: 2 * 1024 * 1024 });
    transport.stderr?.on('data', value => { stderrBytes += value.byteLength; }); // never echo credentials or stderr.
  } else if (config.transport === 'http') {
    const url = checkedEndpoint(config.url);
    if (!['127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Only literal loopback MCP endpoints are supported; DNS pinning is not implemented');
    transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: config.token ? { Authorization: 'Bearer ' + config.token } : {} },
      fetch: (target, options) => {
        const next = new URL(target);
        if (next.origin !== url.origin || next.pathname !== url.pathname || next.search || next.hash) throw new Error('MCP endpoint changed');
        return fetchImpl(target, { ...options, credentials: 'omit', redirect: 'error', signal: AbortSignal.any([bounded, ...(options?.signal ? [options.signal] : [])]) });
      },
    });
  } else throw new Error('Unsupported MCP transport');
  const close = async () => { if (closed) return; closed = true; clearTimeout(timer); bounded.removeEventListener('abort', abort); await client.close(); };
  const abort = () => { void close().catch(() => {}); };
  bounded.addEventListener('abort', abort, { once: true });
  try {
    bounded.throwIfAborted();
    await client.connect(transport, { signal: bounded, timeout: timeoutMs, maxTotalTimeout: timeoutMs });
    return {
      serverInfo: client.getServerVersion(), capabilities: client.getServerCapabilities(),
      get pid() { return transport.pid || null; }, get stderrBytes() { return stderrBytes; },
      async listTools() {
        const tools = [], cursors = new Set(); let cursor;
        for (let page = 0; page < 10; page++) {
          const result = await client.listTools(cursor ? { cursor } : undefined, { signal: bounded, timeout: timeoutMs, maxTotalTimeout: timeoutMs });
          tools.push(...result.tools);
          if (tools.length > 256 || Buffer.byteLength(JSON.stringify(tools)) > 512 * 1024) throw new Error('MCP tool catalog exceeds limit');
          if (!result.nextCursor) return tools;
          if (cursors.has(result.nextCursor)) throw new Error('MCP tool cursor repeated');
          cursors.add(result.nextCursor); cursor = result.nextCursor;
        }
        throw new Error('MCP tool catalog pagination incomplete');
      },
      async callTool(name, args) { bounded.throwIfAborted(); return client.callTool({ name, arguments: args }, undefined, { signal: bounded, timeout: timeoutMs, maxTotalTimeout: timeoutMs }); },
      close,
    };
  } catch (error) { await close().catch(() => {}); throw error; }
}
