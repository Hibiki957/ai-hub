// Read-only task document access. Zotero remains the source of truth. The
// caller owns task/project authorization and opaque, short-lived reader IDs.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { fail } from './store.mjs';

const ORIGIN = 'http://127.0.0.1:23119';
const ITEM_KEY = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;
const MAX_PDF = 16 * 1024 * 1024,
  MAX_JSON = 1024 * 1024;
const MAX_PAGES = 1000,
  MAX_PAGE_TEXT = 256 * 1024,
  CHILD_LIMIT = 20;
const hash = value => createHash('sha256').update(value).digest('hex');
const problem = (message, code, status = 409) => fail(message, status, code);
const unavailable = () =>
  problem('Zotero 本机接口暂不可用，请检查原应用；Hub 不会重配连接或借用其他客户端凭据。', 'zotero_document_unavailable', 503);
const changed = () => problem('Zotero 实例、附件或文件已变化，请重新打开文档。', 'zotero_document_changed');
const short = (value, max = 1000) => (typeof value === 'string' ? value.slice(0, max) : '');
const plain = value =>
  short(value, 12000)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(
      /&(?:amp|lt|gt|quot|apos|nbsp);/g,
      item => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' })[item]
    )
    .trim();

// Offsets are JavaScript UTF-16 offsets, as returned by a textarea's selection.
// Keep this validator shared by the task reader and later knowledge reads so a
// saved page quote never degrades into an attachment's metadata/fulltext index.
export function validateZoteroExcerpt(spec) {
  const fields = ['sourceFingerprint', 'sourceHash', 'page', 'pageTextHash', 'startOffset', 'endOffset', 'comment'];
  if (
    !spec ||
    typeof spec !== 'object' ||
    Array.isArray(spec) ||
    Object.keys(spec).some(key => !fields.includes(key)) ||
    !['sourceFingerprint', 'sourceHash', 'pageTextHash'].every(key => /^[a-f0-9]{64}$/.test(spec[key] || '')) ||
    !Number.isSafeInteger(spec.page) ||
    spec.page < 1 ||
    spec.page > MAX_PAGES ||
    !Number.isSafeInteger(spec.startOffset) ||
    spec.startOffset < 0 ||
    !Number.isSafeInteger(spec.endOffset) ||
    spec.endOffset <= spec.startOffset ||
    spec.endOffset > MAX_PAGE_TEXT ||
    (spec.comment !== undefined && (typeof spec.comment !== 'string' || spec.comment.length > 2000 || spec.comment.includes('\0')))
  )
    throw problem('页引用缺少完整的来源、页码或选段核验信息，请重新选择。', 'zotero_document_excerpt_spec', 400);
  return Object.freeze({
    sourceFingerprint: spec.sourceFingerprint,
    sourceHash: spec.sourceHash,
    page: spec.page,
    pageTextHash: spec.pageTextHash,
    startOffset: spec.startOffset,
    endOffset: spec.endOffset,
    ...(spec.comment ? { comment: spec.comment } : {})
  });
}

