import { createHash, randomUUID } from 'node:crypto';
import { fail, digest } from './store.mjs';

// Thin, deliberately page-scoped Notion protocol adapter. Approval and durable
// attempt ownership belong to the task manager, not to this connector.
// Contract: parseNotionPage -> canonical UUID string; configure/status expose no
// token; read -> immutable content fingerprint; preparePatch -> exact body/hash;
// write requires the host's beforeWrite() authority check immediately before
// PATCH, then returns a fresh read-back snapshot and previous fingerprints.
export const NOTION_VERSION = '2026-03-11';
export const NOTION_MARKDOWN_VERSION = 'v1';
export const NOTION_TEXT_LIMIT = 256 * 1024;
// Notion's documented overall payload limit is 500 KB. Count actual serialized
// UTF-8 bytes, including JSON escapes and both sides of a replacement.
export const NOTION_PATCH_LIMIT = 500000;
const RESPONSE_LIMIT = 2 * 1024 * 1024;
const CONFIG_KIND = 'knowledge-connector',
  CONFIG_ID = 'notion';
const API_ORIGIN = 'https://api.notion.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{32}$/i;
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
const bad = (message, code = 'notion_invalid_request', status = 400) => fail(message, status, code);
function canonicalUUID(value) {
  if (typeof value !== 'string' || !(UUID.test(value) || HEX.test(value)))
    throw bad('请提供明确的 Notion 页面 ID 或页面链接。', 'notion_page_invalid');
  const h = value.replaceAll('-', '').toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function parseNotionPage(value) {
  if (typeof value !== 'string' || value.length > 4096 || value !== value.trim())
    throw bad('请提供明确的 Notion 页面 ID 或页面链接。', 'notion_page_invalid');
  if (UUID.test(value) || HEX.test(value)) return canonicalUUID(value);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw bad('Notion 页面链接无效。', 'notion_page_invalid');
  }
  const host = url.hostname.toLowerCase();
  const officialPageHost = ['notion.so', 'notion.site'].some(base => host === base || host.endsWith('.' + base));
  if (url.protocol !== 'https:' || url.username || url.password || url.port || (!officialPageHost && host !== 'app.notion.com'))
    throw bad('仅接受 Notion 官方 HTTPS 页面链接。', 'notion_page_invalid');
  if (host === 'app.notion.com') {
    // This is an official connector return form, not a general notion.com URL
    // allowance. Only the exact /p/<page-id> route is a page reference.
    const page = /^\/p\/([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(url.pathname);
    if (!page) throw bad('该 Notion 应用链接不是明确的页面链接。', 'notion_page_invalid');
    return canonicalUUID(page[1]);
  }
  let segment;
  try {
    segment = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) || '');
  } catch {
    throw bad('Notion 页面链接无效。', 'notion_page_invalid');
  }
  if (UUID.test(segment) || HEX.test(segment)) return canonicalUUID(segment);
  const suffix = /-([0-9a-f]{32})$/i.exec(segment);
  if (!suffix) throw bad('链接中没有明确的 Notion 页面 ID。', 'notion_page_invalid');
  return canonicalUUID(suffix[1]);
}

function markdownText(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0') || Buffer.byteLength(value, 'utf8') > NOTION_TEXT_LIMIT)
    throw bad('Notion 正文必须是完整 UTF-8 文本，且不超过 256 KiB。', 'notion_text_limit');
  return value;
}
function boundaryLeft(text, index) {
  return index > 0 && index < text.length && /[\uDC00-\uDFFF]/.test(text[index]) && /[\uD800-\uDBFF]/.test(text[index - 1])
    ? index - 1
    : index;
}
function boundaryRight(text, index) {
  return index > 0 && index < text.length && /[\uDC00-\uDFFF]/.test(text[index]) && /[\uD800-\uDBFF]/.test(text[index - 1])
    ? index + 1
    : index;
}
function unique(text, needle) {
  const first = needle.length ? text.indexOf(needle) : -1;
  return first !== -1 && text.indexOf(needle, first + 1) === -1;
}

