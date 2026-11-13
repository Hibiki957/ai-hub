import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { digest, fail } from './store.mjs';

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; worker-src 'self'; font-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self' https://miro.com/app/live-embed/; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'";
const SESSION_MS = 12 * 3600000;

const safeEqual = (a, b) => {
  const hash = value =>
    createHash('sha256')
      .update(String(value || ''))
      .digest();
  return timingSafeEqual(hash(a), hash(b));
};

export function registerErrorHandler(app) {
  app.setErrorHandler((error, _request, reply) => {
    const status = error.status || error.statusCode || 500;
    reply
      .code(status >= 400 && status <= 599 ? status : 500)
      .send({ error: status >= 500 && !error.code ? '服务暂时不可用，请检查连接。' : error.message, code: error.code || 'server_error' });
  });
}

export function registerRequestGuard(app, { store, accessToken, secure }) {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'same-origin').header('Cache-Control', 'no-store');
    reply.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    if (!['GET', 'HEAD'].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin && origin !== `${secure ? 'https' : 'http'}://${request.headers.host}`)
        throw fail('跨站请求已拒绝。', 403, 'origin_rejected');
      const hasBody = Number(request.headers['content-length'] || 0) > 0 || !!request.headers['transfer-encoding'];
      if ((hasBody || request.method === 'POST') && !request.headers['content-type']?.startsWith('application/json'))
        throw fail('请使用 JSON 请求。', 415);
    }
    const path = request.url.split('?')[0];
    if (!path.startsWith('/api/') || path === '/api/health' || (path === '/api/session' && request.method === 'POST')) return;
    const signed = request.unsignCookie(request.cookies.hub_session || '');
    const parts = signed.valid ? signed.value.split(':') : [];
    const session = signed.valid ? store.get('session', digest(signed.value)) : null;
    if (!signed.valid || parts[0] !== 'hub' || Date.now() > Number(parts[1]) || !session || session.authHash !== digest(accessToken)) {
      return reply.code(401).send({ error: '请先登录 AI Hub。', code: 'unauthenticated' });
    }
  });
}

export function registerSessionRoutes(app, { store, accessToken, secure }) {
  const attempts = new Map();
  app.get('/api/health', () => ({ ready: true }));
  app.post('/api/session', async (request, reply) => {
    const key = request.ip,
      current = attempts.get(key) || { count: 0, since: Date.now() };
    if (Date.now() - current.since > 60000) {
      current.count = 0;
      current.since = Date.now();
    }
    if (++current.count > 10) throw fail('登录尝试过多，请一分钟后再试。', 429);
    attempts.set(key, current);
    if (attempts.size > 1000) attempts.delete(attempts.keys().next().value);
    if (!safeEqual(request.body?.token, accessToken)) throw fail('访问口令不正确。', 401, 'unauthenticated');
    attempts.delete(key);
    const expiresAt = Date.now() + SESSION_MS,
      value = `hub:${expiresAt}:${randomUUID()}`;
    store.put('session', { id: digest(value), expiresAt, authHash: digest(accessToken) });
    for (const stale of store.list('session').filter(s => s.expiresAt < Date.now())) store.remove('session', stale.id);
    reply.setCookie('hub_session', value, {
      path: '/',
      signed: true,
      httpOnly: true,
      sameSite: 'strict',
      secure,
      maxAge: SESSION_MS / 1000
    });
    return { ok: true };
  });
  app.delete('/api/session', (request, reply) => {
    const signed = request.unsignCookie(request.cookies.hub_session || '');
    if (signed.valid) store.remove('session', digest(signed.value));
    reply.clearCookie('hub_session', { path: '/' });
    return { ok: true };
  });
}
