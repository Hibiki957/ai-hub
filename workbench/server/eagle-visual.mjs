// Selected Eagle items only. Eagle owns the library; this host reader never
// scans it, refreshes thumbnails, follows source URLs, or changes its files.
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { digest, fail } from './store.mjs';

export const EAGLE_IMAGE_LIMIT = 8 * 1024 * 1024;
export const EAGLE_PIXEL_LIMIT = 40 * 1000 * 1000;
const sha = value => createHash('sha256').update(value).digest('hex');
const deny = (message, code = 'eagle_visual_invalid', status = 409) => fail(message, status, code);
const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a, b) => sameNode(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
const credential =
  /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.ssh|\.aws|\.gnupg|\.keychain|credentials|auth\.json)(?:\/|$)|\.(?:pem|p12|pfx|keychain-db)$/i;
const dimension = (width, height, mime) => {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > EAGLE_PIXEL_LIMIT)
    throw deny('图片尺寸超过 4000 万像素或无效。', 'eagle_visual_dimensions', 413);
  return { mime, width, height };
};

// Inspect container signatures and dimensions, never trust an Eagle filename.
// The browser remains responsible for raster decoding; no SVG/HTML is served.
export function inspectEagleRaster(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > EAGLE_IMAGE_LIMIT)
    throw deny('图片超过 8 MiB 预览上限或没有内容。', 'eagle_visual_size', 413);
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw deny('PNG 头部无效。');
    let at = 8,
      ended = false;
    while (at + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(at),
        type = bytes.toString('ascii', at + 4, at + 8);
      if (length > bytes.length - at - 12) throw deny('PNG 数据不完整。');
      at += length + 12;
      if (type === 'IEND') {
        if (length || at !== bytes.length) throw deny('PNG 结束标记无效。');
        ended = true;
        break;
      }
    }
    if (!ended) throw deny('PNG 数据不完整。');
    return dimension(bytes.readUInt32BE(16), bytes.readUInt32BE(20), 'image/png');
  }
  if (bytes.length >= 14 && /^(GIF87a|GIF89a)$/.test(bytes.toString('ascii', 0, 6))) {
    if (bytes.at(-1) !== 0x3b) throw deny('GIF 数据不完整。');
    return dimension(bytes.readUInt16LE(6), bytes.readUInt16LE(8), 'image/gif');
  }
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw deny('WebP 数据不完整。');
    let at = 12,
      found;
    while (at + 8 <= bytes.length) {
      const type = bytes.toString('ascii', at, at + 4),
        length = bytes.readUInt32LE(at + 4),
        start = at + 8;
      if (length > bytes.length - start) throw deny('WebP 数据不完整。');
      if (!found && type === 'VP8X' && length === 10)
        found = dimension(1 + bytes.readUIntLE(start + 4, 3), 1 + bytes.readUIntLE(start + 7, 3), 'image/webp');
      if (!found && type === 'VP8L' && length >= 5 && bytes[start] === 0x2f) {
        const bits = bytes.readUInt32LE(start + 1);
        found = dimension((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, 'image/webp');
      }
      if (!found && type === 'VP8 ' && length >= 10 && bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 0x01, 0x2a])))
        found = dimension(bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff, 'image/webp');
      at = start + length + (length % 2);
    }
    if (at !== bytes.length || !found) throw deny('WebP 缺少可核验的图片尺寸。');
    return found;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
    let at = 2;
    while (at < bytes.length - 2) {
      if (bytes[at++] !== 0xff) break;
      while (bytes[at] === 0xff) at++;
      const marker = bytes[at++];
      if (marker === 0xda || marker === 0xd9 || at + 2 > bytes.length) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = bytes.readUInt16BE(at);
      if (length < 2 || at + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8)
        return dimension(bytes.readUInt16BE(at + 5), bytes.readUInt16BE(at + 3), 'image/jpeg');
      at += length;
    }
    throw deny('JPEG 缺少可核验的图片尺寸。');
  }
  throw deny('仅支持实际 PNG、JPEG、GIF 或 WebP 图片预览；此条目仍可查看元数据。', 'eagle_visual_format', 415);
}

