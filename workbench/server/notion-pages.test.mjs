import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Store } from './store.mjs';
import {
  createNotionPages,
  parseNotionPage,
  preparePatch,
  NOTION_VERSION,
  NOTION_TEXT_LIMIT,
  NOTION_PATCH_LIMIT
} from './notion-pages.mjs';

const PAGE = 'b55c9c91-384d-452b-81db-d1ef79372b75',
  OTHER = '3c90c3cc-0d44-4b50-8888-8dd25736052a';
const TOKEN = 'public-synthetic-notion-token-no-credentials';
const sha = value => createHash('sha256').update(value).digest('hex');
const rejection = (promise, code, unknown) =>
  assert.rejects(promise, error => error.code === code && (unknown === undefined || error.outcomeUnknown === unknown));
function fixture(t, options = {}) {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  t.after(() => store.close());
  const state = {
    text: '# Public fixture\n\nOriginal alpha evidence.\n',
    title: 'Public synthetic Notion page',
    parent: { type: 'workspace', workspace: true },
    edited: '2026-10-23T00:00:00.000Z',
    truncated: false,
    unknown: [],
    warnings: [],
    archived: false,
    inTrash: false
  };
  const calls = [];
  const meta = () => ({
    object: 'page',
    id: PAGE,
    archived: state.archived,
    in_trash: state.inTrash,
    last_edited_time: state.edited,
    parent: structuredClone(state.parent),
    properties: { arbitraryColumn: { type: 'title', title: [{ type: 'text', plain_text: state.title, text: { content: state.title } }] } }
  });
  const body = () => ({
    object: 'page_markdown',
    id: PAGE,
    markdown: state.text,
    truncated: state.truncated,
    unknown_block_ids: structuredClone(state.unknown),
    ...(state.warnings.length ? { warnings: structuredClone(state.warnings) } : {})
  });
  const apply = patch => {
    assert.equal(patch.allow_async, false);
    assert.equal(patch.markdown_version, 'v1');
    if (patch.type === 'update_content') {
      assert.equal(patch.update_content.content_updates.length, 1);
      const row = patch.update_content.content_updates[0];
      assert.ok(row.old_str);
      assert.equal(patch.update_content.replace_all_matches, undefined);
      assert.equal(row.replace_all_matches, undefined);
      assert.equal(patch.update_content.allow_deleting_content, undefined);
      assert.equal(state.text.split(row.old_str).length, 2);
      state.text = state.text.replace(row.old_str, () => row.new_str);
    } else {
      assert.equal(patch.type, 'insert_content');
      assert.equal(state.text, '');
      assert.deepEqual(patch.insert_content.position, { type: 'start' });
      state.text = patch.insert_content.content;
    }
    state.edited = '2026-10-23T00:00:01.000Z';
  };
  const fetchImpl = async (target, init) => {
    const url = new URL(target),
      parsedBody = init.body ? JSON.parse(init.body) : undefined;
    const call = { url, method: init.method, body: parsedBody, headers: init.headers };
    calls.push(call);
    assert.equal(url.origin, 'https://api.notion.com');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    assert.equal(init.headers['Notion-Version'], NOTION_VERSION);
    assert.equal(init.headers.Accept, 'application/json');
    assert.ok(init.headers.Authorization.startsWith('Bearer public-synthetic-'));
    assert.ok(['GET', 'PATCH'].includes(init.method));
    if (options.intercept) {
      const response = await options.intercept({ call, state, calls, meta, body, apply, store });
      if (response !== undefined) return response;
    }
    if (url.pathname === `/v1/pages/${PAGE}`) {
      assert.equal(init.method, 'GET');
      assert.equal(url.search, '');
      return Response.json(meta());
    }
    assert.equal(url.pathname, `/v1/pages/${PAGE}/markdown`);
    if (init.method === 'GET') {
      assert.equal(url.search, '?markdown_version=v1');
      return Response.json(body());
    }
    assert.equal(url.search, '');
    apply(parsedBody);
    return Response.json(body());
  };
  const adapter = createNotionPages({
    store,
    fetchImpl,
    now: () => Date.parse('2026-10-23T01:02:03.000Z'),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {})
  });
  if (options.configure !== false) adapter.configure({ token: TOKEN, pageIds: [PAGE], confirmed: true });
  return { adapter, store, state, calls, meta, body, fetchImpl };
}

