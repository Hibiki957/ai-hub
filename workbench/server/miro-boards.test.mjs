import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Store } from './store.mjs';
import { createMiroBoards, parseMiroBoard, miroEmbedURL, MIRO_EMBED_MODE, MIRO_TEXT_LIMIT } from './miro-boards.mjs';

const BOARD = 'uXjVPublic1=',
  OTHER = 'uXjVPublic2=',
  ITEM = '3458764512345678901',
  SECOND = '3458764512345678902',
  FRAME = '3458764512345678903';
const TOKEN = 'public-synthetic-miro-token-no-credentials',
  sha = value => createHash('sha256').update(value).digest('hex');
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);
function fixture(t, options = {}) {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  t.after(() => store.close());
  const state = {
    board: {
      type: 'board',
      id: BOARD,
      name: 'Public synthetic board',
      description: 'Fixture only',
      team: { id: '1234567890123456789', name: 'Ignored private team name' },
      modifiedAt: '2026-10-24T00:00:00Z',
      createdAt: '2026-10-23T00:00:00Z',
      links: { self: 'https://api.miro.com/v2/boards/forbidden?access_token=private' }
    },
    items: new Map([
      [
        ITEM,
        {
          id: ITEM,
          type: 'sticky_note',
          data: { content: '<p>Public <strong>alpha</strong> evidence</p>', shape: 'square' },
          geometry: { width: 200, height: 200 },
          position: { x: 1, y: 2, origin: 'center', relativeTo: 'canvas_center' },
          modifiedAt: '2026-10-24T00:00:00Z'
        }
      ],
      [
        SECOND,
        {
          id: SECOND,
          type: 'card',
          data: { title: 'Public card', description: '<p>Reviewed beta evidence</p>' },
          parent: { id: FRAME },
          modifiedAt: '2026-10-24T00:00:00Z'
        }
      ],
      [
        FRAME,
        {
          id: FRAME,
          type: 'frame',
          data: { title: 'Public frame' },
          geometry: { width: 1000, height: 500 },
          modifiedAt: '2026-10-24T00:00:00Z'
        }
      ]
    ])
  };
  const calls = [];
  const fetchImpl = async (target, init) => {
    const url = new URL(target),
      call = { url, method: init.method, headers: init.headers };
    calls.push(call);
    assert.equal(url.origin, 'https://api.miro.com');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    assert.ok(init.headers.Authorization.startsWith('Bearer public-synthetic-'));
    assert.equal(init.headers.Accept, 'application/json');
    assert.equal(init.body, undefined);
    if (options.intercept) {
      const value = await options.intercept({ call, calls, state, store });
      if (value !== undefined) return value;
    }
    const path = decodeURIComponent(url.pathname);
    if (path === `/v2/boards/${BOARD}`) {
      assert.equal(url.search, '');
      return Response.json(state.board);
    }
    if (path === `/v2/boards/${BOARD}/items`) {
      assert.equal(url.searchParams.get('limit'), '50');
      let rows = [...state.items.values()];
      if (url.searchParams.has('parent_item_id')) rows = rows.filter(row => row.parent?.id === url.searchParams.get('parent_item_id'));
      if (url.searchParams.has('type')) rows = rows.filter(row => row.type === url.searchParams.get('type'));
      return Response.json({ type: 'cursor-list', data: rows, cursor: null });
    }
    const id = path.split('/').at(-1),
      item = state.items.get(id);
    assert.ok(item);
    return Response.json(item);
  };
  const adapter = createMiroBoards({
    store,
    fetchImpl,
    now: () => Date.parse('2026-10-24T01:02:03Z'),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {})
  });
  if (options.configure !== false) adapter.configure({ token: TOKEN, boardIds: [BOARD], confirmed: true });
  return { adapter, store, state, calls, fetchImpl };
}