function excerptFor(snapshot, page, input) {
  const spec = validateZoteroExcerpt(input);
  if (
    snapshot.sourceFingerprint !== spec.sourceFingerprint ||
    snapshot.document.hash !== spec.sourceHash ||
    page.sourceHash !== spec.sourceHash ||
    page.page !== spec.page ||
    page.textHash !== spec.pageTextHash
  )
    throw problem('PDF 来源或该页文字已变化，请重新打开并选择。', 'zotero_document_excerpt_changed');
  const splitsSurrogate = offset =>
    offset > 0 && offset < page.text.length && /[\uD800-\uDBFF]/.test(page.text[offset - 1]) && /[\uDC00-\uDFFF]/.test(page.text[offset]);
  if (spec.endOffset > page.text.length || splitsSurrogate(spec.startOffset) || splitsSurrogate(spec.endOffset))
    throw problem('选段不在当前页的完整文字范围内，请重新选择。', 'zotero_document_excerpt_range', 400);
  const selected = page.text.slice(spec.startOffset, spec.endOffset);
  if (!selected.trim() || Buffer.byteLength(selected) > 16000)
    throw problem('请选择该页非空、且不超过 16,000 字节的文字选段。', 'zotero_document_excerpt_range', 400);
  const title = snapshot.document.title;
  const body = `【Zotero PDF 页引用】\n文档：${title}\n页码：${page.pageLabel}（第 ${page.page}/${page.pages} 页）\n选段：\n${selected}${spec.comment ? '\n\n批注（用户填写）：\n' + spec.comment : ''}`;
  return {
    body,
    sourceHash: snapshot.document.hash,
    contentType: 'text/plain',
    provenance: {
      source: 'zotero',
      kind: 'pdf-page-excerpt',
      itemKey: snapshot.document.itemKey,
      itemVersion: snapshot.document.itemVersion,
      ...spec,
      pageLabel: page.pageLabel,
      pages: page.pages,
      extraction: page.extraction,
      trust: 'reference-data-not-instructions'
    },
    limitation: '仅此 PDF、此页的明确文字选段与用户批注；不代表已读取整篇、图片或扫描内容。',
    modelCalls: 0
  };
}

function targetFor(location) {
  if (typeof location !== 'string' || location.length > 3000)
    throw problem('请明确选择一条 Zotero 文献或附件。', 'zotero_document_location', 400);
  let url;
  try {
    url = new URL(location);
  } catch {
    throw problem('Zotero 定位无效。', 'zotero_document_location', 400);
  }
  if (url.username || url.password || url.search || url.hash)
    throw problem('Zotero 定位不能携带其他权限或参数。', 'zotero_document_location', 400);
  let match;
  if (url.protocol === 'zotero:' && url.hostname === 'select')
    match = url.pathname.match(/^\/(?:library|groups\/([1-9][0-9]{0,14}))\/items\/([A-Z0-9]{8})$/);
  else if (url.origin === ORIGIN) match = url.pathname.match(/^\/api\/(?:users\/0|groups\/([1-9][0-9]{0,14}))\/items\/([A-Z0-9]{8})$/);
  if (!match || !ITEM_KEY.test(match[2]) || (match[1] && !Number.isSafeInteger(Number(match[1]))))
    throw problem('只接受明确的本机 Zotero 文献或附件定位。', 'zotero_document_location', 400);
  const groupId = match[1] || null,
    itemKey = match[2];
  return {
    groupId,
    itemKey,
    prefix: groupId ? `/api/groups/${groupId}` : '/api/users/0',
    location: `zotero://select/${groupId ? 'groups/' + groupId : 'library'}/items/${itemKey}`
  };
}
const itemLocation = (target, key) => `zotero://select/${target.groupId ? 'groups/' + target.groupId : 'library'}/items/${key}`;
const itemVersion = row => {
  const value = row?.version ?? row?.data?.version;
  if (!Number.isSafeInteger(value) || value < 0) throw problem('Zotero 未提供可核验的条目版本。', 'zotero_document_protocol', 503);
  return value;
};
function dataFor(value, expectedKey, target) {
  const data = value?.data;
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    !ITEM_KEY.test(value.key || '') ||
    (data.key && data.key !== value.key) ||
    (expectedKey && value.key !== expectedKey)
  )
    throw problem('Zotero 未返回有效的指定条目。', 'zotero_document_protocol', 503);
  if (data.version != null && data.version !== value.version) throw problem('Zotero 条目版本不一致。', 'zotero_document_protocol', 503);
  if (
    target &&
    (value.library?.type !== (target.groupId ? 'group' : 'user') || (target.groupId && String(value.library?.id) !== target.groupId))
  )
    throw problem('Zotero 条目不属于所选文献库。', 'zotero_document_scope', 403);
  itemVersion(value);
  return data;
}
function identity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    nlink: String(stat.nlink),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs)
  };
}
const sameIdentity = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function canonical(path) {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes('\0'))
    throw problem('附件位置不符合本机文件范围。', 'zotero_document_path', 403);
  // Credentials and private key locations must not become a PDF back door.
  if (
    /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.ssh|\.aws|\.gnupg|\.keychain|credentials|auth\.json)(?:\/|$)|\.(?:pem|p12|pfx|keychain-db)$/i.test(path)
  )
    throw problem('凭据文件不能作为附件读取。', 'zotero_document_path', 403);
  let cursor = parse(path).root;
  for (const part of path.slice(cursor.length).split('/').filter(Boolean)) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw problem('附件路径包含链接，请在原应用明确真实文件。', 'zotero_document_link', 403);
  }
  if ((await realpath(path)) !== path) throw problem('附件位置不是规范真实路径。', 'zotero_document_path', 403);
}
async function readPDF(path) {
  let file;
  try {
    await canonical(path);
    const before = await lstat(path, { bigint: true });
    if (!before.isFile()) throw problem('附件不是普通 PDF 文件。', 'zotero_document_type', 415);
    if (before.nlink !== 1n) throw problem('附件包含硬链接，暂不能在 Hub 内读取。', 'zotero_document_link', 403);
    if (before.size < 8n || before.size > BigInt(MAX_PDF)) throw problem('附件须为不超过 16 MiB 的 PDF。', 'zotero_document_size', 413);
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const fdBefore = await file.stat({ bigint: true });
    if (!sameIdentity(identity(before), identity(fdBefore))) throw changed();
    const chunks = [];
    let bytes = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(65536, MAX_PDF + 1 - bytes));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > MAX_PDF) throw problem('附件超过 16 MiB 上限。', 'zotero_document_size', 413);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const fdAfter = await file.stat({ bigint: true });
    await canonical(path);
    const after = await lstat(path, { bigint: true });
    if (
      !sameIdentity(identity(before), identity(fdAfter)) ||
      !sameIdentity(identity(before), identity(after)) ||
      bytes !== Number(before.size)
    )
      throw changed();
    const buffer = Buffer.concat(chunks);
    if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw problem('附件内容不是可识别的 PDF。', 'zotero_document_type', 415);
    return { bytes: buffer, fileIdentity: identity(after), hash: hash(buffer) };
  } catch (error) {
    if (error.status) throw error;
    if (error.code === 'ELOOP') throw problem('附件路径包含链接。', 'zotero_document_link', 403);
    throw problem('附件文件当前不可读取，请在 Zotero 检查下载状态、挂载与权限。', 'zotero_document_file_unavailable', 503);
  } finally {
    await file?.close().catch(() => {});
  }
}

