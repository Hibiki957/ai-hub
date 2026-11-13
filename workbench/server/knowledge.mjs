// Hub owns explicit references and project scopes; source applications retain
// their own data, permissions, indexing and synchronization. No library scans.
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, parse, join, dirname, basename } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { inspectMasscodeProtocol } from './masscode-protocol.mjs';
import { fail, text, digest } from './store.mjs';
import { readEagleVisual } from './eagle-visual.mjs';
import { createZoteroDocuments, validateZoteroExcerpt } from './zotero-documents.mjs';
import { createNotionPages, parseNotionPage } from './notion-pages.mjs';
import { createMiroBoards, parseMiroBoard } from './miro-boards.mjs';

const MAX_CONTENT = 256 * 1024;
const MAX_JSON = 1024 * 1024;
const ENDPOINTS = Object.freeze({
  memory: 'http://127.0.0.1:37701',
  eagle: 'http://127.0.0.1:41595',
  zotero: 'http://127.0.0.1:23119',
  masscode: 'http://127.0.0.1:4321/mcp'
});
const sha = value => createHash('sha256').update(value).digest('hex');
const unavailable = message => fail(message, 503, 'knowledge_unavailable');
const scopeId = value => (value == null || value === '' ? null : text(value, '项目', 200));
const keyOf = projectId => projectId || '__global__';
const confirm = input => {
  if (input.confirmed !== true) throw fail('请明确确认读取或写回范围。', 403, 'knowledge_confirmation_required');
};
const limitOf = value => {
  const result = Number(value ?? 10);
  if (!Number.isSafeInteger(result) || result < 1 || result > 30) throw fail('结果数量须为 1 到 30。');
  return result;
};
const externalId = value => {
  const id = String(value ?? '');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw fail('来源记录编号无效。');
  return id;
};
const numericId = value => {
  const id = String(value ?? '');
  if (!/^[1-9][0-9]{0,14}$/.test(id) || !Number.isSafeInteger(Number(id))) throw fail('记忆编号无效。');
  return id;
};
const secretPattern =
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|private[_-]?key|authorization)\s*["']?\s*[:=]\s*)(?:["']?)([^\s"'<>`,;]{8,})/gi;
export function redactContent(value) {
  return String(value)
    .replace(secretPattern, '$1<REDACTED>')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, '<REDACTED>')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<REDACTED PRIVATE KEY>');
}
function utf8(buffer) {
  if (
    buffer.includes(0) ||
    buffer
      .subarray(0, 8)
      .toString('latin1')
      .match(/^(?:%PDF-|PK[\x03\x05\x07]|GIF8|RIFF|\x89PNG|\x7fELF)/) ||
    buffer.some(byte => byte < 32 && ![9, 10, 13].includes(byte))
  )
    throw fail('二进制资料暂不支持正文预览，请在原应用查看。', 415, 'binary_resource');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw fail('资料不是有效 UTF-8 文本，暂不能安全预览。', 415, 'binary_resource');
  }
}
function htmlText(value) {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->/gi, '')
    .replace(/<\/(?:p|div|h[1-6]|li|tr|section|article|pre)>|<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(
      /&(?:amp|lt|gt|quot|apos|nbsp);/g,
      entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' })[entity]
    )
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => {
      const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/\n[ \t]*\n[ \t]*\n/g, '\n\n')
    .trim();
}

const private4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
])
  private4.addSubnet(address, prefix, 'ipv4');
const global6 = new BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
const private6 = new BlockList();
private6.addSubnet('2001::', 23, 'ipv6');
private6.addSubnet('2001:db8::', 32, 'ipv6');
private6.addSubnet('2002::', 16, 'ipv6');
export function isPublicAddress(address) {
  const family = isIP(address);
  return family === 4
    ? !private4.check(address, 'ipv4')
    : family === 6
      ? global6.check(address, 'ipv6') && !private6.check(address, 'ipv6')
      : false;
}
export async function checkedPublicURL(value, resolver = lookup) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail('网页地址无效。');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    [...url.searchParams.keys()].some(key => /token|secret|api.?key|password|authorization/i.test(key))
  )
    throw fail('网页资料只接受不含凭据的标准 HTTPS 地址。', 400, 'unsafe_resource_url');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if ((!hostname.includes('.') && !isIP(hostname)) || /(?:^|\.)(localhost|local|internal|home|test|invalid)$/i.test(hostname))
    throw fail('网页资料不能访问本机或私有网络。', 403, 'private_resource_url');
  let addresses;
  try {
    addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolver(hostname, { all: true, verbatim: true });
  } catch {
    throw unavailable('无法解析网页资料地址。');
  }
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address)))
    throw fail('网页资料不能访问本机、私网或保留地址。', 403, 'private_resource_url');
  url.hash = '';
  return { url, address: addresses[0].address, family: isIP(addresses[0].address) };
}
export async function publicText(value, resolver, requestImpl = https.get) {
  const target = await checkedPublicURL(value, resolver);
  return new Promise((resolvePromise, reject) => {
    // Pin the checked IP for the actual TLS connection, closing DNS rebinding.
    const request = requestImpl(
      target.url,
      {
        agent: false,
        signal: AbortSignal.timeout(8000),
        maxHeaderSize: 16384,
        headers: {
          Accept: 'text/plain,text/html,application/json,application/xml;q=0.8',
          'Accept-Encoding': 'identity',
          'User-Agent': 'AIHub-Explicit-Resource/1'
        },
        lookup: (_hostname, options, callback) => {
          if (options?.all) callback(null, [{ address: target.address, family: target.family }]);
          else callback(null, target.address, target.family);
        }
      },
      response => {
        if (response.statusCode >= 300 && response.statusCode < 400) {
          response.resume();
          reject(fail('资料地址发生跳转；请检查并明确引用最终 HTTPS 地址。', 400, 'resource_redirect'));
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(unavailable(`网页资料当前不可读取（HTTP ${response.statusCode}）。`));
          return;
        }
        const type = (response.headers['content-type'] || '').split(';')[0].toLowerCase();
        if (
          !/^(text\/|application\/(?:json|xml|xhtml\+xml)$)/.test(type) ||
          (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')
        ) {
          response.resume();
          reject(fail('该网页不是可预览的未压缩文本。', 415, 'binary_resource'));
          return;
        }
        let size = 0;
        const chunks = [];
        response.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_CONTENT) {
            response.destroy();
            reject(fail('资源超过 256 KiB 正文上限，请缩小资料范围。', 413, 'resource_too_large'));
          } else chunks.push(chunk);
        });
        response.on('error', () => reject(unavailable('网页资料读取中断。')));
        response.on('end', () => {
          try {
            const raw = utf8(Buffer.concat(chunks));
            resolvePromise({ body: /html/.test(type) ? htmlText(raw) : raw, contentType: type, sourceHash: sha(Buffer.concat(chunks)) });
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.setTimeout(8000, () => request.destroy(new Error('timeout')));
    request.on('error', error => reject(error.status ? error : unavailable('网页资料连接失败或超时。')));
  });
}

async function localFile(location) {
  if (!isAbsolute(location) || resolve(location) !== location) throw fail('请引用规范化的本机绝对文件路径。');
  if (
    /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.ssh|\.aws|\.gnupg|\.keychain|credentials|auth\.json)(?:\/|$)|\.(?:pem|p12|pfx|keychain-db)$/i.test(
      location
    )
  )
    throw fail('凭据与密钥文件不能作为资料正文读取。', 403, 'credential_resource');
  let cursor = parse(location).root;
  try {
    for (const part of location.slice(cursor.length).split('/').filter(Boolean)) {
      cursor = join(cursor, part);
      if ((await lstat(cursor)).isSymbolicLink()) throw fail('资料路径包含符号链接，请明确引用真实文件位置。', 403, 'resource_symlink');
    }
    if ((await realpath(location)) !== location) throw fail('资料路径发生变化，请重新确认真实文件。', 403, 'resource_path_changed');
    const requireRuntime = createRequire(new URL('../../runtime/package.json', import.meta.url));
    const { root } = await import(pathToFileURL(requireRuntime.resolve('@openclaw/fs-safe')).href);
    const scoped = await root(dirname(location), { hardlinks: 'reject', symlinks: 'reject', nonBlockingRead: true, maxBytes: MAX_CONTENT });
    // Reuse the runtime's guarded, bounded reader; the only accessible relative
    // name in this operation is the one file explicitly referenced by the user.
    const result = await scoped.read(basename(location));
    if (result.realPath !== location) throw fail('资料实际位置已改变，请重新引用。', 409, 'resource_path_changed');
    return { body: utf8(result.buffer), contentType: 'text/plain', sourceHash: sha(result.buffer), containment: result.containment };
  } catch (error) {
    if (error.status) throw error;
    if (error.code === 'too-large') throw fail('资源超过 256 KiB 正文上限。', 413, 'resource_too_large');
    if (['symlink', 'hardlink', 'outside-workspace', 'path-mismatch', 'path-alias'].includes(error.code))
      throw fail('资料路径或链接不符合明确文件授权范围。', 403, 'resource_path_changed');
    if (error.code === 'not-file') throw fail('请引用具体文本文件；不会扫描目录或读取特殊设备。', 415, 'resource_directory');
    throw unavailable('该资料文件或受控读取组件当前不可用，请检查挂载与文件权限。');
  }
}
async function boundedJSON(response) {
  const reader = response.body?.getReader();
  if (!reader) throw unavailable('来源未返回可读取结果。');
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_JSON) throw fail('来源结果过大，请缩小查询范围。', 413, 'source_response_too_large');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  try {
    return JSON.parse(utf8(Buffer.concat(chunks)));
  } catch (error) {
    if (error.status) throw error;
    throw unavailable('来源返回的格式无法识别。');
  }
}
function plainResult(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
function decodeMetadata(value) {
  if (typeof value === 'object' && value) return value;
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

export function createKnowledge({
  store,
  snapshot,
  notify = () => {},
  fetchImpl = fetch,
  resolver = lookup,
  webReader = publicText,
  mcpOperate,
  masscodeProtocol = inspectMasscodeProtocol,
  zoteroDocuments,
  notionPages,
  miroBoards
} = {}) {
  if (!store) throw new Error('Knowledge requires the Hub store');
  const documents = zoteroDocuments || createZoteroDocuments({ fetchImpl });
  const notion = notionPages || createNotionPages({ store, fetchImpl });
  const miro = miroBoards || createMiroBoards({ store, fetchImpl });
  const rejectPublicDocumentSpec = input => {
    if (Object.hasOwn(input, 'zoteroExcerpt'))
      throw fail('页引用只能由本任务已打开的 PDF 选段建立，请使用任务文档工具。', 403, 'knowledge_document_candidate_required');
  };
  const local = async (source, path, { method = 'GET', body } = {}) => {
    try {
      const response = await fetchImpl(ENDPOINTS[source] + path, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      if (!response.ok) throw unavailable(`${source} 本机接口当前不可用（HTTP ${response.status}），请在原应用检查授权与运行状态。`);
      return await boundedJSON(response);
    } catch (error) {
      if (error.status) throw error;
      throw unavailable(`${source} 本机服务未连接；不会启动、重配或改用其他应用的凭据。`);
    }
  };
  const checkZotero = async () => {
    let response;
    try {
      // Zotero's API root is a protocol probe, not a JSON resource. In Zotero
      // 10 it returns text/plain; the documented version headers identify it.
      // Do not query library items or request write authorization for health.
      response = await fetchImpl(ENDPOINTS.zotero + '/api/', {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: { Accept: 'text/plain' }
      });
      if (response.status !== 200)
        throw unavailable(`zotero 本机接口当前不可用（HTTP ${response.status}），请在原应用检查授权与运行状态。`);
      const version = response.headers.get('X-Zotero-Version')?.trim(),
        apiVersion = response.headers.get('Zotero-API-Version')?.trim(),
        serverId = response.headers.get('Zotero-Server-ID')?.trim();
      if (apiVersion !== '3' || !/^\d{1,3}(?:\.\d{1,6}){1,3}(?:[-+][A-Za-z0-9][A-Za-z0-9.+-]{0,64})?$/.test(version || ''))
        throw unavailable('本机端口未返回可识别的 Zotero 本地 API v3 协议与版本。');
      if (Number(version.split('.')[0]) >= 10 && !/^[A-Za-z0-9_-]{1,128}$/.test(serverId || ''))
        throw unavailable('Zotero 本地 API 缺少有效实例标识，请检查原应用状态。');
      return { connected: true, version, apiVersion: 3, protocol: 'zotero-local-api' };
    } catch (error) {
      return { connected: false, reason: error.status ? error.message : 'zotero 本机服务未连接；不会启动、重配或改用其他应用的凭据。' };
    } finally {
      try {
        await response?.body?.cancel();
      } catch {}
    }
  };
  const checkProject = async projectId => {
    const id = scopeId(projectId);
    if (id && snapshot) {
      const state = await snapshot();
      if (!state.projects?.some(item => item.id === id))
        throw fail('项目不存在或尚未同步，不能跨项目读取资料。', 404, 'knowledge_project_missing');
    }
    return id;
  };
  const allowed = (item, projectId, includeGlobal) => (item.projectId || null) === projectId || (includeGlobal === true && !item.projectId);
  const memoryScope = async projectId => {
    const id = await checkProject(projectId);
    const mapped = store.get('knowledge-memory-scope', keyOf(id));
    return { projectId: id, memoryProject: mapped?.memoryProject || `aihub:${id || 'global'}`, explicitMapping: Boolean(mapped) };
  };
  const normalizeMemory = (row, scope) => {
    const body = redactContent(
      [
        row.narrative,
        ...(() => {
          try {
            const facts = typeof row.facts === 'string' ? JSON.parse(row.facts) : row.facts;
            return Array.isArray(facts) ? facts : [];
          } catch {
            return [];
          }
        })()
      ]
        .filter(Boolean)
        .join('\n')
    );
    const metadata = decodeMetadata(row.metadata),
      origin = metadata.importedFrom;
    const replaces =
      typeof metadata.hubCorrectionId === 'string' &&
      metadata.hubCorrectionId.length <= 200 &&
      /^[1-9][0-9]{0,14}$/.test(metadata.replaces?.id || '') &&
      /^[a-f0-9]{64}$/.test(metadata.replaces?.hash || '')
        ? { id: String(metadata.replaces.id), hash: metadata.replaces.hash, correctionId: metadata.hubCorrectionId }
        : undefined;
    const importedFrom =
      origin?.kind === 'hub-legacy-local' && typeof origin.id === 'string' && /^[a-f0-9]{64}$/.test(origin.hash || '')
        ? {
            kind: 'hub-legacy-local',
            id: origin.id,
            projectId: typeof origin.projectId === 'string' ? origin.projectId : null,
            hash: origin.hash
          }
        : undefined;
    return {
      id: String(row.id),
      title: row.title || '',
      text: body,
      hash: sha(body),
      readAt: new Date().toISOString(),
      projectId: scope.projectId,
      memoryProject: scope.memoryProject,
      createdAt: row.created_at || null,
      source: 'claude-mem',
      provenance: {
        source: 'claude-mem',
        externalId: String(row.id),
        project: row.project,
        location: `claude-mem://observation/${row.id}`,
        ...(importedFrom ? { importedFrom } : {}),
        ...(replaces ? { replaces } : {})
      }
    };
  };
  const lookupMemoryRow = async (id, scope) => {
    const rows = await local('memory', '/api/observations/batch', {
      method: 'POST',
      body: { ids: [Number(numericId(id))], project: scope.memoryProject, limit: 1 }
    });
    if (!Array.isArray(rows)) throw unavailable('共享记忆没有返回可核验的指定记录结果。');
    return rows.find(item => String(item.id) === String(id) && item.project === scope.memoryProject) || null;
  };
  const readMemoryRow = async (id, scope) => {
    const row = await lookupMemoryRow(id, scope);
    if (!row) throw fail('该记忆不存在或不属于当前项目授权范围。', 404, 'memory_scope_mismatch');
    return row;
  };
  const ownedMemory = (row, scope) => {
    const link = store.get('knowledge-memory-link', String(row.id)),
      metadata = decodeMetadata(row.metadata);
    return (
      !!link?.owned &&
      link.projectId === scope.projectId &&
      link.memoryProject === scope.memoryProject &&
      metadata.sourceFingerprint === link.sourceFingerprint &&
      metadata.hubCaptureId === link.captureId
    );
  };
  const correctionList = scope =>
    store
      .list('knowledge-memory-correction')
      .filter(item => item.projectId === scope.projectId && item.memoryProject === scope.memoryProject);
  const publicCorrection = item => {
    if (!item) return null;
    const { newText: _text, sourceFingerprint: _fingerprint, captureId: _capture, ...metadata } = item;
    return {
      ...metadata,
      canDeleteOld: ['replacement_verified', 'delete_retry_requires_confirmation'].includes(item.status),
      modelCall: false,
      syncPolicy: 'existing-worker-sync-settings',
      replicationVerified: false
    };
  };
  const governanceFor = (id, scope) => {
    const deleted = store.get('knowledge-memory-deletion', String(id));
    if (deleted?.projectId === scope.projectId && deleted.memoryProject === scope.memoryProject)
      return { status: deleted.status, reason: deleted.reason };
    const correction = correctionList(scope)
      .filter(item => item.oldId === String(id) || item.newId === String(id))
      .at(-1);
    if (correction)
      return {
        correctionId: correction.id,
        role: correction.oldId === String(id) ? 'old' : 'replacement',
        status: correction.status,
        oldId: correction.oldId,
        replacementId: correction.newId,
        oldAbsentVerified: correction.status === 'completed',
        reason: correction.reason
      };
    return null;
  };
  const correctionLocks = new Set();
  const lockedMemory = async (id, operation) => {
    if (correctionLocks.has(id)) throw fail('此条记忆正在核验或修改，请等待本次操作结束。', 409, 'memory_mutation_busy');
    correctionLocks.add(id);
    try {
      return await operation();
    } finally {
      correctionLocks.delete(id);
    }
  };
  const patchCorrection = (id, fields) => {
    const saved = store.put('knowledge-memory-correction', { ...store.get('knowledge-memory-correction', id), ...fields });
    store.audit({ type: 'knowledge.memory.correction.stage', correctionId: id, projectId: saved.projectId }, 'user', {
      status: saved.status,
      oldId: saved.oldId,
      newId: saved.newId,
      oldHash: saved.oldHash,
      newHash: saved.newHash
    });
    notify();
    return saved;
  };
  const checkedCorrection = async input => {
    const id = text(input.correctionId, '更正收据', 200),
      scope = await memoryScope(input.projectId),
      correction = store.get('knowledge-memory-correction', id);
    if (!correction || correction.projectId !== scope.projectId || correction.memoryProject !== scope.memoryProject)
      throw fail('更正收据不在当前明确共享范围，或范围映射已改变。', 404, 'memory_correction_scope_mismatch');
    return { correction, scope };
  };
  const verifyReplacement = async (correction, scope, candidateId = correction.newId) => {
    if (!candidateId) throw fail('尚未取得新记录编号；请在原库核对后提供具体编号，不会重发写入。', 409, 'memory_replacement_id_unknown');
    const row = await readMemoryRow(candidateId, scope),
      metadata = decodeMetadata(row.metadata),
      value = normalizeMemory(row, scope);
    if (
      String(row.id) === correction.oldId ||
      metadata.hubCorrectionId !== correction.id ||
      metadata.sourceFingerprint !== correction.sourceFingerprint ||
      metadata.hubCaptureId !== correction.captureId ||
      value.hash !== correction.newHash ||
      value.text !== correction.newText ||
      value.title !== correction.newTitle
    )
      throw fail('新记录的正文、标题或 Hub 更正归属未通过核验，旧记录不能删除。', 409, 'memory_replacement_unverified');
    store.put('knowledge-memory-link', {
      id: String(row.id),
      projectId: scope.projectId,
      memoryProject: scope.memoryProject,
      owned: true,
      captureId: correction.captureId,
      sourceFingerprint: correction.sourceFingerprint,
      correctionId: correction.id
    });
    return { ...value, owned: true, capabilities: { update: false, replace: true, delete: true } };
  };
  // Recover metadata only. A restart must never replay an external write/delete.
  for (const correction of store.list('knowledge-memory-correction')) {
    if (['write_calling', 'delete_calling'].includes(correction.status))
      patchCorrection(correction.id, {
        status: correction.status === 'write_calling' ? 'write_uncertain' : 'delete_uncertain',
        reason: 'Hub 重启中断了阶段回执；请只读核验原库，不会自动重发。'
      });
  }
  const once = async (action, input, operation) => {
    const requestId = text(input.requestId, '幂等键', 160),
      key = `knowledge:${action}:${requestId}`;
    const prior = store.begin(key, digest(input));
    if (prior.replay) return prior.result;
    // An unconfirmed transport outcome stays started; never repeat a remote write.
    const result = await operation();
    store.commit(key, result);
    notify();
    return result;
  };
  const masscode = async (tool, args) => {
    const protocol = await masscodeProtocol();
    if (protocol.protocolCompatible === false) throw fail(protocol.disabledReason, 409, 'masscode_protocol_unsupported');
    const config = store.get('knowledge-connector', 'masscode');
    if (!config?.sealedToken) throw unavailable('massCode 尚未在 Hub 明确配置 Integration API token；可以先引用明确的 Markdown 文件。');
    try {
      const operate = mcpOperate || (await import('../../runtime/mcp-client.mjs')).operate;
      const result = await operate({
        action: 'call',
        url: ENDPOINTS.masscode,
        token: store.unseal(config.sealedToken),
        tool,
        allowedTools: ['search', 'get_item'],
        confirmed: true,
        arguments: args
      });
      if (result.isError) throw unavailable('massCode MCP 拒绝读取，请检查 API/MCP 开关及你在 Hub 明确配置的 token。');
      const value = result.structuredContent || result.content?.find(item => item.type === 'text')?.text;
      if (value == null) throw unavailable('massCode MCP 未返回正文或结构化结果。');
      if (Buffer.byteLength(plainResult(value)) > MAX_JSON) throw fail('massCode 结果过大，请缩小范围。', 413);
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch {
          return { text: value };
        }
      }
      return value;
    } catch (error) {
      if (error.status) throw error;
      throw unavailable('massCode MCP 未连接；Hub 不会修改原应用设置或借用其他客户端 token。');
    }
  };
  const locator = resource => {
    const source = resource.source;
    if (resource.locator?.id) return { ...resource.locator, source };
    let url;
    try {
      url = new URL(resource.location);
    } catch {
      return { source: isAbsolute(resource.location || '') ? 'file' : source };
    }
    if (url.username || url.password || [...url.searchParams.keys()].some(key => /token|secret|api.?key|password|authorization/i.test(key)))
      throw fail('资料定位不能携带凭据。', 400, 'unsafe_resource_url');
    if (source === 'notion' || url.protocol === 'notion:') {
      if (
        source !== 'notion' ||
        url.protocol !== 'notion:' ||
        url.hostname !== 'page' ||
        url.search ||
        url.hash ||
        resource.integration !== 'manual-notion-editor'
      )
        throw fail('请从当前任务的 Notion 工作区明确选择页面。', 403, 'notion_resource_scope');
      const id = parseNotionPage(url.pathname.slice(1));
      if (resource.notionPageId !== id) throw fail('Notion 页面来源不一致。', 409, 'notion_resource_scope');
      return { source: 'notion', id };
    }
    if (source === 'miro' || url.protocol === 'miro:') {
      if (
        source !== 'miro' ||
        url.protocol !== 'miro:' ||
        url.hostname !== 'board' ||
        url.search ||
        url.hash ||
        resource.integration !== 'task-miro-board'
      )
        throw fail('请从当前任务的 Miro 工作区明确选择画板内容。', 403, 'miro_resource_scope');
      let id;
      try {
        id = parseMiroBoard(decodeURIComponent(url.pathname.slice(1)));
      } catch {
        throw fail('Miro 画板来源无效，请重新选择。', 409, 'miro_resource_scope');
      }
      if (resource.miroBoardId !== id) throw fail('Miro 画板来源不一致。', 409, 'miro_resource_scope');
      return { source: 'miro', id };
    }
    if (source === 'eagle' || url.protocol === 'eagle:') {
      const id = url.protocol === 'eagle:' ? url.pathname.split('/').filter(Boolean).at(-1) : url.searchParams.get('id');
      if (url.protocol !== 'eagle:' && (url.origin !== ENDPOINTS.eagle || url.pathname !== '/api/item/info'))
        throw fail('Eagle 只接受明确的本机条目定位。');
      return { source: 'eagle', id: externalId(id) };
    }
    if (source === 'zotero' || url.protocol === 'zotero:') {
      const match =
        url.protocol === 'zotero:'
          ? url.pathname.match(/^(?:\/library|\/groups\/(\d+))\/items\/([A-Z0-9]{8})$/)
          : url.pathname.match(/^\/api\/(?:users\/0|groups\/(\d+))\/items\/([A-Z0-9]{8})$/);
      if (!match || (url.protocol !== 'zotero:' && url.origin !== ENDPOINTS.zotero))
        throw fail('Zotero 只接受明确文献或附件定位，不读取整个文献库。');
      return { source: 'zotero', id: match[2], groupId: match[1] || null };
    }
    if (source === 'masscode' && url.protocol === 'masscode:') return { source, type: url.hostname, id: externalId(url.pathname.slice(1)) };
    return { source: isAbsolute(resource.location || '') ? 'file' : 'web' };
  };
  const reference = async input => {
    rejectPublicDocumentSpec(input);
    const projectId = await checkProject(input.projectId),
      title = text(input.title, '资源名称', 200),
      location = text(input.location, '资料位置', 3000);
    const resource = { title, location, source: input.source || 'manual', projectId, integration: 'explicit-reference' };
    const target = locator(resource);
    if (target.source === 'web') await checkedPublicURL(location, resolver);
    if (target.source === 'file' && !isAbsolute(location)) throw fail('本机资料需要绝对文件路径。');
    if (!['file', 'web', 'eagle', 'zotero', 'masscode'].includes(target.source)) throw fail('资料来源尚未支持。');
    return resource;
  };
  const readReference = async (resource, projectId, id = null) => {
    const target = locator(resource);
    let result;
    if (Object.hasOwn(resource, 'zoteroExcerpt')) {
      if (target.source !== 'zotero' || resource.source !== 'zotero')
        throw fail('PDF 页引用来源不一致，请重新打开文档并选择。', 409, 'resource_document_scope');
      const spec = validateZoteroExcerpt(resource.zoteroExcerpt);
      if (id && !/^[a-f0-9]{64}$/.test(resource.expectedPreviewHash || ''))
        throw fail('已保存的页引用缺少已确认正文摘要，请重新选择。', 409, 'resource_document_unpinned');
      const read = await documents.readExcerpt({ location: resource.location, spec });
      const proof = read.provenance;
      if (
        typeof read.body !== 'string' ||
        read.contentType !== 'text/plain' ||
        read.sourceHash !== spec.sourceHash ||
        proof?.kind !== 'pdf-page-excerpt' ||
        ['sourceFingerprint', 'sourceHash', 'page', 'pageTextHash', 'startOffset', 'endOffset'].some(key => proof[key] !== spec[key]) ||
        !Number.isSafeInteger(proof.pages) ||
        proof.pages < spec.page ||
        typeof proof.pageLabel !== 'string' ||
        proof.pageLabel.length > 100
      )
        throw fail('PDF 选段来源核验不完整，请重新打开文档。', 409, 'resource_document_proof');
      // Never copy the raw quote/comment into provenance: the common body
      // redaction below is the only model-visible text channel. Keep exact
      // source/offset proofs so the citation can be rechecked on every use.
      result = {
        body: read.body,
        contentType: 'text/plain',
        sourceHash: spec.sourceHash,
        limitation: read.limitation,
        document: {
          kind: 'pdf-page-excerpt',
          sourceFingerprint: spec.sourceFingerprint,
          page: spec.page,
          pageTextHash: spec.pageTextHash,
          startOffset: spec.startOffset,
          endOffset: spec.endOffset,
          pageLabel: proof.pageLabel,
          pages: proof.pages,
          ...(typeof proof.extraction === 'string' ? { extraction: proof.extraction.slice(0, 100) } : {}),
          hasComment: Boolean(spec.comment),
          ...(spec.comment ? { commentHash: sha(spec.comment) } : {})
        }
      };
    } else if (target.source === 'file') result = await localFile(resource.location);
    else if (target.source === 'web') result = await webReader(resource.location, resolver);
    else if (target.source === 'eagle') {
      const value = await local('eagle', '/api/item/info?' + new URLSearchParams({ id: externalId(target.id) }));
      if (value.status !== 'success' || !value.data || value.data.isDeleted || String(value.data.id) !== String(target.id))
        throw unavailable('Eagle 条目不存在或已删除。');
      const row = value.data;
      result = {
        body: [row.name, row.annotation, row.tags?.length ? '标签：' + row.tags.join('、') : '', row.url ? '原始来源：' + row.url : '']
          .filter(Boolean)
          .join('\n\n'),
        contentType: 'text/plain',
        limitation: '读取 Eagle 条目名称、注释和来源；不将图片二进制伪装为已读正文。'
      };
      if (resource.expectedVisualFingerprint) {
        if (!/^[a-f0-9]{64}$/.test(resource.expectedVisualFingerprint))
          throw fail('已选 Eagle 图片缺少有效指纹，请重新预览选择。', 409, 'resource_visual_changed');
        const visual = await readEagleVisual({
          id: externalId(target.id),
          readJSON: path => local('eagle', path),
          redact: redactContent,
          expectedItem: row
        });
        if (visual.fingerprint !== resource.expectedVisualFingerprint)
          throw fail('Eagle 图片与所确认预览不同，请重新预览选择。', 409, 'resource_visual_changed');
        result.visual = { ...visual.image, fingerprint: visual.fingerprint };
        result.limitation = visual.limitation;
      }
    } else if (target.source === 'zotero') {
      const prefix = target.groupId ? `/api/groups/${externalId(target.groupId)}` : '/api/users/0';
      const value = await local('zotero', `${prefix}/items/${externalId(target.id)}`),
        row = value.data || value;
      if (String(value.key || row.key || '') !== String(target.id)) throw unavailable('Zotero 返回的条目与明确引用不一致。');
      const body = [
        row.title,
        row.creators?.map(item => item.name || [item.firstName, item.lastName].filter(Boolean).join(' ')).join('、'),
        row.abstractNote,
        row.note ? htmlText(row.note) : '',
        row.DOI ? 'DOI：' + row.DOI : '',
        row.url
      ]
        .filter(Boolean)
        .join('\n\n');
      result = { body, contentType: 'text/plain', limitation: '仅返回该条目的元数据、摘要或笔记；附件需要明确引用其条目。' };
      if (row.itemType === 'attachment') {
        try {
          const full = await local('zotero', `${prefix}/items/${externalId(target.id)}/fulltext`);
          if (typeof full.content === 'string')
            result = {
              body: body + '\n\n' + full.content,
              contentType: 'text/plain',
              limitation: '正文来自 Zotero 已有全文索引，不直接读取 SQLite 或附件目录。'
            };
        } catch {
          result.limitation = '该附件暂没有可用的 Zotero 全文索引，仅显示元数据。';
        }
      }
    } else if (target.source === 'notion') {
      if (
        !/^[a-f0-9]{64}$/.test(resource.expectedPreviewHash || '') ||
        !/^[a-f0-9]{64}$/.test(resource.expectedNotionFingerprint || '') ||
        !resource.notionConnectionRevision
      )
        throw fail('Notion 引用缺少所确认的页面版本，请重新选择。', 409, 'notion_resource_unpinned');
      const page = await notion.read({ pageId: target.id, expectedConnectionRevision: resource.notionConnectionRevision });
      if (
        page.modelEligible !== true ||
        page.truncated ||
        page.unknownBlockIds?.length ||
        page.warnings?.length ||
        page.fingerprint !== resource.expectedNotionFingerprint ||
        page.sourceHash !== resource.expectedPreviewHash
      )
        throw fail('Notion 页面或连接已变化，不能沿用旧正文。', 409, 'notion_resource_changed');
      result = {
        body: page.text,
        contentType: 'text/plain',
        sourceHash: page.sourceHash,
        document: {
          pageId: page.pageId,
          sourceFingerprint: page.fingerprint,
          connectionRevision: page.connectionRevision,
          lastEditedTime: page.lastEditedTime,
          apiVersion: '2026-03-11',
          markdownVersion: 'v1'
        },
        limitation: '只读取本任务明确选择的 Notion 页面；使用前核验原页与 Hub 连接版本，不扫描工作区。'
      };
    } else if (target.source === 'miro') {
      const pin = resource.miroSelection,
        ids = resource.miroItemIds;
      if (
        !pin ||
        !Array.isArray(ids) ||
        !Array.isArray(pin.itemIds) ||
        ids.length < 1 ||
        ids.length > 20 ||
        ids.some(id => typeof id !== 'string') ||
        new Set(ids).size !== ids.length ||
        digest(pin.itemIds) !== digest(ids) ||
        !/^[a-f0-9]{64}$/.test(resource.expectedPreviewHash || '') ||
        pin.sourceHash !== resource.expectedPreviewHash ||
        !/^[a-f0-9]{64}$/.test(resource.expectedMiroFingerprint || '') ||
        pin.fingerprint !== resource.expectedMiroFingerprint ||
        !resource.miroConnectionRevision ||
        pin.connectionRevision !== resource.miroConnectionRevision
      )
        throw fail('Miro 引用缺少所确认的条目范围或版本，请重新选择。', 409, 'miro_resource_unpinned');
      const selection = await miro.readSelection({ boardId: target.id, itemIds: ids, expectedConnectionRevision: pin.connectionRevision });
      if (
        selection.modelEligible !== true ||
        selection.boardId !== target.id ||
        selection.fingerprint !== pin.fingerprint ||
        selection.sourceHash !== pin.sourceHash ||
        selection.connectionRevision !== pin.connectionRevision ||
        redactContent(selection.text) !== selection.text
      )
        throw fail('Miro 原条目、权限或连接已变化，不能沿用归档正文。', 409, 'miro_resource_changed');
      result = {
        body: selection.text,
        contentType: 'text/plain',
        sourceHash: selection.sourceHash,
        document: {
          boardId: target.id,
          itemIds: [...ids],
          sourceFingerprint: selection.fingerprint,
          connectionRevision: selection.connectionRevision,
          snapshotId: resource.miroSnapshotId,
          snapshotDigest: resource.miroSnapshotDigest,
          apiVersion: 'v2'
        },
        limitation: '只使用明确选择的 Miro 条目文本与结构；每次使用前重读原条目。画框标题不代表全部子项，图片与附件未经视觉解析。'
      };
    } else if (target.source === 'masscode') {
      if (!['note', 'snippet'].includes(target.type)) throw fail('只支持 massCode 笔记和代码片段，不读取或执行保存的 HTTP 请求。');
      const row = await masscode('get_item', { type: target.type, id: Number(numericId(target.id)) });
      result = {
        body: [
          row.name || row.title,
          row.content,
          row.text,
          ...(Array.isArray(row.fragments) ? row.fragments.map(item => item.content) : [])
        ]
          .filter(value => typeof value === 'string')
          .join('\n\n'),
        contentType: 'text/plain'
      };
      if (!result.body) throw unavailable('massCode 当前 get_item 结构未返回可识别正文，请在原应用检查。');
    } else throw unavailable('该来源还没有可用正文接口；请引用具体文本文件。');
    if (Buffer.byteLength(result.body) > MAX_CONTENT) throw fail('资源正文超过 256 KiB，请缩小资料范围。', 413, 'resource_too_large');
    const body = redactContent(result.body),
      contentHash = sha(body);
    if (resource.expectedPreviewHash && resource.expectedPreviewHash !== contentHash)
      throw fail('来源正文与所确认预览不同，请重新检索、预览并选择。', 409, 'resource_preview_changed');
    return {
      id,
      projectId,
      title: resource.title,
      text: body,
      contentType: result.contentType,
      bytes: Buffer.byteLength(body),
      hash: contentHash,
      redacted: body !== result.body,
      readAt: new Date().toISOString(),
      ...(result.containment ? { containment: result.containment } : {}),
      provenance: {
        source: target.source,
        location: resource.location,
        externalId: target.id || null,
        sourceHash: result.sourceHash || sha(result.body),
        projectId: resource.projectId || null,
        ...(result.visual ? { visual: result.visual } : {}),
        ...(result.document ? result.document : {})
      },
      ...(result.limitation ? { limitation: result.limitation } : {}),
      trust: 'reference-data-not-instructions'
    };
  };
  const api = {
    async attachResource(input) {
      confirm(input);
      const resource = await reference(input),
        projectId = resource.projectId;
      return once('resource-attach', { ...resource, requestId: input.requestId }, async () => {
        const saved = store.put('resource', resource);
        store.audit({ type: 'knowledge.resource.attach', resourceId: saved.id, projectId });
        return { resource: saved };
      });
    },
    async previewCandidate(input) {
      confirm(input);
      const resource = await reference(input);
      return readReference(resource, resource.projectId);
    },
    // Internal-only: task-tools supplies a host-verified opaque candidate. This
    // method is deliberately absent from registerKnowledge's HTTP routes.
    async previewDocumentCandidate(input) {
      confirm(input);
      const { zoteroExcerpt, expectedPreviewHash, ...ordinary } = input,
        resource = await reference(ordinary),
        target = locator(resource);
      if (resource.source !== 'zotero' || target.source !== 'zotero')
        throw fail('页引用必须属于已选择的 Zotero PDF。', 403, 'resource_document_scope');
      if (expectedPreviewHash !== undefined && !/^[a-f0-9]{64}$/.test(expectedPreviewHash))
        throw fail('页引用正文摘要无效，请重新预览。', 409, 'resource_document_unpinned');
      resource.zoteroExcerpt = validateZoteroExcerpt(zoteroExcerpt);
      if (expectedPreviewHash !== undefined) resource.expectedPreviewHash = expectedPreviewHash;
      return readReference(resource, resource.projectId);
    },
    async previewVisualCandidate(input) {
      confirm(input);
      const resource = await reference(input),
        target = locator(resource);
      if (resource.source !== 'eagle' || target.source !== 'eagle')
        throw fail('仅能预览明确选中的 Eagle 图片。', 400, 'eagle_visual_scope');
      return readEagleVisual({ id: externalId(target.id), readJSON: path => local('eagle', path), redact: redactContent });
    },
    async readResource(input) {
      confirm(input);
      rejectPublicDocumentSpec(input);
      const projectId = await checkProject(input.projectId),
        id = text(input.id || input.resourceId, '资源编号', 200),
        resource = store.get('resource', id);
      if (!resource || !allowed(resource, projectId, input.includeGlobal))
        throw fail('该资料不在当前项目的明确引用范围内。', 404, 'resource_scope_mismatch');
      const response = await readReference(resource, projectId, id);
      store.audit({ type: 'knowledge.resource.read', resourceId: id, projectId }, 'user', {
        hash: response.hash,
        bytes: response.bytes,
        redacted: response.redacted
      });
      return response;
    },
    async searchResources(input) {
      const projectId = await checkProject(input.projectId),
        query = input.content
          ? text(input.query, '检索内容', 1000)
          : input.query == null
            ? ''
            : typeof input.query === 'string' && input.query.length <= 1000
              ? input.query.trim()
              : (() => {
                  throw fail('检索内容格式无效。');
                })(),
        limit = limitOf(input.limit);
      let rows = store.list('resource').filter(item => allowed(item, projectId, input.includeGlobal));
      if (input.resourceIds) {
        if (!Array.isArray(input.resourceIds) || input.resourceIds.length > 20) throw fail('一次最多明确选择 20 个资料。');
        rows = rows.filter(item => input.resourceIds.includes(item.id));
      }
      if (!input.content)
        return {
          results: rows.filter(item => `${item.title} ${item.location}`.toLowerCase().includes(query.toLowerCase())).slice(0, limit),
          mode: 'reference-metadata'
        };
      confirm(input);
      if (!input.resourceIds?.length) throw fail('正文检索须明确选择资料，不会自动读取整个资源库。', 403, 'resource_selection_required');
      const results = [],
        failures = [];
      for (const row of rows) {
        try {
          const item = await api.readResource({ id: row.id, projectId, includeGlobal: input.includeGlobal, confirmed: true });
          const offset = item.text.toLowerCase().indexOf(query.toLowerCase());
          if (offset >= 0)
            results.push({ ...item, text: undefined, excerpt: item.text.slice(Math.max(0, offset - 120), offset + query.length + 240) });
        } catch (error) {
          failures.push({ id: row.id, code: error.code || 'knowledge_unavailable', reason: error.message });
        }
      }
      return { results: results.slice(0, limit), failures, mode: 'explicit-content' };
    },
    async searchConnector(input) {
      confirm(input);
      const projectId = await checkProject(input.projectId),
        query = text(input.query, '检索内容', 500),
        limit = limitOf(input.limit);
      let results;
      if (input.source === 'eagle') {
        const data = await local('eagle', '/api/item/list?' + new URLSearchParams({ keyword: query, limit: String(limit) }));
        if (data.status !== 'success' || !Array.isArray(data.data)) throw unavailable('Eagle 未返回有效检索结果。');
        results = data.data
          .filter(item => !item.isDeleted)
          .slice(0, limit)
          .map(item => ({
            id: String(item.id),
            title: item.name || 'Eagle 条目',
            source: 'eagle',
            location: `eagle://item/${externalId(item.id)}`,
            excerpt: redactContent(item.annotation || '').slice(0, 600),
            projectId
          }));
      } else if (input.source === 'zotero') {
        const data = await local('zotero', '/api/users/0/items?' + new URLSearchParams({ q: query, limit: String(limit), format: 'json' }));
        if (!Array.isArray(data)) throw unavailable('Zotero 未返回有效检索结果。');
        results = data
          .slice(0, limit)
          .map(item => ({
            id: String(item.key || item.data?.key),
            title: item.data?.title || 'Zotero 条目',
            source: 'zotero',
            location: `zotero://select/library/items/${externalId(item.key || item.data?.key)}`,
            excerpt: redactContent(item.data?.abstractNote || '').slice(0, 600),
            projectId,
            ...(typeof item.data?.itemType === 'string'
              ? {
                  itemType: item.data.itemType,
                  ...(item.data.itemType === 'attachment' ? { readablePDF: item.data.contentType === 'application/pdf' } : {})
                }
              : {})
          }));
      } else if (input.source === 'masscode') {
        const data = await masscode('search', { query, type: input.type === 'snippet' ? 'snippet' : 'note', limit });
        const rows = Array.isArray(data) ? data : data.items || data.results;
        if (!Array.isArray(rows)) throw unavailable('massCode 当前搜索结构未返回可识别条目。');
        results = rows
          .slice(0, limit)
          .filter(item => ['note', 'snippet'].includes(item.type || input.type || 'note'))
          .map(item => ({
            id: String(item.id),
            title: item.name || item.title || 'massCode 条目',
            source: 'masscode',
            location: `masscode://${item.type || input.type || 'note'}/${externalId(item.id)}`,
            excerpt: redactContent(item.excerpt || item.preview || '').slice(0, 600),
            projectId
          }));
      } else throw unavailable('该来源尚无获授权的搜索接口。Obsidian 可先明确引用具体 Markdown 文件，Hub 不扫描 Vault。');
      return { results, projectId, attached: false, source: input.source, notice: '检索结果尚未加入项目；明确引用后才能作为执行上下文。' };
    },
    async configureMasscode(input) {
      confirm(input);
      const token = text(input.token, 'massCode Integration API token', 4096);
      const protocol = await masscodeProtocol();
      if (protocol.protocolCompatible === false) throw fail(protocol.disabledReason, 409, 'masscode_protocol_unsupported');
      const value = store.put('knowledge-connector', { id: 'masscode', sealedToken: store.seal(token), endpoint: ENDPOINTS.masscode });
      store.audit({ type: 'knowledge.connector.configure', source: 'masscode' });
      notify();
      return { source: value.id, configured: true, verified: false };
    },
    async memoryProjects() {
      const data = await local('memory', '/api/projects');
      return { projects: Array.isArray(data.projects) ? data.projects.filter(item => typeof item === 'string') : [], source: 'claude-mem' };
    },
    memoryScopes() {
      return store
        .list('knowledge-memory-scope')
        .map(({ id, projectId, memoryProject, updatedAt }) => ({ id, projectId, memoryProject, updatedAt }));
    },
    async mapMemoryScope(input) {
      confirm(input);
      const projectId = await checkProject(input.projectId),
        memoryProject = text(input.memoryProject, '共享记忆项目范围', 200);
      if (/[,\r\n\u0000]/.test(memoryProject)) throw fail('共享记忆范围须为单一项目名称。');
      const result = store.put('knowledge-memory-scope', { id: keyOf(projectId), projectId, memoryProject });
      store.audit({ type: 'knowledge.memory.scope', projectId, memoryProject });
      notify();
      return result;
    },
    async searchMemory(input) {
      const scope = await memoryScope(input.projectId),
        query = text(input.query, '检索内容', 500),
        limit = limitOf(input.limit);
      const data = await local(
        'memory',
        '/api/search?' +
          new URLSearchParams({ query, project: scope.memoryProject, type: 'observations', format: 'json', limit: String(limit) })
      );
      if (!Array.isArray(data.observations)) throw unavailable('共享记忆当前未返回可核验的结构化检索结果。');
      const results = data.observations
        .filter(row => row.project === scope.memoryProject)
        .slice(0, limit)
        .map(row => {
          const item = normalizeMemory(row, scope);
          return { ...item, text: undefined, excerpt: item.text.slice(0, 1200), governance: governanceFor(item.id, scope) };
        });
      store.audit({ type: 'knowledge.memory.search', projectId: scope.projectId, memoryProject: scope.memoryProject }, 'user', {
        count: results.length
      });
      return { results, ...scope, source: 'claude-mem', trust: 'reference-data-not-instructions' };
    },
    async readMemory(input) {
      const scope = await memoryScope(input.projectId),
        id = numericId(input.id),
        row = await lookupMemoryRow(id, scope),
        governance = governanceFor(id, scope);
      if (!row) {
        if (governance?.role === 'old' && governance.oldAbsentVerified)
          throw fail(
            `原库已不再返回旧记忆 #${id}；更正记录为 #${governance.replacementId}。请明确选择新记录，不能继续使用旧快照。`,
            409,
            'memory_replaced'
          );
        if (governance?.status === 'deleted') throw fail(`原库已不再返回已删除记忆 #${id}，请移除旧引用。`, 409, 'memory_deleted');
        throw fail('该记忆不存在或不属于当前项目授权范围；请重核已选来源。', 404, 'memory_scope_mismatch');
      }
      if ((governance?.role === 'old' && governance.oldAbsentVerified) || governance?.status === 'deleted')
        throw fail('原库重新出现已核验删除的旧记录，请先在更正收据中核对同步状态，不能继续用旧引用。', 409, 'memory_governance_conflict');
      const owned = ownedMemory(row, scope);
      return { ...normalizeMemory(row, scope), owned, governance, capabilities: { update: false, replace: owned, delete: owned } };
    },
    async captureMemory(input) {
      confirm(input);
      const scope = await memoryScope(input.projectId),
        body = text(input.text, '共享记忆正文', 24000),
        title = input.title ? text(input.title, '记忆标题', 200) : body.slice(0, 60);
      if (redactContent(body) !== body) throw fail('记忆包含疑似凭据，请用占位符替换后再保存。', 400, 'memory_credential_content');
      let importedFrom;
      if (input.legacyId != null) {
        const id = text(input.legacyId, '历史本地记录编号', 200),
          hash = input.legacySourceHash;
        if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
          throw fail('请从历史本地列表重新准备导入，核对原文与目标范围。', 400, 'legacy_memory_hash_required');
        const prior = store.get('memory', id);
        if (!prior || typeof prior.text !== 'string')
          throw fail('原历史本地记录已不存在，请刷新后重新选择。', 404, 'legacy_memory_missing');
        if (sha(prior.text) !== hash)
          throw fail('历史本地原文已改变，请重新预览并准备导入；尚未写入共享库。', 409, 'legacy_memory_changed');
        importedFrom = { kind: 'hub-legacy-local', id, projectId: prior.projectId || null, hash };
      } else if (input.legacySourceHash != null) throw fail('导入来源编号缺失，请重新选择历史本地记录。', 400, 'legacy_memory_missing');
      return once(
        'memory-capture',
        { requestId: input.requestId, text: body, title, ...scope, ...(importedFrom ? { importedFrom } : {}) },
        async () => {
          const fingerprint = sha(JSON.stringify({ scope, requestId: input.requestId, body, ...(importedFrom ? { importedFrom } : {}) }));
          const result = await local('memory', '/api/memory/save', {
            method: 'POST',
            body: {
              text: body,
              title,
              project: scope.memoryProject,
              metadata: {
                platformSource: 'aihub',
                sourceFingerprint: fingerprint,
                hubProjectId: scope.projectId,
                hubCaptureId: input.requestId,
                ...(importedFrom ? { importedFrom } : {})
              }
            }
          });
          if (!result.success || !result.id || result.project !== scope.memoryProject)
            throw unavailable('共享记忆写回未得到明确的项目归属确认；不要重复提交，请先核验。');
          const row = await readMemoryRow(result.id, scope),
            metadata = decodeMetadata(row.metadata),
            owned = metadata.hubCaptureId === input.requestId && metadata.sourceFingerprint === fingerprint;
          store.put('knowledge-memory-link', {
            id: String(result.id),
            projectId: scope.projectId,
            memoryProject: scope.memoryProject,
            owned,
            captureId: input.requestId,
            sourceFingerprint: fingerprint,
            ...(importedFrom ? { importedFrom } : {})
          });
          store.audit(
            {
              type: 'knowledge.memory.capture',
              projectId: scope.projectId,
              memoryId: String(result.id),
              memoryProject: scope.memoryProject
            },
            'user',
            { owned, ...(importedFrom ? { importedFrom } : {}) }
          );
          return {
            memory: normalizeMemory(row, scope),
            owned,
            source: 'claude-mem',
            syncPolicy: 'existing-worker-sync-settings',
            modelCall: false
          };
        }
      );
    },
    async memoryCorrections(input) {
      const scope = await memoryScope(input.projectId);
      return {
        corrections: correctionList(scope).slice(-30).reverse().map(publicCorrection),
        deletions: store
          .list('knowledge-memory-deletion')
          .filter(item => item.projectId === scope.projectId && item.memoryProject === scope.memoryProject)
          .slice(-30)
          .reverse(),
        ...scope,
        source: 'claude-mem'
      };
    },
    async replaceMemory(input) {
      confirm(input);
      const scope = await memoryScope(input.projectId),
        oldId = numericId(input.id),
        requestId = text(input.requestId, '幂等键', 160),
        newText = text(input.text, '更正后的完整正文', 24000),
        newTitle = input.title ? text(input.title, '更正标题', 200) : newText.slice(0, 60),
        oldHash = input.oldHash;
      if (typeof oldHash !== 'string' || !/^[a-f0-9]{64}$/.test(oldHash))
        throw fail('请先读回旧记忆全文并核对摘要。', 400, 'memory_old_hash_required');
      if (redactContent(newText) !== newText) throw fail('更正正文包含疑似凭据，请使用占位符。', 400, 'memory_credential_content');
      const key = `knowledge:memory-replace:${requestId}`,
        fingerprint = digest({ requestId, oldId, oldHash, newText, newTitle, ...scope });
      if (store.db.prepare('SELECT id FROM receipts WHERE id=?').get(key)) {
        const prior = store.begin(key, fingerprint);
        return { correction: publicCorrection(store.get('knowledge-memory-correction', prior.result.correctionId)), replay: true };
      }
      return lockedMemory(oldId, async () => {
        const open = correctionList(scope).find(item => item.oldId === oldId && item.status !== 'completed');
        if (open) throw fail(`此条记忆已有更正收据 ${open.id}。请先核对该收据，不会创建重复新记录。`, 409, 'memory_correction_pending');
        const oldRow = await readMemoryRow(oldId, scope),
          original = normalizeMemory(oldRow, scope);
        if (!ownedMemory(oldRow, scope))
          throw fail(
            '只能替换 Hub 写入且归属已核验的记录；其他工具记录请在原 Claude-Mem 查看器或来源应用治理。',
            403,
            'memory_replace_not_owned'
          );
        if (original.hash !== oldHash) throw fail('旧记忆正文已改变，请重新读取并核对后再更正。', 409, 'memory_old_changed');
        if (original.text === newText && original.title === newTitle)
          throw fail('更正全文与标题没有变化，不会创建重复记忆。', 409, 'memory_correction_unchanged');
        const id = 'correction-' + sha(key).slice(0, 32),
          captureId = id,
          sourceFingerprint = sha(JSON.stringify({ id, scope, oldId, oldHash, newText, newTitle }));
        let correction;
        store.transaction(() => {
          store.begin(key, fingerprint);
          correction = store.put('knowledge-memory-correction', {
            id,
            oldId,
            oldHash,
            oldTitle: original.title,
            projectId: scope.projectId,
            memoryProject: scope.memoryProject,
            newId: null,
            newText,
            newHash: sha(newText),
            newTitle,
            sourceFingerprint,
            captureId,
            status: 'write_calling',
            deleteAttempts: 0,
            reason: '正在写入新记录，旧记录保持原样。'
          });
          store.commit(key, { correctionId: id });
        });
        notify();
        try {
          const saved = await local('memory', '/api/memory/save', {
            method: 'POST',
            body: {
              text: newText,
              title: newTitle,
              project: scope.memoryProject,
              metadata: {
                platformSource: 'aihub',
                sourceFingerprint,
                hubProjectId: scope.projectId,
                hubCaptureId: captureId,
                hubCorrectionId: id,
                replaces: { id: oldId, hash: oldHash }
              }
            }
          });
          if (!saved.success || !saved.id || saved.project !== scope.memoryProject)
            throw unavailable('共享服务没有明确确认新记录的编号与范围。');
          correction = patchCorrection(id, {
            newId: numericId(saved.id),
            status: 'replacement_unverified',
            reason: '原库已返回新编号，正在读回核对正文与归属；旧记录尚未删除。'
          });
          const memory = await verifyReplacement(correction, scope);
          correction = patchCorrection(id, {
            status: 'replacement_verified',
            newVerifiedAt: new Date().toISOString(),
            reason: '新记录全文与归属已核验；旧记录仍可被其他客户端召回，须另行明确确认删除。'
          });
          return { correction: publicCorrection(correction), memory, original };
        } catch (error) {
          correction = patchCorrection(id, {
            status: correction.newId ? 'replacement_unverified' : 'write_uncertain',
            reason: `${error.message} 此阶段不会自动重发；旧记录未由本操作删除。`
          });
          return { correction: publicCorrection(correction) };
        }
      });
    },
    async verifyMemoryCorrection(input) {
      confirm(input);
      const { correction: selected, scope } = await checkedCorrection(input);
      return lockedMemory(selected.oldId, async () => {
        let correction = store.get('knowledge-memory-correction', selected.id),
          memory;
        try {
          memory = await verifyReplacement(correction, scope, input.candidateId == null ? correction.newId : numericId(input.candidateId));
          const old = await lookupMemoryRow(correction.oldId, scope);
          if (!old) {
            store.remove('knowledge-memory-link', correction.oldId);
            correction = patchCorrection(correction.id, {
              newId: memory.id,
              status: 'completed',
              oldAbsentVerifiedAt: new Date().toISOString(),
              reason: '本次只读核验：新记录真实存在，原库已不再返回旧记录。其他设备同步状态尚未逐一核验。'
            });
          } else if (!ownedMemory(old, scope) || normalizeMemory(old, scope).hash !== correction.oldHash) {
            correction = patchCorrection(correction.id, {
              newId: memory.id,
              status: 'old_changed',
              reason: '新记录已核验，但旧记录正文或归属已经改变，禁止沿用原删除确认；请在原应用核对。'
            });
          } else {
            correction = patchCorrection(correction.id, {
              newId: memory.id,
              status: correction.deleteAttempts ? 'delete_retry_requires_confirmation' : 'replacement_verified',
              newVerifiedAt: new Date().toISOString(),
              reason: correction.deleteAttempts
                ? '本次只读核验：旧记录仍在、新记录已核验。不会自动重试；如仍需删除，必须再次明确确认本条旧记录。'
                : '新记录已核验，旧记录仍在；本次核验未执行删除。'
            });
          }
          return { correction: publicCorrection(correction), memory, original: old ? normalizeMemory(old, scope) : null };
        } catch (error) {
          correction = patchCorrection(correction.id, { reason: `${error.message} 当前状态仍待核验；没有重发任何写入或删除。` });
          return { correction: publicCorrection(correction) };
        }
      });
    },
    async finishMemoryCorrection(input) {
      confirm(input);
      if (input.deleteOldConfirmed !== true)
        throw fail('请单独明确确认删除这条旧 Hub 自有记录。', 403, 'memory_old_delete_confirmation_required');
      const { correction: selected, scope } = await checkedCorrection(input),
        requestId = text(input.requestId, '幂等键', 160);
      if (input.oldHash !== selected.oldHash || input.newHash !== selected.newHash)
        throw fail('本次删除确认与更正收据不一致，请重新核对新旧全文摘要。', 409, 'memory_correction_confirmation_stale');
      const key = `knowledge:memory-correction-delete:${requestId}`,
        fingerprint = digest({ correctionId: selected.id, requestId, oldHash: input.oldHash, newHash: input.newHash, ...scope });
      if (store.db.prepare('SELECT id FROM receipts WHERE id=?').get(key)) {
        store.begin(key, fingerprint);
        return { correction: publicCorrection(store.get('knowledge-memory-correction', selected.id)), replay: true };
      }
      return lockedMemory(selected.oldId, async () => {
        let correction = store.get('knowledge-memory-correction', selected.id);
        if (!['replacement_verified', 'delete_retry_requires_confirmation'].includes(correction.status))
          throw fail('当前更正阶段不能删除旧记录。请先只读核验收据与原库，不会自动重试。', 409, 'memory_correction_not_ready');
        const old = await readMemoryRow(correction.oldId, scope);
        if (!ownedMemory(old, scope) || normalizeMemory(old, scope).hash !== correction.oldHash)
          throw fail('旧记忆正文或归属已改变，原删除确认失效。', 409, 'memory_old_changed');
        const memory = await verifyReplacement(correction, scope);
        store.transaction(() => {
          store.begin(key, fingerprint);
          correction = store.put('knowledge-memory-correction', {
            ...correction,
            status: 'delete_calling',
            deleteAttempts: correction.deleteAttempts + 1,
            deleteConfirmedAt: new Date().toISOString(),
            reason: '已单独确认这条旧记录，正在请求原库删除；新记录已保留。'
          });
          store.commit(key, { correctionId: correction.id });
        });
        notify();
        try {
          const removed = await local('memory', `/api/observation/${correction.oldId}`, { method: 'DELETE' });
          if (removed.success !== true) throw unavailable('原库删除未得到明确成功回执。');
          const remaining = await lookupMemoryRow(correction.oldId, scope);
          if (remaining) throw unavailable('原库仍返回旧记录，删除未核验完成。');
          store.remove('knowledge-memory-link', correction.oldId);
          correction = patchCorrection(correction.id, {
            status: 'completed',
            workerDeleteReceipt: { success: true, id: correction.oldId, entityRev: removed.entity_rev || null },
            oldAbsentVerifiedAt: new Date().toISOString(),
            reason: '原库确认删除且按旧编号读回为空；新记录已核验。同步沿用 worker 设置，其他设备尚未逐一核验。'
          });
          return { correction: publicCorrection(correction), memory };
        } catch (error) {
          correction = patchCorrection(correction.id, {
            status: 'delete_uncertain',
            reason: `${error.message} 新记录保留；旧记录删除结果待核验，不会自动重试。`
          });
          return { correction: publicCorrection(correction), memory };
        }
      });
    },
    async updateMemory() {
      throw fail(
        '现有 Claude-Mem worker 没有已核验的单条更新接口；请新增更正记录，Hub 不直改它的数据库。',
        501,
        'memory_update_unavailable'
      );
    },
    async deleteMemory(input) {
      confirm(input);
      const scope = await memoryScope(input.projectId),
        id = numericId(input.id);
      return once(
        'memory-delete',
        { requestId: input.requestId, id, ...scope, ...(input.expectedHash ? { expectedHash: input.expectedHash } : {}) },
        () =>
          lockedMemory(id, async () => {
            const link = store.get('knowledge-memory-link', id);
            if (!link?.owned || link.projectId !== scope.projectId || link.memoryProject !== scope.memoryProject)
              throw fail('只允许删除 Hub 自己写入并核验归属的共享记忆。', 403, 'memory_delete_not_owned');
            const row = await readMemoryRow(id, scope);
            if (!ownedMemory(row, scope)) throw fail('只允许删除 Hub 自己写入并核验归属的共享记忆。', 403, 'memory_delete_not_owned');
            const value = normalizeMemory(row, scope);
            if (input.expectedHash && input.expectedHash !== value.hash)
              throw fail('原库正文与预览不同，请重新读回后再确认删除。', 409, 'memory_old_changed');
            store.put('knowledge-memory-deletion', {
              id,
              projectId: scope.projectId,
              memoryProject: scope.memoryProject,
              hash: value.hash,
              status: 'delete_uncertain',
              reason: '本条原库删除已单独确认，正在等待结果核验。'
            });
            try {
              const deleted = await local('memory', `/api/observation/${id}`, { method: 'DELETE' });
              if (deleted.success !== true || (await lookupMemoryRow(id, scope))) throw unavailable('原库未确认该记录已经不存在。');
              store.remove('knowledge-memory-link', id);
              store.put('knowledge-memory-deletion', {
                id,
                projectId: scope.projectId,
                memoryProject: scope.memoryProject,
                hash: value.hash,
                status: 'deleted',
                reason: '原库删除回执及指定编号读回为空均已核验。',
                verifiedAt: new Date().toISOString()
              });
              store.audit({ type: 'knowledge.memory.delete', memoryId: id, projectId: scope.projectId }, 'user', {
                hash: value.hash,
                absenceVerified: true
              });
              return { id, deleted: true, source: 'claude-mem', syncPolicy: 'existing-worker-sync-settings', replicationVerified: false };
            } catch (error) {
              store.put('knowledge-memory-deletion', {
                id,
                projectId: scope.projectId,
                memoryProject: scope.memoryProject,
                hash: value.hash,
                status: 'delete_uncertain',
                reason: `${error.message} 不会自动重发，请只读核验。`
              });
              return { id, deleted: false, status: 'delete_uncertain', reason: '原库删除结果待核验，不会自动重试。', source: 'claude-mem' };
            }
          })
      );
    },
    async verifyMemoryDeletion(input) {
      confirm(input);
      const scope = await memoryScope(input.projectId),
        id = numericId(input.id),
        prior = store.get('knowledge-memory-deletion', id);
      if (!prior || prior.projectId !== scope.projectId || prior.memoryProject !== scope.memoryProject)
        throw fail('当前范围没有这条已确认删除的核验收据。', 404, 'memory_deletion_receipt_missing');
      const row = await lookupMemoryRow(id, scope);
      if (row)
        return {
          id,
          deleted: false,
          status: 'delete_uncertain',
          reason: '本次只读核验：原库仍返回该记录，尚未删除。不会自动重试。',
          memory: { ...normalizeMemory(row, scope), owned: ownedMemory(row, scope) }
        };
      store.remove('knowledge-memory-link', id);
      store.put('knowledge-memory-deletion', {
        ...prior,
        status: 'deleted',
        reason: '本次只读核验：原库已不再返回该编号。',
        verifiedAt: new Date().toISOString()
      });
      notify();
      return {
        id,
        deleted: true,
        status: 'deleted',
        source: 'claude-mem',
        syncPolicy: 'existing-worker-sync-settings',
        replicationVerified: false
      };
    },
    async status() {
      const check = async (source, path) => {
        try {
          const data = await local(source, path);
          return { connected: true, version: source === 'eagle' ? data.data?.version || null : data.version || null };
        } catch (error) {
          return { connected: false, reason: error.message };
        }
      };
      const [memory, eagle, zotero, masscode] = await Promise.all([
        check('memory', '/api/health'),
        check('eagle', '/api/application/info'),
        checkZotero(),
        masscodeProtocol()
      ]);
      const notionStatus = notion.status(),
        miroStatus = miro.status();
      return {
        resourceLimits: { bytes: MAX_CONTENT, explicitReferencesOnly: true, binary: false, directoryScan: false },
        memory: {
          ...memory,
          source: 'claude-mem',
          search: memory.connected,
          capture: memory.connected,
          update: false,
          replacement: 'explicit-hub-owned-two-stage',
          delete: 'hub-owned-confirmed-only',
          scopes: api.memoryScopes(),
          defaultScope: 'aihub:<projectId>',
          syncPolicy: 'existing-worker-sync-settings'
        },
        connectors: {
          notion: notionStatus,
          miro: miroStatus,
          eagle: { ...eagle, read: true, search: true, visualPreview: true, write: false },
          zotero: { ...zotero, read: true, search: true, write: false },
          masscode: {
            ...masscode,
            configured: Boolean(store.get('knowledge-connector', 'masscode')),
            connected: masscode.protocolCompatible === false ? false : null,
            read: masscode.protocolCompatible === false ? false : 'requires-explicit-token-and-enabled-mcp',
            reason: masscode.disabledReason,
            write: false
          },
          obsidian: { read: 'explicit-markdown-file', search: false, write: false }
        }
      };
    }
  };
  return api;
}

