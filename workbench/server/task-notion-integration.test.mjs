import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createNotionWorkspaceFixture,
  fixtureToken,
  fixturePageId,
  originalBody,
  resultBody
} from '../web/tests/notion-workspace-fixture.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, options = {}) {
  const f = await createNotionWorkspaceFixture({ build: false, ...options });
  t.after(() => f.close());
  const login = await f.app.inject({ method: 'POST', url: '/api/session', payload: { token: fixtureToken } });
  assert.equal(login.statusCode, 200, login.body);
  const session = login.cookies[0].value;
  const inject = (url, payload) =>
    f.app.inject({
      url,
      method: payload === undefined ? 'GET' : 'POST',
      cookies: { hub_session: session },
      ...(payload !== undefined ? { payload } : {})
    });
  const ok = response => {
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    },
    task = f.tasks[0],
    base = `/api/tasks/${task.id}/notion`;
  const open = async () => ok(await inject(base + '/pages/open', { pageId: fixturePageId, confirmed: true }));
  const start = async () => {
    const source = await open();
    return ok(
      await inject(base + '/drafts/start', {
        pageId: fixturePageId,
        expectedSourceHash: source.sourceHash,
        expectedFingerprint: source.fingerprint,
        expectedContextDigest: source.contextDigest,
        requestId: 'start-notion',
        confirmed: true
      })
    );
  };
  const prepared = async () => {
    const draft = await start(),
      saved = ok(
        await inject(base + `/drafts/${draft.id}/save`, {
          expectedDigest: draft.digest,
          text: resultBody,
          requestId: 'save-notion',
          confirmed: true
        })
      );
    return ok(
      await inject(base + `/drafts/${draft.id}/prepare`, { expectedDigest: saved.digest, requestId: 'prepare-notion', confirmed: true })
    );
  };
  const decide = (draft, allow = true, idempotencyKey = 'decide-notion') => ({
    command: {
      type: 'approval.decide',
      id: draft.approval.id,
      allow,
      digest: draft.approval.digest,
      taskRevision: draft.approval.taskRevision
    },
    idempotencyKey
  });
  return { f, task, base, inject, ok, open, start, prepared, decide };
}

test('actual App HTTP → main approval decision → one finite protocol PATCH → independent readback → explicit page input, with no model calls', async t => {
  const { f, task, base, inject, ok, open, prepared, decide } = await fixture(t);
  const preview = await open();
  assert.equal(preview.text, originalBody);
  assert.equal(f.store.list('task-notion-draft').length, 0);
  assert.equal(f.store.list('resource').length, 1);
  const draft = await prepared();
  assert.equal(draft.status, 'prepared');
  assert.equal(draft.approval.status, 'pending');
  assert.equal((await f.readRemote()).text, originalBody);
  assert.equal((await inject(base + `/drafts/${draft.id}/publish`, {})).statusCode, 404);
  const resume = await inject('/api/commands', {
    command: { type: 'task.resume', id: task.id },
    idempotencyKey: 'resume-during-notion-draft'
  });
  assert.equal(resume.statusCode, 409, resume.body);
  assert.equal(resume.json().code, 'task_notion_edit_pending');
  await assert.rejects(f.brain.start(task.id), { code: 'task_notion_edit_pending' });
  const publication = ok(await inject('/api/commands', decide(draft)));
  assert.equal(publication.commandResult.requiresResume, false);
  assert.equal(publication.commandResult.publication.completed, true);
  assert.equal(publication.commandResult.publication.actualHash, sha(resultBody));
  assert.equal((await f.readRemote()).text, resultBody);
  const afterWrite = await f.state();
  assert.equal(afterWrite.counters.notionPATCHes, 1);
  assert.equal(afterWrite.counters.publicationReceipts, 1);
  assert.equal(afterWrite.tasks[0].context.resourceIds.length, 1);
  assert.equal(afterWrite.tasks[0].context.items[0].id, 'notion-retained-note-a');
  const input = {
    expectedResultHash: sha(resultBody),
    expectedContextDigest: afterWrite.tasks[0].context.digest,
    requestId: 'use-notion-result',
    confirmed: true
  };
  const returned = ok(await inject(base + `/drafts/${draft.id}/use-input`, input));
  assert.equal(returned.context.status, 'prepared');
  assert.deepEqual(returned.context.resourceIds, ['notion-retained-note-a', returned.resource.id]);
  assert.equal(returned.context.items.find(item => item.id === returned.resource.id).provenance.sourceHash, sha(resultBody));
  assert.equal((await f.app.hub.taskContexts.readForUse(task.id)).items.find(item => item.id === returned.resource.id).text, resultBody);
  const inputReplay = ok(await inject(base + `/drafts/${draft.id}/use-input`, input));
  assert.equal(inputReplay.replayed, true);
  assert.equal(inputReplay.context.digest, returned.context.digest);
  const replayedDecision = ok(await inject('/api/commands', decide(draft)));
  assert.equal(
    replayedDecision.commandResult.publication,
    undefined,
    'The durable decision receipt is not fabricated into a publication receipt.'
  );
  const differentDecisionId = await inject('/api/commands', decide(draft, true, 'duplicate-decision-new-client-id'));
  assert.equal(differentDecisionId.statusCode, 409);
  assert.equal(differentDecisionId.json().code, 'approval_expired');
  const final = await f.state();
  assert.equal(final.counters.notionPATCHes, 1);
  assert.equal(final.counters.modelCalls, 0);
  assert.equal(final.counters.paperclipMutations, 0);
  assert.equal(final.counters.jobs, 0);
  assert.equal(final.counters.workerRuns, 0);
  assert.equal(final.counters.modelIntents, 0);
  assert.equal(final.tasks[1].context, null);
  assert.equal(final.tasks[1].drafts.length, 0);
  assert.equal(final.realNotionWrites, 0);
  assert.equal(final.originalProductionWrites, 0);
});