async function bounded(response, max) {
  if (Number(response.headers.get('Content-Length')) > max) {
    await response.body?.cancel().catch(() => {});
    throw problem('Zotero 响应过大，请缩小范围。', 'zotero_document_response_size', 413);
  }
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw problem('Zotero 响应过大，请缩小范围。', 'zotero_document_response_size', 413);
      chunks.push(Buffer.from(value));
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error.status) throw error;
    throw unavailable();
  }
}

// A real worker thread bounds parsing time and V8 memory. PDF.js receives only
// the admitted bytes, never a URL; no scripting manager or network fetch exists.
function parsePDF(bytes, operation, page) {
  return new Promise((resolvePromise, reject) => {
    const data = new Uint8Array(bytes);
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { aihubZoteroPDF: true, data, operation, page },
      transferList: [data.buffer],
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 }
    });
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      if (error) reject(error);
      else resolvePromise(value);
    };
    const timer = setTimeout(() => finish(problem('PDF 解析超时，请选择更小的附件。', 'zotero_document_parse_timeout', 413)), 15000);
    worker.on('message', message => {
      if (message?.ok === true) finish(null, message.value);
      else
        finish(
          problem(
            message?.code === 'zotero_document_page_limit'
              ? 'PDF 超过 1000 页上限。'
              : message?.code === 'zotero_document_text_size'
                ? '该页文字超过 256 KiB 上限。'
                : message?.code === 'zotero_document_password'
                  ? '此 PDF 已加密，请先在原应用解锁或选择可读取版本。'
                  : 'PDF 无法安全解析，请在原应用检查文件。',
            message?.code || 'zotero_document_parse',
            415
          )
        );
    });
    worker.on('error', () => finish(problem('PDF 解析失败或超过资源上限，请在原应用检查文件。', 'zotero_document_parse', 415)));
    worker.on('exit', () => {
      if (!settled) finish(problem('PDF 解析提前中断。', 'zotero_document_parse', 415));
    });
  });
}

