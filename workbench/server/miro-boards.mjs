import { createHash, randomUUID } from 'node:crypto';
import { fail, digest } from './store.mjs';

// GET-only Miro protocol boundary. No UI/connector login is imported, no REST
// search, writes, downloads, Web SDK or webhooks are exposed by this adapter.
// Public contract: parseMiroBoard(), miroEmbedURL(); createMiroBoards() returns
// configure/status/readBoard/listItems/readItem/readFrame/readSelection.
// readSelection accepts 1–20 explicit textual item IDs; sourceHash is SHA-256 of
// the returned UTF-8 text. rawSourceHash binds source structure without exposing
// arbitrary remote links, user objects, style properties or nested API payloads.
export const MIRO_API_VERSION = 'v2';
export const MIRO_EMBED_MODE = 'view_only_without_ui';
export const MIRO_TEXT_LIMIT = 256 * 1024;
const ORIGIN = 'https://api.miro.com',
  CONFIG_KIND = 'knowledge-connector',
  CONFIG_ID = 'miro';
const RESPONSE_LIMIT = 2 * 1024 * 1024;
const BOARD = /^[A-Za-z0-9_-]{1,128}={0,2}$/;
const ITEM = /^[0-9]{1,40}$/;
const TYPES = new Set([
  'app_card',
  'card',
  'data_table_format',
  'document',
  'embed',
  'frame',
  'image',
  'shape',
  'sticky_note',
  'text',
  'doc_format'
]);
const TEXTUAL = new Set(['app_card', 'card', 'shape', 'sticky_note', 'text']);
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
const problem = (message, code = 'miro_invalid_request', status = 400) => fail(message, status, code);
const protocol = () => problem('Miro 返回的数据不完整或不符合已核对的读取接口。', 'miro_protocol_invalid', 502);