test('explicit original page selection is pinned and later publication replaces only this page while retaining other task input', async t => {
  const { f, base, inject, ok, open, prepared, decide } = await fixture(t),
    source = await open();
  const selected = ok(
    await inject(base + '/use-source', {
      pageId: source.pageId,
      expectedSourceHash: source.sourceHash,
      expectedFingerprint: source.fingerprint,
      expectedContextDigest: source.contextDigest,
      requestId: 'use-original',
      confirmed: true
    })
  );
  assert.equal(selected.context.resourceIds.length, 2);
  const originalResource = selected.resource.id;
  const draft = await prepared();
  ok(await inject('/api/commands', decide(draft)));
  const stale = f.app.hub.taskContexts.snapshot(f.tasks[0].id);
  assert.equal(stale.status, 'stale');
  const returned = ok(
    await inject(base + `/drafts/${draft.id}/use-input`, {
      expectedResultHash: sha(resultBody),
      expectedContextDigest: stale.digest,
      requestId: 'replace-original-page',
      confirmed: true
    })
  );
  assert.equal(returned.context.resourceIds.includes(originalResource), false);
  assert.equal(returned.context.resourceIds.includes('notion-retained-note-a'), true);
  assert.equal(returned.context.resourceIds.length, 2);
  assert.equal((await f.state()).counters.notionPATCHes, 1);
});

test('a lost protocol response remains durable unknown across real Store/App restart; replayed approval never emits another PATCH', async t => {
  const { f, task, base, inject, ok, prepared, decide } = await fixture(t),
    draft = await prepared();
  f.injectLostResponse();
  const response = await inject('/api/commands', decide(draft));
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, 'notion_write_unknown');
  assert.equal((await f.readRemote()).text, resultBody);
  assert.equal((await f.state()).counters.notionPATCHes, 1);
  assert.equal(f.manager.list(task.id)[0].status, 'outcome_unknown');
  await f.restart();
  const unknown = ok(await inject(base + '/drafts')).drafts[0];
  assert.equal(unknown.status, 'outcome_unknown');
  ok(await inject('/api/commands', decide(draft)));
  assert.equal((await f.state()).counters.notionPATCHes, 1);
  const reconciled = ok(await inject(base + `/drafts/${draft.id}/reconcile`, { confirmed: true }));
  assert.equal(reconciled.matchesResult, true);
  assert.equal(reconciled.claimReleased, false);
  assert.equal(f.manager.list(task.id)[0].status, 'outcome_unknown');
  const discard = await inject(base + `/drafts/${draft.id}/discard`, {
    expectedDigest: draft.digest,
    requestId: 'discard-unknown',
    confirmed: true
  });
  assert.equal(discard.statusCode, 409, discard.body);
  const blocked = await inject('/api/commands', {
    command: { type: 'task.resume', id: task.id },
    idempotencyKey: 'resume-during-unknown-notion'
  });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().code, 'task_notion_edit_pending');
  const state = await f.state();
  assert.equal(state.counters.serviceRestarts, 1);
  assert.equal(state.counters.notionPATCHes, 1);
  assert.equal(state.counters.jobs, 0);
  assert.equal(state.pageClaims[0].status, 'outcome_unknown');
});