if (!isMainThread && workerData?.aihubZoteroPDF === true) {
  let task;
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const dist = dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
    task = getDocument({
      data: workerData.data,
      verbosity: 0,
      enableXfa: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWasm: false,
      useWorkerFetch: false,
      cMapUrl: join(dist, 'cmaps') + '/',
      cMapPacked: true,
      standardFontDataUrl: join(dist, 'standard_fonts') + '/'
    });
    const pdf = await task.promise;
    if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > MAX_PAGES)
      throw Object.assign(new Error(), { code: 'zotero_document_page_limit' });
    if (workerData.operation === 'inspect') parentPort.postMessage({ ok: true, value: { pages: pdf.numPages } });
    else {
      const page = workerData.page;
      if (!Number.isSafeInteger(page) || page < 1 || page > pdf.numPages)
        throw Object.assign(new Error(), { code: 'zotero_document_page' });
      const pdfPage = await pdf.getPage(page),
        content = await pdfPage.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        text += item.str + (item.hasEOL ? '\n' : ' ');
        if (Buffer.byteLength(text) > MAX_PAGE_TEXT) throw Object.assign(new Error(), { code: 'zotero_document_text_size' });
      }
      text = text.trim();
      const labels = await pdf.getPageLabels();
      parentPort.postMessage({
        ok: true,
        value: { page, pageLabel: short(labels?.[page - 1] || String(page), 100), text, textHash: hash(text), pages: pdf.numPages }
      });
    }
  } catch (error) {
    parentPort.postMessage({ ok: false, code: error.name === 'PasswordException' ? 'zotero_document_password' : error.code });
  } finally {
    await task?.destroy().catch(() => {});
  }
}