test('canonical page input accepts UUID, compact ID and official page links without fetching supplied URLs', () => {
  for (const value of [
    PAGE,
    PAGE.toUpperCase(),
    PAGE.replaceAll('-', ''),
    `https://www.notion.so/${PAGE}?pvs=4`,
    `https://notion.so/Workspace/Public-page-${PAGE.replaceAll('-', '')}`,
    `https://public-fixture.notion.site/Document-${PAGE.replaceAll('-', '')}#${OTHER}`,
    `https://app.notion.com/p/${PAGE}?pvs=204`,
    `https://app.notion.com/p/${PAGE.replaceAll('-', '')}?pvs=204`
  ])
    assert.equal(parseNotionPage(value), PAGE);
  assert.equal(
    parseNotionPage('https://app.notion.com/p/4021b6526ab1819884a0feb1a79f3dba?pvs=204'),
    '4021b652-6ab1-8198-84a0-feb1a79f3dba'
  );
  for (const value of [
    `http://notion.so/${PAGE}`,
    `https://notion.so.evil.example/${PAGE}`,
    `https://notion.site.attacker.example/${PAGE}`,
    `https://127.0.0.1/${PAGE}`,
    `https://notion.so:444/${PAGE}`,
    `https://token@notion.so/${PAGE}`,
    `https://api.notion.com/v1/pages/${PAGE}`,
    `https://notion.so/not-a-page`,
    `https://app.notion.com/${PAGE}`,
    `https://app.notion.com/p/slug-${PAGE.replaceAll('-', '')}`,
    `https://sub.app.notion.com/p/${PAGE}`,
    `https://app.notion.com.attacker.example/p/${PAGE}`,
    `https://app.notion.com/p/${PAGE}/other`,
    `${PAGE} `,
    '',
    null
  ])
    assert.throws(() => parseNotionPage(value), { code: 'notion_page_invalid' });
});

test('explicit configuration stores only ciphertext; unchanged save is stable, scope or token rotation invalidates revision', t => {
  const f = fixture(t, { configure: false });
  assert.equal(f.adapter.status().configured, false);
  assert.throws(() => f.adapter.configure({ token: TOKEN, pageIds: [PAGE] }), { code: 'confirmation_required' });
  const first = f.adapter.configure({ token: TOKEN, pageIds: [PAGE, PAGE.toUpperCase()], confirmed: true });
  assert.equal(first.pageCount, 1);
  assert.equal(first.connected, null);
  assert.equal(first.modelCalls, 0);
  const stored = f.store.get('knowledge-connector', 'notion');
  assert.equal(f.store.unseal(stored.sealedToken), TOKEN);
  assert.ok(!JSON.stringify(stored).includes(TOKEN));
  assert.ok(!JSON.stringify(first).includes('sealedToken'));
  assert.ok(!JSON.stringify(first).includes(TOKEN));
  assert.equal(f.adapter.configure({ pageIds: [PAGE], confirmed: true }).connectionRevision, first.connectionRevision);
  const rotated = f.adapter.configure({ token: 'public-synthetic-new-token', pageIds: [PAGE], confirmed: true });
  assert.notEqual(rotated.connectionRevision, first.connectionRevision);
  const rescope = f.adapter.configure({ pageIds: [PAGE, OTHER], confirmed: true });
  assert.notEqual(rescope.connectionRevision, rotated.connectionRevision);
  assert.equal(f.calls.length, 0);
});

test('configuration validates scope and token before storing, never scans a workspace or borrows credentials', t => {
  const f = fixture(t, { configure: false });
  for (const pageIds of [[], Array(21).fill(PAGE), [OTHER, 'https://localhost/secret']])
    assert.throws(() => f.adapter.configure({ token: TOKEN, pageIds, confirmed: true }));
  for (const token of ['', 'short', 'Bearer unsafe token', TOKEN + '\n'])
    assert.throws(() => f.adapter.configure({ token, pageIds: [PAGE], confirmed: true }), { code: 'notion_token_invalid' });
  assert.throws(() => f.adapter.configure({ pageIds: [PAGE], confirmed: true }), { code: 'notion_not_configured' });
  assert.equal(f.store.list('knowledge-connector').length, 0);
  assert.equal(f.calls.length, 0);
});