test('task/project routing cannot read another task draft or claim the same page through another execution surface', async t => {
  const { f, base, inject, ok, open, start } = await fixture(t),
    source = await open(),
    draft = await start(),
    otherBase = `/api/tasks/${f.tasks[1].id}/notion`;
  const foreign = await inject(otherBase + `/drafts/${draft.id}`);
  assert.equal(foreign.statusCode, 404, foreign.body);
  const second = await inject(otherBase + '/drafts/start', {
    pageId: fixturePageId,
    expectedSourceHash: source.sourceHash,
    expectedFingerprint: source.fingerprint,
    expectedContextDigest: null,
    requestId: 'other-start',
    confirmed: true
  });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().code, 'task_notion_page_claimed');
  const list = ok(await inject(otherBase + '/drafts'));
  assert.deepEqual(list.drafts, []);
  for (const extra of [
    { path: '/tmp/unrequested' },
    { token: 'public-synthetic-ignored' },
    { projectId: f.tasks[1].projectId },
    { taskId: f.tasks[1].id }
  ])
    assert.equal((await inject(base + '/pages/open', { pageId: fixturePageId, confirmed: true, ...extra })).statusCode, 400);
  assert.equal((await f.state()).counters.notionPATCHes, 0);
});

test('denial and drift preserve the actual remote page and never schedule a model or job', async t => {
  const { f, base, inject, ok, prepared, decide } = await fixture(t),
    draft = await prepared();
  const denied = ok(await inject('/api/commands', decide(draft, false)));
  assert.equal(denied.commandResult.requiresResume, false);
  assert.equal((await f.readRemote()).text, originalBody);
  const saved = ok(
    await inject(base + `/drafts/${draft.id}/save`, {
      expectedDigest: draft.digest,
      text: resultBody + 'Another reviewed line.\n',
      requestId: 'save-after-denial',
      confirmed: true
    })
  );
  const preparedAgain = ok(
    await inject(base + `/drafts/${draft.id}/prepare`, { expectedDigest: saved.digest, requestId: 'prepare-after-denial', confirmed: true })
  );
  const remote = await f.readRemote();
  remote.text = 'Changed outside the editor.\n';
  remote.edited++;
  await f.writeRemote(remote);
  const approvedDrift = await inject('/api/commands', decide(preparedAgain, true, 'approve-drift'));
  assert.equal(approvedDrift.statusCode, 409, approvedDrift.body);
  assert.equal((await f.readRemote()).text, remote.text);
  ok(await inject('/api/commands', decide(preparedAgain, true, 'approve-drift')));
  const state = await f.state();
  assert.equal(state.counters.notionPATCHes, 0);
  assert.equal(state.counters.modelCalls, 0);
  assert.equal(state.counters.jobs, 0);
});

test('the task-scoped page input cannot be changed by a model/user plan while a Notion draft is active', async t => {
  const { f, task, inject, start } = await fixture(t);
  await start();
  const changed = await inject(`/api/tasks/${task.id}/context/clear`, {
    expectedDigest: f.app.hub.taskContexts.snapshot(task.id).digest,
    requestId: 'clear-during-notion',
    confirmed: true
  });
  assert.equal(changed.statusCode, 409, changed.body);
  assert.equal(changed.json().code, 'task_context_notion_edit_active');
  assert.equal((await f.state()).counters.notionPATCHes, 0);
});