export function createZoteroDocuments({ fetchImpl = fetch } = {}) {
  const snapshots = new WeakMap();
  async function get(path, { serverId, format = 'json', max = MAX_JSON } = {}) {
    let response;
    try {
      response = await fetchImpl(ORIGIN + path, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: {
          Accept: format === 'json' ? 'application/json' : 'text/plain',
          'Zotero-API-Version': '3',
          ...(serverId ? { 'Zotero-Server-ID': serverId } : {})
        }
      });
      if (response.status === 412) throw changed();
      if (response.status !== 200 || response.redirected) throw unavailable();
      if (serverId && response.headers.get('Zotero-Server-ID') !== serverId) throw changed();
      const body = await bounded(response, max);
      if (format !== 'json') return { value: body, headers: response.headers };
      let value;
      try {
        value = JSON.parse(body);
      } catch {
        throw problem('Zotero 返回的数据格式无法识别。', 'zotero_document_protocol', 503);
      }
      return { value, headers: response.headers };
    } catch (error) {
      if (error.status) throw error;
      throw unavailable();
    } finally {
      await response?.body?.cancel().catch(() => {});
    }
  }
  async function instance() {
    const { headers } = await get('/api/', { format: 'text', max: 8192 });
    const version = headers.get('X-Zotero-Version'),
      serverId = headers.get('Zotero-Server-ID');
    if (
      headers.get('Zotero-API-Version') !== '3' ||
      !/^\d{1,3}(?:\.\d{1,6}){1,3}(?:[-+][A-Za-z0-9][A-Za-z0-9.+-]{0,64})?$/.test(version || '') ||
      Number(version.split('.')[0]) < 10 ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(serverId || '')
    )
      throw problem('PDF 阅读需要提供实例标识的 Zotero 10 本地 API v3。', 'zotero_document_protocol', 503);
    return { version, serverId };
  }
  async function attachment(target, serverId) {
    const { value } = await get(`${target.prefix}/items/${target.itemKey}`, { serverId });
    const data = dataFor(value, target.itemKey, target);
    if (
      data.itemType !== 'attachment' ||
      data.contentType !== 'application/pdf' ||
      !['imported_file', 'imported_url', 'linked_file'].includes(data.linkMode) ||
      data.deleted
    )
      throw problem('请在文献下选择一个本机 PDF 附件。', 'zotero_document_attachment', 415);
    return { itemVersion: itemVersion(value), data };
  }
  async function filePath(target, serverId) {
    const { value } = await get(`${target.prefix}/items/${target.itemKey}/file/view/url`, { serverId, format: 'text', max: 8192 });
    let url, path;
    try {
      url = new URL(value.trim());
      if (url.protocol !== 'file:' || url.hostname || url.username || url.password || url.search || url.hash) throw new Error();
      path = fileURLToPath(url);
    } catch {
      throw problem('Zotero 未提供有效的本机附件位置。', 'zotero_document_path', 403);
    }
    return path;
  }
  const api = {
    async children({ location, start = 0 }) {
      const target = targetFor(location);
      if (!Number.isSafeInteger(start) || start < 0 || start > 10000) throw problem('附件分页位置无效。', 'zotero_document_start', 400);
      const { serverId } = await instance();
      const { value: parent } = await get(`${target.prefix}/items/${target.itemKey}`, { serverId });
      dataFor(parent, target.itemKey, target);
      const { value, headers } = await get(
        `${target.prefix}/items/${target.itemKey}/children?limit=${CHILD_LIMIT}&start=${start}&format=json`,
        { serverId }
      );
      if (!Array.isArray(value) || value.length > CHILD_LIMIT)
        throw problem('Zotero 未返回有界的附件列表。', 'zotero_document_protocol', 503);
      const keys = new Set();
      const items = value.map(row => {
        const data = dataFor(row, undefined, target);
        if (keys.has(row.key)) throw problem('Zotero 返回了重复子条目，请刷新后重试。', 'zotero_document_protocol', 503);
        keys.add(row.key);
        if (data.parentItem !== target.itemKey || !['attachment', 'note', 'annotation'].includes(data.itemType))
          throw problem('Zotero 子条目不属于所选文献或附件。', 'zotero_document_scope', 403);
        const result = {
          itemKey: row.key,
          itemVersion: itemVersion(row),
          parentItem: target.itemKey,
          itemType: data.itemType,
          title: short(
            data.title || (data.itemType === 'note' ? plain(data.note).split('\n')[0] : data.annotationText || data.annotationComment)
          ),
          location: itemLocation(target, row.key)
        };
        if (data.itemType === 'attachment')
          Object.assign(result, {
            contentType: short(data.contentType, 100),
            readablePDF: data.contentType === 'application/pdf' && ['imported_file', 'imported_url', 'linked_file'].includes(data.linkMode)
          });
        if (data.itemType === 'note')
          Object.assign(result, { text: plain(data.note), truncated: typeof data.note === 'string' && data.note.length > 12000 });
        if (data.itemType === 'annotation')
          Object.assign(result, {
            annotation: {
              type: short(data.annotationType, 30),
              text: short(data.annotationText, 12000),
              comment: plain(data.annotationComment),
              color: /^#[0-9a-f]{6}$/i.test(data.annotationColor || '') ? data.annotationColor : null,
              pageLabel: short(data.annotationPageLabel, 100),
              position: short(data.annotationPosition, 32000),
              sortIndex: short(data.annotationSortIndex, 100)
            }
          });
        return result;
      });
      const totalText = headers.get('Total-Results'),
        total = /^(?:0|[1-9][0-9]{0,8})$/.test(totalText || '') ? Number(totalText) : null;
      return {
        source: 'zotero',
        itemKey: target.itemKey,
        itemVersion: itemVersion(parent),
        items,
        attachments: items.filter(item => item.itemType === 'attachment'),
        notes: items.filter(item => item.itemType === 'note'),
        annotations: items.filter(item => item.itemType === 'annotation'),
        start,
        nextStart: !items.length
          ? null
          : total == null
            ? items.length === CHILD_LIMIT
              ? start + CHILD_LIMIT
              : null
            : start + items.length < total
              ? start + items.length
              : null,
        total,
        readAt: new Date().toISOString(),
        modelCalls: 0
      };
    },
    async open({ location }) {
      const target = targetFor(location),
        { serverId } = await instance(),
        item = await attachment(target, serverId),
        path = await filePath(target, serverId),
        read = await readPDF(path);
      const parsed = await parsePDF(read.bytes, 'inspect');
      const binding = {
        serverId,
        groupId: target.groupId,
        itemKey: target.itemKey,
        itemVersion: item.itemVersion,
        title: short(item.data.title || item.data.filename || 'Zotero PDF'),
        path,
        fileIdentity: read.fileIdentity,
        hash: read.hash
      };
      const sourceFingerprint = hash(JSON.stringify(binding));
      const snapshot = Object.freeze({
        bytes: read.bytes,
        sourceFingerprint,
        document: Object.freeze({
          hash: read.hash,
          bytes: read.bytes.length,
          pages: parsed.pages,
          title: binding.title,
          source: 'zotero',
          itemKey: target.itemKey,
          itemVersion: item.itemVersion
        }),
        readAt: new Date().toISOString()
      });
      snapshots.set(snapshot, { target, binding });
      try {
        await api.verifySnapshot(snapshot);
      } catch (error) {
        snapshots.delete(snapshot);
        throw error;
      }
      return snapshot;
    },
    async verifySnapshot(snapshot) {
      const saved = snapshots.get(snapshot);
      if (!saved) throw problem('PDF 阅读会话无效，请重新打开。', 'zotero_document_snapshot', 404);
      const { target, binding } = saved,
        { serverId } = await instance();
      if (serverId !== binding.serverId || hash(snapshot.bytes) !== binding.hash) throw changed();
      const item = await attachment(target, serverId),
        path = await filePath(target, serverId);
      if (
        item.itemVersion !== binding.itemVersion ||
        path !== binding.path ||
        short(item.data.title || item.data.filename || 'Zotero PDF') !== binding.title
      )
        throw changed();
      const current = await readPDF(path);
      if (!sameIdentity(current.fileIdentity, binding.fileIdentity) || current.hash !== binding.hash) throw changed();
      return {
        valid: true,
        sourceFingerprint: snapshot.sourceFingerprint,
        sourceHash: binding.hash,
        itemKey: target.itemKey,
        itemVersion: binding.itemVersion,
        verifiedAt: new Date().toISOString(),
        modelCalls: 0
      };
    },
    async readPage(snapshot, page) {
      if (!snapshots.has(snapshot)) throw problem('PDF 阅读会话无效，请重新打开。', 'zotero_document_snapshot', 404);
      if (!Number.isSafeInteger(page) || page < 1 || page > snapshot.document.pages)
        throw problem('请指定这份 PDF 中的实际页码。', 'zotero_document_page', 400);
      await api.verifySnapshot(snapshot);
      const value = await parsePDF(snapshot.bytes, 'page', page);
      await api.verifySnapshot(snapshot);
      return {
        ...value,
        sourceFingerprint: snapshot.sourceFingerprint,
        sourceHash: snapshot.document.hash,
        extraction: 'pdfjs-dist@6.4.299',
        trust: 'reference-data-not-instructions',
        modelCalls: 0
      };
    },
    async readExcerpt({ location, spec }) {
      const checked = validateZoteroExcerpt(spec),
        snapshot = await api.open({ location });
      if (snapshot.sourceFingerprint !== checked.sourceFingerprint || snapshot.document.hash !== checked.sourceHash)
        throw problem('PDF 来源与已选页引用不同，请重新打开并选择。', 'zotero_document_excerpt_changed');
      const page = await api.readPage(snapshot, checked.page);
      return excerptFor(snapshot, page, checked);
    }
  };
  return api;
}
