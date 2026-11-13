import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, realpath, rm, symlink, link, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEagleVisual, inspectEagleRaster, EAGLE_IMAGE_LIMIT } from './eagle-visual.mjs';
import { redactContent } from './knowledge.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lV8AAAAASUVORK5CYII=', 'base64');
const sha = value => createHash('sha256').update(value).digest('hex');
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);
async function fixture(t) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'hub-eagle-visual-'));
  const id = 'SELECTED_ITEM',
    library = join(directory, 'Design 公开.library'),
    itemDir = join(library, 'images', id + '.info'),
    path = join(itemDir, 'selected_thumbnail.png');
  await mkdir(itemDir, { recursive: true });
  await writeFile(path, png);
  const item = {
    id,
    name: 'Selected drawing',
    ext: 'jpg',
    size: 300000,
    width: 3360,
    height: 2400,
    annotation: 'One explicit item',
    tags: ['design'],
    url: 'https://example.org/drawing',
    isDeleted: false,
    modificationTime: 1700000000000,
    lastModified: 1700000000001,
    preferences: { token: 'DO_NOT_RETURN' }
  };
  const state = { path, item, calls: [], onCall: null };
  const readJSON = async value => {
    const url = new URL('http://127.0.0.1:41595' + value);
    state.calls.push(url.pathname);
    assert.equal(url.searchParams.get('id'), id);
    assert.equal([...url.searchParams.keys()].length, 1);
    await state.onCall?.(state.calls.length, url);
    return url.pathname === '/api/item/info'
      ? { status: 'success', data: structuredClone(state.item) }
      : url.pathname === '/api/item/thumbnail'
        ? { status: 'success', data: encodeURI(state.path) }
        : assert.fail('No scans, application info, remote URLs or writes');
  };
  const read = options => readEagleVisual({ id, readJSON, redact: redactContent, ...options });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, library, itemDir, path, id, state, read };
}

test('one explicit selected image is bounded, identified by bytes, and returned without private paths, identities or unrelated metadata', async t => {
  const f = await fixture(t),
    result = await f.read();
  assert.deepEqual(result.bytes, png);
  assert.deepEqual(result.image, { mime: 'image/png', width: 1, height: 1, hash: sha(png), bytes: png.length, kind: 'thumbnail' });
  assert.equal(result.fingerprint.length, 64);
  assert.equal(result.metadata.originalWidth, 3360);
  assert.equal(result.metadata.originalHeight, 2400);
  assert.equal(result.metadata.originalBytes, 300000);
  assert.match(result.limitation, /尚未将图片发送给模型/);
  const metadata = JSON.stringify({ ...result, bytes: undefined });
  assert.doesNotMatch(metadata, /DO_NOT_RETURN|preferences|\/hub-eagle-visual-|\.library|\.info|dev|ino/);
  assert.deepEqual(f.state.calls, ['/api/item/info', '/api/item/thumbnail', '/api/item/info', '/api/item/thumbnail']);
  assert.equal((await f.read()).fingerprint, result.fingerprint, 'identical source has a stable fingerprint');
});

test('metadata whitelist redacts credential text and omits credential or non-web source URLs', async t => {
  const f = await fixture(t);
  f.state.item.annotation = 'api_key=public-fixture-sensitive-text';
  f.state.item.tags = ['password=public-fixture-sensitive-tag'];
  f.state.item.url = 'https://example.org/?access_token=public-fixture-sensitive-url';
  const result = await f.read();
  assert.match(result.metadata.annotation, /REDACTED/);
  assert.match(result.metadata.tags[0], /REDACTED/);
  assert.equal(result.metadata.sourceURL, null);
  assert.doesNotMatch(JSON.stringify(result), /public-fixture-sensitive/);
  f.state.item.url = 'file:///private/path';
  assert.equal((await f.read()).metadata.sourceURL, null);
});

test('original classification requires explicit noThumbnail and matching original bytes', async t => {
  const f = await fixture(t);
  f.state.item.noThumbnail = true;
  assert.equal((await f.read()).image.kind, 'thumbnail');
  f.state.item.size = png.length;
  assert.equal((await f.read()).image.kind, 'original');
});

test('metadata, actual image, and item-directory identity all participate in the source fingerprint', async t => {
  const f = await fixture(t),
    initial = await f.read();
  f.state.item.width++;
  const metadataChanged = await f.read();
  assert.notEqual(metadataChanged.fingerprint, initial.fingerprint);
  f.state.item.width--;
  const replacement = join(f.itemDir, 'replacement.png');
  await writeFile(replacement, png);
  await rename(replacement, f.path);
  assert.notEqual((await f.read()).fingerprint, initial.fingerprint, 'same content replacement is a new file identity');
});