// One contiguous change, with the smallest symmetric context radius needed to
// make old_str unique (binary search, bounded O(n log n), Unicode-safe bounds).
// Empty pages use the documented insertion command; no force-replacement,
// replace_all_matches or allow_deleting_content escape hatch is exposed.
export function preparePatch(source, result) {
  markdownText(source);
  markdownText(result);
  if (source === result) throw bad('正文没有变化，无需发布。', 'notion_no_change', 409);
  let body, changedRange;
  if (!source.length) {
    body = {
      type: 'insert_content',
      insert_content: { content: result, position: { type: 'start' } },
      allow_async: false,
      markdown_version: NOTION_MARKDOWN_VERSION
    };
    changedRange = { sourceStart: 0, sourceEnd: 0, resultStart: 0, resultEnd: result.length };
  } else {
    let prefix = 0,
      suffix = 0;
    while (prefix < Math.min(source.length, result.length) && source[prefix] === result[prefix]) prefix++;
    prefix = boundaryLeft(source, prefix);
    while (
      suffix < Math.min(source.length - prefix, result.length - prefix) &&
      source[source.length - 1 - suffix] === result[result.length - 1 - suffix]
    )
      suffix++;
    const end = boundaryRight(source, source.length - suffix);
    suffix = source.length - end;
    const newEnd = result.length - suffix;
    const range = radius => [
      boundaryLeft(source, Math.max(0, prefix - radius)),
      boundaryRight(source, Math.min(source.length, end + radius))
    ];
    let low = 0,
      high = source.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2),
        [left, right] = range(mid);
      if (unique(source, source.slice(left, right))) high = mid;
      else low = mid + 1;
    }
    const [left, right] = range(low),
      oldStr = source.slice(left, right);
    const newStr = source.slice(left, prefix) + result.slice(prefix, newEnd) + source.slice(end, right);
    if (!unique(source, oldStr) || source.replace(oldStr, () => newStr) !== result)
      throw bad('无法生成唯一且精确的 Notion 文本替换。', 'notion_patch_ambiguous', 409);
    body = {
      type: 'update_content',
      update_content: { content_updates: [{ old_str: oldStr, new_str: newStr }] },
      allow_async: false,
      markdown_version: NOTION_MARKDOWN_VERSION
    };
    changedRange = { sourceStart: left, sourceEnd: right, resultStart: left, resultEnd: left + newStr.length };
  }
  const payloadBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  if (payloadBytes > NOTION_PATCH_LIMIT)
    throw bad('这份修改的 Notion 请求超过 500 KB，请缩小修改范围后重新准备；尚未发出写入。', 'notion_patch_too_large', 413);
  return { body, patchHash: digest(body), sourceHash: sha(source), resultHash: sha(result), changedRange, payloadBytes };
}

function invalidProtocol() {
  return bad('Notion 返回的页面数据不完整或协议不符，请重新核对连接。', 'notion_protocol_invalid', 502);
}
function parentOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidProtocol();
  if (value.type === 'workspace' && value.workspace === true) return { type: 'workspace', workspace: true };
  if (!['page_id', 'database_id', 'data_source_id', 'block_id'].includes(value.type)) throw invalidProtocol();
  try {
    return { type: value.type, [value.type]: canonicalUUID(value[value.type]) };
  } catch {
    throw invalidProtocol();
  }
}
function metadata(value, pageId) {
  if (!value || value.object !== 'page') throw invalidProtocol();
  let id;
  try {
    id = canonicalUUID(value.id);
  } catch {
    throw invalidProtocol();
  }
  if (
    id !== pageId ||
    typeof value.archived !== 'boolean' ||
    typeof value.in_trash !== 'boolean' ||
    typeof value.last_edited_time !== 'string' ||
    value.last_edited_time.length > 64 ||
    !Number.isFinite(Date.parse(value.last_edited_time))
  )
    throw invalidProtocol();
  if (value.archived || value.in_trash) throw bad('该 Notion 页面已归档或移入废纸篓。', 'notion_page_unavailable', 409);
  if (!value.properties || typeof value.properties !== 'object' || Array.isArray(value.properties)) throw invalidProtocol();
  const titleProperties = Object.values(value.properties).filter(row => row?.type === 'title');
  if (titleProperties.length !== 1) throw invalidProtocol();
  const titleParts = titleProperties[0].title;
  if (!Array.isArray(titleParts) || titleParts.length > 512) throw invalidProtocol();
  const title = titleParts
    .map(part => {
      if (typeof part?.plain_text === 'string') return part.plain_text;
      if (typeof part?.text?.content === 'string') return part.text.content;
      throw invalidProtocol();
    })
    .join('');
  if (Buffer.byteLength(title) > 4096 || !title.isWellFormed()) throw invalidProtocol();
  return {
    pageId: id,
    title: title || 'Untitled',
    parent: parentOf(value.parent),
    archived: false,
    inTrash: false,
    lastEditedTime: value.last_edited_time
  };
}
function content(value, pageId) {
  if (!value || value.object !== 'page_markdown') throw invalidProtocol();
  let id;
  try {
    id = canonicalUUID(value.id);
  } catch {
    throw invalidProtocol();
  }
  if (
    id !== pageId ||
    typeof value.truncated !== 'boolean' ||
    !Array.isArray(value.unknown_block_ids) ||
    value.unknown_block_ids.length > 1000 ||
    (value.warnings !== undefined && (!Array.isArray(value.warnings) || value.warnings.length > 1000))
  )
    throw invalidProtocol();
  let text, unknownBlockIds;
  try {
    text = markdownText(value.markdown);
    unknownBlockIds = value.unknown_block_ids.map(canonicalUUID);
  } catch {
    throw invalidProtocol();
  }
  // Never echo remote error/warning messages: they can include tokens, URLs,
  // content excerpts or server-controlled instructions. Codes are allow-shaped.
  const warnings = (value.warnings || []).map(row => ({
    code: ['unsupported_tag', 'no_match', 'indentation_mismatch'].includes(row?.code) ? row.code : 'notion_warning',
    message: 'Notion 报告内容未被完整处理，请在原页面核对。'
  }));
  return {
    text,
    sourceHash: sha(text),
    truncated: value.truncated,
    unknownBlockIds,
    warnings,
    editable: !value.truncated && !unknownBlockIds.length && !warnings.length
  };
}

