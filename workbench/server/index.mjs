import { readFileSync, statSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createApp } from './app.mjs';
import { Paperclip } from './paperclip.mjs';
import { Store } from './store.mjs';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { createBrain } from './brain.mjs';
import { ManagedHermesHarness } from './harnesses/managed-hermes.mjs';
import { createTaskDocumentHost } from './task-document-host.mjs';
import { createTaskFileEdits } from './task-file-edits.mjs';
import { createTaskNotionEdits } from './task-notion-edits.mjs';

function secret(name) {
  if (process.env[`${name}_FILE`]) {
    const path = resolve(process.env[`${name}_FILE`]);
    const info = statSync(path);
    if (!info.isFile() || info.mode & 0o077) throw new Error(`${name}_FILE must be a private regular file (0600).`);
    return readFileSync(path, 'utf8').trim();
  }
  return process.env[name]?.trim();
}

const dataDir = resolve(process.env.HUB_DATA_DIR || './runtime-data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const encryptionKey = secret('HUB_ENCRYPTION_KEY');
const store = new Store(join(dataDir, 'hub-sidecar.sqlite'), encryptionKey);
const paperclip = new Paperclip({
  baseURL: process.env.HUB_PAPERCLIP_URL || 'http://127.0.0.1:3100',
  token: secret('HUB_PAPERCLIP_TOKEN'),
  companyId: process.env.HUB_PAPERCLIP_COMPANY_ID
});
const app = await createApp({
  dataDir,
  accessToken: secret('HUB_ACCESS_TOKEN'),
  encryptionKey,
  store,
  paperclip,
  secure: process.env.HUB_SECURE_COOKIE === 'true'
});
const port = Number(process.env.HUB_PORT || 8787),
  host = process.env.HUB_HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('HUB_PORT is invalid.');
const workspaceRoot = join(dataDir, 'worker-workspaces/hermes');
mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
const hermes = new ManagedHermesHarness({
  store,
  workerProvider: app.hub.workerProvider,
  workspaceRoot,
  proxyBaseURL: `http://127.0.0.1:${port}/worker-provider/v1`
});
const checkpointer = SqliteSaver.fromConnString(join(dataDir, 'brain-checkpoints.sqlite'));
if (app.hub.executionOwner.describe().agentId) {
  try {
    await app.hub.executionOwner.assertHealthy();
  } catch {
    console.log('Hub task responsibility connection requires verification; no agent was resumed.');
  }
}
const brain = createBrain({
  store,
  providers: app.hub.providers,
  taskContexts: app.hub.taskContexts,
  taskBudgets: app.hub.taskBudgets,
  preparedPlans: app.hub.preparedPlans,
  routingQuality: app.hub.routingQuality,
  executionOwner: app.hub.executionOwner,
  paperclip,
  checkpointer,
  notify: app.hub.notify,
  harnessRegistry: { hermes },
  onTaskStatus: id => app.hub.schedule(id, { type: 'status', taskId: id })
});
const taskDocuments = await createTaskDocumentHost({
  store,
  claimRoot: join(dataDir, 'document-claims'),
  brain,
  knowledge: app.hub.knowledge,
  taskContexts: app.hub.taskContexts,
  taskBudgets: app.hub.taskBudgets,
  artifactAccess: app.hub.artifactAccess,
  workerProvider: app.hub.workerProvider,
  notify: app.hub.notify,
  resolveNativeScope: ref => hermes.documentScope(ref),
  resolveNativeScopeNow: ref => hermes.documentScopeNow(ref)
});
app.hub.setTaskDocuments(taskDocuments);
const claimPath = join(dataDir, 'document-claims'),
  claimStat = statSync(claimPath, { bigint: true });
const taskFileEdits = await createTaskFileEdits({
  store,
  claimRoot: { path: claimPath, dev: claimStat.dev.toString(), ino: claimStat.ino.toString() },
  getTask: id => brain.getTask(id),
  knowledge: app.hub.knowledge,
  taskContexts: app.hub.taskContexts,
  requestApproval: input => brain.requestManualFilePublication(input),
  consumeApproval: input => brain.consumeManualFilePublication(input),
  notify: app.hub.notify
});
brain.setTaskFileEdits(taskFileEdits);
app.hub.setTaskFileEdits(taskFileEdits);
const taskNotionEdits = createTaskNotionEdits({
  store,
  pages: app.hub.notionPages,
  getTask: id => brain.getTask(id),
  knowledge: app.hub.knowledge,
  taskContexts: app.hub.taskContexts,
  requestApproval: input => brain.requestNotionPublication(input),
  consumeApproval: input => brain.consumeNotionPublication(input),
  notify: app.hub.notify
});
brain.setTaskNotionEdits(taskNotionEdits);
app.hub.setTaskNotionEdits(taskNotionEdits);
const reconciliation = await brain.reconcile();
console.log(
  `Startup reconciliation: ${reconciliation.checked} checked, ${reconciliation.interrupted} interrupted; no paid calls replayed.`
);
app.hub.setBrain(brain);
app.addHook('onClose', async () => {
  taskNotionEdits.close();
  await taskFileEdits.close();
  await brain.close();
  taskDocuments.close();
  checkpointer.db.close();
  store.close();
});
await app.listen({ host, port });
console.log(`AI Hub listening on ${host}:${port}. Credentials are never printed.`);
let preflight = Promise.resolve();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => preflight.finally(() => app.close()).then(() => process.exit(0)));
// The UI stays available while zero-model transport/isolation checks run. This
// never mints a paid lease or wakes a user's existing Hermes profile.
preflight = brain
  .preflightWorker('hermes', { startup: true })
  .then(
    evidence => {
      store.audit({ type: 'worker.preflight', harnessId: 'hermes' }, 'system', { scope: evidence.scope, modelCalls: 0 });
    },
    error => {
      store.audit({ type: 'worker.preflight.failed', harnessId: 'hermes' }, 'system', {
        code: error.code || 'preflight_unavailable',
        modelCalls: 0
      });
    }
  )
  .finally(app.hub.notify);