test('board URL parser preserves real base64-style identity and only accepts explicit official board routes', () => {
  for (const input of [
    BOARD,
    `https://miro.com/app/board/${BOARD}/`,
    `https://miro.com/app/board/${encodeURIComponent(BOARD)}/?moveToWidget=${ITEM}`,
    `https://miro.com/app/live-embed/${BOARD}/?embedMode=standard`
  ])
    assert.equal(parseMiroBoard(input), BOARD);
  for (const value of [
    null,
    true,
    '',
    'bad id',
    'a'.repeat(129),
    BOARD + ' ',
    '../secret',
    `http://miro.com/app/board/${BOARD}`,
    `https://miro.com.attacker.example/app/board/${BOARD}`,
    `https://sub.miro.com/app/board/${BOARD}`,
    `https://miro.com:444/app/board/${BOARD}`,
    `https://auth@miro.com/app/board/${BOARD}`,
    `https://miro.com/app/board/${BOARD}/extra`,
    `https://miro.com/app/board/${BOARD}/?boardsAccessToken=private`,
    `https://miro.com/app/board/${BOARD}/?access_token=private`,
    `https://miro.com/app/board/${BOARD}%2fother/`,
    `https://miro.com/app/board/%GG`
  ])
    assert.throws(() => parseMiroBoard(value), { code: 'miro_board_invalid' });
});

test('canonical embed enforces official read-only mode, exact host and token-free item targeting', () => {
  assert.equal(miroEmbedURL({ boardId: BOARD }), `https://miro.com/app/live-embed/${BOARD}/?embedMode=view_only_without_ui&autoplay=true`);
  assert.equal(
    miroEmbedURL({ boardId: `https://miro.com/app/board/${BOARD}/?embedMode=standard`, itemId: ITEM }),
    `https://miro.com/app/live-embed/${BOARD}/?embedMode=view_only_without_ui&autoplay=true&moveToWidget=${ITEM}`
  );
  assert.equal(MIRO_EMBED_MODE, 'view_only_without_ui');
  for (const id of [1, '', '1&embedMode=standard', 'https://attacker.invalid', '1e6', '-1'])
    assert.throws(() => miroEmbedURL({ boardId: BOARD, itemId: id }), { code: 'miro_item_invalid' });
  assert.ok(miroEmbedURL({ boardId: 'a'.repeat(128) + '==', itemId: '1'.repeat(40) }).includes('moveToWidget=' + '1'.repeat(40)));
  assert.throws(() => miroEmbedURL({ boardId: BOARD, itemId: '1'.repeat(41) }), { code: 'miro_item_invalid' });
});

test('own token stays encrypted, explicit scope is required, unchanged saves are stable and rotations invalidate reads', async t => {
  const f = fixture(t, { configure: false });
  assert.equal(f.adapter.status().configured, false);
  assert.throws(() => f.adapter.configure({ token: TOKEN, boardIds: [BOARD] }), { code: 'confirmation_required' });
  for (const boardIds of [[], Array(21).fill(BOARD), [BOARD, 'not a board']])
    assert.throws(() => f.adapter.configure({ token: TOKEN, boardIds, confirmed: true }));
  for (const token of ['', 'short', TOKEN + '\n'])
    assert.throws(() => f.adapter.configure({ token, boardIds: [BOARD], confirmed: true }), { code: 'miro_token_invalid' });
  const first = f.adapter.configure({ token: TOKEN, boardIds: [BOARD, BOARD], confirmed: true });
  const stored = f.store.get('knowledge-connector', 'miro');
  assert.equal(f.store.unseal(stored.sealedToken), TOKEN);
  assert.ok(!JSON.stringify(stored).includes(TOKEN));
  assert.ok(!JSON.stringify(first).includes(TOKEN));
  assert.equal(first.boardCount, 1);
  assert.equal(first.connected, null);
  assert.equal(first.write, false);
  assert.equal(f.adapter.configure({ boardIds: [BOARD], confirmed: true }).connectionRevision, first.connectionRevision);
  const rotated = f.adapter.configure({ token: 'public-synthetic-miro-new-token', boardIds: [BOARD], confirmed: true });
  assert.notEqual(rotated.connectionRevision, first.connectionRevision);
  await rejects(f.adapter.readBoard({ boardId: BOARD, expectedConnectionRevision: first.connectionRevision }), 'miro_connection_changed');
  assert.equal(f.calls.length, 0);
});