test('page allowlist and revision are checked before any network call', async t => {
  const f = fixture(t);
  await rejection(f.adapter.read({ pageId: OTHER }), 'notion_page_not_allowed');
  await rejection(f.adapter.read({ pageId: PAGE, expectedConnectionRevision: 'old' }), 'notion_connection_changed');
  await rejection(f.adapter.write({ pageId: OTHER, expectedFingerprint: 'a'.repeat(64), resultText: 'result' }), 'notion_page_not_allowed');
  assert.equal(f.calls.length, 0);
});

test('read pins markdown v1 and binds page identity, metadata, scope revision and exact raw text hash', async t => {
  const f = fixture(t),
    result = await f.adapter.read({ pageId: `https://notion.so/Public-${PAGE.replaceAll('-', '')}` });
  assert.equal(result.pageId, PAGE);
  assert.equal(result.text, f.state.text);
  assert.equal(result.title, f.state.title);
  assert.equal(result.sourceHash, sha(f.state.text));
  assert.equal(result.editable, true);
  assert.equal(result.modelEligible, true);
  assert.equal(result.modelCalls, 0);
  assert.equal(result.readAt, '2026-10-23T01:02:03.000Z');
  assert.equal(f.calls.length, 3);
  assert.equal(f.adapter.status().connected, true);
  const same = await f.adapter.read({ pageId: PAGE });
  assert.equal(same.fingerprint, result.fingerprint);
  f.state.title = 'Changed title';
  const retitled = await f.adapter.read({ pageId: PAGE });
  assert.equal(retitled.sourceHash, result.sourceHash);
  assert.notEqual(retitled.fingerprint, result.fingerprint);
});

test('partial markdown remains clearly read-only and cannot become a task/model input', async t => {
  for (const flag of ['truncated', 'unknown', 'warnings']) {
    const f = fixture(t);
    if (flag === 'truncated') f.state.truncated = true;
    else if (flag === 'unknown') f.state.unknown = [OTHER];
    else f.state.warnings = [{ code: 'no_match', message: `SECRET ${TOKEN} should never be echoed` }];
    const before = await f.adapter.read({ pageId: PAGE });
    assert.equal(before.editable, false);
    assert.equal(before.modelEligible, false);
    assert.ok(before.limitation);
    assert.ok(!JSON.stringify(before.warnings).includes(TOKEN));
    await rejection(
      f.adapter.write({ pageId: PAGE, expectedFingerprint: before.fingerprint, resultText: 'changed', beforeWrite: async () => true }),
      'notion_incomplete'
    );
    assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 0);
  }
});

test('metadata mutation during read and configuration rotation during a request both fail closed', async t => {
  let metaReads = 0;
  const f = fixture(t, {
    intercept: ({ call, state }) => {
      if (call.url.pathname === `/v1/pages/${PAGE}` && ++metaReads === 2) state.edited = '2026-10-23T00:00:02.000Z';
    }
  });
  await rejection(f.adapter.read({ pageId: PAGE }), 'notion_source_changed');
  const g = fixture(t, {
    intercept: ({ calls }) => {
      if (calls.length === 1) g.adapter.configure({ token: 'public-synthetic-rotated-mid-read', pageIds: [PAGE], confirmed: true });
    }
  });
  await rejection(g.adapter.read({ pageId: PAGE }), 'notion_connection_changed');
  assert.equal(g.calls.length, 1);
});

test('archived, trashed, wrong-ID and malformed pages are rejected without a markdown fetch', async t => {
  for (const mode of ['archived', 'inTrash', 'id', 'parent', 'title', 'edited']) {
    const f = fixture(t, {
      intercept: ({ call, meta }) => {
        if (call.url.pathname !== `/v1/pages/${PAGE}`) return;
        const value = meta();
        if (mode === 'archived') value.archived = true;
        if (mode === 'inTrash') value.in_trash = true;
        if (mode === 'id') value.id = OTHER;
        if (mode === 'parent') value.parent = { type: 'unsupported', secret: TOKEN };
        if (mode === 'title') value.properties = {};
        if (mode === 'edited') delete value.last_edited_time;
        return Response.json(value);
      }
    });
    await assert.rejects(f.adapter.read({ pageId: PAGE }));
    assert.equal(f.calls.length, 1);
  }
});

