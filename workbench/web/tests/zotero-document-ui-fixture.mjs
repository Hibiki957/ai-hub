// Private, complete-App fixture. Only Paperclip records and the Zotero HTTP
// source are synthetic. SQLite, auth, CSP, PDF parsing, task-scoped readers,
// exact page quotes, resource selection and source re-verification are real.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../../server/app.mjs';
import { createKnowledge } from '../../server/knowledge.mjs';
import { createZoteroDocuments } from '../../server/zotero-documents.mjs';
import { Store } from '../../server/store.mjs';

export const zoteroFixtureToken = 'public-synthetic-zotero-reader-fixture-only-20261023';
export const publicParentKey = 'ABCD2345',
  publicAttachmentKey = 'BCDE3456';
export const firstPageText = 'First page: alpha background. This page is not the selected evidence.';
export const secondPageText = 'Second page: beta evidence. Quote only this sentence, not the whole document.';
const sha = value => createHash('sha256').update(value).digest('hex');

export function publicTwoPagePDF({ first = firstPageText, second = secondPageText } = {}) {
  const streams = [first, second].map(text => `BT /F1 12 Tf 32 720 Td (${text.replace(/[\\()]/g, value => '\\' + value)}) Tj ET\n`);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...streams.map(stream => `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`)
  ];
  let result = '%PDF-1.4\n% public synthetic task reader\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(result));
    result += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(result);
  result +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`)
      .join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}

export async function createZoteroDocumentUIFixture({ buildUI = true } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'aihub-zotero-document-ui-'))),
    dataDir = join(directory, 'service'),
    webRoot = join(directory, 'web-dist');
  const pdfPath = join(directory, 'public-two-page.pdf'),
    priorPath = join(directory, 'prior.md'),
    pdfBytes = publicTwoPagePDF();
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(pdfPath, pdfBytes);
  await writeFile(priorPath, '# Prior task input\n\nKeep this task input when selecting one PDF page excerpt.\n');
  let store, app;
  try {
    if (buildUI) {
      const [{ build: buildWeb }, { default: react }] = await Promise.all([import('vite'), import('@vitejs/plugin-react')]);
      await buildWeb({
        configFile: false,
        root: fileURLToPath(new URL('..', import.meta.url)),
        plugins: [react()],
        logLevel: 'error',
        build: { outDir: webRoot, emptyOutDir: true }
      });
    } else {
      await mkdir(webRoot, { mode: 0o700 });
      await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>API-only isolated Zotero fixture</title>');
    }
    const encryptionKey = randomBytes(32).toString('base64');
    store = new Store(join(dataDir, 'sidecar.sqlite'), encryptionKey);
    const counters = {
      modelCalls: 0,
      paperclipMutations: 0,
      realConnectorRequests: 0,
      originalProductionWrites: 0,
      syntheticSourceChanges: 0,
      lostResponses: 0
    };
    const pdfState = { serverId: 'public-fixture-zotero-instance', version: 4 },
      connectorRequests = [];
    const tasks = ['a', 'b'].map(suffix => ({
      id: `pdf-fixture-${suffix}`,
      projectId: `pdf-project-${suffix}`,
      title: suffix === 'a' ? '任务 A · PDF 阅读与页引用验收' : '任务 B · 文档范围隔离',
      goal: '在任务中打开真实两页 PDF，查看第二页，选择文字、添加批注，并明确加入任务输入。',
      status: 'blocked',
      revision: `public-pdf-task-${suffix}-1`,
      artifacts: [],
      progress: { completed: 0, total: 1 },
      steps: [
        {
          id: `select-page-${suffix}`,
          title: '阅读 PDF 并引用具体页面',
          status: 'blocked',
          description: '在右侧 Zotero 工具中查询公开合成文献，展开附件并阅读第二页；此任务不提供模型或执行器。',
          error: '等待人工选择引用，不会自动启动后续任务。',
          dependsOn: [],
          assignment: { harnessId: 'fixture-none', modelId: 'fixture-no-model' }
        }
      ]
    }));
    const projects = tasks.map(task => ({
      id: task.projectId,
      name: task.id.endsWith('-a') ? '隔离项目 A · PDF 文档' : '隔离项目 B · 无输入'
    }));
    const paperclip = {
      async task(id) {
        return { task: structuredClone(tasks.find(task => task.id === id) || null) };
      },
      async snapshot() {
        return {
          projects: structuredClone(projects),
          tasks: structuredClone(tasks),
          approvals: [],
          pool: { models: [], harnesses: [] },
          events: [],
          global: {},
          backend: { version: 'isolated-zotero-document-fixture' }
        };
      },
      async company() {
        return 'public-pdf-fixture-company';
      },
      async request() {
        counters.paperclipMutations++;
        assert.fail('Document reading cannot issue Paperclip mutations.');
      },
      async command() {
        counters.paperclipMutations++;
        assert.fail('Document reading cannot issue Paperclip commands.');
      }
    };
    const row = (key, data) => ({
      key,
      version: pdfState.version,
      library: { type: 'user', id: 0 },
      data: { key, version: pdfState.version, ...data }
    });
    const article = () =>
      row(publicParentKey, {
        itemType: 'journalArticle',
        title: '公开合成文献 · 两页 PDF',
        abstractNote: '此摘要只是元数据；实际证据位于明确 PDF 的第二页。',
        creators: [{ firstName: 'Public', lastName: 'Fixture' }]
      });
    const attachment = () =>
      row(publicAttachmentKey, {
        itemType: 'attachment',
        parentItem: publicParentKey,
        title: '公开两页文档 · 可在任务内阅读',
        contentType: 'application/pdf',
        linkMode: 'imported_file'
      });
    const note = () =>
      row('CDEF4567', { itemType: 'note', parentItem: publicParentKey, note: '<p>公开临时笔记：请比较第二页中的 beta evidence。</p>' });
    const fetchZotero = async (target, input) => {
      const url = new URL(target);
      connectorRequests.push({ origin: url.origin, method: input.method, pathname: url.pathname });
      assert.equal(url.origin, 'http://127.0.0.1:23119');
      assert.equal(input.method, 'GET');
      assert.equal(input.redirect, 'error');
      assert.equal(input.headers.Authorization, undefined);
      assert.equal(input.headers['Zotero-API-Key'], undefined);
      const headers = { 'X-Zotero-Version': '10.0.6', 'Zotero-API-Version': '3', 'Zotero-Server-ID': pdfState.serverId };
      if (url.pathname === '/api/') return new Response('Local API', { headers });
      if (input.headers['Zotero-Server-ID'] && input.headers['Zotero-Server-ID'] !== pdfState.serverId)
        return new Response('Changed instance', { status: 412, headers });
      const prefix = '/api/users/0/items';
      if (url.pathname === prefix) {
        assert.equal(url.searchParams.get('limit'), '10');
        return Response.json([article()], { headers });
      }
      if (url.pathname === `${prefix}/${publicParentKey}`) return Response.json(article(), { headers });
      if (url.pathname === `${prefix}/${publicAttachmentKey}`) return Response.json(attachment(), { headers });
      if (url.pathname === `${prefix}/CDEF4567`) return Response.json(note(), { headers });
      if (url.pathname === `${prefix}/${publicParentKey}/children`)
        return Response.json([attachment(), note()], { headers: { ...headers, 'Total-Results': '2' } });
      if (url.pathname === `${prefix}/${publicAttachmentKey}/children`)
        return Response.json([], { headers: { ...headers, 'Total-Results': '0' } });
      if (url.pathname === `${prefix}/${publicAttachmentKey}/file/view/url`) return new Response(pathToFileURL(pdfPath).href, { headers });
      if (url.pathname === `${prefix}/${publicAttachmentKey}/fulltext`)
        return new Response('No synthetic fulltext index.', { status: 404, headers });
      assert.fail('Only explicitly selected public synthetic Zotero rows may be read: ' + url.pathname);
    };
    const documents = createZoteroDocuments({ fetchImpl: fetchZotero });
    app = await createApp({
      dataDir,
      store,
      encryptionKey,
      accessToken: zoteroFixtureToken,
      paperclip,
      webRoot,
      zoteroDocuments: documents,
      fetchImpl: async () => {
        counters.modelCalls++;
        assert.fail('Document reader fixture cannot call any provider.');
      }
    });
    app.hub.providers.complete = async () => {
      counters.modelCalls++;
      assert.fail('PDF reading and selection cannot call a model.');
    };
    const knowledge = createKnowledge({ store, snapshot: async () => ({ projects }), fetchImpl: fetchZotero, zoteroDocuments: documents });
    knowledge.status = async () => ({
      resourceLimits: { bytes: 256 * 1024, explicitReferencesOnly: true, binary: false, directoryScan: false },
      memory: { connected: false, reason: '隔离文档验收不连接真实共享记忆。' },
      connectors: {
        eagle: { connected: false, read: true, search: true, write: false },
        zotero: {
          connected: true,
          read: true,
          search: true,
          write: false,
          reason: '合成 Zotero API + 真实临时两页 PDF；不访问用户文献库。'
        },
        masscode: { configured: false, connected: false, read: true, search: true, write: false },
        obsidian: { read: 'explicit-markdown-file', search: false, write: false }
      }
    });
    Object.assign(app.hub.knowledge, knowledge);
    store.put('resource', {
      id: 'pdf-prior-a',
      projectId: tasks[0].projectId,
      title: '已选材料 · 保留原有任务输入',
      source: 'file',
      location: priorPath
    });
    await app.hub.taskContexts.prepare({
      taskId: tasks[0].id,
      projectId: tasks[0].projectId,
      resourceIds: ['pdf-prior-a'],
      memoryIds: [],
      requestId: 'fixture-prior-pdf-context',
      confirmed: true
    });
    let loseUseResponse = false;
    app.addHook('onSend', async (request, reply, payload) => {
      if (loseUseResponse && request.method === 'POST' && /\/tools\/use$/.test(request.url) && reply.statusCode === 200) {
        loseUseResponse = false;
        counters.lostResponses++;
        reply.hijack();
        reply.raw.destroy();
      }
      return payload;
    });
    const state = () => ({
      scope: 'isolated-production-App-zotero-document-reader',
      pdf: { hash: sha(pdfBytes), pages: 2, firstPageText, secondPageText },
      counters: {
        ...counters,
        modelIntents: store.list('model-call-intent').length,
        workerRecords: store.list('worker-run').length,
        jobs: store.list('job').length,
        selectionReceipts: store.events().filter(event => event.type === 'task.tool.use').length,
        contextVersions: store.list('task-context-version').length
      },
      tasks: tasks.map(task => ({ id: task.id, projectId: task.projectId, context: app.hub.taskContexts.snapshot(task.id) })),
      connectorRequests: [...connectorRequests],
      lostUseResponseArmed: loseUseResponse
    });
    const mutateSource = async () => {
      await writeFile(
        pdfPath,
        publicTwoPagePDF({ second: 'Second page changed outside the task reader. Reopen and review before using.' })
      );
      counters.syntheticSourceChanges++;
    };
    app.get('/__fixture/state', state);
    app.post('/__fixture/control', async (request, reply) => {
      if (!request.body || Object.keys(request.body).some(key => key !== 'operation'))
        return reply.code(400).send({ error: 'Only fixture-owned controls are permitted.' });
      if (request.body.operation === 'lose-use-response') loseUseResponse = true;
      else if (request.body.operation === 'mutate-source') await mutateSource();
      else return reply.code(400).send({ error: 'Only lost-response simulation or temporary PDF mutation is permitted.' });
      return state();
    });
    let url = null,
      closed = false;
    return {
      directory,
      dataDir,
      webRoot,
      store,
      app,
      documents,
      tasks,
      projects,
      pdfState,
      pdfPath,
      pdfBytes,
      counters,
      state,
      mutateSource,
      async listen(port = 0) {
        if (!url) url = await app.listen({ host: '127.0.0.1', port });
        return url;
      },
      async close() {
        if (closed) return;
        closed = true;
        await app.close();
        store.close();
        await rm(directory, { recursive: true, force: true });
      },
      async readSyntheticPDF() {
        return readFile(pdfPath);
      }
    };
  } catch (error) {
    await app?.close().catch(() => {});
    try {
      store?.close();
    } catch {}
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture = await createZoteroDocumentUIFixture(),
    url = await fixture.listen(Number(process.env.ZOTERO_DOCUMENT_FIXTURE_PORT || 0));
  console.log(
    JSON.stringify({
      fixture: 'isolated-production-App-zotero-document-reader',
      url,
      token: zoteroFixtureToken,
      directory: fixture.directory,
      buildUI: true,
      realModelCalls: 0,
      realLibraryWrites: 0
    })
  );
  const stop = async () => {
    await fixture.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