const scalar = value => (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null);
function itemSnapshot(row, id) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || row.id !== id || row.isDeleted)
    throw deny('Eagle 条目不存在、已删除或与所选编号不符。', 'eagle_visual_item_missing', 404);
  return Object.fromEntries(
    ['id', 'name', 'ext', 'size', 'width', 'height', 'annotation', 'url', 'noThumbnail', 'modificationTime', 'lastModified']
      .map(key => [key, scalar(row[key])])
      .concat([['tags', Array.isArray(row.tags) ? row.tags.filter(value => typeof value === 'string') : []]])
  );
}
function selectedPath(value, id) {
  if (typeof value !== 'string' || value.length > 8192) throw deny('Eagle 未返回明确的本机缩略图路径。', 'eagle_visual_path');
  // Real Eagle 4.0 encodes spaces/non-ASCII with encodeURI; reserved path
  // separators must never be introduced by decoding untrusted bytes.
  let path;
  try {
    path = decodeURI(value);
  } catch {
    throw deny('Eagle 缩略图路径编码无效。', 'eagle_visual_path');
  }
  if (!isAbsolute(path) || resolve(path) !== path || /[\x00-\x1f\x7f\\]/.test(path) || /%[0-9a-f]{2}/i.test(path) || credential.test(path))
    throw deny('Eagle 缩略图不是可授权的规范本机图片路径。', 'eagle_visual_path', 403);
  const itemDir = dirname(path),
    images = dirname(itemDir),
    library = dirname(images);
  if (
    basename(itemDir) !== id + '.info' ||
    basename(images) !== 'images' ||
    !basename(library).endsWith('.library') ||
    !basename(path) ||
    basename(path).startsWith('.')
  )
    throw deny('Eagle 缩略图不属于当前明确选中的条目目录。', 'eagle_visual_boundary', 403);
  return { path, itemDir, library };
}
async function treeSnapshot(path) {
  let cursor = parse(path).root;
  const nodes = [];
  for (const part of dirname(path).slice(cursor.length).split('/').filter(Boolean)) {
    cursor = join(cursor, part);
    const stat = await lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(cursor)) !== cursor)
      throw deny('Eagle 图片目录包含链接或发生变化。', 'eagle_visual_path', 403);
    nodes.push({ path: cursor, dev: stat.dev, ino: stat.ino });
  }
  const file = await lstat(path);
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || (await realpath(path)) !== path)
    throw deny('Eagle 图片必须是无链接的普通文件。', 'eagle_visual_path', 403);
  if (!file.size || file.size > EAGLE_IMAGE_LIMIT) throw deny('图片超过 8 MiB 预览上限或没有内容。', 'eagle_visual_size', 413);
  return { nodes, file };
}
function assertSameTree(before, after) {
  if (
    before.nodes.length !== after.nodes.length ||
    before.nodes.some((node, index) => node.path !== after.nodes[index].path || !sameNode(node, after.nodes[index])) ||
    !sameFile(before.file, after.file)
  )
    throw deny('预览期间 Eagle 图片或目录发生变化，请重新选择。', 'eagle_visual_changed');
}
function sourceURL(value, redact) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      ![...url.searchParams.keys()].some(key => /token|secret|api.?key|password|authorization/i.test(key))
      ? redact(value)
      : null;
  } catch {
    return null;
  }
}

/** Trusted host interface. readJSON is the existing fixed-localhost reader,
 * never a client URL/path. No path or directory identity leaves this module. */
