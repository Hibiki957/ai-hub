// Disposable, read-only UI fixture. Never imports production state or contacts a provider.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('../dist', import.meta.url)));
const now = new Date().toISOString();
const approvalMode = process.argv.includes('--approval');
const reviewMode = process.argv.includes('--review');
const task = {
  id: 'fixture-task',
  projectId: 'fixture-project',
  title: '工作流交互验收（隔离 UI 测试）',
  goal: '仅检查界面，不连接模型，不产生真实任务，不作为运行验收。',
  mode: null,
  status: reviewMode ? 'review' : 'blocked',
  assignment: { modelId: 'fixture-model', harnessId: 'fixture-harness' },
  briefing: '这是隔离界面 fixture。步骤和依赖仅供验证节点、窗口与可读性，不是真实执行结果。',
  steps: [
    {
      id: 'fixture-analysis',
      title: '整理验收材料',
      description: '确认输入边界，仅为布局测试记录。',
      kind: '整理',
      status: 'done',
      dependsOn: [],
      assignment: { modelId: 'fixture-model', harnessId: 'fixture-harness' },
      artifacts: [{ title: '测试材料索引' }]
    },
    {
      id: 'fixture-draft',
      title: '检查画布可视化',
      description: '依赖前一步输入。拖动只改变坐标，不改变执行关系。',
      error: reviewMode ? undefined : '隔离测试：等待补充验收材料。',
      kind: '检查',
      status: reviewMode ? 'done' : 'blocked',
      dependsOn: ['fixture-analysis'],
      assignment: { modelId: 'fixture-model', harnessId: 'fixture-harness' }
    },
    {
      id: 'fixture-final',
      title: '汇总交接简报',
      description: '需要已有材料与检查结果。',
      kind: '交接',
      status: reviewMode ? 'done' : 'queued',
      dependsOn: ['fixture-analysis', 'fixture-draft'],
      assignment: { modelId: 'fixture-model', harnessId: 'fixture-harness-b' },
      handoff: reviewMode ? { workDone: '汇总完成', decisions: '保留已完成材料', pitfalls: '仅隔离测试', unfinished: '无' } : null
    }
  ],
  artifacts: [
    {
      id: 'fixture-artifact',
      title: '界面测试说明.txt',
      content: '这是明确标记的隔离 UI fixture，不是模型生成的真实产物。',
      sha256: '0'.repeat(64)
    }
  ],
  progress: { completed: reviewMode ? 3 : 1, total: 3 },
  spent: null,
  currency: 'USD',
  revision: 'fixture-1',
  manualOverrides: { status: { locked: true } },
  recoveryUsed: false,
  createdAt: now,
  updatedAt: now
};
const state = {
  revision: 'ui-fixture-only',
  projects: [{ id: 'fixture-project', name: '隔离界面验收' }],
  tasks: [task],
  inbox: [],
  approvals: approvalMode
    ? [
        {
          id: 'fixture-approval',
          taskId: task.id,
          kind: 'direction',
          title: '仅验证拦截弹卡，未发起真实操作',
          detail: '当前处于只读 UI fixture。允许或拒绝只会返回测试端点禁止写入，不会启动任务。',
          digest: 'fixture-action',
          taskRevision: 'fixture-1',
          status: 'pending',
          actionBound: true,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          createdAt: now
        }
      ]
    : [],
  memories: [],
  resources: [],
  pool: {
    models: [{ id: 'fixture-model', name: '测试模型标签', enabled: false }],
    harnesses: [
      { id: 'fixture-harness', name: '测试 Harness 标签', enabled: false, verified: false, capabilities: [] },
      { id: 'fixture-harness-b', name: '第二 Harness', enabled: false, verified: false, capabilities: [] }
    ]
  },
  events: [],
  settings: {
    backend: { name: '隔离 UI Fixture', connected: true },
    orchestrator: { ready: false, reason: '此服务仅用于界面验收，不连接 Paperclip、模型或真实任务。' }
  },
  global: {
    approvals: approvalMode ? 1 : 0,
    acceptance: 0,
    runningTasks: 0,
    runningAgents: 0,
    todaySpend: null,
    unknownCostCalls: 0,
    providerBalances: []
  }
};
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  const json = (status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (req.method !== 'GET') return json(405, { error: '只读 UI fixture：禁止任何业务写入。' });
  if (pathname === '/api/state') return json(200, state);
  if (pathname === '/api/connections') return json(200, { providers: [] });
  if (pathname === '/api/tasks/fixture-task') return json(200, { task, events: [], artifacts: task.artifacts });
  if (pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('event: change\ndata: {}\n\n');
    req.on('close', () => res.end());
    return;
  }
  let path = resolve(root, `.${decodeURIComponent(pathname)}`);
  if (!path.startsWith(root + sep)) path = resolve(root, 'index.html');
  try {
    const data = await readFile(path);
    res.writeHead(200, {
      'Content-Type': { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[extname(path)] || 'application/octet-stream'
    });
    res.end(data);
  } catch {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(await readFile(resolve(root, 'index.html')));
  }
});
const port = Number(process.env.UI_FIXTURE_PORT || (approvalMode ? 18789 : reviewMode ? 18790 : 18788));
server.listen(port, '127.0.0.1', () => console.log(`Read-only UI fixture http://127.0.0.1:${server.address().port}`));
process.on('SIGTERM', () => server.close());