export function parseMiroBoard(value) {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 4096)
    throw problem('请提供明确的 Miro 画板 ID 或官方画板链接。', 'miro_board_invalid');
  if (BOARD.test(value)) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw problem('Miro 画板链接无效。', 'miro_board_invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'miro.com' ||
    url.username ||
    url.password ||
    url.port ||
    [...url.searchParams.keys()].some(key => /token|secret|api.?key|password|authorization|access.?key/i.test(key))
  )
    throw problem('仅接受不含凭据的 miro.com 官方 HTTPS 画板链接。', 'miro_board_invalid');
  const match = /^\/app\/(?:board|live-embed)\/([^/]+)\/?$/.exec(url.pathname);
  let id;
  try {
    id = match && decodeURIComponent(match[1]);
  } catch {
    throw problem('Miro 画板链接无效。', 'miro_board_invalid');
  }
  if (!id || !BOARD.test(id)) throw problem('链接中没有明确的 Miro 画板 ID。', 'miro_board_invalid');
  return id;
}
function itemId(value) {
  if (typeof value !== 'string' || !ITEM.test(value)) throw problem('Miro 条目 ID 必须是明确的数字字符串。', 'miro_item_invalid');
  return value;
}
export function miroEmbedURL({ boardId, itemId: targetItem } = {}) {
  const id = parseMiroBoard(boardId);
  return `https://miro.com/app/live-embed/${id}/?embedMode=${MIRO_EMBED_MODE}&autoplay=true${targetItem === undefined ? '' : '&moveToWidget=' + itemId(targetItem)}`;
}
function cursorValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_~.+/=|:-]{1,2048}$/.test(value) || value.includes('://'))
    throw problem('Miro 分页游标无效，请重新读取明确画板。', 'miro_cursor_invalid');
  return value;
}
function string(value, max = MIRO_TEXT_LIMIT, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0') || Buffer.byteLength(value) > max) throw protocol();
  return value;
}
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw protocol();
  return value;
}
function timestamp(value) {
  if (value === undefined || value === null) return null;
  const text = string(value, 64);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text) || !Number.isFinite(Date.parse(text))) throw protocol();
  return text;
}
function canonical(value, depth = 0) {
  if (depth > 24) throw protocol();
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(key => JSON.stringify(key) + ':' + canonical(value[key], depth + 1))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
const sourceDigest = value => sha(canonical(value));

// The same plain-text extraction rules used for existing explicit HTML sources:
// no HTML is rendered, links/attributes are not imported and script/style bodies
// are removed. Decode entities once, after removing markup; the result is data.
function plainHTML(value) {
  return string(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->/gi, '')
    .replace(/<\/(?:p|div|h[1-6]|li|tr|section|article|pre)>|<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(
      /&(?:amp|lt|gt|quot|apos|nbsp);/g,
      entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' })[entity]
    )
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, value) => {
      const code = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    })
    .replace(/\n[ \t]*\n[ \t]*\n/g, '\n\n')
    .trim();
}
function numbers(value, keys, dimensions = false) {
  if (value === undefined || value === null) return null;
  record(value);
  const result = {};
  for (const key of keys)
    if (value[key] !== undefined) {
      const number = value[key];
      if (
        typeof number !== 'number' ||
        !Number.isFinite(number) ||
        Math.abs(number) > 1e12 ||
        (dimensions && ['width', 'height'].includes(key) && number < 0)
      )
        throw protocol();
      result[key] = number;
    }
  return result;
}
function normalizeBoard(value, boardId) {
  const row = record(value);
  if (row.type !== 'board' || row.id !== boardId) throw protocol();
  const name = plainHTML(string(row.name, 4096)),
    description = plainHTML(string(row.description, 16384));
  let teamId = null;
  if (row.team !== undefined) {
    record(row.team);
    teamId = itemId(row.team.id);
  }
  if (!name) throw protocol();
  const metadata = { boardId, title: name, name, description, teamId };
  const dates = { createdAt: timestamp(row.createdAt), modifiedAt: timestamp(row.modifiedAt) };
  return {
    ...metadata,
    ...dates,
    metadataFingerprint: sourceDigest(metadata),
    fingerprint: sourceDigest({ ...metadata, ...dates }),
    embedURL: miroEmbedURL({ boardId }),
    modelCalls: 0
  };
}
function normalizeItem(value, boardId) {
  const row = record(value),
    id = itemId(row.id);
  if (
    (row.boardId !== undefined && row.boardId !== boardId) ||
    (row.board !== undefined && row.board?.id !== boardId) ||
    typeof row.type !== 'string' ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(row.type)
  )
    throw protocol();
  const data = row.data === undefined ? {} : record(row.data),
    parent = row.parent == null ? null : record(row.parent),
    parentId = parent?.id == null ? null : itemId(parent.id);
  const geometry = numbers(row.geometry, ['width', 'height', 'rotation'], true),
    position = numbers(row.position, ['x', 'y']);
  if (position && row.position.origin !== undefined) {
    if (!['center', 'top_left'].includes(row.position.origin)) throw protocol();
    position.origin = row.position.origin;
  }
  if (position && row.position.relativeTo !== undefined) {
    if (!['canvas_center', 'parent_top_left'].includes(row.position.relativeTo)) throw protocol();
    position.relativeTo = row.position.relativeTo;
  }
  const supported = TEXTUAL.has(row.type);
  const titleText = plainHTML(string(data.title, 16384));
  let text = '';
  if (supported)
    text = ['card', 'app_card'].includes(row.type)
      ? [titleText, plainHTML(data.description)].filter(Boolean).join('\n\n')
      : plainHTML(data.content);
  if (Buffer.byteLength(text) > MIRO_TEXT_LIMIT) throw protocol();
  const title = (
    titleText ||
    text.split('\n')[0] ||
    { frame: '框架', image: '图片', embed: '嵌入内容', document: '附件', doc_format: '结构化文档', data_table_format: '数据表' }[
      row.type
    ] ||
    'Miro 条目'
  ).slice(0, 200);
  const modelEligible = supported && text.trim().length > 0;
  const limitations =
    row.type === 'frame'
      ? ['仅返回框架自身信息；其标题不代表子条目。请分页列出直接子条目并明确选择。']
      : !supported
        ? ['此条目类型尚未取得可验证正文，不作为文字任务输入；附件及嵌入内容未下载或执行。']
        : !text.trim()
          ? ['该条目没有可验证文字正文，不能作为任务输入。']
          : row.type === 'app_card'
            ? ['仅读取应用卡片的标题和描述；自定义字段未转换为正文。']
            : [];
  const source = {
    type: row.type,
    data,
    style: row.style || null,
    parentId,
    geometry,
    position,
    createdAt: timestamp(row.createdAt),
    modifiedAt: timestamp(row.modifiedAt)
  };
  const rawSourceHash = sourceDigest(source),
    sourceHash = sha(text);
  return {
    boardId,
    id,
    itemId: id,
    type: row.type,
    title,
    text,
    sourceHash,
    rawSourceHash,
    parentId,
    geometry,
    position,
    createdAt: source.createdAt,
    modifiedAt: source.modifiedAt,
    modelEligible,
    limitations,
    fingerprint: sourceDigest({ boardId, id, sourceHash, rawSourceHash }),
    embedURL: miroEmbedURL({ boardId, itemId: id }),
    modelCalls: 0
  };
}