export function registerKnowledge(app, options) {
  const knowledge = createKnowledge(options);
  app.get('/api/knowledge/status', () => knowledge.status());
  app.post('/api/knowledge/resources', request => knowledge.attachResource(request.body || {}));
  app.post('/api/knowledge/resources/search', request => knowledge.searchResources(request.body || {}));
  app.post('/api/knowledge/resources/:id/read', request => knowledge.readResource({ ...(request.body || {}), id: request.params.id }));
  app.post('/api/knowledge/connectors/:source/search', request =>
    knowledge.searchConnector({ ...(request.body || {}), source: request.params.source })
  );
  app.post('/api/knowledge/connectors/masscode/configuration', request => knowledge.configureMasscode(request.body || {}));
  app.get('/api/knowledge/memory/projects', () => knowledge.memoryProjects());
  app.get('/api/knowledge/memory/scopes', () => ({ scopes: knowledge.memoryScopes() }));
  app.post('/api/knowledge/memory/scopes', request => knowledge.mapMemoryScope(request.body || {}));
  app.post('/api/knowledge/memory/search', request => knowledge.searchMemory(request.body || {}));
  app.post('/api/knowledge/memory/read', request => knowledge.readMemory(request.body || {}));
  app.post('/api/knowledge/memory/capture', request => knowledge.captureMemory(request.body || {}));
  app.get('/api/knowledge/memory/corrections', request => knowledge.memoryCorrections(request.query || {}));
  app.post('/api/knowledge/memory/:id/replace', request => knowledge.replaceMemory({ ...(request.body || {}), id: request.params.id }));
  app.post('/api/knowledge/memory/corrections/:correctionId/verify', request =>
    knowledge.verifyMemoryCorrection({ ...(request.body || {}), correctionId: request.params.correctionId })
  );
  app.post('/api/knowledge/memory/corrections/:correctionId/delete-old', request =>
    knowledge.finishMemoryCorrection({ ...(request.body || {}), correctionId: request.params.correctionId })
  );
  app.post('/api/knowledge/memory/:id/update', request => knowledge.updateMemory({ ...(request.body || {}), id: request.params.id }));
  app.post('/api/knowledge/memory/:id/deletion/verify', request =>
    knowledge.verifyMemoryDeletion({ ...(request.body || {}), id: request.params.id })
  );
  app.post('/api/knowledge/memory/:id/delete', request => knowledge.deleteMemory({ ...(request.body || {}), id: request.params.id }));
  return knowledge;
}
