import { createServer as createHTTPServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';

const digest = text => createHash('sha256').update(text).digest('hex');
const sourceText = '# Public synthetic note\n\nApples: 2\nOranges: 3\n',
  resultText = '# Public synthetic note\n\nApples: 2\nOranges: 3\nTotal: 5\n';
const sourceHash = digest(sourceText),
  resultHash = digest(resultText);
export async function createTaskDocumentsUIFixture() {
  const counters = {
      modelCalls: 0,
      originalWrites: 0,
      selectionWrites: 0,
      previewCalls: 0,
      gateRequests: 0,
      publicationRequests: 0,
      releaseRequests: 0,
      openApprovals: 0,
      replays: 0,
      actions: []
    },
    receipts = new Map();
  let sequence = 0;
  const rows = new Map();
  const reset = id => {
    const suffix = id === 'fixture-a' ? 'A' : 'B',
      resourceId = `resource-${suffix}`,
      stepId = `edit-${suffix}`;
    rows.set(id, {
      loseSelect: false,
      delay: 0,
      documents: { selection: null, revision: null, claims: [], limitations: ['仅隔离 UI fixture，不证明任何生产连接。'] },
      gates: [],
      task: {
        id,
        title: `合成任务 ${suffix}`,
        projectId: `project-${suffix}`,
        revision: `fixture-revision-${suffix}-${++sequence}`,
        status: 'queued',
        knowledgeContext: {
          status: 'prepared',
          projectId: `project-${suffix}`,
          items: [
            {
              kind: 'resource',
              id: resourceId,
              title: `公开合成说明-${suffix}.md`,
              hash: sourceHash,
              provenance: { source: 'file', projectId: `project-${suffix}`, sourceHash }
            },
            {
              kind: 'resource',
              id: `web-${suffix}`,
              title: '网页不能作为本机原件',
              hash: sourceHash,
              provenance: { source: 'web', projectId: `project-${suffix}` }
            }
          ]
        },
        steps: [
          {
            id: stepId,
            title: `修改说明 ${suffix}`,
            version: 1,
            status: 'queued',
            assignment: { harnessId: 'hermes', modelId: 'fixture-no-model' }
          }
        ],
        artifacts: []
      }
    });
  };
  reset('fixture-a');
  reset('fixture-b');
  const pool = {
    harnesses: [
      {
        id: 'hermes',
        kind: 'hermes',
        name: 'Hermes（UI fixture）',
        enabled: true,
        verified: true,
        capabilities: { files: true, documentClaims: true }
      }
    ]
  };
  const state = () => ({
    scope: 'synthetic-ui-fixture-only',
    tasks: [...rows.values()].map(row => ({ ...row.task, documents: row.documents })),
    approvals: [...rows.values()].flatMap(row => row.gates),
    pool,
    resources: [...rows.values()].map(row => ({
      id: row.task.knowledgeContext.items[0].id,
      title: row.task.knowledgeContext.items[0].title,
      projectId: row.task.projectId
    })),
    counters
  });
  const snapshot = row => ({
    documents: row.documents,
    taskRevision: row.task.revision,
    eligibleSteps: row.task.steps
      .filter(step => ['queued', 'failed'].includes(step.status))
      .map(step => ({ ...step, stepVersion: step.version })),
    publicationGates: row.gates,
    modelCalls: 0
  });
  const comparison = () => ({
    sourceText,
    resultText,
    sourceHash,
    resultHash,
    sourceBytes: Buffer.byteLength(sourceText),
    resultBytes: Buffer.byteLength(resultText)
  });
  const vite = await createViteServer({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom'
  });
  const server = createHTTPServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    const json = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(data));
    };
    const body = async () => {
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 64_000) throw new Error('Fixture body limit');
      }
      return JSON.parse(raw || '{}');
    };
    try {
      if (path === '/__fixture/state' && request.method === 'GET') return json(200, state());
      if (path === '/__fixture/control' && request.method === 'POST') {
        const input = await body(),
          row = rows.get(input.taskId);
        if (!row) return json(404, { error: 'Fixture task missing' });
        const { task } = row;
        if (input.operation === 'reset') reset(task.id);
        if (input.operation === 'lose-select-response') row.loseSelect = true;
        if (input.operation === 'delay-read') row.delay = 800;
        if (input.operation === 'open-approvals') counters.openApprovals++;
        if (['approve', 'approve-only'].includes(input.operation)) {
          row.gates = row.gates.map(gate => ({ ...gate, status: 'approved' }));
          const claim = row.documents.claims[0];
          if (input.operation === 'approve' && claim?.publication && row.gates.length && !claim.completed) {
            counters.publicationRequests++;
            row.gates[0].consumedAt = new Date().toISOString();
            claim.status = 'committed';
            claim.completed = true;
            claim.receipt = {
              actualHash: resultHash,
              resultHash,
              sourceHash,
              completed: true,
              publicationVerified: true,
              scope: 'synthetic-ui-only-no-files-written'
            };
          }
        }
        if (input.operation === 'result' && row.documents.selection) {
          const suffix = task.id === 'fixture-a' ? 'A' : 'B',
            selection = row.documents.selection,
            runId = `fixture-run-${suffix}`;
          row.documents.claims = [
            {
              id: `claim-${suffix}`,
              resourceId: selection.resourceId,
              owner: {
                projectId: task.projectId,
                taskId: task.id,
                stepId: selection.stepId,
                stepVersion: 1,
                runIntentId: `${task.id}:${selection.stepId}:1`
              },
              runId,
              digest: digest(`claim-${suffix}`),
              sourceHash,
              sourceSize: Buffer.byteLength(sourceText),
              snapshot: { relativePath: 'input/synthetic.md', hash: sourceHash, size: Buffer.byteLength(sourceText) },
              status: 'running',
              completed: false
            }
          ];
          task.status = 'review';
          task.steps[0].status = 'done';
          task.artifacts = [
            {
              id: `artifact-${suffix}`,
              title: `修改后-${suffix}.md`,
              source: 'worker-file',
              runId,
              stepId: selection.stepId,
              stepVersion: 1,
              hash: resultHash,
              size: Buffer.byteLength(resultText)
            }
          ];
          task.revision += '-result';
        }
        if (input.operation === 'unknown' && row.documents.claims[0]) row.documents.claims[0].status = 'outcome_unknown';
        if (input.operation === 'conflict' && row.documents.claims[0]) {
          row.documents.claims[0].status = 'needs_reconcile';
          row.documents.claims[0].conflict = { code: 'synthetic_source_changed' };
        }
        return json(200, { fixture: true, modelCalls: 0 });
      }
      const match = path.match(
        /^\/api\/tasks\/([^/]+)\/documents(?:\/(select|clear)|\/claims\/([^/]+)\/(preview|prepare|comparison|publish|discard))?$/
      );
      if (match) {
        const row = rows.get(decodeURIComponent(match[1]));
        if (!row) return json(404, { error: 'Fixture task missing' });
        const action = match[2] || match[4];
        if (!action && request.method === 'GET') {
          const result = structuredClone(snapshot(row));
          const delay = row.delay;
          row.delay = 0;
          if (delay) await new Promise(resolve => setTimeout(resolve, delay));
          return json(200, result);
        }
        const input = request.method === 'GET' ? {} : await body();
        counters.actions.push({ taskId: row.task.id, action, requestId: input.requestId || null });
        if (input.requestId && receipts.has(row.task.id + ':' + input.requestId)) {
          counters.replays++;
          return json(200, receipts.get(row.task.id + ':' + input.requestId));
        }
        let result;
        if (action === 'select') {
          if (
            input.confirmed !== true ||
            input.expectedTaskRevision !== row.task.revision ||
            input.resourceId !== row.task.knowledgeContext.items[0].id ||
            input.stepId !== row.task.steps[0].id ||
            input.expectedSourceHash !== sourceHash ||
            input.stepVersion !== 1
          )
            return json(409, { error: 'Fixture exact selection binding mismatch' });
          counters.selectionWrites++;
          row.documents.selection = {
            taskId: row.task.id,
            projectId: row.task.projectId,
            stepId: input.stepId,
            stepVersion: 1,
            resourceId: input.resourceId,
            title: row.task.knowledgeContext.items[0].title,
            sourceHash,
            sourceBytes: Buffer.byteLength(sourceText),
            digest: digest(JSON.stringify(input)),
            version: 1,
            status: 'selected',
            onlyHostCanPublish: true,
            modelCalls: 0
          };
          row.documents.revision = row.documents.selection.digest;
          result = snapshot(row);
        } else if (action === 'clear') {
          row.documents.selection = null;
          result = snapshot(row);
        } else {
          const claim = row.documents.claims.find(item => item.id === decodeURIComponent(match[3]));
          if (!claim) return json(404, { error: 'Fixture claim missing' });
          if (['outcome_unknown', 'needs_reconcile'].includes(claim.status))
            return json(409, { error: '合成 fixture：实际运行或文件冲突尚未核验，保留记录。' });
          if (action === 'comparison') return json(200, comparison());
          if (action === 'preview' || action === 'prepare') {
            if (
              input.expectedSourceHash !== sourceHash ||
              input.expectedResultHash !== resultHash ||
              input.artifactId !== row.task.artifacts[0]?.id
            )
              return json(409, { error: 'Fixture exact file digest mismatch' });
            const publication = {
              claimId: claim.id,
              resourceId: claim.resourceId,
              fence: 1,
              runId: claim.runId,
              artifactId: input.artifactId,
              sourceHash,
              resultHash,
              digest: digest('publication-' + claim.id)
            };
            claim.publication = publication;
            claim.status = 'prepared';
            result = { publication, comparison: comparison(), requiresOverwriteApproval: true, modelCalls: 0 };
            if (action === 'preview') counters.previewCalls++;
            else {
              counters.gateRequests++;
              let gate = row.gates[0];
              if (!gate) {
                gate = {
                  id: 'gate-' + claim.id,
                  taskId: row.task.id,
                  claimId: claim.id,
                  publicationDigest: publication.digest,
                  kind: 'document_publication',
                  status: 'pending',
                  expiresAt: new Date(Date.now() + 3600000).toISOString()
                };
                row.gates.push(gate);
              }
              result.gate = gate;
            }
          } else if (action === 'publish') {
            if (
              input.confirmed !== true ||
              row.gates.find(gate => gate.id === input.approvalId)?.status !== 'approved' ||
              input.digest !== claim.publication?.digest
            )
              return json(403, { error: 'Fixture requires separate exact publication approval' });
            counters.publicationRequests++;
            claim.status = 'committed';
            claim.completed = true;
            claim.receipt = {
              actualHash: resultHash,
              resultHash,
              sourceHash,
              completed: true,
              publicationVerified: true,
              scope: 'synthetic-ui-only-no-files-written'
            };
            result = claim.receipt;
          } else if (action === 'discard') {
            counters.releaseRequests++;
            claim.status = 'released';
            result = snapshot(row);
          } else return json(405, { error: 'Synthetic fixture operation unsupported' });
        }
        if (input.requestId) receipts.set(row.task.id + ':' + input.requestId, structuredClone(result));
        if (action === 'select' && row.loseSelect) {
          row.loseSelect = false;
          request.socket.destroy();
          return;
        }
        return json(200, result);
      }
      if (path.startsWith('/api/')) return json(403, { error: 'Synthetic fixture has no model, production or approval-decide API.' });
      if (path === '/') {
        const html = await vite.transformIndexHtml(
          '/',
          '<!doctype html><html><head><meta charset="UTF-8"><title>Task Documents · Synthetic UI Fixture</title><style>body{margin:0;background:#f7f8fa;color:#202630;font-family:system-ui;font-size:14px}main{max-width:1000px;margin:auto;padding:24px;display:grid;gap:20px}button,select{font:inherit;padding:9px 12px;border:1px solid #d8dee4;border-radius:8px;background:white;color:inherit}button{cursor:pointer}button:disabled{opacity:.45;cursor:default}.primary{background:#286b65;color:white}.fixture-toolbar{display:grid;gap:12px;border-bottom:1px solid #d8dee4;padding-bottom:20px}.fixture-toolbar h1,.fixture-toolbar p{margin:0}.fixture-toolbar h1{font-size:22px}.fixture-toolbar>div{display:flex;flex-wrap:wrap;gap:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere}*{box-sizing:border-box}</style></head><body><div id="fixture-root"></div><script type="module" src="/tests/TaskDocumentsFixture.jsx"></script></body></html>'
        );
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(html);
        return;
      }
      vite.middlewares(request, response, () => json(404, { error: 'Fixture asset missing' }));
    } catch {
      if (!response.headersSent && !response.destroyed)
        json(500, { error: 'Synthetic UI fixture request failed; no production operation occurred.' });
    }
  });
  return {
    server,
    state,
    async listen(port = 0) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      await new Promise(resolve => server.close(resolve));
      await vite.close();
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture = await createTaskDocumentsUIFixture(),
    url = await fixture.listen(Number(process.env.TASK_DOCUMENTS_FIXTURE_PORT || 0));
  console.log('Synthetic TaskDocumentsPanel CUA fixture:', url);
  const stop = async () => {
    await fixture.close();
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