test('preparePatch produces one exact unique edit, handles repeated fragments, Unicode, inserts, deletes and empty pages', () => {
  for (const [source, result] of [
    ['alpha beta alpha beta', 'alpha BETA alpha beta'],
    ['aaa', 'aaaa'],
    ['aaa', 'aa'],
    ['hello', 'Xhello'],
    ['hello', 'helloX'],
    ['天🌏地🌏人', '天🌊地🌏人'],
    ['🌏', '🌊'],
    ['🌏', ''],
    ['abc', ''],
    ['abc', 'xyz'],
    ['', '# A new page\n']
  ]) {
    const plan = preparePatch(source, result);
    assert.equal(plan.sourceHash, sha(source));
    assert.equal(plan.resultHash, sha(result));
    assert.match(plan.patchHash, /^[a-f0-9]{64}$/);
    assert.equal(plan.body.allow_async, false);
    assert.equal(plan.body.markdown_version, 'v1');
    assert.ok(!JSON.stringify(plan.body).includes('allow_deleting_content'));
    assert.ok(!JSON.stringify(plan.body).includes('replace_all_matches'));
    if (source) {
      assert.equal(plan.body.type, 'update_content');
      const [{ old_str, new_str }] = plan.body.update_content.content_updates;
      assert.ok(old_str);
      assert.equal(source.indexOf(old_str, source.indexOf(old_str) + 1), -1);
      assert.equal(
        source.replace(old_str, () => new_str),
        result
      );
      assert.equal(old_str.isWellFormed(), true);
      assert.equal(new_str.isWellFormed(), true);
    } else assert.deepEqual(plan.body.insert_content, { content: result, position: { type: 'start' } });
  }
  assert.equal(preparePatch('hello world', 'hello World').body.update_content.content_updates[0].old_str, 'w');
  assert.throws(() => preparePatch('same', 'same'), { code: 'notion_no_change' });
  assert.throws(() => preparePatch('text', '\uD800'), { code: 'notion_text_limit' });
  assert.throws(() => preparePatch('text', 'a'.repeat(NOTION_TEXT_LIMIT + 1)), { code: 'notion_text_limit' });
});

test('preparePatch repeated-page worst case remains finite and exact', () => {
  const source = 'a'.repeat(200000),
    result = source.slice(0, -1) + 'b';
  const plan = preparePatch(source, result),
    row = plan.body.update_content.content_updates[0];
  assert.equal(
    source.replace(row.old_str, () => row.new_str),
    result
  );
  assert.equal(source.indexOf(row.old_str, source.indexOf(row.old_str) + 1), -1);
});

test('patch planning enforces Notion actual 500 KB JSON payload limit, not merely separate text lengths', () => {
  const source = 'a'.repeat(NOTION_TEXT_LIMIT),
    result = source.slice(0, -1) + 'b';
  assert.throws(() => preparePatch(source, result), { code: 'notion_patch_too_large', status: 413 });
  const escapedSource = '\\'.repeat(130000),
    escapedResult = '"'.repeat(130000);
  assert.throws(() => preparePatch(escapedSource, escapedResult), { code: 'notion_patch_too_large' });
  const accepted = preparePatch('a'.repeat(200000), 'b'.repeat(200000));
  assert.equal(accepted.payloadBytes, Buffer.byteLength(JSON.stringify(accepted.body)));
  assert.ok(accepted.payloadBytes <= NOTION_PATCH_LIMIT);
});

test('one-edit patch planning preserves exact UTF-8 bytes across deterministic multi-span edits', () => {
  let seed = 90123;
  const next = n => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  const alphabet = ['a', 'b', '\n', '中', '🌏', '🌊', '$', '<', '>'];
  for (let i = 0; i < 500; i++) {
    const input = Array.from({ length: 1 + next(50) }, () => alphabet[next(alphabet.length)]);
    const output = input.slice();
    for (let edit = 0; edit < 1 + next(4); edit++)
      output.splice(next(output.length + 1), next(4), ...Array.from({ length: next(4) }, () => alphabet[next(alphabet.length)]));
    const source = input.join(''),
      result = output.join('');
    if (source === result) continue;
    const row = preparePatch(source, result).body.update_content.content_updates[0];
    assert.equal(
      source.replace(row.old_str, () => row.new_str),
      result
    );
    assert.equal(row.old_str.isWellFormed(), true);
    assert.equal(row.new_str.isWellFormed(), true);
  }
});

