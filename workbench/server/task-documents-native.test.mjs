import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, realpath, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Store, fail } from './store.mjs';
import { Providers } from './providers.mjs';
import { createKnowledge } from './knowledge.mjs';
import { createTaskContexts } from './task-context.mjs';
import { createTaskBudgets } from './task-budget.mjs';
import { createArtifactReader } from './artifact-access.mjs';
import { registerWorkerProvider } from './worker-provider.mjs';
import { createTaskDocumentHost } from './task-document-host.mjs';
import { registerTaskDocumentRoutes } from './task-document-routes.mjs';
import { ManagedHermesHarness } from './harnesses/managed-hermes.mjs';
import { HermesService } from './harnesses/hermes-service.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const stable = value =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item
  );
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const MODEL = 'aihub-document-zero-cost-fixed-fixture';
const ORIGINAL = '# R22 synthetic original\n\nPublic fixture, before revision.\n\nTotal: 5\n';
const REVISED =
  '# R22 synthetic revised document\n\nPublic fixture, revised through native Hermes file tools.\n\nTotal: 5\nVerified: yes\n';
const hermesRoot = join(homedir(), '.hermes/hermes-agent');
const enabled =
  process.env.AIHUB_TEST_TASK_DOCUMENTS_NATIVE === '1' && process.platform === 'darwin' && existsSync(join(hermesRoot, 'venv/bin/python'));

