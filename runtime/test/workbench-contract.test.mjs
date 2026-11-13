import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { ApprovalBroker } from '../workbench.mjs';

test('mid-run correction is unsupported: stdin accepts only a matching one-shot approval response', async () => {
  const input = new PassThrough(), events = [];
  const approval = new ApprovalBroker(input, event => events.push(event), () => {}, 1000);
  try {
    let settled = false;
    const waiting = approval.ask({ nodeID: 'only-gate', summary: 'offline contract' });
    waiting.then(() => { settled = true; });
    const { requestID } = events[0];
    input.write(JSON.stringify({ type: 'instruction', requestID, decision: 'allow_once', text: 'change the plan' }) + '\n');
    input.write(JSON.stringify({ type: 'approval_response', requestID: 'another-run', decision: 'allow_once' }) + '\n');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'instruction and foreign request do not advance approval');
    assert.equal(approval.pending.size, 1);
    input.write(JSON.stringify({ type: 'approval_response', requestID, decision: 'allow_once' }) + '\n');
    assert.equal(await waiting, true);
    input.write(JSON.stringify({ type: 'approval_response', requestID, decision: 'allow_once' }) + '\n');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(approval.pending.size, 0, 'replayed permission cannot recreate an action');
  } finally { approval.close(); input.destroy(); }
});