test('write performs exactly one protected PATCH and three actual read-back GETs before reporting delivery', async t => {
  const f = fixture(t),
    before = await f.adapter.read({ pageId: PAGE });
  const result = before.text.replace('Original alpha', 'Reviewed beta');
  const receipt = await f.adapter.write({
    pageId: PAGE,
    expectedFingerprint: before.fingerprint,
    resultText: result,
    beforeWrite: async () => true
  });
  assert.equal(f.state.text, result);
  assert.equal(receipt.text, result);
  assert.equal(receipt.sourceHash, sha(result));
  assert.equal(receipt.resultHash, sha(result));
  assert.equal(receipt.previousFingerprint, before.fingerprint);
  assert.equal(receipt.previousSourceHash, before.sourceHash);
  assert.notEqual(receipt.fingerprint, before.fingerprint);
  assert.equal(receipt.readBack, true);
  assert.equal(receipt.outcomeUnknown, false);
  assert.equal(receipt.modelCalls, 0);
  assert.match(receipt.concurrencyLimitation, /原子/);
  const writes = f.calls.filter(call => call.method === 'PATCH');
  assert.equal(writes.length, 1);
  const at = f.calls.indexOf(writes[0]);
  assert.deepEqual(
    f.calls.slice(at + 1).map(call => call.method),
    ['GET', 'GET', 'GET']
  );
  await rejection(
    f.adapter.write({ pageId: PAGE, expectedFingerprint: before.fingerprint, resultText: result, beforeWrite: async () => true }),
    'notion_source_changed'
  );
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('host authority hook is awaited after every preflight GET and immediately precedes the only PATCH', async t => {
  const events = [];
  const f = fixture(t, {
    intercept: ({ call }) => {
      events.push(call.method);
    }
  });
  const before = await f.adapter.read({ pageId: PAGE });
  let release, entered;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const authorityEntered = new Promise(resolve => {
    entered = resolve;
  });
  const write = f.adapter.write({
    pageId: PAGE,
    expectedFingerprint: before.fingerprint,
    resultText: 'replacement',
    beforeWrite: async () => {
      events.push('authority:start');
      entered();
      await gate;
      events.push('authority:true');
      return true;
    }
  });
  await authorityEntered;
  assert.equal(f.calls.length, 6);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 0);
  assert.deepEqual(events, [...Array(6).fill('GET'), 'authority:start']);
  release();
  assert.equal((await write).published, true);
  assert.deepEqual(events.slice(6), ['authority:start', 'authority:true', 'PATCH', 'GET', 'GET', 'GET']);
});

test('host-bound exact patch hash is checked after planning, and receipt reports actual payload bytes', async t => {
  const f = fixture(t),
    before = await f.adapter.read({ pageId: PAGE }),
    text = 'An approved replacement\n';
  const plan = preparePatch(before.text, text);
  const actual = await f.adapter.write({
    pageId: PAGE,
    expectedFingerprint: before.fingerprint,
    resultText: text,
    expectedPatchHash: plan.patchHash,
    beforeWrite: async () => true
  });
  assert.equal(actual.patchHash, plan.patchHash);
  assert.equal(actual.payloadBytes, plan.payloadBytes);
  assert.equal(actual.payloadBytes, Buffer.byteLength(JSON.stringify(f.calls.find(call => call.method === 'PATCH').body)));
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('different approved patch hash stops before authority hook or PATCH, with a proven zero-dispatch error', async t => {
  const f = fixture(t),
    before = await f.adapter.read({ pageId: PAGE });
  let authorityCalls = 0;
  await assert.rejects(
    f.adapter.write({
      pageId: PAGE,
      expectedFingerprint: before.fingerprint,
      resultText: 'replacement',
      expectedPatchHash: 'a'.repeat(64),
      beforeWrite: async () => {
        authorityCalls++;
        return true;
      }
    }),
    error => error.code === 'notion_patch_changed' && error.outcomeUnknown === false && error.writeDispatched === false
  );
  assert.equal(authorityCalls, 0);
  assert.equal(f.calls.length, 6);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 0);
  assert.equal(f.state.text, before.text);
});

test('optional expected patch hash rejects malformed host input before any HTTP request', async t => {
  const f = fixture(t);
  for (const expectedPatchHash of [null, true, '', 'not-a-hash', 'a'.repeat(63)])
    await rejection(
      f.adapter.write({
        pageId: PAGE,
        expectedFingerprint: 'b'.repeat(64),
        resultText: 'replacement',
        expectedPatchHash,
        beforeWrite: async () => true
      }),
      'notion_patch_hash_invalid'
    );
  assert.equal(f.calls.length, 0);
});

test('missing, rejecting or nontrue host authority prevents every PATCH and never exposes hook errors', async t => {
  const missing = fixture(t),
    beforeMissing = await missing.adapter.read({ pageId: PAGE });
  await rejection(
    missing.adapter.write({ pageId: PAGE, expectedFingerprint: beforeMissing.fingerprint, resultText: 'replacement' }),
    'notion_write_authority_required'
  );
  assert.equal(missing.calls.length, 3);
  for (const value of [false, undefined, 1, 'true', { authorized: true }, new Error(TOKEN)]) {
    const f = fixture(t),
      before = await f.adapter.read({ pageId: PAGE });
    let called = 0;
    await assert.rejects(
      f.adapter.write({
        pageId: PAGE,
        expectedFingerprint: before.fingerprint,
        resultText: 'replacement',
        beforeWrite: async () => {
          called++;
          if (value instanceof Error) throw value;
          return value;
        }
      }),
      error =>
        error.code === 'notion_write_authority_changed' &&
        error.outcomeUnknown === false &&
        error.writeDispatched === false &&
        !error.message.includes(TOKEN)
    );
    assert.equal(called, 1);
    assert.equal(f.calls.length, 6);
    assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 0);
    assert.equal(f.state.text, before.text);
  }
});

test('connection rotation inside the host authority hook still prevents PATCH without another network request', async t => {
  const f = fixture(t),
    before = await f.adapter.read({ pageId: PAGE });
  await rejection(
    f.adapter.write({
      pageId: PAGE,
      expectedFingerprint: before.fingerprint,
      resultText: 'replacement',
      beforeWrite: async () => {
        f.adapter.configure({ token: 'public-synthetic-hook-rotation', pageIds: [PAGE], confirmed: true });
        return true;
      }
    }),
    'notion_connection_changed'
  );
  assert.equal(f.calls.length, 6);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 0);
});