export function createNotionPages({ store, fetchImpl = fetch, now = Date.now, timeoutMs = 12000 } = {}) {
  if (!store?.seal || !store?.unseal || !store?.get || !store?.put)
    throw bad('Notion 连接需要 Hub 加密存储。', 'notion_store_required', 500);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw bad('Notion 请求超时设置无效。');
  const inFlight = new Set();
  let verifiedRevision = null,
    lastReadAt = null;
  const time = () => new Date(now()).toISOString();
  const config = () => store.get(CONFIG_KIND, CONFIG_ID);
  function status() {
    const c = config(),
      configured = !!c?.sealedToken && Array.isArray(c?.pageIds) && c.pageIds.length > 0;
    return {
      source: 'notion',
      configured,
      connected: configured && verifiedRevision === c.connectionRevision ? true : null,
      pageIds: c?.pageIds || [],
      pageCount: c?.pageIds?.length || 0,
      connectionRevision: c?.connectionRevision || null,
      apiVersion: NOTION_VERSION,
      markdownVersion: NOTION_MARKDOWN_VERSION,
      read: configured,
      write: configured,
      lastReadAt: configured && verifiedRevision === c.connectionRevision ? lastReadAt : null,
      modelCalls: 0
    };
  }
  function configure({ token, pageIds, confirmed } = {}) {
    if (confirmed !== true) throw bad('保存 Notion 连接与允许读取的页面前需要明确确认。', 'confirmation_required');
    if (!Array.isArray(pageIds) || !pageIds.length || pageIds.length > 20)
      throw bad('请明确指定 1 至 20 个允许接入的 Notion 页面。', 'notion_scope_invalid');
    const ids = [...new Set(pageIds.map(parseNotionPage))].sort(),
      old = config();
    if (token !== undefined && (typeof token !== 'string' || token.length < 8 || token.length > 4096 || !/^[\x21-\x7E]+$/.test(token)))
      throw bad('Notion 令牌格式无效，请在 Hub 连接窗口重新填写。', 'notion_token_invalid');
    if (token === undefined && !old?.sealedToken) throw bad('请明确为 Hub 配置 Notion 令牌。', 'notion_not_configured', 409);
    let oldToken;
    try {
      oldToken = old?.sealedToken ? store.unseal(old.sealedToken) : undefined;
    } catch {
      throw bad('Hub 无法解密原 Notion 连接，请重新配置。', 'notion_configuration_invalid', 409);
    }
    if (old && (token === undefined || token === oldToken) && digest(ids) === digest(old.pageIds)) return status();
    store.put(CONFIG_KIND, {
      id: CONFIG_ID,
      sealedToken: store.seal(token === undefined ? oldToken : token),
      pageIds: ids,
      connectionRevision: randomUUID()
    });
    return status();
  }
  function scoped(pageValue, expectedRevision) {
    const pageId = parseNotionPage(pageValue),
      c = config();
    if (!c?.sealedToken || !c.connectionRevision || !Array.isArray(c.pageIds))
      throw bad('请先在 Hub 配置 Notion 连接和允许接入的页面。', 'notion_not_configured', 409);
    if (expectedRevision !== undefined && expectedRevision !== c.connectionRevision)
      throw bad('Notion 连接已变化，请重新打开页面。', 'notion_connection_changed', 409);
    if (!c.pageIds.includes(pageId)) throw bad('该页面不在 Hub 明确配置的 Notion 页面范围内。', 'notion_page_not_allowed', 403);
    return { c, pageId };
  }
  function current(c, pageId) {
    scoped(pageId, c.connectionRevision);
  }
  async function request(c, path, method = 'GET', body) {
    let token;
    try {
      token = store.unseal(c.sealedToken);
    } catch {
      throw bad('Hub 无法解密 Notion 连接，请重新配置。', 'notion_configuration_invalid', 409);
    }
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(bad('Notion 请求超时，请核对连接；没有自动重试。', 'notion_timeout', 504));
      }, timeoutMs);
    });
    const operation = async () => {
      let response;
      try {
        response = await fetchImpl(API_ORIGIN + path, {
          method,
          redirect: 'error',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token}`,
            'Notion-Version': NOTION_VERSION,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
      } catch {
        throw bad('Notion 请求未取得可确认的响应；没有自动重试。', 'notion_network', 502);
      }
      if (!response || !Number.isInteger(response.status)) throw invalidProtocol();
      if (response.url) {
        let url;
        try {
          url = new URL(response.url);
        } catch {
          throw invalidProtocol();
        }
        if (url.href !== API_ORIGIN + path) throw bad('Notion 响应来源变化，已停止。', 'notion_response_redirect', 502);
      }
      if (response.status !== 200) {
        const code = response.status >= 300 && response.status < 400 ? 'notion_response_redirect' : 'notion_http_error';
        throw Object.assign(
          bad(
            'Notion 未确认此次请求，请在原页面核对；没有自动重试。',
            code,
            response.status >= 500 ? 502 : response.status >= 400 && response.status < 500 ? response.status : 502
          ),
          { upstreamStatus: response.status }
        );
      }
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type') || '')) throw invalidProtocol();
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > RESPONSE_LIMIT)) throw invalidProtocol();
      const reader = response.body?.getReader();
      if (!reader) throw invalidProtocol();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > RESPONSE_LIMIT) throw invalidProtocol();
          chunks.push(Buffer.from(value));
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      } catch (error) {
        try {
          await reader.cancel();
        } catch {}
        if (error?.code === 'notion_protocol_invalid') throw error;
        throw invalidProtocol();
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
  async function read({ pageId: pageValue, expectedConnectionRevision } = {}) {
    const { pageId, c } = scoped(pageValue, expectedConnectionRevision);
    const before = metadata(await request(c, `/v1/pages/${pageId}`), pageId);
    current(c, pageId);
    const body = content(await request(c, `/v1/pages/${pageId}/markdown?markdown_version=${NOTION_MARKDOWN_VERSION}`), pageId);
    current(c, pageId);
    const after = metadata(await request(c, `/v1/pages/${pageId}`), pageId);
    current(c, pageId);
    if (digest(before) !== digest(after)) throw bad('读取期间 Notion 页面发生变化，请重新打开。', 'notion_source_changed', 409);
    const readAt = time();
    verifiedRevision = c.connectionRevision;
    lastReadAt = readAt;
    return {
      ...after,
      ...body,
      bytes: Buffer.byteLength(body.text, 'utf8'),
      connectionRevision: c.connectionRevision,
      fingerprint: digest({
        version: 1,
        connectionRevision: c.connectionRevision,
        metadata: after,
        sourceHash: body.sourceHash,
        truncated: body.truncated,
        unknownBlockIds: body.unknownBlockIds,
        warnings: body.warnings
      }),
      readAt,
      trust: 'reference-data-not-instructions',
      modelEligible: body.editable,
      limitation: body.editable ? null : '此预览不完整，不能编辑或作为任务输入；请先在 Notion 中核对。',
      modelCalls: 0
    };
  }
  async function write({
    pageId: pageValue,
    expectedFingerprint,
    resultText,
    expectedConnectionRevision,
    expectedPatchHash,
    beforeWrite
  } = {}) {
    const { pageId, c } = scoped(pageValue, expectedConnectionRevision);
    if (typeof expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(expectedFingerprint))
      throw bad('发布前缺少已核对的 Notion 页面指纹。', 'notion_fingerprint_required');
    if (expectedPatchHash !== undefined && (typeof expectedPatchHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedPatchHash)))
      throw bad('Notion 发布请求摘要格式无效。', 'notion_patch_hash_invalid');
    markdownText(resultText);
    if (typeof beforeWrite !== 'function') throw bad('发布前需要 Hub 核对当前任务与审批授权。', 'notion_write_authority_required', 409);
    if (inFlight.has(pageId)) throw bad('该 Notion 页面已有写入正在核对，请勿重复发布。', 'notion_write_busy', 409);
    inFlight.add(pageId);
    let dispatched = false,
      patchAccepted = false;
    try {
      const before = await read({ pageId, expectedConnectionRevision: c.connectionRevision });
      if (before.fingerprint !== expectedFingerprint)
        throw bad('Notion 原页面或连接已变化，请重新对比后申请发布。', 'notion_source_changed', 409);
      if (!before.editable) throw bad('Notion 页面含未完整读取的内容，本次不能发布。', 'notion_incomplete', 409);
      const plan = preparePatch(before.text, resultText);
      if (expectedPatchHash !== undefined && plan.patchHash !== expectedPatchHash)
        throw bad('Notion 实际写入请求与已批准方案不同，请重新核对发布方案。', 'notion_patch_changed', 409);
      current(c, pageId);
      let authorized;
      try {
        authorized = await beforeWrite();
      } catch {
        throw Object.assign(bad('Hub 未确认当前任务与审批授权，尚未写入 Notion。', 'notion_write_authority_changed', 409), {
          outcomeUnknown: false
        });
      }
      if (authorized !== true)
        throw Object.assign(bad('Hub 未确认当前任务与审批授权，尚未写入 Notion。', 'notion_write_authority_changed', 409), {
          outcomeUnknown: false
        });
      // Only synchronous local checks follow the host authorization hook. No
      // network round-trip can open another approval race before dispatch.
      current(c, pageId);
      dispatched = true;
      const patch = content(await request(c, `/v1/pages/${pageId}/markdown`, 'PATCH', plan.body), pageId);
      patchAccepted = true;
      current(c, pageId);
      // PATCH echoes alone never prove delivery. Fetch metadata/content again,
      // including a second metadata read, and require the exact expected bytes.
      const after = await read({ pageId, expectedConnectionRevision: c.connectionRevision });
      if (
        !patch.editable ||
        patch.sourceHash !== plan.resultHash ||
        !after.editable ||
        after.sourceHash !== plan.resultHash ||
        before.title !== after.title ||
        digest(before.parent) !== digest(after.parent)
      )
        throw bad('Notion 写入后的内容未通过完整回读核对。', 'notion_readback_mismatch', 409);
      return {
        ...after,
        previousFingerprint: before.fingerprint,
        previousSourceHash: before.sourceHash,
        resultHash: after.sourceHash,
        patchHash: plan.patchHash,
        payloadBytes: plan.payloadBytes,
        published: true,
        readBack: true,
        outcomeUnknown: false,
        publishedAt: time(),
        concurrencyLimitation: 'Notion 不提供原子条件写入；Hub 已在派发前核对指纹并在写入后回读，但无法排除远端同时编辑。'
      };
    } catch (error) {
      if (!dispatched) throw Object.assign(error, { outcomeUnknown: false, writeDispatched: false });
      // Documented 4xx rejections mean this one PATCH was rejected. All other
      // failures after dispatch are uncertain, never eligible for auto replay.
      if (
        !patchAccepted &&
        error?.code === 'notion_http_error' &&
        Number.isInteger(error.upstreamStatus) &&
        error.upstreamStatus >= 400 &&
        error.upstreamStatus < 500 &&
        ![408, 425].includes(error.upstreamStatus)
      )
        throw Object.assign(error, { outcomeUnknown: false, writeDispatched: true });
      throw Object.assign(
        bad('Notion 写入已派发，但结果未能完整确认。请到原页面核对；禁止自动重试或重复发布。', 'notion_write_unknown', 409),
        {
          outcomeUnknown: true,
          writeDispatched: true,
          ...(Number.isInteger(error?.upstreamStatus) ? { upstreamStatus: error.upstreamStatus } : {})
        }
      );
    } finally {
      inFlight.delete(pageId);
    }
  }
  return { status, configure, read, write };
}
