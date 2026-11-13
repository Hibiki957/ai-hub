import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function fail(message, status = 400, code = 'invalid_request') {
  return Object.assign(new Error(message), { status, code });
}
export function text(value, name, max = 12000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail(`${name}不能为空，且不能超过 ${max} 字。`);
  return value.trim();
}

// Sidecar data only. Projects, issues, steps and execution history remain in Paperclip.
export class Store {
  constructor(path, encryptionKey) {
    const key = Buffer.from(encryptionKey || '', 'base64');
    if (key.length !== 32) throw fail('HUB_ENCRYPTION_KEY 必须是 32 字节的 base64 编码。', 500);
    this.key = key;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS counters (id TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT OR IGNORE INTO counters VALUES ('revision',0);`);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  get revision() {
    return this.db.prepare("SELECT value FROM counters WHERE id='revision'").get().value;
  }
  list(kind) {
    return this.db
      .prepare('SELECT value FROM records WHERE kind=? ORDER BY rowid')
      .all(kind)
      .map(row => JSON.parse(row.value));
  }
  get(kind, id) {
    const row = this.db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get(kind, id);
    return row ? JSON.parse(row.value) : null;
  }
  put(kind, value) {
    const record = { ...value, id: value.id || randomUUID(), updatedAt: new Date().toISOString() };
    record.createdAt ||= record.updatedAt;
    this.db
      .prepare('INSERT INTO records VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value')
      .run(kind, record.id, JSON.stringify(record));
    this.db.prepare("UPDATE counters SET value=value+1 WHERE id='revision'").run();
    return record;
  }
  remove(kind, id) {
    this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id);
    this.db.prepare("UPDATE counters SET value=value+1 WHERE id='revision'").run();
  }
  audit(command, actor = 'user', result = {}) {
    const event = { id: randomUUID(), command, type: command.type, actor, createdAt: new Date().toISOString(), result };
    const row = this.db.prepare('INSERT INTO audit(value) VALUES(?)').run(JSON.stringify(event));
    return { ...event, sequence: Number(row.lastInsertRowid) };
  }
  events() {
    return this.db
      .prepare('SELECT sequence,value FROM audit ORDER BY sequence DESC LIMIT 500')
      .all()
      .reverse()
      .map(row => ({ ...JSON.parse(row.value), sequence: row.sequence }));
  }
  begin(id, fingerprint) {
    text(id, '幂等键', 160);
    const prior = this.db.prepare('SELECT * FROM receipts WHERE id=?').get(id);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw fail('同一个幂等键不能用于不同操作。', 409, 'idempotency_conflict');
      if (prior.state !== 'committed') throw fail('该操作的上次结果尚未确认。请先刷新核对，避免重复执行。', 409, 'operation_uncertain');
      return { replay: true, result: JSON.parse(prior.result) };
    }
    this.db.prepare('INSERT INTO receipts VALUES(?,?,?,NULL)').run(id, fingerprint, 'started');
    return { replay: false };
  }
  commit(id, result) {
    this.db.prepare("UPDATE receipts SET state='committed',result=? WHERE id=?").run(JSON.stringify(result), id);
  }
  abandon(id) {
    this.db.prepare("DELETE FROM receipts WHERE id=? AND state='started'").run(id);
  }
  seal(value) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const content = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), content]).toString('base64');
  }
  unseal(value) {
    const b = Buffer.from(value, 'base64'),
      cipher = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
    cipher.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString('utf8');
  }
  close() {
    this.db.close();
  }
}