test('changed source, changed connection and unchanged edits never dispatch PATCH', async t => {
  const f = fixture(t),
    before = await f.adapter.read({ pageId: PAGE });
  await rejection(
    f.adapter.write({ pageId: PAGE, expectedFingerprint: before.fingerprint, resultText: before.text, beforeWrite: async () => true }),
    'notion_no_change'
  );
  f.state.text += 'New upstream content.\n';
  await rejection(
    f.adapter.write({ pageId: PAGE, expectedFingerprint: before.fingerprint, resultText: 'result', beforeWrite: async () => true }),
    'notion_source_changed'
  );
  f.state.text = before.text;
  f.adapter.configure({ token: 'public-synthetic-rotated-token', pageIds: [PAGE], confirmed: true });
  await rejection(
    f.adapter.write({ pageId: PAGE, expectedFingerprint: before.fingerprint, resultText: 'result', beforeWrite: async () => true }),
    'notion_source_changed'
  );
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 0);
});

test('empty page publishing uses safe insertion and verifies actual content', async t => {
  const f = fixture(t);
  f.state.text = '';
  const before = await f.adapter.read({ pageId: PAGE }),
    receipt = await f.adapter.write({
      pageId: PAGE,
      expectedFingerprint: before.fingerprint,
      resultText: '# New fixture\n',
      beforeWrite: async () => true
    });
  assert.equal(receipt.text, '# New fixture\n');
  assert.equal(f.calls.find(call => call.method === 'PATCH').body.type, 'insert_content');
});