test('configuration HTTP reports plain unconfigured status and encrypts explicit credentials without reading any page', async t => {
  const { f, task, inject, ok } = await fixture(t, { configured: false }),
    route = `/api/tasks/${task.id}/tools/notion/configuration`;
  const empty = ok(await inject(route));
  assert.equal(empty.configured, false);
  assert.equal(empty.connected, null);
  assert.equal(empty.connectionRevision, null);
  assert.equal((await f.state()).counters.notionGETs, 0);
  const unavailable = await inject(`/api/tasks/${task.id}/notion/pages/open`, { pageId: fixturePageId, confirmed: true });
  assert.equal(unavailable.statusCode, 409);
  assert.equal(unavailable.json().code, 'notion_not_configured');
  assert.equal((await f.state()).counters.notionGETs, 0);
  const token = 'public-synthetic-notion-api-no-real-credentials',
    saved = ok(await inject(route, { token, pageIds: [fixturePageId], confirmed: true }));
  assert.equal(saved.configured, true);
  assert.equal(saved.connected, null);
  assert.equal(saved.pageCount, 1);
  assert.equal(saved.modelCalls, 0);
  assert.equal((await f.state()).counters.notionGETs, 0);
  assert.equal((await f.state()).counters.notionPATCHes, 0);
  const persisted = f.store.get('knowledge-connector', 'notion');
  assert.equal(f.store.unseal(persisted.sealedToken), token);
  assert.equal(JSON.stringify(persisted).includes(token), false);
  assert.equal(JSON.stringify(saved).includes(token), false);
  assert.equal(JSON.stringify(saved).includes('sealedToken'), false);
  // The UI represents a blank token field by omitting token, preserving the
  // Hub-owned encrypted credential; an explicit empty replacement is rejected.
  const stable = ok(await inject(route, { pageIds: [fixturePageId.toUpperCase()], confirmed: true }));
  assert.equal(stable.connectionRevision, saved.connectionRevision);
  assert.equal(f.store.get('knowledge-connector', 'notion').sealedToken, persisted.sealedToken);
  const explicitEmpty = await inject(route, { token: '', pageIds: [fixturePageId], confirmed: true });
  assert.equal(explicitEmpty.statusCode, 400);
  assert.equal(explicitEmpty.json().code, 'notion_token_invalid');
  assert.equal(f.store.get('knowledge-connector', 'notion').connectionRevision, saved.connectionRevision);
  assert.equal((await f.state()).counters.notionGETs, 0);
});

test('configuration scope, confirmation, field allowlist, queries and ended task are checked before storing or fetching', async t => {
  const { f, task, inject, ok } = await fixture(t),
    route = `/api/tasks/${task.id}/tools/notion/configuration`,
    before = ok(await inject(route));
  for (const extra of [
    { apiKey: 'public-synthetic-unused' },
    { headers: { Authorization: 'unused' } },
    { endpoint: 'https://example.invalid' },
    { projectId: 'other' },
    { taskId: 'other' },
    { sealedToken: 'unused' }
  ]) {
    const response = await inject(route, { pageIds: [fixturePageId], confirmed: true, ...extra });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'notion_configuration_fields_invalid');
  }
  for (const pageIds of [[], ['https://notion.so.evil.example/' + fixturePageId], ['https://127.0.0.1/' + fixturePageId], ['not-a-page']])
    assert.ok((await inject(route, { pageIds, confirmed: true })).statusCode >= 400);
  assert.equal((await inject(route, { pageIds: [fixturePageId] })).statusCode, 400);
  assert.equal((await inject(route + '?token=public-synthetic-unused')).statusCode, 400);
  assert.equal((await inject(route + '?endpoint=https://example.invalid', { pageIds: [fixturePageId], confirmed: true })).statusCode, 400);
  for (const status of ['done', 'archived', 'cancelled']) {
    task.status = status;
    const response = await inject(route, { pageIds: [fixturePageId], confirmed: true });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'notion_configuration_task_ended');
  }
  task.status = 'review';
  assert.equal(ok(await inject(route)).connectionRevision, before.connectionRevision);
  assert.equal((await f.state()).counters.notionGETs, 0);
  const otherPage = '3c90c3cc-0d44-4b50-8888-8dd25736052a',
    changed = ok(await inject(route, { pageIds: [fixturePageId, otherPage], confirmed: true }));
  assert.equal(changed.pageCount, 2);
  assert.notEqual(changed.connectionRevision, before.connectionRevision);
  assert.equal((await f.state()).counters.notionGETs, 0);
});

