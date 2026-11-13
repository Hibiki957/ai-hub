import { runRequest, ndjsonWriter } from '../bridge.mjs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const cwd = process.argv[2];
const selected = process.argv[3] === 'zcode'
  ? { id: 'zcode', available: true, transport: 'zcode-tui-engine', command: ['/usr/bin/python3', fileURLToPath(new URL('./zcode-helper.py', import.meta.url)), 'wait', join(cwd, 'evidence')] }
  : { id: 'fixture', available: true, transport: 'acp', command: [process.execPath, fileURLToPath(new URL('./fake-acp.mjs', import.meta.url)), 'wait', join(cwd, 'evidence')] };
await runRequest({ id: 'cancel', goal: 'wait', cwd, agents: [selected.id], hostBound: process.argv[3] === 'host' }, {
  stateRoot: cwd,
  agents: [selected],
  ...(process.argv[3] === 'host' ? {} : { broker: { ask: async () => 'reject_once', close() {} } }),
  emit: ndjsonWriter(process.stdout, () => process.kill(process.pid, 'SIGTERM')),
});