test('board scope is checked before HTTP and no workspace search or arbitrary endpoint can be requested', async t => {
  const f = fixture(t);
  for (const method of ['readBoard', 'listItems', 'readItem', 'readSelection'])
    await rejects(f.adapter[method]({ boardId: OTHER, itemId: ITEM, itemIds: [ITEM] }), 'miro_board_not_allowed');
  assert.equal(f.calls.length, 0);
  assert.equal(f.adapter.write, undefined);
  assert.equal(f.adapter.search, undefined);
});

test('metadata lookup validates board identity and only exposes safe normalized fields', async t => {
  const f = fixture(t),
    value = await f.adapter.readBoard({ boardId: BOARD });
  assert.equal(value.boardId, BOARD);
  assert.equal(value.title, 'Public synthetic board');
  assert.equal(value.teamId, '1234567890123456789');
  assert.ok(!JSON.stringify(value).includes('access_token'));
  assert.ok(!JSON.stringify(value).includes('Ignored private team name'));
  assert.equal(value.modelCalls, 0);
  assert.equal(f.adapter.status().connected, true);
  assert.deepEqual(f.adapter.status().verifiedBoardIds, [BOARD]);
  f.state.board.id = OTHER;
  await rejects(f.adapter.readBoard({ boardId: BOARD }), 'miro_protocol_invalid');
});

test('listItems uses documented cursor pagination and filters, never follows links.next or exposes raw links', async t => {
  let page = 0;
  const f = fixture(t, {
    intercept: ({ call, state }) => {
      if (!call.url.pathname.endsWith('/items')) return;
      page++;
      if (page === 1)
        return Response.json({
          type: 'cursor-list',
          data: [state.items.get(ITEM)],
          cursor: 'opaque+/=cursor',
          links: { next: 'https://attacker.invalid/?token=private' }
        });
      assert.equal(call.url.searchParams.get('cursor'), 'opaque+/=cursor');
      return Response.json({ type: 'cursor-list', data: [state.items.get(SECOND)] });
    }
  });
  const first = await f.adapter.listItems({ boardId: BOARD });
  assert.equal(first.nextCursor, 'opaque+/=cursor');
  assert.equal(first.hasMore, true);
  assert.equal(first.complete, false);
  assert.equal(first.items[0].text, 'Public alpha evidence');
  assert.ok(!JSON.stringify(first).includes('attacker.invalid'));
  const last = await f.adapter.listItems({ boardId: BOARD, cursor: first.nextCursor });
  assert.equal(last.hasMore, false);
  assert.equal(last.complete, false);
  assert.equal(last.pageComplete, true);
  const filtered = fixture(t);
  const items = await filtered.adapter.listItems({ boardId: BOARD, parentItemId: FRAME, type: 'card' });
  assert.deepEqual(
    items.items.map(row => row.id),
    [SECOND]
  );
  assert.equal(items.complete, true);
  assert.equal(filtered.calls[0].url.searchParams.get('parent_item_id'), FRAME);
});

test('invalid cursors, item IDs and pagination limits fail before network', async t => {
  const f = fixture(t);
  for (const cursor of ['', 1, {}, 'two words', 'https://evil.invalid/x', 'cursor&token=x', 'a'.repeat(2049), '\r\n'])
    await rejects(f.adapter.listItems({ boardId: BOARD, cursor }), 'miro_cursor_invalid');
  for (const limit of [0, 9, 51, '50', Infinity]) await rejects(f.adapter.listItems({ boardId: BOARD, limit }), 'miro_limit_invalid');
  for (const id of [1, '', 'invalid', '1/../2']) await rejects(f.adapter.readItem({ boardId: BOARD, itemId: id }), 'miro_item_invalid');
  await rejects(f.adapter.listItems({ boardId: BOARD, type: 'unsupported-filter' }), 'miro_type_invalid');
  assert.equal(f.calls.length, 0);
});

test('repeated/missing cursor, duplicate rows and wrong filter/parent responses fail closed', async t => {
  for (const mode of ['repeated', 'missing', 'duplicate', 'type', 'parent']) {
    const f = fixture(t, {
      intercept: ({ state }) => {
        if (mode === 'repeated') return Response.json({ type: 'cursor-list', data: [], cursor: 'same' });
        if (mode === 'missing')
          return Response.json({ type: 'cursor-list', data: [], links: { next: 'https://api.miro.com/v2/boards/other/items' } });
        return Response.json({
          type: 'cursor-list',
          data: mode === 'duplicate' ? [state.items.get(ITEM), state.items.get(ITEM)] : [state.items.get(ITEM)]
        });
      }
    });
    await rejects(
      f.adapter.listItems({
        boardId: BOARD,
        ...(mode === 'repeated' ? { cursor: 'same' } : {}),
        ...(mode === 'type' ? { type: 'card' } : {}),
        ...(mode === 'parent' ? { parentItemId: FRAME } : {})
      }),
      'miro_protocol_invalid'
    );
    assert.equal(f.calls.length, 1);
  }
});