test('any task with unknown page publication blocks global connection rotation without changing ciphertext or scope', async t => {
  const { f, inject, prepared, decide } = await fixture(t),
    draft = await prepared();
  f.injectLostResponse();
  assert.equal((await inject('/api/commands', decide(draft))).statusCode, 409);
  const before = f.store.get('knowledge-connector', 'notion'),
    count = (await f.state()).counters.notionGETs,
    response = await inject(`/api/tasks/${f.tasks[1].id}/tools/notion/configuration`, {
      token: 'public-synthetic-different-token',
      pageIds: [fixturePageId],
      confirmed: true
    });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, 'notion_configuration_publication_pending');
  assert.deepEqual(f.store.get('knowledge-connector', 'notion'), before);
  assert.equal((await f.state()).counters.notionGETs, count);
  assert.equal((await f.state()).counters.notionPATCHes, 1);
});

test('zero-PATCH host preflight rejection preserves editable draft and allows a new explicit approval without replaying the old decision', async t => {
  const { f, task, base, inject, ok, prepared, decide } = await fixture(t),
    draft = await prepared();
  f.beforeNotionGET(() => {
    if (f.store.get('task-notion-draft', draft.id).status === 'committing') task.status = 'running';
  });
  const stopped = await inject('/api/commands', decide(draft));
  assert.equal(stopped.statusCode, 409, stopped.body);
  assert.equal(stopped.json().code, 'notion_write_authority_changed');
  assert.equal((await f.state()).counters.notionPATCHes, 0);
  assert.equal(f.manager.list(task.id)[0].status, 'draft');
  assert.equal(f.store.list('notion-page-writer')[0].status, 'held');
  assert.equal((await f.readRemote()).text, originalBody);
  task.status = 'review';
  f.beforeNotionGET(null);
  ok(await inject('/api/commands', decide(draft)));
  assert.equal((await f.state()).counters.notionPATCHes, 0);
  const retained = ok(await inject(base + `/drafts/${draft.id}`)),
    newDraft = ok(
      await inject(base + `/drafts/${draft.id}/prepare`, {
        expectedDigest: retained.digest,
        requestId: 'prepare-new-safe-attempt',
        confirmed: true
      })
    );
  assert.notEqual(newDraft.approval.id, draft.approval.id);
  assert.notEqual(newDraft.publication.digest, draft.publication.digest);
  const finished = ok(await inject('/api/commands', decide(newDraft, true, 'approve-new-safe-attempt')));
  assert.equal(finished.commandResult.publication.completed, true);
  assert.equal((await f.state()).counters.notionPATCHes, 1);
});

test('denied and expired main gates project their current status and support explicit reprepare without editing the body', async t => {
  const { f, base, inject, ok, prepared, decide } = await fixture(t),
    draft = await prepared();
  ok(await inject('/api/commands', decide(draft, false)));
  const denied = ok(await inject(base + `/drafts/${draft.id}`));
  assert.equal(denied.approval.status, 'denied');
  const replayedPrepare = await inject(base + `/drafts/${draft.id}/prepare`, {
    expectedDigest: denied.digest,
    requestId: 'prepare-notion',
    confirmed: true
  });
  assert.equal(replayedPrepare.statusCode, 409);
  assert.equal(replayedPrepare.json().code, 'task_notion_publication_stale');
  const next = ok(
    await inject(base + `/drafts/${draft.id}/prepare`, {
      expectedDigest: denied.digest,
      requestId: 'prepare-after-denial-unchanged-body',
      confirmed: true
    })
  );
  assert.equal(next.approval.status, 'pending');
  assert.notEqual(next.approval.id, draft.approval.id);
  assert.equal(next.resultHash, draft.resultHash);
  const gate = f.store.get('gate', next.approval.id);
  f.store.put('gate', { ...gate, expiresAt: '2020-01-01T00:00:00.000Z' });
  const expired = ok(await inject(base + `/drafts/${draft.id}`));
  assert.equal(expired.approval.status, 'expired');
  const final = ok(
    await inject(base + `/drafts/${draft.id}/prepare`, {
      expectedDigest: expired.digest,
      requestId: 'prepare-after-expiry-unchanged-body',
      confirmed: true
    })
  );
  assert.equal(final.approval.status, 'pending');
  assert.notEqual(final.approval.id, next.approval.id);
  assert.equal((await f.state()).counters.notionPATCHes, 0);
});
