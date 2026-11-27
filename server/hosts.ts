import { Refusal } from './refusal.ts'
import { createPublicKey, randomUUID, verify } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { digest, opaque } from './store.ts'

type Principal = { tenant: string; role: string }
export function hosts(
  api: FastifyInstance,
  db: DatabaseSync,
  origin: string,
  session: (r: FastifyRequest) => Principal,
  event: (tenant: string, action: string, id: string) => void,
  initializePolicy: boolean,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS cli_hosts(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,label TEXT NOT NULL,ticket TEXT UNIQUE,expires INTEGER NOT NULL,pub TEXT,revoked INTEGER DEFAULT 0);
    CREATE INDEX IF NOT EXISTS hosts_workspace ON cli_hosts(tenant);
    CREATE TABLE IF NOT EXISTS host_pairs(pair TEXT PRIMARY KEY REFERENCES pairs(id) ON DELETE CASCADE,host TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS host_grants(grant_id TEXT PRIMARY KEY,host TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS host_nonces(host TEXT,nonce TEXT,expires INTEGER,PRIMARY KEY(host,nonce));
    CREATE INDEX IF NOT EXISTS nonce_expiry ON host_nonces(expires);`)
  db.exec(
    'CREATE TABLE IF NOT EXISTS standalone_workspaces(tenant TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS host_policy(version INTEGER PRIMARY KEY)',
  )
  if (initializePolicy) {
    db.exec(`BEGIN IMMEDIATE;
      INSERT OR IGNORE INTO standalone_workspaces SELECT DISTINCT tenant FROM grants WHERE NOT EXISTS(SELECT 1 FROM host_policy);
      INSERT OR IGNORE INTO host_policy VALUES(1); COMMIT;`)
  }
  const initialized = !!db.prepare('SELECT 1 FROM host_policy').get()
  function deny(): never {
    throw new Refusal(403, 'Approved host required')
  }
  api.post('/admin/hosts', async (r) => {
    const s = session(r)
    if (s.role !== 'owner') deny()
    const { label } = z.object({ label: z.string().trim().min(1).max(100) }).parse(r.body)
    const ticket = opaque(),
      id = randomUUID()
    db.prepare('INSERT INTO cli_hosts(id,tenant,label,ticket,expires) VALUES(?,?,?,?,?)').run(
      id,
      s.tenant,
      label,
      digest(ticket),
      Date.now() + 600000,
    )
    event(s.tenant, 'Host enrollment issued', id)
    return { id, ticket: id + '.' + ticket }
  })
  api.delete('/admin/hosts/:id', async (r) => {
    const s = session(r)
    if (s.role !== 'owner') deny()
    const { id } = z.object({ id: z.string().uuid() }).parse(r.params)
    if (
      !db
        .prepare('UPDATE cli_hosts SET revoked=1,ticket=NULL WHERE id=? AND tenant=? AND revoked=0')
        .run(id, s.tenant).changes
    )
      deny()
    event(s.tenant, 'Host revoked', id)
    return { ok: true }
  })
  api.post('/v1/hosts/enroll', async (r) => {
    const b = z
      .object({
        ticket: z.string().regex(/^[a-f0-9-]{36}\.[\w-]{43}$/),
        key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      })
      .parse(r.body)
    const host = db
      .prepare(
        'UPDATE cli_hosts SET ticket=NULL,pub=? WHERE id=? AND ticket=? AND expires>? AND revoked=0 RETURNING id,tenant',
      )
      .get(b.key, b.ticket.slice(0, 36), digest(b.ticket.slice(37)), Date.now())
    if (!host) deny()
    event(String(host.tenant), 'Host connected', String(host.id))
    return { id: host.id }
  })
  const verified = new WeakMap<FastifyRequest, string>()
  let cleanup = 0
  function identity(r: FastifyRequest) {
    const proof = r.headers['openpassword-host']
    if (!proof) return undefined
    if (typeof proof !== 'string' || proof.length > 300) deny()
    const [id, time, nonce, sig, ...rest] = proof.split('.')
    const row = db
      .prepare(
        'SELECT id,label,pub,tenant FROM cli_hosts WHERE id=? AND revoked=0 AND pub IS NOT NULL',
      )
      .get(id)
    if (!row) deny()
    if (verified.get(r) === id) return row
    if (
      rest.length ||
      !/^\d{13}$/.test(time) ||
      Math.abs(Date.now() - Number(time)) > 60000 ||
      !/^[\w-]{22}$/.test(nonce) ||
      !/^[\w-]{86}$/.test(sig)
    )
      deny()
    const body =
      r.body === undefined ? '' : Buffer.isBuffer(r.body) ? r.body : JSON.stringify(r.body)
    const fingerprint = digest(
      JSON.stringify([
        origin,
        r.method,
        r.url,
        digest(r.headers.authorization || ''),
        digest(body),
      ]),
    )
    const key = createPublicKey({
      format: 'jwk',
      key: { kty: 'OKP', crv: 'Ed25519', x: String(row.pub) },
    })
    if (
      !verify(
        null,
        Buffer.from(['OpenPassword.host.1', id, time, nonce, fingerprint].join('.')),
        key,
        Buffer.from(sig, 'base64url'),
      )
    )
      deny()
    if (Date.now() > cleanup) {
      db.prepare('DELETE FROM host_nonces WHERE expires<?').run(Date.now())
      cleanup = Date.now() + 30000
    }
    if (
      !db
        .prepare('INSERT OR IGNORE INTO host_nonces VALUES(?,?,?)')
        .run(id, nonce, Number(time) + 60001).changes
    )
      deny()
    verified.set(r, id)
    return row
  }
  api.get('/v1/hosts/self', async (r) => {
    const host = identity(r)
    if (!host) deny()
    return { host_id: host.id, label: host.label, workspace: host.tenant }
  })
  function bound(r: FastifyRequest, grant: string, tenant: string) {
    const link = db.prepare('SELECT host FROM host_grants WHERE grant_id=?').get(grant)
    if (link && identity(r)?.id !== link.host) deny()
    if (!link && (managed(tenant) || r.headers['openpassword-host'])) deny()
  }
  function managed(t: string) {
    if (initialized && !db.prepare('SELECT 1 FROM standalone_workspaces WHERE tenant=?').get(t))
      return true
    return !!db.prepare('SELECT 1 FROM cli_hosts WHERE tenant=? AND pub IS NOT NULL LIMIT 1').get(t)
  }
  return { identity, bound, managed }
}
