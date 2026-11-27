import { DatabaseSync } from 'node:sqlite'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  openSync,
  closeSync,
  constants,
  fstatSync,
  realpathSync,
  renameSync,
  unlinkSync,
  fsyncSync,
} from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'

export const opaque = () => randomBytes(32).toString('base64url')
export const digest = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex')
function readPrivate(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const file = fstatSync(fd)
    if (
      !file.isFile() ||
      file.nlink !== 1 ||
      (file.mode & 0o077) !== 0 ||
      (process.getuid && file.uid !== process.getuid())
    )
      throw Error('Vault key files must be private regular files owned by the broker')
    return readFileSync(fd, 'utf8').trim()
  } finally {
    closeSync(fd)
  }
}
function persistent(path: string, create: () => string) {
  try {
    writeFileSync(path, create(), { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return readPrivate(path)
}
function encrypt(key: Buffer, data: Buffer, aad: string) {
  const iv = randomBytes(12),
    c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(aad))
  return Buffer.concat([iv, c.update(data), c.final(), c.getAuthTag()]).toString('base64')
}
function decrypt(key: Buffer, str: string, aad: string) {
  const b = Buffer.from(str, 'base64'),
    d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12))
  d.setAAD(Buffer.from(aad))
  d.setAuthTag(b.subarray(-16))
  return Buffer.concat([d.update(b.subarray(12, -16)), d.final()])
}
const wrapPrefix = 'openpassword-wrapped-v1:'
const wrapContext = 'openpassword/master-key/v1'
function hexKey(material: string) {
  if (!/^[0-9a-f]{64}$/i.test(material)) throw Error('Expected a 256-bit hexadecimal key')
  return Buffer.from(material, 'hex')
}
function wrappingKey(dir: string, path: string) {
  if (!isAbsolute(path)) throw Error('Wrapping key path must be absolute')
  const location = relative(realpathSync(dir), realpathSync(path))
  if (!location.startsWith('..' + sep))
    throw Error('Keep the wrapping key outside the vault directory')
  return hexKey(readPrivate(path))
}
function unlockMaster(material: string, external?: Buffer) {
  if (material.startsWith(wrapPrefix)) {
    if (!external) throw Error('Wrapped vault requires OPENPASSWORD_WRAPPING_KEY_FILE')
    const key = decrypt(external, material.slice(wrapPrefix.length), wrapContext)
    if (key.length !== 32) throw Error('Invalid wrapped key')
    return key
  }
  if (external) throw Error('Wrap the existing master key before enabling the wrapping key')
  return hexKey(material)
}
// Called offline, under the broker identity. The wrapped key is durable before the rename.
export function wrapExistingMaster(dir: string, path: string) {
  const file = join(dir, 'master.key')
  const external = wrappingKey(dir, path)
  const material = readPrivate(file)
  if (material.startsWith(wrapPrefix)) {
    unlockMaster(material, external)
    return
  }
  writeWrappedMaster(dir, hexKey(material), external)
}
function writeWrappedMaster(dir: string, master: Buffer, external: Buffer) {
  const file = join(dir, 'master.key')
  const wrapped = wrapPrefix + encrypt(external, master, wrapContext)
  const tmp = file + '.' + opaque()
  try {
    writeFileSync(tmp, wrapped, { mode: 0o600, flag: 'wx', flush: true })
    renameSync(tmp, file)
    const fd = openSync(dir, constants.O_RDONLY)
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp)
  }
}
// Offline rotation. A retry after the atomic rename recognizes the new envelope.
export function rotateWrappingKey(dir: string, previous: string, next: string) {
  const oldKey = wrappingKey(dir, previous),
    newKey = wrappingKey(dir, next)
  if (oldKey.equals(newKey)) throw Error('Choose a different wrapping key')
  const material = readPrivate(join(dir, 'master.key'))
  if (!material.startsWith(wrapPrefix)) throw Error('Wrap the master key before rotation')
  try {
    unlockMaster(material, newKey)
    return
  } catch {
    /* still wrapped with the previous key */
  }
  writeWrappedMaster(dir, unlockMaster(material, oldKey), newKey)
  unlockMaster(readPrivate(join(dir, 'master.key')), newKey)
}
export function store(dir: string, wrappingFile = process.env.OPENPASSWORD_WRAPPING_KEY_FILE) {
  const policy = process.env.OPENPASSWORD_REQUIRE_WRAPPED_MASTER
  if (policy !== undefined && !['0', '1'].includes(policy))
    throw Error('OPENPASSWORD_REQUIRE_WRAPPED_MASTER must be 0 or 1')
  if (policy === '1' && !wrappingFile)
    throw Error('Gateway custody policy requires an external wrapping key file')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (existsSync(join(dir, 'vault.sqlite')) && !existsSync(join(dir, 'master.key')))
    throw Error('Restore master.key before opening the vault')
  const external = wrappingFile ? wrappingKey(dir, wrappingFile) : undefined
  const material = persistent(join(dir, 'master.key'), () => {
    const fresh = randomBytes(32)
    return external ? wrapPrefix + encrypt(external, fresh, wrapContext) : fresh.toString('hex')
  })
  const key = unlockMaster(material, external)
  const operatorToken = persistent(join(dir, 'operator.token'), opaque)
  if (!/^[a-zA-Z0-9_-]{43}$/.test(operatorToken)) throw Error('Invalid operator token')
  const admin = digest(operatorToken)
  const db = new DatabaseSync(join(dir, 'vault.sqlite'))
  db.exec(`
    PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, label TEXT NOT NULL);
    INSERT OR IGNORE INTO workspaces VALUES('default','My workspace');
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, tenant TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY, tenant TEXT NOT NULL,provider TEXT NOT NULL,label TEXT NOT NULL,identity TEXT NOT NULL,revision INTEGER NOT NULL,secret TEXT NOT NULL,active INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS connections_tenant ON connections(tenant);
    CREATE TABLE IF NOT EXISTS pairs(id TEXT PRIMARY KEY,code TEXT UNIQUE,user_code TEXT UNIQUE,label TEXT,expires INTEGER, grant_id TEXT);
    CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY,tenant TEXT,label TEXT,connection_id TEXT,ops TEXT,expires INTEGER,access TEXT UNIQUE,refresh TEXT UNIQUE,access_until INTEGER,active INTEGER);
    CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,tenant TEXT,actor TEXT,conn TEXT,op TEXT,idem TEXT,hash TEXT,revision INTEGER,state TEXT,preview TEXT,outcome TEXT,created INTEGER, UNIQUE(actor,conn,idem));
    CREATE INDEX IF NOT EXISTS runs_pending ON runs(tenant,state,created);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,tenant TEXT,action TEXT,subject TEXT,at INTEGER);
    CREATE INDEX IF NOT EXISTS events_tenant ON events(tenant,id);
  `)
  function seal(value: unknown, context: string) {
    const dek = randomBytes(32)
    return (
      encrypt(key, dek, 'key/' + context) +
      '.' +
      encrypt(dek, Buffer.from(JSON.stringify(value)), 'value/' + context)
    )
  }
  function open(str: string, context: string) {
    const [wrapped, data] = str.split('.')
    return JSON.parse(
      decrypt(decrypt(key, wrapped, 'key/' + context), data, 'value/' + context).toString(),
    )
  }
  return { db, admin, seal, open }
}
