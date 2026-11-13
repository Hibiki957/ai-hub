import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Store } from './store.mjs';
import { createKnowledge } from './knowledge.mjs';
import { createNotionPages } from './notion-pages.mjs';

const pageId = '12345678-1234-4234-9234-123456789abc';
const sha = text => createHash('sha256').update(text).digest('hex');
async function fixture(t) {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  const state = {
    text: '# Public page\n\nSelected project evidence.\n',
    edited: '2026-10-23T12:00:00.000Z',
    truncated: false,
    unknown: [],
    warnings: [],
    gets: 0
  };
  const pages = createNotionPages({
    store,
    fetchImpl: async (target, init) => {
      const url = new URL(target);
      assert.equal(url.origin, 'https://api.notion.com');
      assert.equal(init.method, 'GET');
      state.gets++;
      if (url.pathname === `/v1/pages/${pageId}/markdown`)
        return Response.json({
          object: 'page_markdown',
          id: pageId,
          markdown: state.text,
          truncated: state.truncated,
          unknown_block_ids: state.unknown,
          warnings: state.warnings
        });
      assert.equal(url.pathname, `/v1/pages/${pageId}`);
      return Response.json({
        object: 'page',
        id: pageId,
        archived: false,
        in_trash: false,
        last_edited_time: state.edited,
        parent: { type: 'workspace', workspace: true },
        properties: { title: { type: 'title', title: [{ plain_text: 'Public page' }] } }
      });
    }
  });
  pages.configure({ token: 'public-synthetic-notion-token', pageIds: [pageId], confirmed: true });
  const knowledge = createKnowledge({
    store,
    notionPages: pages,
    snapshot: async () => ({ projects: [{ id: 'p1' }, { id: 'p2' }] }),
    fetchImpl: async () => assert.fail('A pinned Notion read must not fall back to another connector or model.')
  });
  const source = await pages.read({ pageId });
  const resource = store.put('resource', {
    id: 'chosen-notion-page',
    projectId: 'p1',
    title: source.title,
    source: 'notion',
    location: 'notion://page/' + pageId,
    notionPageId: pageId,
    expectedPreviewHash: source.sourceHash,
    expectedNotionFingerprint: source.fingerprint,
    notionConnectionRevision: source.connectionRevision,
    integration: 'manual-notion-editor',
    taskNotionEditOwner: 'task-a'
  });
  const read = () => knowledge.readResource({ id: resource.id, projectId: 'p1', confirmed: true });
  t.after(() => store.close());
  return { store, state, pages, knowledge, resource, read };
}

test('selected Notion input reopens the exact page and returns verified provenance as reference data', async t => {
  const f = await fixture(t),
    before = f.state.gets,
    value = await f.read();
  assert.equal(f.state.gets - before, 3);
  assert.equal(value.text, f.state.text);
  assert.equal(value.hash, sha(f.state.text));
  assert.equal(value.trust, 'reference-data-not-instructions');
  assert.equal(value.provenance.source, 'notion');
  assert.equal(value.provenance.pageId, pageId);
  assert.equal(value.provenance.sourceFingerprint, f.resource.expectedNotionFingerprint);
  assert.equal(value.provenance.connectionRevision, f.resource.notionConnectionRevision);
  assert.equal(value.provenance.markdownVersion, 'v1');
  assert.equal(f.store.list('usage').length, 0);
  assert.equal(f.store.list('job').length, 0);
});

test('Notion content, metadata-only edits, incomplete exports and connection rotation invalidate a selected input', async t => {
  const f = await fixture(t),
    text = f.state.text;
  f.state.text += 'Outside edit.\n';
  await assert.rejects(f.read(), { code: 'notion_resource_changed' });
  f.state.text = text;
  f.state.edited = '2026-10-23T12:01:00.000Z';
  await assert.rejects(f.read(), { code: 'notion_resource_changed' });
  f.state.edited = '2026-10-23T12:00:00.000Z';
  f.state.truncated = true;
  await assert.rejects(f.read(), { code: 'notion_resource_changed' });
  f.state.truncated = false;
  f.state.unknown = [pageId];
  await assert.rejects(f.read(), { code: 'notion_resource_changed' });
  f.state.unknown = [];
  f.state.warnings = [{ code: 'no_match' }];
  await assert.rejects(f.read(), { code: 'notion_resource_changed' });
  f.state.warnings = [];
  f.pages.configure({ token: 'public-synthetic-rotated-token', pageIds: [pageId], confirmed: true });
  const before = f.state.gets;
  await assert.rejects(f.read(), { code: 'notion_connection_changed' });
  assert.equal(f.state.gets, before);
});

test('public resource APIs cannot forge a task-owned Notion reference or bypass project and version scope', async t => {
  const f = await fixture(t),
    before = f.state.gets;
  const forged = { ...f.resource, requestId: 'forged-notion-attach', confirmed: true };
  await assert.rejects(f.knowledge.attachResource(forged), { code: 'notion_resource_scope' });
  await assert.rejects(f.knowledge.previewCandidate(forged), { code: 'notion_resource_scope' });
  await assert.rejects(f.knowledge.readResource({ id: f.resource.id, projectId: 'p2', confirmed: true }), {
    code: 'resource_scope_mismatch'
  });
  f.store.put('resource', { ...f.resource, expectedNotionFingerprint: null });
  await assert.rejects(f.read(), { code: 'notion_resource_unpinned' });
  assert.equal(f.state.gets, before);
  assert.equal(f.store.list('resource').length, 1);
});