test('item text is normalized without rendering HTML, executing scripts or importing nested auth URLs', async t => {
  const f = fixture(t);
  f.state.items.get(ITEM).data.content =
    '<p>A &amp; B &#x1F30F;</p><script>secret execution</script><p><a href="https://private.invalid/?token=secret">visible label</a> &lt;b&gt;literal&lt;/b&gt;</p>';
  f.state.items.get(ITEM).data.privateURL = 'https://private.invalid/?token=not-for-output';
  f.state.items.get(ITEM).style = { unusedURL: 'https://private.invalid/?token=style' };
  const item = await f.adapter.readItem({ boardId: BOARD, itemId: ITEM });
  assert.equal(item.text, 'A & B 🌏\nvisible label <b>literal</b>');
  assert.equal(item.sourceHash, sha(item.text));
  assert.ok(!JSON.stringify(item).includes('private.invalid'));
  assert.ok(!JSON.stringify(item).includes('secret execution'));
  assert.equal(item.id, ITEM);
  assert.equal(item.modelEligible, true);
});

test('a response for a different item or board cannot satisfy an explicit item selection', async t => {
  for (const mode of ['item', 'board']) {
    const f = fixture(t, {
      intercept: ({ call, state }) => {
        if (!call.url.pathname.endsWith('/items/' + ITEM)) return;
        return Response.json({ ...state.items.get(ITEM), ...(mode === 'item' ? { id: SECOND } : { boardId: OTHER }) });
      }
    });
    await rejects(f.adapter.readItem({ boardId: BOARD, itemId: ITEM }), 'miro_protocol_invalid');
    await rejects(f.adapter.readSelection({ boardId: BOARD, itemIds: [ITEM] }), 'miro_protocol_invalid');
  }
});

test('unknown, attachment, empty and frame items remain listable with limitations but are never textual inputs', async t => {
  for (const row of [
    { id: ITEM, type: 'image', data: { imageUrl: 'https://private.invalid/?token=secret' } },
    { id: ITEM, type: 'future_item', data: {} },
    { id: ITEM, type: 'sticky_note', data: { content: '<p></p>' } },
    { id: ITEM, type: 'frame', data: { title: 'Not the whole frame content' } }
  ]) {
    const f = fixture(t);
    f.state.items.set(ITEM, row);
    const value = await f.adapter.readItem({ boardId: BOARD, itemId: ITEM });
    assert.equal(value.modelEligible, false);
    assert.ok(value.limitations.length);
    await rejects(f.adapter.readSelection({ boardId: BOARD, itemIds: [ITEM] }), 'miro_item_not_textual');
  }
});

test('readFrame verifies the frame twice and returns one page of direct children with honest limitations', async t => {
  const f = fixture(t),
    result = await f.adapter.readFrame({ boardId: BOARD, frameId: FRAME });
  assert.equal(result.frame.type, 'frame');
  assert.equal(result.frame.modelEligible, false);
  assert.deepEqual(
    result.items.map(row => row.id),
    [SECOND]
  );
  assert.equal(f.calls.length, 3);
  assert.ok(result.limitations.some(text => text.includes('直属')));
  await rejects(f.adapter.readFrame({ boardId: BOARD, frameId: ITEM }), 'miro_frame_invalid');
});