test('safe layouts reject outside-item paths, source URLs, encoded separators, aliases and credential files before image reading', async t => {
  const f = await fixture(t),
    original = f.state.path;
  for (const path of [
    join(f.directory, 'outside.png'),
    join(f.library, 'images', 'OTHER.info', 'image.png'),
    join(f.itemDir, 'nested', 'image.png'),
    join(f.itemDir, '.env'),
    'https://example.org/image.png',
    original + '?anything'
  ]) {
    f.state.path = path;
    await assert.rejects(f.read(), error =>
      ['eagle_visual_boundary', 'eagle_visual_path', 'eagle_visual_unavailable'].includes(error.code)
    );
  }
  f.state.path = original;
  const alias = join(f.itemDir, 'alias.png');
  await symlink(original, alias);
  f.state.path = alias;
  await rejects(f.read(), 'eagle_visual_path');
  await rm(alias);
  await link(original, alias);
  f.state.path = alias;
  await rejects(f.read(), 'eagle_visual_path');
  await rm(alias);
  const images = join(f.library, 'images'),
    realImages = join(f.library, 'real-images');
  await rename(images, realImages);
  await symlink(realImages, images);
  f.state.path = original;
  await rejects(f.read(), 'eagle_visual_path');
});

test('size limits, directories and executable image types fail closed without returning bytes', async t => {
  const f = await fixture(t);
  await writeFile(f.path, Buffer.alloc(EAGLE_IMAGE_LIMIT + 1));
  await rejects(f.read(), 'eagle_visual_size');
  await writeFile(f.path, '<svg xmlns="http://www.w3.org/2000/svg"><script>anything</script></svg>');
  await rejects(f.read(), 'eagle_visual_format');
  await writeFile(f.path, '<html><script>anything</script></html>');
  await rejects(f.read(), 'eagle_visual_format');
  await rm(f.path);
  await mkdir(f.path);
  await rejects(f.read(), 'eagle_visual_path');
});

test('re-fetch rejects changed metadata or thumbnail path even if text and file content look unchanged', async t => {
  const f = await fixture(t);
  f.state.onCall = async n => {
    if (n === 3) f.state.item.lastModified++;
  };
  await rejects(f.read(), 'eagle_visual_changed');
  f.state.calls = [];
  f.state.onCall = async n => {
    if (n === 4) f.state.path = join(f.itemDir, 'different.png');
  };
  await rejects(f.read(), 'eagle_visual_changed');
});

test('file replacement while re-fetching source metadata invalidates the result', async t => {
  const f = await fixture(t);
  f.state.onCall = async n => {
    if (n === 3) {
      const next = join(f.itemDir, 'next.png');
      await writeFile(next, png);
      await rename(next, f.path);
    }
  };
  await rejects(f.read(), 'eagle_visual_changed');
});

test('source errors, deletion, malformed responses and mismatched explicit metadata are not accepted as images', async t => {
  const f = await fixture(t);
  await rejects(
    readEagleVisual({ id: f.id, readJSON: async () => ({ status: 'error', message: '/private/path' }) }),
    'eagle_visual_item_missing'
  );
  f.state.item.id = 'OTHER';
  await rejects(f.read(), 'eagle_visual_item_missing');
  f.state.item.id = f.id;
  f.state.item.isDeleted = true;
  await rejects(f.read(), 'eagle_visual_item_missing');
  f.state.item.isDeleted = false;
  await rejects(f.read({ expectedItem: { ...f.state.item, annotation: 'changed source' } }), 'eagle_visual_changed');
  await rejects(readEagleVisual({ id: '../anything', readJSON: async () => assert.fail('must not call') }), 'eagle_visual_scope');
});

test('raster inspection derives PNG, GIF, JPEG and all WebP dimension headers from bytes and rejects oversized or incomplete images', () => {
  assert.deepEqual(inspectEagleRaster(png), { mime: 'image/png', width: 1, height: 1 });
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  assert.deepEqual(inspectEagleRaster(gif), { mime: 'image/gif', width: 1, height: 1 });
  const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 10, 0, 20, 1, 1, 0x11, 0, 0xff, 0xd9]);
  assert.deepEqual(inspectEagleRaster(jpegHeader), { mime: 'image/jpeg', width: 20, height: 10 });
  const webp = (type, payload) => {
    const header = Buffer.alloc(20);
    header.write('RIFF');
    header.writeUInt32LE(12 + payload.length + (payload.length % 2), 4);
    header.write('WEBP', 8);
    header.write(type, 12);
    header.writeUInt32LE(payload.length, 16);
    return Buffer.concat([header, payload, Buffer.alloc(payload.length % 2)]);
  };
  assert.deepEqual(inspectEagleRaster(webp('VP8L', Buffer.from([0x2f, 0, 0, 0, 0]))), { mime: 'image/webp', width: 1, height: 1 });
  assert.deepEqual(inspectEagleRaster(webp('VP8 ', Buffer.from([0, 0, 0, 0x9d, 1, 0x2a, 20, 0, 10, 0]))), {
    mime: 'image/webp',
    width: 20,
    height: 10
  });
  const extended = Buffer.alloc(10);
  extended.writeUIntLE(19, 4, 3);
  extended.writeUIntLE(9, 7, 3);
  assert.deepEqual(inspectEagleRaster(webp('VP8X', extended)), { mime: 'image/webp', width: 20, height: 10 });
  const huge = Buffer.from(png);
  huge.writeUInt32BE(10000, 16);
  huge.writeUInt32BE(10000, 20);
  assert.throws(
    () => inspectEagleRaster(huge),
    error => error.code === 'eagle_visual_dimensions'
  );
  for (const invalid of [png.subarray(0, -1), gif.subarray(0, -1), jpegHeader.subarray(0, -1), Buffer.from('<svg/>')])
    assert.throws(() => inspectEagleRaster(invalid));
});