export async function readEagleVisual({ id, readJSON, redact = value => String(value), expectedItem } = {}) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id || '') || typeof readJSON !== 'function')
    throw deny('Eagle 视觉读取范围无效。', 'eagle_visual_scope', 400);
  const itemPath = '/api/item/info?' + new URLSearchParams({ id }),
    thumbnailPath = '/api/item/thumbnail?' + new URLSearchParams({ id });
  const info = async () => {
    const value = await readJSON(itemPath);
    if (value.status !== 'success') throw deny('Eagle 未返回有效的所选条目。', 'eagle_visual_item_missing', 404);
    return itemSnapshot(value.data, id);
  };
  const thumbnail = async () => {
    const value = await readJSON(thumbnailPath);
    if (value.status !== 'success') throw deny('Eagle 暂无可用的所选条目缩略图。', 'eagle_visual_unavailable', 503);
    return selectedPath(value.data, id);
  };
  try {
    const item = await info();
    if (expectedItem && digest(itemSnapshot(expectedItem, id)) !== digest(item))
      throw deny('Eagle 条目已变化，请重新预览。', 'eagle_visual_changed');
    const selected = await thumbnail(),
      before = await treeSnapshot(selected.path);
    const requireRuntime = createRequire(new URL('../../runtime/package.json', import.meta.url));
    const { root } = await import(pathToFileURL(requireRuntime.resolve('@openclaw/fs-safe')).href);
    const scoped = await root(selected.itemDir, {
      hardlinks: 'reject',
      symlinks: 'reject',
      nonBlockingRead: true,
      maxBytes: EAGLE_IMAGE_LIMIT
    });
    const result = await scoped.read(basename(selected.path));
    if (result.realPath !== selected.path || result.buffer.length !== before.file.size)
      throw deny('Eagle 实际图片位置或大小已变化。', 'eagle_visual_changed');
    const dimensions = inspectEagleRaster(result.buffer),
      afterItem = await info(),
      afterPath = await thumbnail();
    if (digest(item) !== digest(afterItem) || selected.path !== afterPath.path)
      throw deny('预览期间 Eagle 条目或缩略图定位发生变化。', 'eagle_visual_changed');
    assertSameTree(before, await treeSnapshot(selected.path));
    const hash = sha(result.buffer),
      original = item.noThumbnail === true && before.file.size === item.size;
    const image = { ...dimensions, hash, bytes: result.buffer.length, kind: original ? 'original' : 'thumbnail' };
    const fingerprint = digest({
      source: 'eagle',
      version: 1,
      item,
      path: selected.path,
      nodes: before.nodes,
      file: {
        dev: before.file.dev,
        ino: before.file.ino,
        size: before.file.size,
        mtimeMs: before.file.mtimeMs,
        ctimeMs: before.file.ctimeMs
      },
      image
    });
    const safeNumber = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);
    const metadata = {
      id,
      name: redact(item.name || 'Eagle 条目'),
      ext: typeof item.ext === 'string' && /^[a-zA-Z0-9]{1,20}$/.test(item.ext) ? item.ext.toLowerCase() : null,
      annotation: redact(item.annotation || ''),
      tags: item.tags.map(redact),
      sourceURL: sourceURL(item.url, redact),
      originalWidth: safeNumber(item.width),
      originalHeight: safeNumber(item.height),
      originalBytes: safeNumber(item.size)
    };
    return {
      bytes: result.buffer,
      fingerprint,
      image,
      metadata,
      readAt: new Date().toISOString(),
      limitation: `${original ? '原始图片' : 'Eagle 缩略图'}仅在本机预览；任务输入只含条目文本与图片指纹，尚未将图片发送给模型。`
    };
  } catch (error) {
    if (error.status) throw error;
    if (error.code === 'too-large') throw deny('图片超过 8 MiB 预览上限。', 'eagle_visual_size', 413);
    if (['symlink', 'hardlink', 'outside-workspace', 'path-mismatch', 'path-alias', 'not-file'].includes(error.code))
      throw deny('Eagle 图片路径或文件身份无法核验。', 'eagle_visual_path', 403);
    throw deny('所选 Eagle 图片当前不可读，请检查原应用、挂载和权限。', 'eagle_visual_unavailable', 503);
  }
}