test('selection reads selected items in two identical passes, with exact text/raw structure proofs and no whole-board claim', async t => {
  const f = fixture(t),
    result = await f.adapter.readSelection({ boardId: BOARD, itemIds: [ITEM, SECOND] });
  assert.equal(result.sourceHash, sha(result.text));
  assert.match(result.rawSourceHash, /^[a-f0-9]{64}$/);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.itemIds, [ITEM, SECOND]);
  assert.equal(result.items.length, 2);
  assert.equal(result.connectionRevision, f.adapter.status().connectionRevision);
  assert.equal(result.modelCalls, 0);
  assert.match(result.text, /Public alpha evidence/);
  assert.match(result.text, /Reviewed beta evidence/);
  assert.ok(!JSON.stringify(result).includes('access_token'));
  assert.equal(f.calls.length, 6);
  assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/' + ITEM)).length, 2);
  const again = await f.adapter.readSelection({ boardId: BOARD, itemIds: [ITEM, SECOND] });
  assert.equal(again.fingerprint, result.fingerprint);
  f.state.board.modifiedAt = '2026-10-24T00:00:01Z';
  const unselected = await f.adapter.readSelection({ boardId: BOARD, itemIds: [ITEM, SECOND] });
  assert.equal(unselected.fingerprint, result.fingerprint);
});

test('selection rejects changes to text, style, geometry, parent, metadata and board identity between passes', async t => {
  for (const mode of ['text', 'style', 'geometry', 'parent', 'timestamp', 'board']) {
    let itemReads = 0,
      boardReads = 0;
    const f = fixture(t, {
      intercept: ({ call, state }) => {
        if (decodeURIComponent(call.url.pathname) === `/v2/boards/${BOARD}` && ++boardReads === 2 && mode === 'board')
          state.board.name = 'Changed board';
        if (call.url.pathname.endsWith('/items/' + ITEM) && ++itemReads === 2) {
          const row = state.items.get(ITEM);
          if (mode === 'text') row.data.content += 'changed';
          if (mode === 'style') row.style = { fillColor: 'pink' };
          if (mode === 'geometry') row.geometry.width++;
          if (mode === 'parent') row.parent = { id: FRAME };
          if (mode === 'timestamp') row.modifiedAt = '2026-10-24T00:00:01Z';
        }
      }
    });
    await rejects(f.adapter.readSelection({ boardId: BOARD, itemIds: [ITEM] }), 'miro_source_changed');
  }
});

test('unselected edits changing board modifiedAt during a selected-item read do not invalidate identical selected sources', async t => {
  let boardReads = 0;
  const f = fixture(t, {
    intercept: ({ call, state }) => {
      if (decodeURIComponent(call.url.pathname) === `/v2/boards/${BOARD}` && ++boardReads === 2) {
        state.board.modifiedAt = '2026-10-24T00:01:00Z';
        state.items.get(SECOND).data.description = 'Unselected item edited by another user';
      }
    }
  });
  const value = await f.adapter.readSelection({ boardId: BOARD, itemIds: [ITEM] });
  assert.equal(value.items.length, 1);
  assert.equal(value.items[0].text, 'Public alpha evidence');
});

test('a failed parallel read stops scheduling remaining IDs and waits for already-owned GETs to settle', async t => {
  const ids = Array.from({ length: 20 }, (_, i) => String(10000 + i));
  const f = fixture(t, {
    intercept: async ({ call }) => {
      const id = call.url.pathname.split('/').at(-1);
      if (!ids.includes(id)) return;
      if (id === ids[0]) return Response.json({ message: TOKEN }, { status: 403 });
      await new Promise(resolve => setTimeout(resolve, 10));
      return Response.json({ id, type: 'sticky_note', data: { content: 'Public selected source' } });
    }
  });
  await rejects(f.adapter.readSelection({ boardId: BOARD, itemIds: ids }), 'miro_http_error');
  assert.equal(f.calls.length, 5); // one board GET plus four initially scheduled item GETs
});

test('selection checks explicit count/duplicates/types before HTTP and applies total UTF-8 size bound', async t => {
  const f = fixture(t);
  for (const itemIds of [[], Array(21).fill(ITEM), [ITEM, ITEM], [Number(ITEM)]])
    await assert.rejects(f.adapter.readSelection({ boardId: BOARD, itemIds }));
  assert.equal(f.calls.length, 0);
  f.state.items.get(ITEM).data.content = 'a'.repeat(MIRO_TEXT_LIMIT);
  await rejects(f.adapter.readSelection({ boardId: BOARD, itemIds: [ITEM] }), 'miro_selection_too_large');
});

