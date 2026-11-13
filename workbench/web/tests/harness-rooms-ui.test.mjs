import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let vite, mod;
before(async () => {
  const memory = new Map();
  globalThis.localStorage ??= { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)), removeItem: k => memory.delete(k) };
  vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom'
  });
  mod = await vite.ssrLoadModule('/src/HarnessRooms.jsx');
});
after(async () => vite?.close());

const full = { cli: true, cliResume: true, desktop: true, desktopSession: true, web: true, webSession: true };

test('surface buttons render every available entry and label new-vs-resume correctly', () => {
  const h = { id: 'x', name: 'X', surfaces: full };
  const resumed = renderToStaticMarkup(React.createElement(mod.SurfaceButtons, { harness: h, sessionId: 's1', onError() {} }));
  assert.match(resumed, />CLI</);
  assert.match(resumed, /桌面版/);
  assert.match(resumed, /网页版/);
  assert.match(resumed, /在桌面版中打开这个会话/);
  const fresh = renderToStaticMarkup(React.createElement(mod.SurfaceButtons, { harness: { ...h, surfaces: { cli: true, cliResume: true, desktop: true } }, onError() {} }));
  assert.match(fresh, /CLI（新）/);
  assert.match(fresh, /不能定位到这个会话/);
  assert.doesNotMatch(fresh, /网页版/);
});

test('the session picker and the full rooms screen render without undefined components', () => {
  assert.ok(renderToStaticMarkup(React.createElement(mod.SessionPicker, { harness: { id: 'x', name: 'X' }, cwd: '/tmp', onPick() {}, onClose() {} })).includes('X 的已有会话'));
  assert.ok(renderToStaticMarkup(React.createElement(mod.default, { onOpenBoard() {} })).includes('新建会话'));
});
