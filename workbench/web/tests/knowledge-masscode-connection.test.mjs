import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let vite, KnowledgePanel, Card, masscodeReadAccess;
before(async () => {
  vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom'
  });
  ({
    default: KnowledgePanel,
    MasscodeConnectionConfiguration: Card,
    masscodeReadAccess
  } = await vite.ssrLoadModule('/src/KnowledgePanel.jsx'));
});
after(async () => vite?.close());

const old = {
  installedVersion: '5.12.3',
  protocolCompatible: false,
  protocolStatus: 'unsupported',
  configured: true,
  integrationTokenScope: 'capture-only',
  requiresUpgradeChoice: true,
  disabledReason: 'massCode 5.12.3 仅支持 /captures 收录，不支持 MCP 搜索与读取。'
};
const candidate = {
  installedVersion: '6.0.0',
  protocolCompatible: null,
  protocolStatus: 'candidate',
  mcpCandidate: true,
  configured: false,
  disabledReason: '版本存在 MCP 接口，但本机开关、令牌、工具目录尚未核验。'
};
const button = (html, text) =>
  [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .map(match => match[0])
    .find(markup => markup.replace(/<[^>]*>/g, '').includes(text));
const tokenInput = html => html.match(/<input\b[^>]*type="password"[^>]*>/)?.[0];
const render = (status, extra = {}) =>
  renderToStaticMarkup(React.createElement(Card, { status, token: '<EXPLICIT_MCP_TOKEN>', initialOpen: true, ...extra }));

test('an unsupported installed massCode cannot enable reads merely because a token was configured', () => {
  const access = masscodeReadAccess(old);
  assert.equal(access.canConfigure, false);
  assert.equal(access.canSearch, false);
  const html = render(old);
  assert.ok(html.includes('massCode 5.12.3'));
  assert.ok(html.includes('/captures 收录'));
  assert.ok(html.includes('先选择升级与库迁移方案'));
  assert.ok(tokenInput(html).includes('disabled'));
  assert.ok(button(html, '保存到 Hub').includes('disabled'));
  assert.ok(!html.includes('独立 token'));
});

test('unknown or loading metadata blocks token entry and search until actual version admission', () => {
  for (const status of [
    null,
    { installedVersion: null },
    { installedVersion: '7.0.0', protocolCompatible: null },
    { installedVersion: '6.0.0', mcpCandidate: false, configured: true }
  ]) {
    assert.equal(masscodeReadAccess(status).canConfigure, false);
    assert.equal(masscodeReadAccess(status).canSearch, false);
    assert.ok(tokenInput(render(status)).includes('disabled'));
  }
  assert.equal(masscodeReadAccess({ ...candidate, configured: true }, true).canConfigure, false);
  assert.equal(masscodeReadAccess({ ...candidate, configured: true }, true).canSearch, false);
  assert.ok(render(null).includes('重新核验 massCode 版本'));
});

test('v6 is a candidate requiring explicit configured credentials and actual handshake, not a verified connection', () => {
  assert.equal(masscodeReadAccess(candidate).canConfigure, true);
  assert.equal(masscodeReadAccess(candidate).canSearch, false);
  assert.equal(masscodeReadAccess({ ...candidate, configured: true }).canSearch, true);
  const html = render(candidate);
  assert.ok(!tokenInput(html).includes('disabled'));
  assert.ok(!button(html, '保存到 Hub').includes('disabled'));
  assert.ok(html.includes('保存令牌不代表已连接'));
  assert.ok(html.includes('MCP 握手和工具目录'));
  assert.ok(html.includes('生成新令牌会使旧令牌失效'));
  assert.ok(html.includes('不生成或轮转令牌'));
  assert.ok(!html.includes('已连接成功'));
});

test('the full panel is safe before metadata arrives and rendering alone does not probe or use credentials', () => {
  const html = renderToStaticMarkup(
    React.createElement(KnowledgePanel, {
      api: () => assert.fail('Rendering must not probe or write.'),
      taskId: 'task-a',
      projectId: 'project-a',
      projects: [{ id: 'project-a', name: 'Project' }],
      initialConnector: 'masscode'
    })
  );
  assert.ok(html.includes('massCode 版本尚未核实'));
  assert.ok(tokenInput(html).includes('disabled'));
  assert.ok(button(html, '只检索这个库').includes('disabled'));
  assert.ok(!html.includes('Hub 独立'));
});