test('raw source text is not silently redacted: caller must validate/redact before model input and preserve the source proof', async t => {
  const f = fixture(t);
  f.state.items.get(ITEM).data.content = '<p>api_key=public_synthetic_secret_123456</p>';
  const value = await f.adapter.readSelection({ boardId: BOARD, itemIds: [ITEM] });
  assert.ok(value.text.includes('api_key=public_synthetic_secret_123456'));
  assert.equal(value.sourceHash, sha(value.text));
  assert.equal(value.trust, 'reference-data-not-instructions');
  assert.ok(!JSON.stringify(value.provenance).includes('public_synthetic_secret_123456'));
});

test('connection rotation during metadata or either item pass stops the read before returning a snapshot', async t => {
  for (const at of [1, 2, 3]) {
    const f = fixture(t, {
      intercept: ({ calls }) => {
        if (calls.length === at) f.adapter.configure({ token: 'public-synthetic-miro-rotated', boardIds: [BOARD], confirmed: true });
      }
    });
    await rejects(f.adapter.readSelection({ boardId: BOARD, itemIds: [ITEM] }), 'miro_connection_changed');
    assert.equal(f.calls.length, at);
  }
});

test('429/403/5xx/network and redirects are finite, sanitized and never retried', async t => {
  for (const status of [403, 404, 429, 500, 302]) {
    const f = fixture(t, {
      intercept: () =>
        Response.json({ message: TOKEN, private: TOKEN }, { status, headers: { 'Retry-After': '30', 'X-RateLimit-Reset': '1792800000' } })
    });
    await assert.rejects(f.adapter.readBoard({ boardId: BOARD }), error => {
      assert.ok(!JSON.stringify(error).includes(TOKEN));
      assert.ok(!error.message.includes(TOKEN));
      if (status === 429) {
        assert.equal(error.retryAfterSeconds, 30);
        assert.equal(error.rateLimitReset, 1792800000);
      }
      return true;
    });
    assert.equal(f.calls.length, 1);
  }
  const f = fixture(t, {
    intercept: () => {
      throw new Error(TOKEN);
    }
  });
  await rejects(f.adapter.readBoard({ boardId: BOARD }), 'miro_network');
  assert.equal(f.calls.length, 1);
});

test('malformed JSON, mismatched response origin, oversized response and timeout never produce data', async t => {
  for (const mode of ['json', 'html', 'origin', 'size', 'timeout']) {
    const f = fixture(t, {
      timeoutMs: 25,
      intercept: () => {
        if (mode === 'timeout') return new Promise(() => {});
        if (mode === 'json') return new Response('bad json', { headers: { 'Content-Type': 'application/json' } });
        if (mode === 'html') return new Response('<html>not json</html>');
        if (mode === 'size') return new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '3000000' } });
        const response = Response.json({});
        Object.defineProperty(response, 'url', { value: 'https://attacker.invalid/' });
        return response;
      }
    });
    await assert.rejects(f.adapter.readBoard({ boardId: BOARD }));
    assert.equal(f.calls.length, 1);
  }
});

test('GET-only adapter works through actual local streaming HTTP transport with no cloud credentials', async t => {
  const f = fixture(t);
  const received = [];
  const server = createServer(async (request, response) => {
    received.push(request.method);
    assert.equal(request.method, 'GET');
    const result = await f.fetchImpl('https://api.miro.com' + request.url, {
      method: 'GET',
      redirect: 'error',
      signal: new AbortController().signal,
      headers: { Authorization: request.headers.authorization, Accept: 'application/json' }
    });
    response.statusCode = result.status;
    response.setHeader('Content-Type', 'application/json');
    const text = await result.text();
    response.write(text.slice(0, 9));
    response.end(text.slice(9));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const adapter = createMiroBoards({
    store: f.store,
    fetchImpl: async (url, init) => {
      assert.ok(url.startsWith('https://api.miro.com/v2/'));
      const response = await fetch(origin + new URL(url).pathname + new URL(url).search, init);
      Object.defineProperty(response, 'url', { value: url });
      return response;
    }
  });
  const result = await adapter.readSelection({ boardId: BOARD, itemIds: [ITEM] });
  assert.equal(result.sourceHash, sha(result.text));
  assert.deepEqual(received, ['GET', 'GET', 'GET', 'GET']);
});