export function createMiroBoards({ store, fetchImpl = fetch, now = Date.now, timeoutMs = 12000 } = {}) {
  if (!store?.seal || !store?.unseal || !store?.get || !store?.put)
    throw problem('Miro 接入需要 Hub 自有加密存储。', 'miro_store_required', 500);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw problem('Miro 读取超时配置无效。');
  let verifiedRevision = null,
    lastReadAt = null;
  const verifiedBoards = new Set(),
    config = () => store.get(CONFIG_KIND, CONFIG_ID),
    time = () => new Date(now()).toISOString();
  function status() {
    const c = config(),
      configured = !!c?.sealedToken && Array.isArray(c.boardIds) && c.boardIds.length > 0,
      verified = configured && verifiedRevision === c.connectionRevision;
    return {
      source: 'miro',
      configured,
      connected: verified ? true : null,
      boardIds: c?.boardIds || [],
      boardCount: c?.boardIds?.length || 0,
      connectionRevision: c?.connectionRevision || null,
      apiVersion: MIRO_API_VERSION,
      requiredScopes: ['boards:read'],
      read: configured,
      write: false,
      embedMode: MIRO_EMBED_MODE,
      embedAuthentication: 'separate-user-session-not-rest-token',
      verifiedBoardIds: verified ? [...verifiedBoards].sort() : [],
      lastReadAt: verified ? lastReadAt : null,
      modelCalls: 0
    };
  }
  function configure({ token, boardIds, confirmed } = {}) {
    if (confirmed !== true) throw problem('保存 Miro 令牌和明确画板范围前需要确认。', 'confirmation_required');
    if (!Array.isArray(boardIds) || !boardIds.length || boardIds.length > 20)
      throw problem('请明确选择 1 至 20 个允许接入的 Miro 画板。', 'miro_scope_invalid');
    const ids = [...new Set(boardIds.map(parseMiroBoard))].sort(),
      old = config();
    if (token !== undefined && (typeof token !== 'string' || token.length < 8 || token.length > 4096 || !/^[\x21-\x7e]+$/.test(token)))
      throw problem('Miro 令牌格式无效，请在 Hub 连接窗口重新填写。', 'miro_token_invalid');
    if (token === undefined && !old?.sealedToken) throw problem('请明确配置 Hub 自己使用的 Miro 令牌。', 'miro_not_configured', 409);
    let oldToken;
    try {
      oldToken = old?.sealedToken ? store.unseal(old.sealedToken) : undefined;
    } catch {
      throw problem('Hub 无法解密原 Miro 连接，请重新配置。', 'miro_configuration_invalid', 409);
    }
    if (old && (token === undefined || token === oldToken) && digest(ids) === digest(old.boardIds)) return status();
    store.put(CONFIG_KIND, {
      id: CONFIG_ID,
      sealedToken: store.seal(token === undefined ? oldToken : token),
      boardIds: ids,
      connectionRevision: randomUUID()
    });
    verifiedBoards.clear();
    return status();
  }
  function scope(boardValue, expectedRevision) {
    const boardId = parseMiroBoard(boardValue),
      c = config();
    if (!c?.sealedToken || !c?.connectionRevision || !Array.isArray(c.boardIds))
      throw problem('请先配置 Hub 的 Miro 连接与明确画板范围。', 'miro_not_configured', 409);
    if (expectedRevision !== undefined && expectedRevision !== c.connectionRevision)
      throw problem('Miro 连接已变化，请重新读取画板。', 'miro_connection_changed', 409);
    if (!c.boardIds.includes(boardId)) throw problem('该画板不在 Hub 明确配置的范围内。', 'miro_board_not_allowed', 403);
    return { boardId, c };
  }
  const check = (c, boardId) => scope(boardId, c.connectionRevision);
  function verified(c, boardId) {
    check(c, boardId);
    if (verifiedRevision !== c.connectionRevision) verifiedBoards.clear();
    verifiedRevision = c.connectionRevision;
    verifiedBoards.add(boardId);
    lastReadAt = time();
  }
  async function request(c, path) {
    let token;
    try {
      token = store.unseal(c.sealedToken);
    } catch {
      throw problem('Hub 无法解密 Miro 连接，请重新配置。', 'miro_configuration_invalid', 409);
    }
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(problem('Miro 读取超时，未自动重试。', 'miro_timeout', 504));
      }, timeoutMs);
    });
    const operation = async () => {
      let response;
      try {
        response = await fetchImpl(ORIGIN + path, {
          method: 'GET',
          redirect: 'error',
          signal: controller.signal,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
        });
      } catch {
        throw problem('Miro 连接未取得可确认的响应，未自动重试。', 'miro_network', 502);
      }
      if (!response || !Number.isInteger(response.status)) throw protocol();
      if (response.url && response.url !== ORIGIN + path) throw problem('Miro 响应来源变化，已停止读取。', 'miro_response_redirect', 502);
      if (response.status !== 200) {
        const code =
          response.status >= 300 && response.status < 400
            ? 'miro_response_redirect'
            : response.status === 429
              ? 'miro_rate_limited'
              : 'miro_http_error';
        const reset = response.headers?.get('x-ratelimit-reset'),
          retry = response.headers?.get('retry-after');
        throw Object.assign(
          problem(
            response.status === 429
              ? 'Miro 当前读取额度已到上限，请稍后手动重试。'
              : 'Miro 未允许此次读取，请核对 Hub 令牌与目标画板权限。',
            code,
            response.status >= 400 && response.status < 500 ? response.status : 502
          ),
          {
            upstreamStatus: response.status,
            ...(reset && /^\d{1,16}$/.test(reset) ? { rateLimitReset: Number(reset) } : {}),
            ...(retry && /^\d{1,6}$/.test(retry) ? { retryAfterSeconds: Number(retry) } : {})
          }
        );
      }
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type') || '')) throw protocol();
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > RESPONSE_LIMIT)) throw protocol();
      const reader = response.body?.getReader();
      if (!reader) throw protocol();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > RESPONSE_LIMIT) throw protocol();
          chunks.push(Buffer.from(value));
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      } catch {
        try {
          await reader.cancel();
        } catch {}
        throw protocol();
      } finally {
        reader.releaseLock();
      }
    };
    try {
      return await Promise.race([operation(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function getBoard(c, boardId) {
    check(c, boardId);
    const row = normalizeBoard(await request(c, `/v2/boards/${encodeURIComponent(boardId)}`), boardId);
    check(c, boardId);
    return row;
  }
  async function getItem(c, boardId, id) {
    check(c, boardId);
    const row = normalizeItem(await request(c, `/v2/boards/${encodeURIComponent(boardId)}/items/${itemId(id)}`), boardId);
    check(c, boardId);
    if (row.id !== id) throw protocol();
    return row;
  }
  const publicItem = (row, c) => ({
    ...row,
    connectionRevision: c.connectionRevision,
    readAt: time(),
    trust: 'reference-data-not-instructions'
  });
  async function readBoard({ boardId: value, expectedConnectionRevision } = {}) {
    const { boardId, c } = scope(value, expectedConnectionRevision),
      row = await getBoard(c, boardId);
    verified(c, boardId);
    return { ...row, connectionRevision: c.connectionRevision, readAt: time() };
  }
  async function readItem({ boardId: value, itemId: id, expectedConnectionRevision } = {}) {
    itemId(id);
    const { boardId, c } = scope(value, expectedConnectionRevision),
      row = await getItem(c, boardId, id);
    verified(c, boardId);
    return publicItem(row, c);
  }
  async function listItems({ boardId: value, parentItemId, type, cursor, limit = 50, expectedConnectionRevision } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 10 || limit > 50) throw problem('Miro 每页条目数量须为 10 至 50。', 'miro_limit_invalid');
    if (parentItemId !== undefined) itemId(parentItemId);
    if (type !== undefined && !TYPES.has(type)) throw problem('Miro 条目类型筛选无效。', 'miro_type_invalid');
    const pageCursor = cursorValue(cursor),
      { boardId, c } = scope(value, expectedConnectionRevision),
      query = new URLSearchParams({ limit: String(limit) });
    if (parentItemId !== undefined) query.set('parent_item_id', parentItemId);
    if (type !== undefined) query.set('type', type);
    if (pageCursor !== null) query.set('cursor', pageCursor);
    const raw = record(await request(c, `/v2/boards/${encodeURIComponent(boardId)}/items?${query}`));
    check(c, boardId);
    if ((raw.type !== undefined && raw.type !== 'cursor-list') || !Array.isArray(raw.data) || raw.data.length > limit) throw protocol();
    const items = raw.data.map(row => normalizeItem(row, boardId));
    if (
      new Set(items.map(row => row.id)).size !== items.length ||
      items.some(row => (type !== undefined && row.type !== type) || (parentItemId !== undefined && row.parentId !== parentItemId))
    )
      throw protocol();
    let nextCursor;
    try {
      nextCursor = cursorValue(raw.cursor);
    } catch {
      throw protocol();
    }
    if ((nextCursor !== null && nextCursor === pageCursor) || (nextCursor === null && raw.links?.next)) throw protocol();
    verified(c, boardId);
    return {
      boardId,
      items: items.map(row => publicItem(row, c)),
      cursor: nextCursor,
      nextCursor,
      hasMore: nextCursor !== null,
      complete: pageCursor === null && nextCursor === null,
      pageComplete: true,
      scope: { parentItemId: parentItemId ?? null, type: type ?? null, limit },
      connectionRevision: c.connectionRevision,
      fingerprint: sourceDigest({
        connectionRevision: c.connectionRevision,
        boardId,
        parentItemId: parentItemId ?? null,
        type: type ?? null,
        pageCursor,
        nextCursor,
        items: items.map(row => row.fingerprint)
      }),
      readAt: time(),
      limitations: ['只代表本次 API 分页结果，不是原子画板快照；仅明确选择并复核的文字条目才能作为任务输入。'],
      modelCalls: 0
    };
  }
  async function readFrame({ boardId: value, frameId, cursor, limit = 50, expectedConnectionRevision } = {}) {
    itemId(frameId);
    const { boardId, c } = scope(value, expectedConnectionRevision),
      before = await getItem(c, boardId, frameId);
    if (before.type !== 'frame') throw problem('所选条目不是 Miro 框架。', 'miro_frame_invalid');
    const page = await listItems({ boardId, parentItemId: frameId, cursor, limit, expectedConnectionRevision: c.connectionRevision }),
      after = await getItem(c, boardId, frameId);
    if (before.fingerprint !== after.fingerprint) throw problem('读取期间框架已变化，请重新读取。', 'miro_source_changed', 409);
    return {
      ...page,
      frame: publicItem(after, c),
      limitations: [...page.limitations, '仅列出当前页的框架直属子项，不自动递归嵌套框架；框架标题不作为子项全文。']
    };
  }
  async function readSelection({ boardId: value, itemIds, expectedConnectionRevision } = {}) {
    if (!Array.isArray(itemIds) || itemIds.length < 1 || itemIds.length > 20 || new Set(itemIds).size !== itemIds.length)
      throw problem('请明确选择 1 至 20 个不重复的 Miro 文字条目。', 'miro_selection_invalid');
    itemIds.forEach(itemId);
    const { boardId, c } = scope(value, expectedConnectionRevision),
      before = await getBoard(c, boardId);
    const pass = async () => {
      const result = new Array(itemIds.length);
      let next = 0,
        failed = false;
      const work = await Promise.allSettled(
        Array.from({ length: Math.min(4, itemIds.length) }, async () => {
          while (!failed && next < itemIds.length) {
            const index = next++;
            try {
              result[index] = await getItem(c, boardId, itemIds[index]);
            } catch (error) {
              failed = true;
              throw error;
            }
          }
        })
      );
      const error = work.find(row => row.status === 'rejected');
      if (error) throw error.reason;
      return result;
    };
    const first = await pass();
    if (first.some(row => !row.modelEligible))
      throw problem('所选条目含框架、未支持类型或空正文，请选择可验证文字条目。', 'miro_item_not_textual', 415);
    const second = await pass(),
      after = await getBoard(c, boardId);
    check(c, boardId);
    if (
      before.metadataFingerprint !== after.metadataFingerprint ||
      first.some((row, index) => row.fingerprint !== second[index].fingerprint)
    )
      throw problem('两轮读取之间画板身份、名称或所选条目已变化，请重新预览选择。', 'miro_source_changed', 409);
    const text = second.map(row => `## ${row.title}\nMiro 条目：${row.id}（${row.type}）\n\n${row.text}`).join('\n\n');
    if (Buffer.byteLength(text) > MIRO_TEXT_LIMIT)
      throw problem('所选 Miro 正文合计超过 256 KiB，请缩小选择。', 'miro_selection_too_large', 413);
    const sourceHash = sha(text),
      rawSourceHash = sourceDigest(second.map(row => ({ id: row.id, rawSourceHash: row.rawSourceHash }))),
      boardMetadataFingerprint = after.metadataFingerprint;
    // Unselected item edits do not silently change this selected-item reference.
    // A board modifiedAt change may concern an unselected item. It is display
    // metadata, not proof of selected-item drift or an atomic board version.
    const fingerprint = sourceDigest({
      connectionRevision: c.connectionRevision,
      boardId,
      boardMetadataFingerprint,
      itemIds,
      sourceHash,
      rawSourceHash
    });
    const limitations = [
      ...new Set(['仅为明确选定的文字条目引用，不代表整块画板或框架，也不是原子画板快照。', ...second.flatMap(row => row.limitations)])
    ];
    verified(c, boardId);
    return {
      boardId,
      title: after.title,
      items: second.map(row => publicItem(row, c)),
      itemIds: [...itemIds],
      text,
      sourceHash,
      rawSourceHash,
      fingerprint,
      boardMetadataFingerprint,
      connectionRevision: c.connectionRevision,
      bytes: Buffer.byteLength(text),
      readAt: time(),
      modelEligible: true,
      limitations,
      provenance: {
        source: 'miro',
        apiVersion: MIRO_API_VERSION,
        boardId,
        itemIds: [...itemIds],
        connectionRevision: c.connectionRevision,
        boardMetadataFingerprint,
        sourceHash,
        rawSourceHash,
        fingerprint
      },
      trust: 'reference-data-not-instructions',
      modelCalls: 0
    };
  }
  return { configure, status, readBoard, listItems, readItem, readFrame, readSelection };
}