test('post-dispatch network failure is unknown, leaks no token or raw error, and never retries', async t => {
  const f = fixture(t, {
    intercept: ({ call, apply }) => {
      if (call.method === 'PATCH') {
        apply(call.body);
        throw new Error(`network lost secret ${TOKEN}`);
      }
    }
  });
  const before = await f.adapter.read({ pageId: PAGE });
  await assert.rejects(
    f.adapter.write({
      pageId: PAGE,
      expectedFingerprint: before.fingerprint,
      resultText: '# New expected\n',
      beforeWrite: async () => true
    }),
    error => {
      assert.equal(error.code, 'notion_write_unknown');
      assert.equal(error.outcomeUnknown, true);
      assert.ok(!JSON.stringify(error).includes(TOKEN));
      assert.ok(!error.message.includes(TOKEN));
      assert.equal(error.cause, undefined);
      return true;
    }
  );
  assert.equal(f.state.text, '# New expected\n');
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('server errors, redirects, async acceptance and malformed successful PATCH replies are unknown with no retries', async t => {
  for (const mode of ['500', '302', '202', 'html', 'json']) {
    const f = fixture(t, {
      intercept: ({ call }) => {
        if (call.method !== 'PATCH') return;
        if (mode === 'html') return new Response(`<html>${TOKEN}</html>`, { headers: { 'Content-Type': 'text/html' } });
        if (mode === 'json') return new Response('broken-json', { headers: { 'Content-Type': 'application/json' } });
        return Response.json({ message: TOKEN }, { status: Number(mode) });
      }
    });
    const before = await f.adapter.read({ pageId: PAGE });
    await rejection(
      f.adapter.write({ pageId: PAGE, expectedFingerprint: before.fingerprint, resultText: 'replacement', beforeWrite: async () => true }),
      'notion_write_unknown',
      true
    );
    assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
  }
});

test('documented 4xx rejection is not published, remains finite, and does not echo provider errors', async t => {
  for (const status of [400, 401, 403, 404, 409, 429]) {
    const f = fixture(t, {
      intercept: ({ call }) =>
        call.method === 'PATCH' ? Response.json({ code: 'validation_error', message: TOKEN }, { status }) : undefined
    });
    const before = await f.adapter.read({ pageId: PAGE });
    await assert.rejects(
      f.adapter.write({ pageId: PAGE, expectedFingerprint: before.fingerprint, resultText: 'replacement', beforeWrite: async () => true }),
      error => error.code === 'notion_http_error' && error.outcomeUnknown === false && !error.message.includes(TOKEN)
    );
    assert.equal(f.state.text, before.text);
    assert.equal(f.calls.length, 7);
  }
});

test('warnings, truncation, unknown blocks, nonexact bytes and changed parent after write can never report success', async t => {
  for (const mode of ['warning', 'truncated', 'unknown', 'bytes', 'parent', 'title']) {
    const f = fixture(t, {
      intercept: ({ call, state, body, apply }) => {
        if (call.method !== 'PATCH') return;
        apply(call.body);
        if (mode === 'warning') state.warnings = [{ code: 'no_match', message: TOKEN }];
        if (mode === 'truncated') state.truncated = true;
        if (mode === 'unknown') state.unknown = [OTHER];
        if (mode === 'bytes') state.text += '\n';
        if (mode === 'parent') state.parent = { type: 'page_id', page_id: OTHER };
        if (mode === 'title') state.title = 'Remote concurrent title';
        return Response.json(body());
      }
    });
    const before = await f.adapter.read({ pageId: PAGE });
    await rejection(
      f.adapter.write({ pageId: PAGE, expectedFingerprint: before.fingerprint, resultText: 'replacement', beforeWrite: async () => true }),
      'notion_write_unknown',
      true
    );
    assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
  }
});

test('a 404 during read-back after successful PATCH is uncertain, not a rejected write', async t => {
  let accepted = false;
  const f = fixture(t, {
    intercept: ({ call, body, apply }) => {
      if (call.method === 'PATCH') {
        apply(call.body);
        accepted = true;
        return Response.json(body());
      }
      if (accepted) return Response.json({ message: TOKEN }, { status: 404 });
    }
  });
  const before = await f.adapter.read({ pageId: PAGE });
  await rejection(
    f.adapter.write({ pageId: PAGE, expectedFingerprint: before.fingerprint, resultText: 'replacement', beforeWrite: async () => true }),
    'notion_write_unknown',
    true
  );
  assert.equal(f.state.text, 'replacement');
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('scope rotation after dispatch cannot publish against a superseded Hub connection', async t => {
  const f = fixture(t, {
    intercept: ({ call, body, apply }) => {
      if (call.method === 'PATCH') {
        apply(call.body);
        f.adapter.configure({ token: 'public-synthetic-after-dispatch', pageIds: [PAGE], confirmed: true });
        return Response.json(body());
      }
    }
  });
  const before = await f.adapter.read({ pageId: PAGE });
  await rejection(
    f.adapter.write({ pageId: PAGE, expectedFingerprint: before.fingerprint, resultText: 'replacement', beforeWrite: async () => true }),
    'notion_write_unknown',
    true
  );
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('concurrent write calls are single-dispatch while one page is being checked', async t => {
  let hold = false,
    release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const f = fixture(t, {
    intercept: async ({ call }) => {
      if (hold && call.method === 'GET') {
        hold = false;
        await gate;
      }
    }
  });
  const before = await f.adapter.read({ pageId: PAGE });
  hold = true;
  const first = f.adapter.write({
    pageId: PAGE,
    expectedFingerprint: before.fingerprint,
    resultText: 'replacement',
    beforeWrite: async () => true
  });
  await rejection(
    f.adapter.write({ pageId: PAGE, expectedFingerprint: before.fingerprint, resultText: 'other', beforeWrite: async () => true }),
    'notion_write_busy'
  );
  release();
  assert.equal((await first).published, true);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('bounded JSON, mismatched response origin and body timeout fail without leaking or retrying', async t => {
  for (const mode of ['length', 'stream', 'origin', 'timeout']) {
    const f = fixture(t, {
      timeoutMs: 30,
      intercept: () => {
        if (mode === 'timeout') return new Promise(() => {});
        if (mode === 'origin') {
          const response = Response.json({});
          Object.defineProperty(response, 'url', { value: 'https://attacker.invalid/secret' });
          return response;
        }
        if (mode === 'length')
          return new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': String(3 * 1024 * 1024) } });
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
              controller.close();
            }
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }
    });
    await rejection(
      f.adapter.read({ pageId: PAGE }),
      mode === 'timeout' ? 'notion_timeout' : mode === 'origin' ? 'notion_response_redirect' : 'notion_protocol_invalid'
    );
    assert.equal(f.calls.length, 1);
  }
});

test('even warning codes cannot echo arbitrary server-supplied token-like text', async t => {
  const f = fixture(t);
  f.state.warnings = [{ code: 'ntn_private_token_like_warning', message: TOKEN }];
  const value = await f.adapter.read({ pageId: PAGE });
  assert.equal(value.warnings[0].code, 'notion_warning');
  assert.ok(!JSON.stringify(value.warnings).includes('ntn_private'));
});

test('real HTTP fixture verifies streaming fetch, fixed API request scope and exact read-back without any authenticated external request', async t => {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  let text = '# Before\n',
    edits = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(request.headers['notion-version'], NOTION_VERSION);
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'PATCH') {
      const row = JSON.parse(Buffer.concat(chunks)).update_content.content_updates[0];
      text = text.replace(row.old_str, () => row.new_str);
      edits++;
    }
    const value = request.url.includes('/markdown')
      ? { object: 'page_markdown', id: PAGE, markdown: text, truncated: false, unknown_block_ids: [] }
      : {
          object: 'page',
          id: PAGE,
          archived: false,
          in_trash: false,
          last_edited_time: `2026-10-23T00:00:0${edits}.000Z`,
          parent: { type: 'workspace', workspace: true },
          properties: { title: { type: 'title', title: [{ plain_text: 'Public HTTP fixture' }] } }
        };
    const json = JSON.stringify(value);
    response.write(json.slice(0, 5));
    response.end(json.slice(5));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const adapter = createNotionPages({
    store,
    fetchImpl: async (url, init) => {
      assert.ok(url.startsWith('https://api.notion.com/v1/pages/' + PAGE));
      const local = await fetch(origin + new URL(url).pathname + new URL(url).search, init);
      // The transport shim is explicit and test-only; do not disable production
      // response-origin validation to make a localhost fixture pass.
      Object.defineProperty(local, 'url', { value: url });
      return local;
    }
  });
  adapter.configure({ token: TOKEN, pageIds: [PAGE], confirmed: true });
  const before = await adapter.read({ pageId: PAGE });
  const receipt = await adapter.write({
    pageId: PAGE,
    expectedFingerprint: before.fingerprint,
    resultText: '# After\n',
    beforeWrite: async () => true
  });
  assert.equal(receipt.text, '# After\n');
  assert.equal(receipt.sourceHash, sha('# After\n'));
  assert.equal(edits, 1);
});