// Explicit native acceptance only. Providers has an in-process fixed response
// transport: no real cloud provider, account, credential or production task is
// discovered. All run/scope/quiescence evidence comes from actual ManagedHermes.
test(
  'R22 real native snapshot read → result write/read → actual quiescence → HTTP comparison → host-only exact publication',
  { skip: !enabled, timeout: 180000 },
  async () => {
    const base = join(homedir(), 'Library/Application Support/AIHubService');
    await mkdir(base, { recursive: true, mode: 0o700 });
    const root = await realpath(await mkdtemp(join(base, 'task-documents-native-fixture-'))),
      sourceRoot = join(root, 'source'),
      workspaceRoot = join(root, 'worker-workspaces/hermes');
    for (const path of [sourceRoot, workspaceRoot]) await mkdir(path, { recursive: true, mode: 0o700 });
    const sourcePath = join(sourceRoot, 'original.md');
    // The ONLY direct write of document content by this fixture is initialization
    // of the public original. REVISED is delivered exclusively by native tools.
    await writeFile(sourcePath, ORIGINAL, { mode: 0o600 });
    const store = new Store(join(root, 'fixture-sidecar.sqlite'), randomBytes(32).toString('base64')),
      app = Fastify({ logger: false });
    app.setErrorHandler((error, _request, reply) =>
      reply.code(error.status || error.statusCode || 500).send({ error: { code: error.code || 'fixture_error', message: error.message } })
    );
    const task = {
      id: 'fixture-document-task',
      title: 'Public native document acceptance',
      goal: 'Read the isolated input copy and deliver a revised plain-text file.',
      projectId: 'fixture-document-project',
      status: 'queued',
      revision: 'fixture-v1',
      steps: [
        {
          id: 'revise-file',
          version: 1,
          issueId: 'fixture-document-child',
          title: 'Revise public synthetic document',
          status: 'queued',
          assignment: { modelId: MODEL, harnessId: 'hermes' }
        }
      ],
      artifacts: []
    };
    store.put('brain-plan', { id: task.id, steps: structuredClone(task.steps) });
    store.put('resource', {
      id: 'fixture-source',
      title: 'Public synthetic source',
      projectId: task.projectId,
      source: 'file',
      location: sourcePath
    });
    const knowledge = createKnowledge({
      store,
      snapshot: async () => ({ projects: [{ id: task.projectId }] }),
      fetchImpl: async () => assert.fail('The document source connector cannot make network requests in this fixture.')
    });
    const taskContexts = createTaskContexts({ store, knowledge, getTask: async () => task });
    await taskContexts.prepare({
      taskId: task.id,
      projectId: task.projectId,
      resourceIds: ['fixture-source'],
      memoryIds: [],
      confirmed: true,
      requestId: 'fixture-context'
    });
    const taskBudgets = createTaskBudgets({ store, getTask: async () => task });
    await taskBudgets.configure({
      taskId: task.id,
      confirmed: true,
      requestId: 'fixture-budget',
      limits: { maxModelCalls: 4, maxOutputTokensPerCall: 1024, workerMaxModelCalls: 4, maxTotalOutputTokens: 4096 }
    });
    let native,
      documents,
      gateRequests = 0,
      gateConsumes = 0;
    const calls = [],
      authorizations = [],
      constructed = [],
      providerKey = randomBytes(32).toString('base64url');
    const providers = new Providers(store, {
      fetchImpl: async (url, options) => {
        assert.equal(
          new URL(url).origin === 'https://aihub-document-zero-cost.invalid',
          true,
          'Providers must use only this in-process fixed fixture.'
        );
        assert.equal(options.headers.Authorization === 'Bearer ' + providerKey, true);
        if (url.endsWith('/models') && options.method === 'GET')
          return new Response(JSON.stringify({ data: [{ id: MODEL }] }), { headers: { 'Content-Type': 'application/json' } });
        assert.equal(url, 'https://aihub-document-zero-cost.invalid/v1/chat/completions');
        assert.equal(options.method, 'POST');
        const body = JSON.parse(options.body),
          index = calls.length;
        assert.ok(index < 4, 'The fixed fixture grants at most four local provider turns.');
        assert.equal(body.model, MODEL);
        assert.equal(body.max_tokens ?? body.max_completion_tokens, 1024);
        assert.equal(body.stream, false);
        assert.equal(
          JSON.stringify(body.messages).includes(sourcePath),
          false,
          'No original file path may enter the native worker prompt.'
        );
        const claim = documents.snapshot(task.id).claims.find(claim => claim.owner.stepId === task.steps[0].id);
        assert.ok(claim?.snapshot?.relativePath, 'A real input claim must exist before the first native model turn.');
        const previous = body.messages.findLast(message => message.role === 'tool');
        if (index > 0) {
          assert.ok(previous, 'The next turn must carry an actual native tool result.');
          const output = JSON.parse(previous.content);
          assert.equal(!!output.error, false);
          if (index === 1)
            assert.ok(
              output.content?.includes('Public fixture, before revision.') && output.content?.includes('Total: 5'),
              'Native read_file must read the claim snapshot.'
            );
          if (index === 2)
            assert.equal(
              output.bytes_written,
              Buffer.byteLength(REVISED),
              'The native write_file result must report the actual result size.'
            );
          if (index === 3)
            assert.ok(
              output.content?.includes('Public fixture, revised through native Hermes file tools.') &&
                output.content?.includes('Verified: yes'),
              'Native read_file must read the newly written result.'
            );
        }
        calls.push({
          index,
          model: body.model,
          outputCeiling: body.max_tokens ?? body.max_completion_tokens,
          previousNativeToolVerified: index > 0,
          snapshot: claim.snapshot.relativePath
        });
        let message, finishReason;
        if (index < 3) {
          const name = index === 1 ? 'write_file' : 'read_file',
            args =
              index === 0
                ? { path: claim.snapshot.relativePath }
                : index === 1
                  ? { path: 'revised.md', content: REVISED }
                  : { path: 'revised.md' };
          message = {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'fixed-document-tool-' + index, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
          };
          finishReason = 'tool_calls';
        } else {
          message = {
            role: 'assistant',
            content: JSON.stringify({
              summary: 'Public synthetic revision delivered by native file tools.',
              artifacts: [{ path: 'revised.md', title: 'Synthetic revised file', mimeType: 'text/markdown' }],
              handoff: {
                workDone: 'Read the isolated snapshot, wrote and read revised.md.',
                decisions: 'Only public synthetic input and the isolated task directory were used.',
                pitfalls: 'Fixed provider replies are transport/tool acceptance, not a live model quality claim.',
                unfinished: 'Original publication is a separate host-approved operation.'
              }
            })
          };
          finishReason = 'stop';
        }
        return new Response(
          JSON.stringify({
            id: 'fixed-document-completion-' + index,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: MODEL,
            choices: [{ index: 0, message, finish_reason: finishReason }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          }),
          { headers: { 'Content-Type': 'application/json', 'x-request-id': 'fixed-document-request-' + index } }
        );
      }
    });
    providers.taskBudgets = taskBudgets;
    providers.save({
      id: 'fixture-provider',
      name: 'In-process zero-cost document fixture',
      baseURL: 'https://aihub-document-zero-cost.invalid/v1',
      apiKey: providerKey
    });
    await providers.test('fixture-provider');
    const identity = {
        taskId: task.id,
        stepId: task.steps[0].id,
        approvalId: 'fixture-dispatch-approval',
        model: MODEL,
        providerId: 'fixture-provider',
        providerFingerprint: providers.fingerprint('fixture-provider'),
        opId: 'fixture-document-native-dispatch'
      },
      intentId = task.id + ':' + task.steps[0].id + ':1';
    app.addHook('onRequest', async request => {
      if (request.method !== 'POST' || request.url !== '/worker-provider/v1/chat/completions') return;
      const bearer = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1],
        lease = bearer && store.get('worker-provider-lease', hash(bearer));
      authorizations.push({
        tokenShapeValid: !!bearer,
        ownLease: !!lease && lease.taskId === task.id && lease.stepId === identity.stepId && lease.model === MODEL && !lease.revokedAt
      });
    });
    const workerProvider = registerWorkerProvider(app, {
      store,
      providers,
      validate: async candidate => {
        if (stable(candidate) !== stable(identity)) throw fail('Fixed fixture action identity changed.', 409, 'fixture_identity_changed');
        let record = store.list('managed-hermes-run').find(row => row.taskId === task.id && row.stepId === identity.stepId);
        // createLease precedes native admission. Once a lease exists, actual model
        // forwarding waits for the native run acknowledgment rather than inventing
        // a run ID while the admitted callback is being persisted.
        if (store.list('worker-provider-lease').length) {
          const deadline = Date.now() + 5000;
          while (!record?.nativeRunId && Date.now() < deadline) {
            await delay(10);
            record = store.list('managed-hermes-run').find(row => row.taskId === task.id && row.stepId === identity.stepId);
          }
          if (!record?.nativeRunId) throw fail('Native admission was not acknowledged.', 409, 'fixture_native_ack_missing');
        }
        return {
          allowed: true,
          runId: record?.nativeRunId || null,
          budget: { maxModelCalls: 4, maxOutputTokens: 1024 },
          budgetDigest: taskBudgets.snapshot(task.id).digest
        };
      }
    });
    const getTask = async id => {
      if (id !== task.id) throw fail('Fixture task missing.', 404, 'task_missing');
      return {
        ...structuredClone(task),
        manualOverrides: store.get('manual', task.id)?.overrides || {},
        knowledgeRevision: taskContexts.revision(task.id),
        knowledgeContext: taskContexts.snapshot(task.id),
        modelBudget: taskBudgets.snapshot(task.id),
        ...(documents ? { documentRevision: documents.revision(task.id) } : {})
      };
    };
    const brain = {
      documentTask: async (id, stepId) => {
        if (stepId && stepId !== identity.stepId) throw fail('Fixture child missing.', 404, 'task_missing');
        return getTask(id);
      },
      workerDescriptor: id => (id === 'hermes' ? native.describe() : null),
      setTaskDocuments(value) {
        documents = value;
      },
      requestDocumentPublication(input) {
        gateRequests++;
        const action = {
          kind: 'overwrite',
          operation: 'document_publication',
          taskId: task.id,
          stepId: identity.stepId,
          stepVersion: 1,
          claimId: input.claim.id,
          claimDigest: input.claim.digest,
          fence: input.claim.fence,
          runId: input.claim.runId,
          publicationDigest: input.publication.digest,
          sourceHash: input.publication.sourceHash,
          resultHash: input.publication.resultHash,
          artifactId: input.publication.artifactId
        };
        const old = store.list('gate').find(gate => stable(gate.action) === stable(action) && gate.status !== 'expired');
        return (
          old || store.put('gate', { id: 'fixture-exact-document-gate', taskId: task.id, kind: 'overwrite', status: 'pending', action })
        );
      },
      consumeDocumentPublication(input) {
        gateConsumes++;
        const gate = store.get('gate', input.approvalId),
          action = gate?.action;
        const allowed =
          gate?.status === 'approved' &&
          !gate.consumedAt &&
          action.claimId === input.claim.id &&
          action.claimDigest === input.claim.digest &&
          action.fence === input.claim.fence &&
          action.runId === input.claim.runId &&
          action.stepVersion === input.claim.owner.stepVersion &&
          action.publicationDigest === input.digest &&
          action.sourceHash === input.publication.sourceHash &&
          action.resultHash === input.publication.resultHash &&
          action.artifactId === input.publication.artifactId;
        if (allowed) store.put('gate', { ...gate, consumedAt: new Date().toISOString() });
        return { allowed, approvalId: input.approvalId, digest: input.digest };
      }
    };
    const artifactAccess = createArtifactReader({ store, getTask, workspaceRoots: [workspaceRoot] });
    registerTaskDocumentRoutes(app, { getManager: () => documents, getTask, getGates: () => store.list('gate') });
    let receipt = {
      scope: 'actual-native-Hermes-file-broker-claim-HTTP-host-publication-with-in-process-fixed-Providers-only',
      root,
      paidModelCalls: 0,
      fixtureReplies: true
    };
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      native = new ManagedHermesHarness({
        store,
        workerProvider,
        workspaceRoot,
        serviceBaseRoot: join(root, 'services'),
        proxyBaseURL: `http://127.0.0.1:${app.server.address().port}/worker-provider/v1`,
        serviceFactory: options => {
          const service = new HermesService({ ...options, hermesRoot });
          constructed.push({ name: options.serviceName, service });
          return service;
        }
      });
      const preflight = await native.preflight();
      assert.equal(preflight.modelCalls, 0);
      assert.equal(preflight.documentIsolation.verified, true);
      assert.equal(calls.length, 0);
      await createTaskDocumentHost({
        store,
        claimRoot: join(root, 'claims'),
        brain,
        knowledge,
        taskContexts,
        taskBudgets,
        artifactAccess,
        workerProvider,
        resolveNativeScope: ref => native.documentScope(ref),
        resolveNativeScopeNow: ref => native.documentScopeNow(ref)
      });
      const path = '/api/tasks/' + task.id + '/documents',
        selected = await app.inject({
          method: 'POST',
          url: path + '/select',
          payload: {
            stepId: identity.stepId,
            stepVersion: 1,
            resourceId: 'fixture-source',
            expectedTaskRevision: (await getTask(task.id)).revision,
            expectedSourceHash: hash(ORIGINAL),
            requestId: 'fixture-select-native',
            confirmed: true
          }
        });
      assert.equal(selected.statusCode, 200, selected.body);
      assert.equal(store.list('document-claim').length, 0);
      assert.equal(calls.length, 0);
      store.put('worker-run', {
        id: intentId,
        taskId: task.id,
        stepId: identity.stepId,
        version: 1,
        childIssueId: task.steps[0].issueId,
        harnessId: 'hermes',
        harnessFingerprint: hash('fixture-current-harness'),
        modelId: MODEL,
        providerId: identity.providerId,
        providerFingerprint: identity.providerFingerprint,
        approvalId: identity.approvalId,
        opId: identity.opId,
        budget: { maxModelCalls: 4, maxOutputTokens: 1024 },
        status: 'prepared',
        finalized: false
      });
      task.status = 'running';
      const admitted = await native.start({
        ...identity,
        projectId: task.projectId,
        stepVersion: 1,
        runIntentId: intentId,
        idempotencyKey: 'fixture-native-document-once',
        budget: { maxModelCalls: 4, maxOutputTokens: 1024 },
        prompt:
          'Read the host-provided input snapshot. Deliver a separate revised.md using native file tools, read it back, and return the required manifest. Only public synthetic fixture data is involved.',
        beforeNativeStart: scope => documents.beforeNativeStart(scope),
        afterNativeStart: scope => documents.afterNativeStart(scope)
      });
      store.put('worker-run', {
        ...store.get('worker-run', intentId),
        runId: admitted.runId,
        sessionId: admitted.sessionId || null,
        status: 'running'
      });
      task.steps[0].status = 'running';
      let status;
      const deadline = Date.now() + 60000;
      do {
        status = await native.status(admitted.runId);
        if (['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(status.status)) break;
        await delay(200);
      } while (Date.now() < deadline);
      assert.equal(
        status.status,
        'succeeded',
        'Native document fixture did not succeed: ' + String(status.error?.message || status.error || status.nativeStatus)
      );
      const result = await native.result(admitted.runId);
      assert.equal(result.artifacts.length, 1);
      const artifact = { ...result.artifacts[0], runId: admitted.runId, source: 'worker-file', childIssueId: task.steps[0].issueId };
      assert.equal(artifact.hash, hash(REVISED));
      assert.equal((await readFile(artifact.path)).toString(), REVISED);
      assert.equal(calls.length, 4);
      assert.ok(authorizations.every(item => item.tokenShapeValid && item.ownLease));
      assert.equal(authorizations.length, 4);
      store.put('step-result', {
        id: intentId,
        taskId: task.id,
        stepId: identity.stepId,
        version: 1,
        completed: true,
        artifacts: [artifact],
        handoff: result.handoff
      });
      store.put('worker-run', {
        ...store.get('worker-run', intentId),
        status: 'succeeded',
        finalized: true,
        endedAt: new Date().toISOString()
      });
      task.artifacts = [artifact];
      task.steps[0].status = 'done';
      task.status = 'review';
      const cleanup = await native.release(admitted.runId);
      assert.equal(cleanup.status, 'released');
      const scope = await native.documentScope({ taskId: task.id, stepId: identity.stepId, stepVersion: 1, runIntentId: intentId });
      assert.equal(scope.allowed, true);
      assert.equal(scope.nativeStatus, 'succeeded');
      assert.equal(scope.quiescent, true);
      const nativeRecord = store.list('managed-hermes-run').find(row => row.nativeRunId === admitted.runId),
        serviceState = constructed.find(item => item.name === nativeRecord.serviceName).service.state();
      assert.equal(serviceState.running, false);
      assert.equal(serviceState.quiescent, true);
      assert.equal(serviceState.broker.running, false);
      assert.equal(serviceState.broker.quiescent, true);
      assert.equal(serviceState.broker.shutdownReceipt.activeHelpers, 0);
      const claim = documents.snapshot(task.id).claims[0];
      assert.equal(claim.runId, admitted.runId);
      assert.deepEqual(await readFile(join(nativeRecord.workspace, claim.snapshot.relativePath)), Buffer.from(ORIGINAL));
      assert.equal((await readdir(join(root, 'claims'))).length, 2);
      assert.equal((await readFile(sourcePath)).toString(), ORIGINAL);
      const publicationInput = { artifactId: artifact.id, expectedSourceHash: hash(ORIGINAL), expectedResultHash: hash(REVISED) },
        claimPath = path + '/claims/' + claim.id;
      const preview = await app.inject({ method: 'POST', url: claimPath + '/preview', payload: publicationInput });
      assert.equal(preview.statusCode, 200, preview.body);
      assert.equal(preview.json().comparison.sourceText, ORIGINAL);
      assert.equal(preview.json().comparison.resultText, REVISED);
      assert.equal(gateRequests, 0);
      assert.equal(gateConsumes, 0);
      assert.equal((await readFile(sourcePath)).toString(), ORIGINAL);
      const prepared = await app.inject({ method: 'POST', url: claimPath + '/prepare', payload: publicationInput });
      assert.equal(prepared.statusCode, 200, prepared.body);
      const approval = prepared.json();
      assert.equal(gateRequests, 1);
      assert.equal(approval.gate.status, 'pending');
      assert.equal(gateConsumes, 0);
      const publishInput = {
        digest: approval.publication.digest,
        approvalId: approval.gate.id,
        expectedSourceHash: hash(ORIGINAL),
        expectedResultHash: hash(REVISED),
        confirmed: true,
        requestId: 'fixture-native-host-publish'
      };
      const unapproved = await app.inject({ method: 'POST', url: claimPath + '/publish', payload: publishInput });
      assert.equal(unapproved.statusCode, 403, unapproved.body);
      assert.equal((await readFile(sourcePath)).toString(), ORIGINAL);
      const gate = store.get('gate', approval.gate.id);
      store.put('gate', {
        ...gate,
        status: 'approved',
        approvedAt: new Date().toISOString(),
        approvalSource: 'explicit-zero-cost-fixed-fixture-only'
      });
      const published = await app.inject({ method: 'POST', url: claimPath + '/publish', payload: publishInput });
      assert.equal(published.statusCode, 200, published.body);
      const publicationReceipt = published.json();
      assert.equal(publicationReceipt.completed, true);
      assert.equal(publicationReceipt.actualHash, hash(REVISED));
      assert.equal(publicationReceipt.release.verifiedReleased, 2);
      assert.equal(publicationReceipt.release.total, 2);
      assert.equal((await readFile(sourcePath)).toString(), REVISED);
      assert.deepEqual(await readdir(join(root, 'claims')), []);
      assert.equal(documents.snapshot(task.id).claims[0].completed, true);
      assert.equal(store.list('usage').length, 4);
      assert.ok(store.list('usage').every(row => row.status === 'responded' && row.maxOutputTokens === 1024));
      assert.equal(calls.length, 4, 'Host preview, gate and publication cannot invoke another provider turn.');
      receipt = {
        ...receipt,
        runId: admitted.runId,
        sessionId: admitted.sessionId,
        preflight: { scope: preflight.scope, modelCalls: preflight.modelCalls, documentIsolation: preflight.documentIsolation },
        nativeCalls: calls,
        authorization: authorizations,
        source: { path: sourcePath, originalHash: hash(ORIGINAL), publishedHash: hash(REVISED), bytes: Buffer.byteLength(REVISED) },
        snapshot: claim.snapshot,
        artifact: { id: artifact.id, path: artifact.path, hash: artifact.hash, size: artifact.size, producedBy: artifact.producedBy },
        actualQuiescence: {
          nativeAllowed: scope.allowed,
          nativeStatus: scope.nativeStatus,
          daemonRunning: serviceState.running,
          daemonQuiescent: serviceState.quiescent,
          brokerRunning: serviceState.broker.running,
          brokerQuiescent: serviceState.broker.quiescent,
          activeHelpers: serviceState.broker.shutdownReceipt.activeHelpers
        },
        comparisonVerified: true,
        zeroGatePreviewVerified: true,
        unapprovedPublicationRejected: true,
        fixtureGateSource: 'explicit-zero-cost-fixed-fixture-only',
        hostPublication: publicationReceipt,
        physicalLockFilesRemaining: 0,
        fixtureProviderCallCount: calls.length,
        actualModelReplyVerified: false
      };
      assert.equal(JSON.stringify(receipt).includes(providerKey), false);
    } catch (error) {
      receipt = {
        ...receipt,
        failed: true,
        errorCode: error.code || 'assertion_failed',
        failure: String(error.message).slice(0, 500),
        nativeCalls: calls,
        authorization: authorizations
      };
      throw error;
    } finally {
      if (native) {
        const closures = await native.close({ stopOwned: true });
        receipt.ownedCleanup = closures.map(item => (item.status === 'fulfilled' ? item.value : { error: 'Owned fixture close failed.' }));
        assert.ok(closures.every(item => item.status === 'fulfilled'));
      }
      documents?.close();
      workerProvider.close();
      await app.close();
      store.close();
      await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
      console.log('R22 zero-cost native document closure receipt:', join(root, 'receipt.json'));
    }
  }
);
