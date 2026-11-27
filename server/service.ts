import { engines, claimEngineOwner } from './engines.ts'
import { isIP } from 'node:net'
import { httpContract } from './http-contract.ts'
import { personalVault } from './personal-vault.ts'
import { hosts } from './hosts.ts'
import releasePackage from '../package.json' with { type: 'json' }
import { activity } from './activity.ts'
import { consoleAuth } from './console-auth.ts'
import { issueFiles, issueFolder, bundleOperation } from './issue-files.ts'
import { templatePlan, writeTemplate } from './template.ts'
import { templateOps } from './template-preview.ts'
import { approvalSnapshot, snapshotDigest } from './snapshot.ts'
import { inbound } from './inbound.ts'
import { batchView } from './batch-view.ts'
import { loopsPacer } from './loops-pacing.ts'
import { billing, StreamUsage } from './billing.ts'
import { keymaster } from './keymaster.ts'
import { delegation } from './delegation.ts'
import { scopedToken } from './provider-auth.ts'
import { consumption } from './consumption.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { intakeKeys, envelope } from './intake.ts'
import { batches } from './batches.ts'
import { sourceOperation, readSource, ReadFailure } from './read-source.ts'
import { project } from './projections.ts'
import { uploadRequest } from './youtube.ts'
import { gmailPage, GmailError } from './gmail.ts'
import { Readable } from 'node:stream'
import { modelLease, chat } from './models.ts'
import { authorize, exchange, oauthConfig, notionAuthorize, notionToken } from './oauth.ts'
import Fastify, { type FastifyRequest } from 'fastify'
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { buildRequest, providers as builtins, sheetsResult } from '../packages/connectors/index.ts'
import { connectionInput, invocation, name } from '../packages/schemas/index.ts'
import { store, digest, opaque } from './store.ts'

const fail = (statusCode: number, message: string): never => {
  throw Object.assign(Error(message), { statusCode })
}
const now = () => Date.now(),
  iso = (n: number) => new Date(n).toISOString()
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  )
type Row = Record<string, any>
function connectorRevision(provider: string, op: string) {
  if (sourceOperation(op)) return provider + '.sources@1'
  if (provider === 'google_sheets') return 'google.sheets@1'
  if (['google.gmail.messages.read_page', 'google.gmail.labels.list'].includes(op))
    return 'google.gmail.newsroom@1'
  if (op.startsWith('hubspot.newsletter.') || op === bundleOperation) return 'hubspot.newsroom@5'
  if (op.startsWith('kit.newsletter.') || op === 'kit.subscribers.read_page')
    return 'kit.newsroom@3'
  if (op.startsWith('loops.newsletter.') || op.startsWith('loops.contacts.'))
    return 'loops.newsroom@2'
  if (op === 'bluesky.post.create') return 'bluesky.post@1'
  if (op.startsWith('threads.container.')) return 'threads.post@1'
  if (op.startsWith('revolut.business.')) return 'revolut-business-read@1'
  if (op.endsWith('.upload_session.create')) return 'google.youtube@1'
  return '1'
}
// OPENPASSWORD_TRUST_PROXY: comma-separated IP addresses or CIDR ranges of reverse proxies whose X-Forwarded-For is
// believed (for example 127.0.0.1). Unset means no proxy is trusted. Wildcards, hop counts and any range that
// would trust the whole internet are refused, so a typo cannot let a client choose its own address.
export function trustedProxies(value: string | undefined) {
  if (value === undefined || value.trim() === '') return undefined
  const list = value.split(',').map((x) => x.trim())
  for (const entry of list) {
    const [addr, bits, ...rest] = entry.split('/')
    const family = isIP(addr)
    const limit = family === 4 ? 32 : 128
    if (
      !family ||
      rest.length ||
      (bits !== undefined && (!/^[0-9]{1,3}$/.test(bits) || Number(bits) > limit)) ||
      (bits !== undefined && Number(bits) < 8)
    )
      throw Error(
        'OPENPASSWORD_TRUST_PROXY must list proxy IP addresses or CIDR ranges of at least 8 bits',
      )
  }
  return list
}
export function grantRate(value: string | undefined) {
  if (value === undefined) return 600
  if (!/^[0-9]{1,9}$/.test(value.trim()) || value !== value.trim())
    throw Error(
      'OPENPASSWORD_GRANT_RATE must be a whole number of requests per minute (0 disables it)',
    )
  const rate = Number(value)
  if (rate === 0)
    console.warn('OPENPASSWORD_GRANT_RATE=0: the per-grant request ceiling is disabled')
  return rate
}
export type Limits = { engineBin?: string; trustProxy?: string; grantPerMinute?: number }
export function service(
  dir: string,
  origin = 'http://localhost:3000',
  transport: typeof fetch = fetch,
  relay = process.env.OPENPASSWORD_YOUTUBE_RELAY === '1',
  initializeHostPolicy = false,
  limits: Limits = {},
) {
  const owner = limits.engineBin ? claimEngineOwner(dir) : undefined
  try {
    return createService(dir, origin, transport, relay, initializeHostPolicy, limits, owner)
  } catch (error) {
    owner?.close()
    throw error
  }
}
function createService(
  dir: string,
  origin = 'http://localhost:3000',
  transport: typeof fetch = fetch,
  relay = process.env.OPENPASSWORD_YOUTUBE_RELAY === '1',
  initializeHostPolicy = false,
  limits: Limits,
  owner: ReturnType<typeof claimEngineOwner> | undefined,
) {
  // The per-grant ceiling counts authenticated /v1 requests per grant per minute (default 600; 0 turns it off).
  // An empty or blank OPENPASSWORD_GRANT_RATE is refused: only an explicit 0 turns the ceiling off, and it says so.
  const grantPerMinute = limits.grantPerMinute ?? grantRate(process.env.OPENPASSWORD_GRANT_RATE)
  if (!Number.isSafeInteger(grantPerMinute) || grantPerMinute < 0)
    throw Error(
      'OPENPASSWORD_GRANT_RATE must be a whole number of requests per minute (0 disables it)',
    )
  const proxies = trustedProxies(limits.trustProxy ?? process.env.OPENPASSWORD_TRUST_PROXY)
  const web = new URL(origin)
  if (
    web.origin !== origin ||
    !(
      web.protocol === 'https:' ||
      (web.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(web.hostname))
    )
  )
    throw Error('Set OPENPASSWORD_WEB_ORIGIN to the HTTPS console origin or a loopback HTTP origin')
  const remote = process.env.OPENPASSWORD_MODEL_CUSTODIAN_ORIGIN
  const providers = { ...builtins }
  if (remote) {
    const url = new URL(remote)
    if (url.protocol !== 'https:' || url.origin !== remote || remote === origin)
      throw Error('Use a distinct HTTPS origin for the model custodian')
  }
  const api = Fastify({
    bodyLimit: 65536,
    routerOptions: { maxParamLength: 200 },
    ...(proxies ? { trustProxy: proxies } : {}),
  })
  const { db, admin, seal, open } = store(dir)
  db.exec(
    'CREATE TABLE IF NOT EXISTS model_custodians(connection TEXT PRIMARY KEY, origin TEXT NOT NULL)',
  )
  if (remote || db.prepare('SELECT 1 FROM model_custodians LIMIT 1').get()) {
    providers.remote_gateway = {
      name: 'Separate OpenPassword gateway (scoped access token)',
      group: 'Model providers',
      origin: remote ? remote + '/v1' : '',
      actions: [
        {
          id: 'remote_gateway.chat',
          method: 'POST',
          path: '/chat/completions',
          query: [],
          body: [],
          required: [],
        },
      ],
    }
  }
  db.exec(
    'CREATE TABLE IF NOT EXISTS loops_created(conn TEXT,revision INTEGER,kind TEXT,remote TEXT,child TEXT,until INTEGER,PRIMARY KEY(conn,revision,kind,remote));',
  )
  db.exec(
    'CREATE TABLE IF NOT EXISTS threads_publications(creation TEXT PRIMARY KEY,execution TEXT NOT NULL)',
  )
  const usageLedger = consumption(db, transport)
  const send = usageLedger.send
  api.addHook('onRequest', (_r, _reply, next) => usageLedger.scope(next))
  function attribute(g: Row, c: Row, operation: string, execution?: string, model?: string) {
    usageLedger.attribute({
      tenant: g.tenant,
      conn: c.id,
      label: c.label,
      provider: c.provider,
      revision: c.revision,
      grantId: g.id,
      agentLabel: g.label,
      profile: get('SELECT profile FROM grant_issuers WHERE grant_id=?', g.id)?.profile ?? 'owner',
      operation,
      execution,
      model,
    })
  }
  api.get('/admin/consumption', async (r) => {
    const s = session(r)
    return usageLedger.report(s.tenant, profileId(s), s.role === 'owner', r.query)
  })
  const issues = issueFiles(db, seal, open)
  const meter = billing(db)
  db.exec(
    "CREATE TABLE IF NOT EXISTS model_adjustments(execution TEXT PRIMARY KEY,evidence TEXT,at INTEGER); UPDATE model_charges SET state='held' WHERE state='reserved'",
  )
  const pacedLoops = loopsPacer(send)
  const batch = batches(db, origin, pacedLoops, seal)
  const get = (sql: string, ...p: (string | number)[]) =>
    db.prepare(sql).get(...p) as Row | undefined
  const all = (sql: string, ...p: (string | number)[]) => db.prepare(sql).all(...p) as Row[]
  const run = (sql: string, ...p: (string | number | null)[]) => db.prepare(sql).run(...p)
  if (!all('PRAGMA table_info(events)').some((x) => x.name === 'actor'))
    db.exec("ALTER TABLE events ADD COLUMN actor TEXT NOT NULL DEFAULT 'system'")
  const auditContext = new AsyncLocalStorage<{ actor: string }>()
  api.addHook('onRequest', (_r, _reply, next) => auditContext.run({ actor: 'system' }, next))
  const actor = (id: string) => {
    const current = auditContext.getStore()
    if (current) current.actor = id
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS cli_connected ON events(tenant,subject,at) WHERE action='CLI connected'",
  )
  const feed = activity(db, !!limits.engineBin)
  let infrastructure: ReturnType<typeof engines> | undefined
  let draining = false
  let inFlight = 0
  api.decorate('beginDrain', () => {
    draining = true
    feed.wakeAll()
  })
  api.addHook('onRequest', async (r, reply) => {
    if (r.url.split('?')[0] === '/health') return
    if (draining)
      return reply
        .code(503)
        .header('Retry-After', '1')
        .header('OpenPassword-Protocol-Version', '1')
        .send({ detail: 'Broker is updating' })
    inFlight++
    const finish = () => {
      reply.raw.off('close', finish)
      reply.raw.off('finish', finish)
      inFlight--
    }
    reply.raw.once('finish', finish)
    reply.raw.once('close', finish)
  })
  const event = (t: string, action: string, id: string) => {
    const by = auditContext.getStore()?.actor || 'system'
    run(
      'INSERT INTO events(tenant,action,subject,at,actor) VALUES(?,?,?,?,?)',
      t,
      action,
      id,
      now(),
      by,
    )
    if (!limits.engineBin) queueMicrotask(() => feed.signal(t, by))
  }
  function tx<T>(fn: () => T) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      db.exec('COMMIT')
      return value
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY,tenant TEXT,label TEXT,role TEXT,token TEXT UNIQUE,active INTEGER);
    CREATE TABLE IF NOT EXISTS session_members(session TEXT PRIMARY KEY,member TEXT);
    CREATE TABLE IF NOT EXISTS operation_stops(tenant TEXT,op TEXT,PRIMARY KEY(tenant,op));
    CREATE TABLE IF NOT EXISTS provider_stops(tenant TEXT,provider TEXT,PRIMARY KEY(tenant,provider));
    CREATE TABLE IF NOT EXISTS stops(tenant TEXT PRIMARY KEY,paused INTEGER)`)
  function session(r: FastifyRequest) {
    const cookie = (r.headers.cookie || '')
      .split(/;\s*/)
      .find((x) => x.startsWith('op_session='))
      ?.slice(11)
    const s =
      get('SELECT * FROM sessions WHERE token=? AND expires>?', digest(cookie || ''), now()) ??
      fail(401, 'Unlock your workspace')
    const member = get(
      'SELECT m.* FROM members m JOIN session_members sm ON m.id=sm.member WHERE sm.session=?',
      s.token,
    )
    if (member && (!member.active || member.tenant !== s.tenant)) fail(401, 'Membership revoked')
    if (
      member?.role === 'viewer' &&
      r.method !== 'GET' &&
      !['/admin/logout', '/delegate/confirm'].includes(r.url) &&
      !/^\/admin\/(intake|connections(?:\/[^/?]+(?:\/(?:sharing|rotate|oauth-refresh))?)?|grants(?:\/[^/?]+)?|approvals\/[^/?]+|oauth\/(google|notion))$/.test(
        r.url,
      ) &&
      !r.url.startsWith('/profile/') &&
      !/^\/auth\/(apple|github|google)\/(start|callback)(\?|$)/.test(r.url)
    )
      fail(403, 'Workspace editor required')
    actor(member?.id || 'owner')
    return {
      ...s,
      tenant: s.tenant,
      token: s.token,
      role: member?.role || 'owner',
      member: member?.id || null,
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS credential_ownership(conn TEXT PRIMARY KEY,owner TEXT NOT NULL,visibility TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS credential_shares(conn TEXT,profile TEXT,PRIMARY KEY(conn,profile));
    CREATE TABLE IF NOT EXISTS grant_issuers(grant_id TEXT PRIMARY KEY,profile TEXT NOT NULL);
    INSERT OR IGNORE INTO credential_ownership SELECT id,'org','organization' FROM connections;`)
  db.exec(
    'CREATE TABLE IF NOT EXISTS credential_deadlines(conn TEXT, target TEXT, expires INTEGER NOT NULL, PRIMARY KEY(conn,target))',
  )
  const deadlineSchema = z.number().int().positive().max(8640000000000000).nullable()
  function deadline(c: string, target: string): number | null {
    return (
      get('SELECT expires FROM credential_deadlines WHERE conn=? AND target=?', c, target)
        ?.expires ?? null
    )
  }
  function setDeadline(c: string, target: string, value: number | null | undefined) {
    if (value === undefined) return
    if (value === null) run('DELETE FROM credential_deadlines WHERE conn=? AND target=?', c, target)
    else run('INSERT OR REPLACE INTO credential_deadlines VALUES(?,?,?)', c, target, value)
  }
  function accessDeadline(c: string, profile: string) {
    const a = ownership(c),
      manager = a.owner === profile || (a.owner === 'org' && profile === 'owner')
    return Math.min(
      deadline(c, 'credential') ?? Infinity,
      manager
        ? Infinity
        : (deadline(c, a.visibility === 'organization' ? 'organization' : 'user/' + profile) ??
            Infinity),
    )
  }
  type Principal = ReturnType<typeof session>
  const profileId = (s: Principal): string => s.member || 'owner'
  function ownership(c: string) {
    return (
      get('SELECT * FROM credential_ownership WHERE conn=?', c) ??
      fail(404, 'Connection unavailable')
    )
  }
  function manages(s: Principal, c: string) {
    const a = ownership(c)
    return a.owner === 'org' ? s.role === 'owner' : a.owner === profileId(s)
  }
  function available(c: string, profile: string) {
    const a = ownership(c)
    if (accessDeadline(c, profile) <= now()) return false
    if (
      a.owner !== 'org' &&
      a.owner !== 'owner' &&
      !get('SELECT id FROM members WHERE id=? AND active=1', a.owner)
    )
      return false
    return (
      a.owner === profile ||
      a.visibility === 'organization' ||
      !!get('SELECT 1 FROM credential_shares WHERE conn=? AND profile=?', c, profile)
    )
  }
  function own(r: FastifyRequest, c: string) {
    const s = session(r)
    conn(s.tenant, c)
    if (!manages(s, c)) fail(403, 'Credential owner required')
  }
  function recordOwner(s: Principal, c: string, scope?: string, expires?: number | null) {
    setDeadline(c, 'credential', expires)
    const org = (scope ?? (s.member ? 'personal' : 'organization')) === 'organization'
    if (org && s.role !== 'owner')
      fail(403, 'Only the administrator can add organization credentials')
    run(
      'INSERT INTO credential_ownership VALUES(?,?,?)',
      c,
      org ? 'org' : profileId(s),
      org ? 'organization' : 'private',
    )
  }
  function deviceIdentity(g: Row, c: Row) {
    const issuer =
      get('SELECT profile FROM grant_issuers WHERE grant_id=?', g.id)?.profile ?? 'owner'
    const owner = ownership(c.id).owner
    return issuer === owner || (owner === 'org' && issuer === 'owner') ? c.identity : c.id
  }
  function grantManager(s: Principal, g: Row) {
    return (
      manages(s, g.connection_id) ||
      (get('SELECT profile FROM grant_issuers WHERE grant_id=?', g.id)?.profile ?? 'owner') ===
        profileId(s)
    )
  }
  api.post('/admin/connections/:id/sharing', async (r) => {
    const s = session(r),
      c = id(r)
    own(r, c)
    const b = z
      .object({
        label: name,
        visibility: z.enum(['private', 'specific', 'organization']),
        recipients: z.array(name).max(100),
        expires_at: deadlineSchema.optional(),
        organization_expires_at: deadlineSchema.optional(),
        recipient_expiries: z.record(name, deadlineSchema).optional(),
      })
      .parse(r.body)
    if (ownership(c).owner === 'org' && b.visibility !== 'organization')
      fail(422, 'Organization credentials are available to the whole workspace')
    return tx(() => {
      setDeadline(c, 'credential', b.expires_at)
      setDeadline(
        c,
        'organization',
        b.visibility === 'organization' ? b.organization_expires_at : null,
      )
      for (const x of all('SELECT profile FROM credential_shares WHERE conn=?', c))
        if (b.visibility !== 'specific' || !b.recipients.includes(x.profile))
          setDeadline(c, 'user/' + x.profile, null)
      run('DELETE FROM credential_shares WHERE conn=?', c)
      if (b.visibility === 'specific')
        for (const p of new Set(b.recipients)) {
          if (
            p !== 'owner' &&
            !get('SELECT id FROM members WHERE tenant=? AND active=1 AND id=?', s.tenant, p)
          )
            fail(422, 'Select an active workspace member')
          setDeadline(c, 'user/' + p, b.recipient_expiries?.[p])
          run('INSERT INTO credential_shares VALUES(?,?)', c, p)
        }
      run('UPDATE credential_ownership SET visibility=? WHERE conn=?', b.visibility, c)
      run('UPDATE connections SET label=? WHERE id=?', b.label, c)
      for (const g of all(
        "SELECT g.id,COALESCE(i.profile,'owner') AS profile FROM grants g LEFT JOIN grant_issuers i ON g.id=i.grant_id WHERE connection_id=? AND active=1",
        c,
      ))
        if (!available(c, g.profile)) run('UPDATE grants SET active=0 WHERE id=?', g.id)
        else {
          const limit = accessDeadline(c, g.profile)
          if (Number.isFinite(limit))
            run(
              'UPDATE grants SET expires=min(expires,?),access_until=min(access_until,?) WHERE id=?',
              limit,
              limit,
              g.id,
            )
        }
      event(s.tenant, 'Credential sharing updated', c)
      return { ok: true }
    })
  })
  function checkIssuer(g: Row) {
    const issuer =
      get('SELECT profile FROM grant_issuers WHERE grant_id=?', g.id)?.profile ?? 'owner'
    if (
      !available(g.connection_id, issuer) ||
      (issuer !== 'owner' && !get('SELECT id FROM members WHERE id=? AND active=1', issuer))
    )
      fail(401, 'Device access revoked')
  }
  personalVault(api, db, session, event)
  const hostAccess = hosts(api, db, origin, session, event, initializeHostPolicy)
  const grantWindows = new Map<string, { count: number; until: number }>()
  const counted = new WeakSet<FastifyRequest>()
  const swept = new WeakMap<object, number>()
  // Expired windows are dropped so a flood of distinct sources cannot grow the maps without bound.
  function sweep(map: Map<string, { count: number; until: number }>) {
    if (now() < (swept.get(map) ?? 0)) return
    swept.set(map, now() + 30000)
    for (const [k, v] of map) if (v.until <= now()) map.delete(k)
  }
  function countGrant(r: FastifyRequest, id: string) {
    if (!grantPerMinute || counted.has(r)) return
    counted.add(r)
    sweep(grantWindows)
    const row = grantWindows.get(id)
    if (!row || row.until <= now()) grantWindows.set(id, { count: 1, until: now() + 60000 })
    else if (++row.count > grantPerMinute) fail(429, 'Try again in one minute')
  }
  function grant(r: FastifyRequest) {
    if (!/^Bearer [A-Za-z0-9_-]+$/.test(r.headers.authorization || ''))
      fail(401, 'Device bearer required')
    const g =
      get(
        'SELECT * FROM grants WHERE access=? AND active=1 AND access_until>? AND expires>?',
        digest((r.headers.authorization || '').replace(/^Bearer /, '')),
        now(),
        now(),
      ) ?? fail(401, 'Device access expired')
    hostAccess.bound(r, g.id, g.tenant)
    checkIssuer(g)
    countGrant(r, g.id)
    actor(g.id)
    return g
  }
  for (const path of ['/admin/activity', '/v1/activity']) {
    api.get(path, async (r, reply) => {
      const q = z
        .object({
          after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
          wait: z.coerce.number().int().min(0).max(20000).default(20000),
        })
        .parse(r.query)
      const authorize = () => {
        if (path === '/v1/activity') {
          const g = grant(r)
          return { tenant: g.tenant, actor: g.id }
        }
        const s = session(r)
        return { tenant: s.tenant, actor: s.role === 'owner' ? undefined : profileId(s) }
      }
      const stop = new AbortController()
      const disconnect = () => stop.abort()
      reply.raw.once('close', disconnect)
      try {
        return await feed.poll(authorize, q.after, stop.signal, q.wait)
      } finally {
        reply.raw.off('close', disconnect)
      }
    })
  }
  api.get('/v1/openapi.json', async () => httpContract)
  api.get('/v1/whoami', async (r) => {
    const g = grant(r)
    return {
      device_id: g.id,
      host_id: get('SELECT host FROM host_grants WHERE grant_id=?', g.id)?.host ?? null,
      label: g.label,
      workspace: g.tenant,
      connection_id: g.connection_id,
      expires_at: iso(g.expires),
    }
  })
  const id = (r: FastifyRequest) => (r.params as { id: string }).id
  const conn = (t: string, c: string) =>
    get('SELECT * FROM connections WHERE tenant=? AND id=?', t, c) ??
    fail(404, 'Connection unavailable')
  const cookie = (v: string) =>
    'op_session=' +
    v +
    '; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800' +
    (origin.startsWith('https:') ? '; Secure' : '')
  db.exec(
    'CREATE TABLE IF NOT EXISTS read_budgets(conn TEXT PRIMARY KEY,day TEXT,used INTEGER,until INTEGER)',
  )
  const attempts = new Map<string, { count: number; until: number }>()
  api.addHook('onRequest', async (r, reply) => {
    reply.header('OpenPassword-Protocol-Version', '1')
    if (
      r.url.startsWith('/v1/') &&
      !['/v1/openapi.json', '/v1/chat/completions', '/v1/models', '/v1/delegation/check'].includes(
        r.url.split('?')[0],
      )
    ) {
      const names = ['openpassword-protocol-version']
      const values = names.flatMap(
        (key) =>
          r.raw.headersDistinct?.[key] ??
          (r.headers[key] === undefined ? [] : [String(r.headers[key])]),
      )
      const duplicates =
        names.some((key) => (r.raw.headersDistinct?.[key]?.length ?? 0) > 1) ||
        values.some((v) => v.includes(','))
      if (!values.length || duplicates || values.some((v) => v !== '1')) {
        const reason = !values.length
          ? 'header_missing'
          : duplicates
            ? 'header_duplicated'
            : 'version_unsupported'
        return reply.code(426).header('Cache-Control', 'no-store').send({
          code: 'protocol_incompatible',
          reason,
          required: 'OpenPassword-Protocol-Version: 1',
        })
      }
    }
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff')
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(r.method) &&
      r.headers['sec-fetch-site'] === 'cross-site'
    )
      fail(403, 'Cross-site request refused')
    if (r.headers.origin && r.headers.origin !== origin) fail(403, 'Origin refused')
    if (
      !['/v1/youtube/uploads:relay', '/delegate/confirm'].includes(r.url) &&
      !r.url.startsWith('/hooks/') &&
      r.url.split('?')[0] !== '/v1/hubspot/issue-assets' &&
      ['POST', 'PATCH', 'PUT'].includes(r.method) &&
      r.headers['content-type'] &&
      !r.headers['content-type'].startsWith('application/json')
    )
      fail(415, 'Use JSON')
  })
  api.addHook('preHandler', async (r) => {
    if (
      [
        '/admin/login',
        '/auth/password',
        '/auth/passkey/begin',
        '/auth/passkey/finish',
        '/profile/passkeys/begin',
        '/auth/setup',
        '/auth/setup-code',
        '/auth/apple/start',
        '/auth/github/start',
        '/auth/google/start',
        '/v1/vault/deposits',
        '/v1/hosts/enroll',
        '/v1/device/authorizations',
        '/v1/device/token',
        '/v1/delegation/check',
      ].includes(r.url.split('?')[0])
    ) {
      const trusted =
        r.url.startsWith('/v1/device/') && r.headers['openpassword-host']
          ? hostAccess.identity(r)
          : null
      sweep(attempts)
      const k = (trusted ? 'host/' + trusted.id : r.ip) + r.url.split('?')[0],
        row = attempts.get(k)
      if (!row || row.until <= now()) attempts.set(k, { count: 1, until: now() + 60000 })
      else if (++row.count > (trusted ? 2400 : 60)) fail(429, 'Try again in one minute')
    }
  })
  api.setErrorHandler((err: Error & { statusCode?: number }, _r, reply) => {
    const status = err instanceof z.ZodError ? 422 : err.statusCode || 500
    reply.code(status).send({
      detail:
        status >= 500
          ? 'Internal service error'
          : err instanceof z.ZodError
            ? 'Invalid input'
            : err.message,
    })
  })
  api.addHook('onClose', async () => {
    await infrastructure?.close()
    db.close()
    owner?.close()
  })
  keymaster(
    api,
    (r) => ({ tenant: grant(r).tenant }),
    (t) => !!get('SELECT paused FROM stops WHERE tenant=?', t)?.paused,
  )
  delegation(api, db, origin, session, seal, open, event)
  api.get('/health', async () => ({
    status: draining ? 'draining' : infrastructure && !infrastructure.healthy() ? 'starting' : 'ok',
    drain_supported: true,
    in_flight: inFlight,
  }))
  function startSession(reply: import('fastify').FastifyReply, member?: Row) {
    const s = opaque()
    tx(() => {
      run(
        'INSERT INTO sessions VALUES(?,?,?)',
        digest(s),
        member?.tenant || 'default',
        now() + 28800000,
      )
      if (member) run('INSERT INTO session_members VALUES(?,?)', digest(s), member.id)
    })
    reply.header('Set-Cookie', cookie(s))
  }
  const consoleOwner = consoleAuth(api, db, origin, admin, session, startSession, seal, open, send)
  api.post('/admin/login', async (r, reply) => {
    const { token } = z.object({ token: name }).parse(r.body)
    const member =
      !consoleOwner() &&
      !get('SELECT id FROM setup_ticket WHERE id=1') &&
      timingSafeEqual(Buffer.from(digest(token)), Buffer.from(admin))
        ? undefined
        : (get('SELECT * FROM members WHERE token=? AND active=1', digest(token)) ??
          fail(401, 'Invalid access token'))
    startSession(reply, member)
    return { ok: true }
  })
  api.post('/admin/logout', async (r, reply) => {
    run('DELETE FROM sessions WHERE token=?', session(r).token)
    reply.header('Set-Cookie', cookie(''))
    return { ok: true }
  })
  api.post('/admin/workspaces', async (r) => {
    if (session(r).role !== 'owner') fail(403, 'Owner required')
    const { label } = z.object({ label: name }).parse(r.body)
    const w = randomUUID()
    run('INSERT INTO workspaces VALUES(?,?)', w, label)
    return { id: w }
  })
  api.post('/admin/switch', async (r) => {
    const s = session(r),
      w = z.object({ id: name }).parse(r.body).id
    if (s.role !== 'owner') fail(403, 'Owner required')
    if (!get('SELECT id FROM workspaces WHERE id=?', w)) fail(404, 'Unknown workspace')
    run('UPDATE sessions SET tenant=? WHERE token=?', w, s.token)
    return { ok: true }
  })
  db.exec(
    'CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, tenant TEXT, title TEXT, username TEXT, envelope TEXT, updated INTEGER)',
  )
  db.exec('CREATE INDEX IF NOT EXISTS items_directory ON items(tenant,title COLLATE NOCASE,id)')
  db.exec(
    'CREATE TABLE IF NOT EXISTS connection_items(conn TEXT PRIMARY KEY,item TEXT NOT NULL); CREATE INDEX IF NOT EXISTS connection_items_by_item ON connection_items(item)',
  )
  api.get('/admin/items', async (r) => {
    const s = session(r)
    const { q, page } = z
      .object({
        q: z.string().max(256).default(''),
        page: z.coerce.number().int().min(1).max(1000000).default(1),
      })
      .parse(r.query)
    const filter =
      'tenant=? AND (instr(lower(title),lower(?))>0 OR instr(lower(username),lower(?))>0)'
    const params = [s.tenant, q, q]
    const total = get('SELECT count(*) AS n FROM items WHERE ' + filter, ...params)!.n
    const current = Math.min(page, Math.max(1, Math.ceil(total / 30)))
    const rows = all(
      'SELECT id,title,username,updated FROM items WHERE ' +
        filter +
        ' ORDER BY title COLLATE NOCASE,id LIMIT 30 OFFSET ?',
      ...params,
      (current - 1) * 30,
    )
    return { rows, total, page: current }
  })
  api.get('/admin/items/:id', async (r) => {
    const s = session(r)
    return (
      get('SELECT id,title,username,updated FROM items WHERE tenant=? AND id=?', s.tenant, id(r)) ??
      fail(404, 'Item unavailable in this workspace')
    )
  })
  api.get('/admin/items/:id/history', async (r) => {
    const s = session(r)
    if (!get('SELECT id FROM items WHERE tenant=? AND id=?', s.tenant, id(r)))
      fail(404, 'Item unavailable in this workspace')
    const { before } = z
      .object({ before: z.coerce.number().int().positive().default(Number.MAX_SAFE_INTEGER) })
      .parse(r.query)
    return all(
      'SELECT id, action, at FROM events WHERE tenant=? AND subject=? AND (?=1 OR actor=?) AND id<? ORDER BY id DESC LIMIT 31',
      s.tenant,
      id(r),
      Number(s.role === 'owner'),
      profileId(s),
      before,
    )
  })
  db.exec(
    "CREATE INDEX IF NOT EXISTS team_item_access ON events(tenant,subject,id DESC) WHERE action='Vault item revealed' AND actor!='owner'",
  )
  api.get('/admin/team-overview', async (r) => {
    const s = session(r)
    if (s.role !== 'owner') fail(403, 'Owner required')
    const item = get('SELECT id,title FROM items WHERE tenant=? ORDER BY rowid LIMIT 1', s.tenant)
    if (!item) return { item: null, access: null }
    const access = get(
      `SELECT e.id,i.id AS item,i.title,m.label AS member,e.at
       FROM events e JOIN items i ON i.id=e.subject AND i.tenant=e.tenant
       JOIN members m ON m.id=e.actor AND m.tenant=e.tenant
       WHERE e.tenant=? AND e.subject=? AND e.action='Vault item revealed' AND e.actor!='owner'
       ORDER BY e.id DESC LIMIT 1`,
      s.tenant,
      item.id,
    )
    return { item, access: access ?? null }
  })
  api.post('/admin/items', async (r) => {
    const s = session(r),
      b = z
        .object({ title: name, username: z.string().max(500), value: z.string().min(1).max(64000) })
        .strict()
        .parse(r.body),
      key = 'item_' + randomUUID()
    tx(() => {
      run(
        'INSERT INTO items VALUES(?,?,?,?,?,?)',
        key,
        s.tenant,
        b.title,
        b.username,
        seal(b.value, key),
        now(),
      )
      event(s.tenant, 'Vault item created', key)
    })
    return { id: key }
  })
  api.post('/admin/items/:id/reveal', async (r) => {
    const s = session(r),
      item =
        get('SELECT * FROM items WHERE id=? AND tenant=?', id(r), s.tenant) ??
        fail(404, 'Item unavailable')
    event(s.tenant, 'Vault item revealed', item.id)
    return { value: open(item.envelope, item.id) }
  })
  api.delete('/admin/items/:id', async (r) => {
    const s = session(r)
    return tx(() => {
      if (
        get(
          'SELECT 1 FROM connection_items l JOIN connections c ON c.id=l.conn WHERE c.tenant=? AND l.item=?',
          s.tenant,
          id(r),
        )
      )
        fail(
          409,
          'A connection uses this item. Rotate its credential or revoke the connection before deleting the item.',
        )
      if (!run('DELETE FROM items WHERE id=? AND tenant=?', id(r), s.tenant).changes)
        fail(404, 'Item unavailable')
      event(s.tenant, 'Vault item deleted', id(r))
      return { ok: true }
    })
  })
  api.get('/admin/workspace', async (r) => {
    const s = session(r),
      t = s.tenant
    return {
      tenant: t,
      role: s.role,
      managed_hosts: hostAccess.managed(t),
      hosts: all(
        'SELECT id,label,revoked,expires,pub IS NOT NULL AS enrolled FROM cli_hosts WHERE tenant=? ORDER BY rowid DESC',
        t,
      ),
      requests: all(
        'SELECT p.id,p.label,h.label AS host FROM pairs p JOIN host_pairs hp ON hp.pair=p.id JOIN cli_hosts h ON h.id=hp.host WHERE h.tenant=? AND h.revoked=0 AND p.expires>? AND p.grant_id IS NULL ORDER BY p.rowid DESC LIMIT 100',
        t,
        now(),
      ),
      version: releasePackage.version,
      operation_stops: all('SELECT op FROM operation_stops WHERE tenant=? ORDER BY op', t).map(
        (x) => x.op,
      ),
      provider_stops: all(
        'SELECT provider FROM provider_stops WHERE tenant=? ORDER BY provider',
        t,
      ).map((r) => r.provider),
      billing: all(
        "SELECT g.id,g.connection_id,g.label,b.available,b.tariff,COALESCE(SUM(c.charged),0) AS spent,COALESCE(SUM(CASE WHEN c.state IN ('reserved','held') THEN c.reserved ELSE 0 END),0) AS held FROM model_budgets b JOIN grants g ON b.grant_id=g.id LEFT JOIN model_charges c ON c.grant_id=g.id WHERE g.tenant=? GROUP BY b.grant_id",
        t,
      ).filter((g) => grantManager(s, g)),
      paused: !!get('SELECT paused FROM stops WHERE tenant=?', t)?.paused,
      items:
        (r.query as { items?: string }).items === 'paged'
          ? []
          : all('SELECT id,title,username,updated FROM items WHERE tenant=? ORDER BY title', t),
      apps:
        s.role === 'owner'
          ? all(
              'SELECT id,label,audience,active FROM delegation_apps WHERE tenant=? ORDER BY label',
              t,
            )
          : [],
      directory: [
        { id: 'owner', label: 'Administrator' },
        ...all('SELECT id,label FROM members WHERE tenant=? AND active=1 ORDER BY label', t),
      ],
      members:
        s.role === 'owner' ? all('SELECT id,label,role,active FROM members WHERE tenant=?', t) : [],
      workspaces:
        s.role === 'owner'
          ? all('SELECT * FROM workspaces ORDER BY label')
          : all('SELECT * FROM workspaces WHERE id=?', t),
      providers,
      connections: all(
        'SELECT id,provider,label,identity,revision,active FROM connections WHERE tenant=? ORDER BY label',
        t,
      )
        .filter((c) => manages(s, c.id) || available(c.id, profileId(s)))
        .map((c) => {
          const a = ownership(c.id),
            manage = manages(s, c.id)
          return {
            ...c,
            private_source:
              manage &&
              !!get(
                'SELECT d.item FROM personal_delegations d JOIN personal_items i ON i.id=d.item WHERE d.conn=? AND i.profile=? AND i.tenant=?',
                c.id,
                profileId(s),
                t,
              ),
            vault_item:
              get(
                'SELECT i.id,i.title FROM connection_items l JOIN items i ON i.id=l.item AND i.tenant=? WHERE l.conn=?',
                t,
                c.id,
              ) ?? null,
            expires_at: deadline(c.id, 'credential'),
            access_expires_at: Number.isFinite(accessDeadline(c.id, profileId(s)))
              ? accessDeadline(c.id, profileId(s))
              : null,
            organization_expires_at: manage ? deadline(c.id, 'organization') : undefined,
            recipient_expiries: manage
              ? Object.fromEntries(
                  all(
                    "SELECT substr(target,6) AS profile,expires FROM credential_deadlines WHERE conn=? AND target LIKE 'user/%'",
                    c.id,
                  ).map((x) => [x.profile, x.expires]),
                )
              : undefined,
            identity: manage ? c.identity : '',
            manage,
            visibility: a.visibility,
            source:
              a.owner === 'org'
                ? 'Organization'
                : manage
                  ? 'Owned by you'
                  : 'Shared by ' +
                    (a.owner === 'owner'
                      ? 'Administrator'
                      : (get('SELECT label FROM members WHERE id=?', a.owner)?.label ?? 'member')),
            recipients: manage
              ? all('SELECT profile FROM credential_shares WHERE conn=?', c.id).map(
                  (x) => x.profile,
                )
              : [],
          }
        }),
      grants: all(
        `SELECT g.id,g.label,g.connection_id,g.ops,g.expires,g.active,
          (SELECT h.label FROM host_grants hg JOIN cli_hosts h ON h.id=hg.host WHERE hg.grant_id=g.id) AS host,
          (SELECT h.revoked FROM host_grants hg JOIN cli_hosts h ON h.id=hg.host WHERE hg.grant_id=g.id) AS host_revoked,
          (SELECT model FROM model_leases WHERE grant_id=g.id) AS model,
          (SELECT MAX(at) FROM events WHERE tenant=g.tenant AND subject=g.id AND action='CLI connected') AS connected_at
         FROM grants g WHERE tenant=? ORDER BY g.rowid DESC`,
        t,
      ).filter((g) => grantManager(s, g)),
      approvals: all(
        "SELECT id,actor,conn,op,preview,created FROM runs WHERE tenant=? AND state='pending' ORDER BY created",
        t,
      )
        .filter((x) => manages(s, x.conn))
        .map((x) => ({
          ...x,
          preview:
            x.op === 'loops.contacts.import_chunk'
              ? batchView(db, get('SELECT * FROM batches WHERE approval=?', x.id)!)
              : open(x.preview, x.id + '/preview'),
        })),
      events: all(
        'SELECT action,subject,at,actor FROM events WHERE tenant=? AND (?=1 OR actor=?) ORDER BY id DESC LIMIT 100',
        t,
        Number(s.role === 'owner'),
        profileId(s),
      ),
    }
  })
  api.post('/admin/members', async (r) => {
    const s = session(r)
    if (s.role !== 'owner') fail(403, 'Owner required')
    const b = z.object({ label: name, role: z.enum(['editor', 'viewer']) }).parse(r.body),
      token = opaque(),
      m = randomUUID()
    tx(() => {
      run('INSERT INTO members VALUES(?,?,?,?,?,1)', m, s.tenant, b.label, b.role, digest(token))
      event(s.tenant, 'Member added · ' + b.role, m)
    })
    return { member_id: m, token }
  })
  api.delete('/admin/members/:id', async (r) => {
    const s = session(r)
    if (s.role !== 'owner') fail(403, 'Owner required')
    tx(() => {
      if (!run('UPDATE members SET active=0 WHERE tenant=? AND id=?', s.tenant, id(r)).changes)
        fail(404, 'Member unavailable')
      run(
        'UPDATE grants SET active=0 WHERE id IN (SELECT grant_id FROM grant_issuers WHERE profile=?) OR connection_id IN (SELECT conn FROM credential_ownership WHERE owner=?)',
        id(r),
        id(r),
      )
      event(s.tenant, 'Member revoked', id(r))
    })
    return { ok: true }
  })
  api.post('/admin/dispatch', async (r) => {
    const s = session(r)
    if (s.role !== 'owner') fail(403, 'Owner required')
    const { paused } = z.object({ paused: z.boolean() }).parse(r.body)
    tx(() => {
      run(
        'INSERT INTO stops VALUES(?,?) ON CONFLICT(tenant) DO UPDATE SET paused=excluded.paused',
        s.tenant,
        Number(paused),
      )
      event(s.tenant, paused ? 'Dispatch paused' : 'Dispatch resumed', s.tenant)
    })
    return { paused }
  })
  api.get('/admin/billing/holds', async (r) => {
    const s = session(r)
    if (s.role !== 'owner') fail(403, 'Owner required')
    return all(
      "SELECT c.execution,g.label,c.reserved,c.created FROM model_charges c JOIN grants g ON c.grant_id=g.id WHERE g.tenant=? AND c.state='held' ORDER BY c.created",
      s.tenant,
    )
  })
  api.post('/admin/billing/holds/:id', async (r) => {
    const s = session(r)
    if (s.role !== 'owner') fail(403, 'Owner required')
    const b = z
      .object({
        actual_micro_usd: z.number().int().min(0).max(1000000000000),
        evidence_sha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict()
      .parse(r.body)
    return tx(() => {
      const c =
        get(
          "SELECT c.* FROM model_charges c JOIN grants g ON c.grant_id=g.id WHERE g.tenant=? AND c.execution=? AND c.state='held'",
          s.tenant,
          id(r),
        ) ?? fail(409, 'Charge unavailable')
      run(
        "UPDATE model_charges SET state='reconciled',charged=? WHERE execution=?",
        b.actual_micro_usd,
        c.execution,
      )
      run(
        'UPDATE model_budgets SET available=available+?-? WHERE grant_id=?',
        c.reserved,
        b.actual_micro_usd,
        c.grant_id,
      )
      run('INSERT INTO model_adjustments VALUES(?,?,?)', c.execution, b.evidence_sha256, now())
      event(s.tenant, 'Model charge reconciled', c.execution)
      return { state: 'reconciled', charged: b.actual_micro_usd }
    })
  })
  api.post('/admin/dispatch/:provider', async (r) => {
    const s = session(r)
    if (s.role !== 'owner') fail(403, 'Owner required')
    const p = (r.params as { provider: string }).provider
    if (!Object.hasOwn(providers, p)) fail(404, 'Unknown provider')
    const { paused } = z.object({ paused: z.boolean() }).strict().parse(r.body)
    return tx(() => {
      if (paused) run('INSERT OR IGNORE INTO provider_stops VALUES(?,?)', s.tenant, p)
      else run('DELETE FROM provider_stops WHERE tenant=? AND provider=?', s.tenant, p)
      event(s.tenant, paused ? 'Provider dispatch paused' : 'Provider dispatch resumed', p)
      return { provider: p, paused }
    })
  })
  api.post('/admin/dispatch/:provider/:operation', async (r) => {
    const s = session(r)
    if (s.role !== 'owner') fail(403, 'Owner required')
    const { provider, operation } = r.params as { provider: string; operation: string }
    if (
      !Object.hasOwn(providers, provider) ||
      !providers[provider].actions.some((a) => a.id === operation)
    )
      fail(404, 'Unknown operation')
    const { paused } = z.object({ paused: z.boolean() }).strict().parse(r.body)
    return tx(() => {
      if (paused) run('INSERT OR IGNORE INTO operation_stops VALUES(?,?)', s.tenant, operation)
      else run('DELETE FROM operation_stops WHERE tenant=? AND op=?', s.tenant, operation)
      event(
        s.tenant,
        paused ? 'Operation dispatch paused' : 'Operation dispatch resumed',
        operation,
      )
      return { operation, paused }
    })
  })
  function checkDispatch(tenant: string, provider: string, operation?: string) {
    if (
      operation &&
      get('SELECT op FROM operation_stops WHERE tenant=? AND op=?', tenant, operation)
    )
      fail(423, 'Operation dispatch paused')
    if (get('SELECT provider FROM provider_stops WHERE tenant=? AND provider=?', tenant, provider))
      fail(423, 'Provider dispatch paused')
    if (get('SELECT paused FROM stops WHERE tenant=?', tenant)?.paused)
      fail(423, 'Workspace dispatch paused')
  }
  api.get('/v1/session', async (r) => {
    const g = grant(r)
    return {
      device_id: g.id,
      access_expires_at: iso(g.access_until),
      grant_expires_at: iso(g.expires),
      connection_id: g.connection_id,
    }
  })
  api.get('/v1/capabilities', async (r) => {
    const g = grant(r),
      c = conn(g.tenant, g.connection_id),
      ops: string[] = JSON.parse(g.ops)
    return {
      connection_id: c.id,
      connection_revision: String(c.revision),
      external_identity: deviceIdentity(g, c),
      label: c.label,
      operations: providers[c.provider].actions
        .filter((a) => ops.includes(a.id))
        .map((a) => ({
          ...a,
          connector_revision: connectorRevision(c.provider, a.id),
          approval: a.method === 'GET' ? 'none' : 'exact',
        })),
      resources: JSON.parse(get('SELECT labels FROM resources WHERE conn=?', c.id)?.labels || '[]'),
      model_lease:
        get('SELECT model,remaining,max_tokens FROM model_leases WHERE grant_id=?', g.id) || null,
    }
  })
  const intake = intakeKeys()
  db.exec(
    'CREATE TABLE IF NOT EXISTS intake_tickets(id TEXT PRIMARY KEY,owner TEXT,tenant TEXT,expires INTEGER)',
  )
  api.post('/admin/intake', async (r) => {
    const s = session(r),
      ticket = opaque()
    run('DELETE FROM intake_tickets WHERE expires<=?', now())
    run(
      'INSERT INTO intake_tickets VALUES(?,?,?,?)',
      digest(ticket),
      s.token,
      s.tenant,
      now() + 60000,
    )
    return { ticket, publicKey: intake.publicKey }
  })
  function intakeBody(r: FastifyRequest, field: string) {
    const b = z.record(z.string(), z.unknown()).parse(r.body)
    if (!Object.hasOwn(b, 'sealed')) return b
    const s = session(r),
      e = envelope.parse(b.sealed)
    if (
      !run(
        'DELETE FROM intake_tickets WHERE id=? AND owner=? AND tenant=? AND expires>?',
        digest(e.ticket),
        s.token,
        s.tenant,
        now(),
      ).changes
    )
      fail(403, 'Intake ticket expired')
    try {
      const { sealed, ...rest } = b
      return { ...rest, [field]: intake.unseal(e) }
    } catch {
      return fail(422, 'Invalid sealed input')
    }
  }
  db.exec(
    'CREATE TABLE IF NOT EXISTS oauth_states(id TEXT PRIMARY KEY,session TEXT,tenant TEXT,expires INTEGER,envelope TEXT)',
  )
  const notionCallback = origin + '/api/oauth/notion/callback'
  api.post('/admin/oauth/notion', async (r) => {
    const s = session(r),
      b = oauthConfig
        .pick({
          label: true,
          client_id: true,
          client_secret: true,
          ownership: true,
          expires_at: true,
        })
        .strict()
        .parse(intakeBody(r, 'client_secret')),
      state = opaque(),
      id = digest(state)
    run('DELETE FROM oauth_states WHERE expires<=?', now())
    run(
      'INSERT INTO oauth_states VALUES(?,?,?,?,?)',
      id,
      s.token,
      s.tenant,
      now() + 600000,
      seal({ ...b, provider: 'notion' }, id),
    )
    return { url: notionAuthorize(b.client_id, state, notionCallback) }
  })
  api.get('/oauth/notion/callback', async (r, reply) => {
    const s = session(r)

    const { code, state } = z
      .object({ code: z.string().min(1).max(4000), state: name })
      .parse(r.query)
    const key = digest(state),
      row =
        get(
          'SELECT * FROM oauth_states WHERE id=? AND session=? AND tenant=? AND expires>?',
          key,
          s.token,
          s.tenant,
          now(),
        ) ?? fail(400, 'Authorization expired')
    const b = open(row.envelope, key)
    if (b.provider !== 'notion') fail(400, 'Wrong authorization provider')
    if (!run('DELETE FROM oauth_states WHERE id=?', key).changes) fail(400, 'Authorization expired')
    const token = await notionToken(
      b.client_id,
      b.client_secret,
      { grant_type: 'authorization_code', code, redirect_uri: notionCallback },
      send,
    )
    if (!token.workspace_id) fail(400, 'Notion workspace unavailable')
    const live = session(r)
    if (live.tenant !== s.tenant) fail(403, 'Workspace changed')
    const c = 'con_' + randomUUID()
    tx(() => {
      run(
        'INSERT INTO connections VALUES(?,?,?,?,?,1,?,1)',
        c,
        s.tenant,
        'notion',
        b.label,
        token.workspace_id!,
        seal(
          {
            ...b,
            ...token,
            expires: token.expires_in ? now() + token.expires_in * 1000 : Number.MAX_SAFE_INTEGER,
          },
          c,
        ),
      )
      run('INSERT INTO resources VALUES(?,?)', c, '[]')
      recordOwner(session(r), c, b.ownership, b.expires_at)
      event(s.tenant, 'Notion workspace connected', c)
    })
    return reply.redirect(origin + '/')
  })
  const callback = origin + '/api/oauth/google/callback'
  api.post('/admin/oauth/google', async (r) => {
    const s = session(r),
      b = oauthConfig.parse(intakeBody(r, 'client_secret')),
      state = opaque(),
      verifier = opaque()
    run('DELETE FROM oauth_states WHERE expires<=?', now())
    run(
      'INSERT INTO oauth_states VALUES(?,?,?,?,?)',
      digest(state),
      s.token,
      s.tenant,
      now() + 600000,
      seal({ ...b, verifier }, digest(state)),
    )
    return { url: authorize(b.client_id, b.scope, state, verifier, callback) }
  })
  api.get('/oauth/google/callback', async (r, reply) => {
    const s = session(r)

    const { code, state } = z
      .object({ code: z.string().min(1).max(4000), state: name })
      .parse(r.query)
    const row = tx(() => {
      const a =
        get(
          'SELECT * FROM oauth_states WHERE id=? AND session=? AND tenant=? AND expires>?',
          digest(state),
          s.token,
          s.tenant,
          now(),
        ) ?? fail(400, 'Authorization expired')
      if (open(a.envelope, a.id).provider === 'notion') fail(400, 'Wrong authorization provider')
      run('DELETE FROM oauth_states WHERE id=?', a.id)
      return a
    })
    const b = open(row.envelope, row.id)
    const token = await exchange(
      {
        client_id: b.client_id,
        client_secret: b.client_secret,
        code,
        code_verifier: b.verifier,
        redirect_uri: callback,
        grant_type: 'authorization_code',
      },
      send,
    )
    const res = await send('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: 'Bearer ' + token.access_token },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) fail(400, 'Google identity unavailable')
    const identity = z
      .object({ email: z.email(), email_verified: z.literal(true) })
      .parse(await res.json())
    const c = 'con_' + randomUUID()
    const bundle = {
      client_id: b.client_id,
      client_secret: b.client_secret,
      ...token,
      expires: now() + token.expires_in * 1000,
    }
    tx(() => {
      run(
        'INSERT INTO connections VALUES(?,?,?,?,?,1,?,1)',
        c,
        s.tenant,
        'google_workspace',
        b.label,
        identity.email,
        seal(bundle, c),
      )
      run('INSERT INTO resources VALUES(?,?)', c, JSON.stringify(b.resources || []))
      recordOwner(session(r), c, b.ownership, b.expires_at)
      event(s.tenant, 'Google account connected', c)
    })
    return reply.redirect(origin + '/')
  })
  const refreshes = new Map<string, Promise<string>>()
  function storedCredential(c: Row) {
    if (c.secret) return open(c.secret, c.id)
    const item = get(
      'SELECT i.id,i.envelope FROM connection_items l JOIN items i ON i.id=l.item AND i.tenant=? WHERE l.conn=?',
      c.tenant,
      c.id,
    )
    if (!c.active || !item) return fail(409, 'Credential unavailable')
    return open(item.envelope, item.id)
  }
  async function credential(c: Row, force = false): Promise<string> {
    if ((deadline(c.id, 'credential') ?? Infinity) <= now()) fail(403, 'Credential expired')
    const value = storedCredential(c)
    if (typeof value === 'string')
      return scopedToken(
        c.provider,
        value,
        send,
        c.provider === 'bluesky' && c.identity.startsWith('did:') ? c.identity : undefined,
      )
    if (!force && value.expires > now() + 60000) return value.access_token
    if (!value.refresh_token) return fail(409, 'Reconnect this account')
    const existing = refreshes.get(c.id)
    if (existing) return existing
    const pending = (async () => {
      const next =
        c.provider === 'notion'
          ? await notionToken(
              value.client_id,
              value.client_secret,
              { grant_type: 'refresh_token', refresh_token: value.refresh_token },
              send,
            )
          : await exchange(
              {
                client_id: value.client_id,
                client_secret: value.client_secret,
                refresh_token: value.refresh_token,
                grant_type: 'refresh_token',
              },
              send,
            )
      if ('workspace_id' in next && next.workspace_id && next.workspace_id !== c.identity)
        fail(409, 'Workspace identity changed')
      const bundle = {
        ...value,
        ...next,
        refresh_token: next.refresh_token || value.refresh_token,
        expires: next.expires_in ? now() + next.expires_in * 1000 : Number.MAX_SAFE_INTEGER,
      }
      if (
        !run(
          'UPDATE connections SET secret=? WHERE id=? AND revision=? AND active=1',
          seal(bundle, c.id),
          c.id,
          c.revision,
        ).changes
      )
        fail(409, 'Connection changed')
      return next.access_token
    })()
    refreshes.set(c.id, pending)
    try {
      return await pending
    } finally {
      refreshes.delete(c.id)
    }
  }
  api.post('/admin/connections/:id/oauth-refresh', async (r) => {
    const s = session(r),
      c = conn(s.tenant, id(r))
    own(r, c.id)
    if (!c.active || typeof storedCredential(c) === 'string')
      fail(409, 'Select an active OAuth connection')
    await credential(c, true)
    event(s.tenant, 'OAuth credential refreshed', c.id)
    return { ok: true }
  })
  db.exec(
    'CREATE TABLE IF NOT EXISTS resources(conn TEXT PRIMARY KEY,labels TEXT); CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,conn TEXT,actor TEXT,expires INTEGER,value TEXT)',
  )
  api.get('/v1/artifacts/:id', async (r, reply) => {
    const g = grant(r),
      a =
        get(
          'SELECT * FROM artifacts WHERE id=? AND actor=? AND conn=? AND expires>?',
          id(r),
          g.id,
          g.connection_id,
          now(),
        ) ?? fail(404, 'Artifact unavailable')
    if (!conn(g.tenant, a.conn).active) fail(404, 'Artifact unavailable')
    const value = open(a.value, a.id)
    if (value?.binary === true)
      return reply
        .type('application/octet-stream')
        .header('Content-Disposition', 'attachment; filename="receipt"')
        .send(Buffer.from(value.base64, 'base64'))
    return reply
      .type('application/json')
      .header('Content-Disposition', 'attachment; filename="gmail-page.json"')
      .send(Buffer.from(value))
  })
  function linkItem(principal: Principal, connection: string, itemId: string) {
    if (principal.role === 'viewer') fail(403, 'Workspace editor required to use a stored value')
    const item =
      get('SELECT id,envelope FROM items WHERE id=? AND tenant=?', itemId, principal.tenant) ??
      fail(404, 'Item unavailable')
    connectionInput.shape.secret.parse(open(item.envelope, item.id))
    run(
      'INSERT INTO connection_items(conn,item) VALUES(?,?) ON CONFLICT(conn) DO UPDATE SET item=excluded.item',
      connection,
      item.id,
    )
  }
  api.post('/admin/connections', async (r) => {
    const principal = session(r),
      t = principal.tenant
    const input = intakeBody(r, 'secret')
    const privateSource = input.private_source
    if (privateSource !== undefined) {
      z.string().uuid().parse(privateSource)
      if (
        input.ownership !== 'personal' ||
        !('sealed' in (r.body as Record<string, unknown>)) ||
        'vault_item_id' in input ||
        !get(
          'SELECT id FROM personal_items WHERE id=? AND tenant=? AND profile=?',
          String(privateSource),
          t,
          profileId(principal),
        )
      )
        fail(403, 'Private item owner required')
      delete input.private_source
    }
    const linked = 'vault_item_id' in input
    const b = linked
      ? connectionInput.omit({ secret: true }).extend({ vault_item_id: name }).parse(input)
      : connectionInput.parse(input)
    if (
      b.provider === 'remote_gateway' &&
      (!remote ||
        !('secret' in b) ||
        typeof b.secret !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(b.secret))
    )
      fail(422, 'Provide a scoped access token issued by the separate gateway')
    if (!Object.hasOwn(providers, b.provider)) fail(422, 'Unknown provider')
    const c = 'con_' + randomUUID()
    tx(() => {
      if ('vault_item_id' in b) linkItem(principal, c, b.vault_item_id)
      run(
        'INSERT INTO connections VALUES(?,?,?,?,?,1,?,1)',
        c,
        t,
        b.provider,
        b.label,
        b.external_identity,
        'secret' in b ? seal(b.secret, c) : '',
      )
      run('INSERT INTO resources VALUES(?,?)', c, JSON.stringify(b.resources || []))
      recordOwner(session(r), c, b.ownership, b.expires_at)
      if (b.provider === 'remote_gateway')
        run('INSERT INTO model_custodians VALUES(?,?)', c, remote!)
      if (privateSource)
        run('INSERT INTO personal_delegations VALUES(?,?)', c, String(privateSource))
      event(t, privateSource ? 'Private credential delegated' : 'Connection added', c)
    })
    return { connection_id: c }
  })
  api.post('/admin/connections/:id/rotate', async (r) => {
    const principal = session(r),
      t = principal.tenant,
      c = conn(t, id(r))
    own(r, c.id)
    if (!c.active) fail(409, 'Connection revoked')
    const input = intakeBody(r, 'secret')
    const source = z
      .union([
        z.object({ secret: connectionInput.shape.secret }).strict(),
        z.object({ vault_item_id: name }).strict(),
      ])
      .parse(input)
    if (
      c.provider === 'remote_gateway' &&
      (!remote ||
        get('SELECT origin FROM model_custodians WHERE connection=?', c.id)?.origin !== remote ||
        !('secret' in source) ||
        !/^[A-Za-z0-9_-]{43}$/.test(source.secret))
    )
      fail(422, 'Recreate a connection for a changed custodian or rotate its scoped access token')
    tx(() => {
      run('DELETE FROM personal_delegations WHERE conn=?', c.id)
      if ('vault_item_id' in source) linkItem(principal, c.id, source.vault_item_id)
      else run('DELETE FROM connection_items WHERE conn=?', c.id)
      run(
        'UPDATE connections SET secret=?,revision=revision+1 WHERE id=?',
        'secret' in source ? seal(source.secret, c.id) : '',
        c.id,
      )
      event(t, 'Credential rotated', c.id)
    })
    return { ok: true }
  })
  api.delete('/admin/connections/:id', async (r) => {
    const t = session(r).tenant,
      c = conn(t, id(r))
    own(r, c.id)
    tx(() => {
      run('DELETE FROM connection_items WHERE conn=?', c.id)
      run("UPDATE connections SET active=0,secret='',revision=revision+1 WHERE id=?", c.id)
      run('UPDATE grants SET active=0 WHERE connection_id=?', c.id)
      run("UPDATE runs SET state='denied' WHERE conn=? AND state IN ('approved','pending')", c.id)
      event(t, 'Connection revoked', c.id)
    })
    return { ok: true }
  })
  function issue(g: Row) {
    const access = opaque(),
      refresh = opaque(),
      until = Math.min(now() + 900000, g.expires)
    run(
      'UPDATE grants SET access=?,refresh=?,access_until=? WHERE id=?',
      digest(access),
      digest(refresh),
      until,
      g.id,
    )
    return {
      device_id: g.id,
      access_token: access,
      refresh_token: refresh,
      access_expires_at: iso(until),
      refresh_expires_at: iso(g.expires),
    }
  }
  api.post('/v1/device/authorizations', async (r) => {
    const label = z.object({ device_name: name }).parse(r.body).device_name,
      code = opaque(),
      u = randomBytes(5).toString('hex').toUpperCase(),
      p = randomUUID(),
      exp = now() + 600000
    const host = hostAccess.identity(r)
    tx(() => {
      run('DELETE FROM pairs WHERE expires<=?', now())
      run('INSERT INTO pairs VALUES(?,?,?,?,?,NULL)', p, digest(code), digest(u), label, exp)
      if (host) run('INSERT INTO host_pairs VALUES(?,?)', p, String(host.id))
    })
    return {
      pairing_id: p,
      device_code: code,
      user_code: u,
      verification_url: origin + '/device',
      expires_at: iso(exp),
      interval_seconds: 5,
    }
  })
  db.exec(
    'CREATE TABLE IF NOT EXISTS model_leases(grant_id TEXT PRIMARY KEY,model TEXT,max_tokens INTEGER,remaining INTEGER)',
  )
  db.exec(
    'CREATE TABLE IF NOT EXISTS draft_limits(actor TEXT PRIMARY KEY,daily INTEGER,until INTEGER); CREATE TABLE IF NOT EXISTS draft_usage(actor TEXT,day TEXT,used INTEGER,PRIMARY KEY(actor,day))',
  )
  api.post('/admin/grants', async (r) => {
    const t = session(r).tenant,
      b = z
        .object({
          label: name,
          connection_id: name,
          operations: z.array(name).min(1),
          hours: z.number().int().min(1).max(720),
          user_code: name.optional(),
          enrollment: z.boolean().optional(),
          host_request: z.string().uuid().optional(),
          model_lease: modelLease.optional(),
          draft_limit: z.number().int().min(1).max(100).optional(),
        })
        .parse(r.body)
    const c = conn(t, b.connection_id)
    if (!available(c.id, profileId(session(r)))) fail(404, 'Connection unavailable')
    if (
      !c.active ||
      b.operations.some((op) => !providers[c.provider].actions.some((a) => a.id === op))
    )
      fail(422, 'Invalid grant')
    return tx(() => {
      const g = 'dev_' + randomUUID(),
        expires = Math.min(now() + b.hours * 3600000, accessDeadline(c.id, profileId(session(r))))
      run(
        'INSERT INTO grants VALUES(?,?,?,?,?,?,NULL,NULL,0,1)',
        g,
        t,
        b.label,
        c.id,
        JSON.stringify(b.operations),
        expires,
      )
      run('INSERT INTO grant_issuers VALUES(?,?)', g, profileId(session(r)))
      if (b.draft_limit) {
        if (
          session(r).role !== 'owner' ||
          !b.operations.some((x) =>
            [
              'loops.newsletter.create_campaign',
              'hubspot.newsletter.update_draft',
              'loops.newsletter.update_email_message',
            ].includes(x),
          )
        )
          fail(403, 'Owner and unsent draft operation required')
        run('INSERT INTO draft_limits VALUES(?,?,?)', g, b.draft_limit, expires)
      }
      if (b.model_lease) {
        if (b.model_lease.tariff) meter.configure(g, b.model_lease.tariff)
        if (
          !['openai', 'openrouter', 'moonshot', 'remote_gateway'].includes(c.provider) ||
          !b.operations.includes(c.provider + '.chat')
        )
          fail(422, 'Model lease requires a chat operation')
        run(
          'INSERT INTO model_leases VALUES(?,?,?,?)',
          g,
          b.model_lease.model,
          b.model_lease.max_tokens,
          b.model_lease.calls,
        )
      }
      if (b.host_request || hostAccess.managed(t)) {
        const pair =
          get(
            'SELECT p.id,p.label,h.id AS host FROM pairs p JOIN host_pairs hp ON hp.pair=p.id JOIN cli_hosts h ON h.id=hp.host WHERE p.id=? AND h.tenant=? AND h.revoked=0 AND p.grant_id IS NULL AND p.expires>?',
            b.host_request || '',
            t,
            now(),
          ) ?? fail(403, 'Choose a pending request from an approved host')
        run('UPDATE pairs SET grant_id=? WHERE id=?', g, pair.id)
        run('INSERT INTO host_grants VALUES(?,?)', g, pair.host)
        event(t, 'Access granted', g)
        return { device_id: g }
      }
      event(t, 'Access granted', g)
      if (b.enrollment && !b.user_code) {
        const ticket = opaque()
        const until = Math.min(now() + 600000, expires)
        run('DELETE FROM pairs WHERE expires<=?', now())
        run(
          'INSERT INTO pairs VALUES(?,?,?,?,?,?)',
          randomUUID(),
          digest(ticket),
          digest(opaque()),
          b.label,
          until,
          g,
        )
        return { enrollment_token: ticket, device_id: g, expires_at: iso(until) }
      }
      if (b.user_code) {
        if (
          !run(
            'UPDATE pairs SET grant_id=? WHERE user_code=? AND expires>? AND grant_id IS NULL AND id NOT IN (SELECT pair FROM host_pairs)',
            g,
            digest(b.user_code.toUpperCase()),
            now(),
          ).changes
        )
          fail(404, 'Pairing code unavailable')
        return { device_id: g }
      }
      return issue({ id: g, expires })
    })
  })
  db.exec(
    'CREATE TABLE IF NOT EXISTS pair_receipts(code TEXT PRIMARY KEY, attempt TEXT NOT NULL, grant_id TEXT NOT NULL, expires INTEGER NOT NULL, sealed TEXT NOT NULL);CREATE INDEX IF NOT EXISTS receipt_expiry ON pair_receipts(expires)',
  )
  api.post('/v1/device/token', async (r, reply) => {
    const code = z.object({ device_code: name }).parse(r.body).device_code
    const attempt = z.string().uuid().optional().parse(r.headers['idempotency-key'])
    return tx(() => {
      run('DELETE FROM pair_receipts WHERE expires<=?', now())
      const fingerprint = digest(code)
      if (attempt) {
        const receipt = get(
          'SELECT * FROM pair_receipts WHERE code=? AND attempt=?',
          fingerprint,
          digest(attempt),
        )
        if (receipt) {
          const g =
            get(
              'SELECT * FROM grants WHERE id=? AND active=1 AND expires>? AND access_until>?',
              receipt.grant_id,
              now(),
              now(),
            ) ?? fail(403, 'Grant unavailable')
          hostAccess.bound(r, g.id, g.tenant)
          checkIssuer(g)
          const result = open(receipt.sealed, 'pair-receipt/' + fingerprint)
          if (digest(result.access_token) !== g.access) fail(403, 'Grant unavailable')
          return result
        }
      }
      const p =
        get('SELECT * FROM pairs WHERE code=? AND expires>?', digest(code), now()) ??
        fail(400, 'Expired pairing')
      const hostPair = get('SELECT host FROM host_pairs WHERE pair=?', p.id)
      if (hostPair && hostAccess.identity(r)?.id !== hostPair.host)
        fail(403, 'Requesting host required')
      if (!p.grant_id) {
        reply.code(428)
        return { code: 'authorization_pending' }
      }
      const g =
        get('SELECT * FROM grants WHERE id=? AND active=1 AND expires>?', p.grant_id, now()) ??
        fail(403, 'Grant unavailable')
      hostAccess.bound(r, g.id, g.tenant)
      checkIssuer(g)
      run('DELETE FROM pairs WHERE id=?', p.id)
      actor(g.id)
      event(g.tenant, 'CLI connected', g.id)
      const result = issue(g)
      if (attempt)
        run(
          'INSERT INTO pair_receipts VALUES(?,?,?,?,?)',
          fingerprint,
          digest(attempt),
          g.id,
          Math.min(p.expires, now() + 60000),
          seal(result, 'pair-receipt/' + fingerprint),
        )
      return result
    })
  })
  api.post('/v1/device/token/refresh', async (r) => {
    const b = z.object({ refresh_token: name }).parse(r.body)
    return tx(() => {
      const g =
        get(
          'SELECT * FROM grants WHERE refresh=? AND active=1 AND expires>?',
          digest(b.refresh_token),
          now(),
        ) ?? fail(401, 'Refresh expired')
      hostAccess.bound(r, g.id, g.tenant)
      checkIssuer(g)
      return issue(g)
    })
  })
  api.post('/v1/device/revoke', async (r, reply) => {
    const g = grant(r)
    tx(() => {
      run('UPDATE grants SET active=0 WHERE id=?', g.id)
      event(g.tenant, 'Access revoked', g.id)
    })
    return reply.code(204).send()
  })
  api.delete('/admin/grants/:id', async (r) => {
    const t = session(r).tenant
    const g =
      get('SELECT * FROM grants WHERE id=? AND tenant=?', id(r), t) ??
      fail(404, 'Grant unavailable')
    if (!grantManager(session(r), g)) fail(403, 'Grant unavailable')
    tx(() => {
      if (!run('UPDATE grants SET active=0 WHERE id=? AND tenant=?', id(r), t).changes)
        fail(404, 'Grant unavailable')
      event(t, 'Access revoked', id(r))
    })
    return { ok: true }
  })
  api.post('/admin/approvals/:id', async (r) => {
    const t = session(r).tenant,
      { approve, shown_manifest_sha256 } = z
        .object({
          approve: z.boolean(),
          shown_manifest_sha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .strict()
        .parse(r.body)
    const result = tx(() => {
      const pending =
        get('SELECT conn FROM runs WHERE id=? AND tenant=?', id(r), t) ??
        fail(409, 'Approval unavailable')
      own(r, pending.conn)
      const batch = get('SELECT * FROM batches WHERE tenant=? AND approval=?', t, id(r))
      if (batch) {
        const view = batchView(db, batch)
        if (view.manifest_sha256 !== shown_manifest_sha256) fail(409, 'Batch manifest changed')
        if (view.state !== 'pending') fail(409, 'Batch approval unavailable')
        if (approve) {
          const live = conn(t, batch.conn),
            m = JSON.parse(batch.manifest)
          const resources = JSON.parse(
            get('SELECT labels FROM resources WHERE conn=?', batch.conn)?.labels ?? '[]',
          )
          if (!live.active || live.revision !== batch.revision || !resources.includes(m.list_id))
            fail(409, 'Batch connection changed')
          checkDispatch(t, live.provider, 'loops.contacts.import_chunk')
        }
      }
      if (infrastructure) {
        const decision = approve ? 2 : 3
        const changed = run(
          "UPDATE engine_jobs SET ready=? WHERE kind='approval' AND ref=? AND ready=0",
          decision,
          id(r),
        )
        if (!changed.changes) fail(409, 'Approval already decided')
        event(t, approve ? 'Request approved' : 'Request denied', id(r))
        return { ok: true }
      }
      if (
        !run(
          "UPDATE runs SET state=? WHERE tenant=? AND id=? AND state='pending'",
          approve ? 'approved' : 'denied',
          t,
          id(r),
        ).changes
      )
        fail(409, 'Approval unavailable')
      const decided = run(
        "UPDATE batches SET state=? WHERE approval=? AND state='pending'",
        approve ? 'approved' : 'denied',
        id(r),
      )
      if (decided.changes) run('INSERT OR IGNORE INTO batch_decisions VALUES(?,?)', id(r), now())
      event(t, approve ? 'Request approved' : 'Request denied', id(r))
      return { ok: true }
    })
    if (infrastructure) {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (!get("SELECT 1 FROM engine_jobs WHERE kind='approval' AND ref=?", id(r))) return result
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      return { ok: true, pending: true }
    }
    return result
  })
  const fenced = (r: FastifyRequest) =>
    String(r.headers['openpassword-capabilities'] ?? '')
      .split(',')
      .map((x) => x.trim())
      .includes('expected-binding')
  api.post('/v1/connections/:id/availability', async (r) => {
    const g = grant(r)
    if (id(r) !== g.connection_id) fail(404, 'Connection unavailable')
    const c = conn(g.tenant, g.connection_id),
      b = z
        .object({
          requirement: z.object({ service: name, operations: z.array(name).min(1) }).passthrough(),
          profile: z.enum(['hosted', 'governed']),
          resource_id: name.optional(),
        })
        .strict()
        .parse(r.body)
    const ops: string[] = JSON.parse(g.ops),
      resources: string[] = JSON.parse(
        get('SELECT labels FROM resources WHERE conn=?', c.id)?.labels || '[]',
      ),
      observed = now()
    const fact = (dimension: string, state: string, blockers: string[] = []) => ({
      dimension,
      state,
      blockers,
      revision: String(c.revision),
      observed_at: iso(observed),
      fresh_until: iso(observed + 10000),
    })
    const allowed = b.requirement.operations.every((op) => ops.includes(op))
    return {
      requirement: b.requirement,
      profile: b.profile,
      connection: { value: c.id },
      revision: String(c.revision),
      facts: [
        fact(
          'implementation',
          b.requirement.operations.every((op) =>
            providers[c.provider].actions.some((a) => a.id === op),
          )
            ? 'satisfied'
            : 'blocked',
        ),
        fact('consent', allowed ? 'satisfied' : 'blocked', allowed ? [] : ['consent_required']),
        fact(
          'resource_binding',
          b.resource_id ? (resources.includes(b.resource_id) ? 'satisfied' : 'blocked') : 'unknown',
        ),
        fact('provider_health', 'unknown'),
      ],
    }
  })
  api.get('/v1/connections', async (r) => {
    const g = grant(r),
      c = conn(g.tenant, g.connection_id)
    return [
      {
        connection_id: c.id,
        provider: c.provider,
        external_identity: deviceIdentity(g, c),
        label: c.label,
        status: c.active ? 'active' : 'revoked',
        operations: JSON.parse(g.ops),
        resources: JSON.parse(
          get('SELECT labels FROM resources WHERE conn=?', c.id)?.labels || '[]',
        ),
        ...(fenced(r) ? { connection_revision: String(c.revision) } : {}),
      },
    ]
  })
  api.get('/v1/models', async (r) => {
    const g = grant(r),
      lease = get('SELECT * FROM model_leases WHERE grant_id=? AND remaining>0', g.id)
    return {
      object: 'list',
      data: lease
        ? [{ id: lease.model, object: 'model', owned_by: conn(g.tenant, g.connection_id).provider }]
        : [],
    }
  })
  api.post('/v1/chat/completions', async (r, reply) => {
    const g = grant(r),
      c = conn(g.tenant, g.connection_id),
      b = chat.parse(r.body)
    if (!c.active || !JSON.parse(g.ops).includes(c.provider + '.chat'))
      fail(403, 'Model grant required')
    const remoteModel = c.provider === 'remote_gateway'
    if (
      remoteModel &&
      (!remote ||
        get('SELECT origin FROM model_custodians WHERE connection=?', c.id)?.origin !== remote)
    )
      fail(403, 'Model custodian binding changed')
    checkDispatch(g.tenant, c.provider, c.provider + '.chat')
    const key =
      r.headers['idempotency-key'] === undefined
        ? randomUUID()
        : name.parse(r.headers['idempotency-key'])
    const ex = 'exec_' + randomUUID(),
      op = c.provider + '.chat'

    tx(() => {
      if (get('SELECT id FROM runs WHERE actor=? AND conn=? AND idem=?', g.id, c.id, key))
        fail(409, 'Model request already claimed')
      meter.claim(g.id, ex, b, Buffer.byteLength(canonical(b)))
      if (
        !run(
          'UPDATE model_leases SET remaining=remaining-1 WHERE grant_id=? AND model=? AND max_tokens>=? AND remaining>0',
          g.id,
          b.model,
          b.max_tokens,
        ).changes
      )
        fail(403, 'Model lease exhausted or out of scope')
      run(
        "INSERT INTO runs VALUES(?,?,?,?,?,?,?,?, 'running',?,NULL,?)",
        ex,
        g.tenant,
        g.id,
        c.id,
        op,
        key,
        digest(canonical(b)),
        c.revision,
        seal({}, ex + '/preview'),
        now(),
      )
      event(g.tenant, 'Model request claimed', ex)
    })
    function authorizeResult() {
      grant(r)
      checkDispatch(g.tenant, c.provider, c.provider + '.chat')
      const live = conn(g.tenant, c.id)
      if (!live.active || live.revision !== c.revision) fail(409, 'Connection changed')
    }
    const abort = new AbortController()
    const onClose = () => abort.abort()
    reply.raw.once('close', onClose)
    function finish(state: string, usage?: unknown) {
      reply.raw.removeListener('close', onClose)
      tx(() => {
        usageLedger.finish(ex, state, usage)
        meter.finish(ex, usage, state === 'confirmed')
        run('UPDATE runs SET state=? WHERE id=?', state, ex)
        event(g.tenant, op + ' · ' + state, ex)
      })
    }
    try {
      const secret = await credential(c)
      grant(r)
      checkDispatch(g.tenant, c.provider, c.provider + '.chat')
      if (conn(g.tenant, c.id).revision !== c.revision) fail(409, 'Connection changed')
      attribute(g, c, op, ex, b.model)
      const response = await send(providers[c.provider].origin + '/chat/completions', {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
        body: JSON.stringify(
          b.stream && !remoteModel ? { ...b, stream_options: { include_usage: true } } : b,
        ),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]),
      })
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw Error('Upstream refused')
      }
      const reader = response.body.getReader()
      if (b.stream && !response.headers.get('content-type')?.includes('text/event-stream')) {
        await reader.cancel()
        throw Error('Unexpected model response')
      }
      if (b.stream) {
        async function* stream() {
          const usage = new StreamUsage()
          let size = 0,
            done = false,
            tail = ''
          try {
            for (;;) {
              const v = await reader.read()
              if (v.done) {
                if (!/(?:^|\n)data: ?\[DONE\]\s*$/.test(tail))
                  throw Error('Incomplete model stream')
                done = true
                break
              }
              authorizeResult()
              tail = (tail + Buffer.from(v.value).toString()).slice(-256)
              size += v.value.length
              if (size > 8388608) throw Error('Stream limit')
              usage.feed(v.value)
              yield Buffer.from(v.value)
            }
          } finally {
            abort.abort()
            await reader.cancel().catch(() => {})
            finish(done ? 'confirmed' : 'ambiguous', usage.usage)
          }
        }
        return reply
          .type('text/event-stream')
          .header('X-Accel-Buffering', 'no')
          .send(Readable.from(stream()))
      }
      const chunks: Buffer[] = []
      let size = 0
      for (;;) {
        const v = await reader.read()
        if (v.done) break
        size += v.value.length
        if (size > 8388608) {
          await reader.cancel()
          throw Error('Model response too large')
        }
        chunks.push(Buffer.from(v.value))
      }
      authorizeResult()
      const result = JSON.parse(Buffer.concat(chunks).toString())
      finish('confirmed', result.usage)
      return result
    } catch {
      abort.abort()
      finish('ambiguous')
      return fail(502, 'Model call outcome uncertain')
    }
  })
  db.exec(
    'CREATE TABLE IF NOT EXISTS uploads(proof TEXT PRIMARY KEY,link TEXT,actor TEXT,conn TEXT,revision INTEGER,size INTEGER,mime TEXT,expires INTEGER)',
  )
  if (!all('PRAGMA table_info(uploads)').some((col) => col.name === 'op')) {
    db.exec('ALTER TABLE uploads ADD COLUMN op TEXT')
    // Pre-upgrade relay proofs lack an operation binding and expire at upgrade.
    run('DELETE FROM uploads WHERE op IS NULL')
  }
  api.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: 4194304 },
    (_r, body, done) => done(null, body),
  )
  api.post('/v1/youtube/uploads:relay', { bodyLimit: 4194304 }, async (r) => {
    if (!relay) fail(404, 'Relay unavailable')
    const g = grant(r),
      c = conn(g.tenant, g.connection_id)
    checkDispatch(g.tenant, c.provider)
    attribute(g, c, 'youtube.upload.relay')
    const location = String(r.headers['openpassword-upload-link'] || ''),
      proof = String(r.headers['openpassword-relay-seal'] || '')
    const u =
      get(
        'SELECT * FROM uploads WHERE proof=? AND link=? AND actor=? AND conn=? AND revision=? AND expires>?',
        digest(proof),
        digest(location),
        g.id,
        c.id,
        c.revision,
        now(),
      ) ?? fail(403, 'Upload not authorized')
    if (!c.active || r.headers['openpassword-connection'] !== c.id)
      fail(403, 'Upload connection changed')
    const range = String(r.headers['openpassword-content-range'] || ''),
      match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range)
    const data = r.body ?? Buffer.alloc(0),
      mime = r.headers['openpassword-content-type'] || u.mime
    const probe = range === 'bytes */' + u.size
    if (
      !Buffer.isBuffer(data) ||
      mime !== u.mime ||
      !(probe
        ? data.length === 0
        : match &&
          Number(match[3]) === u.size &&
          Number(match[2]) < u.size &&
          Number(match[2]) - Number(match[1]) + 1 === data.length &&
          data.length > 0)
    )
      fail(422, 'Invalid upload chunk')
    const token = await credential(c)
    grant(r)
    checkDispatch(g.tenant, c.provider, u.op)
    if (conn(g.tenant, c.id).revision !== c.revision) fail(409, 'Connection changed')
    const response = await send(location, {
      method: 'PUT',
      redirect: 'manual',
      headers: { Authorization: 'Bearer ' + token, 'Content-Range': range, 'Content-Type': u.mime },
      body: new Uint8Array(data as Buffer),
      signal: AbortSignal.timeout(120000),
    })
    if (![200, 201, 308].includes(response.status)) {
      await response.body?.cancel()
      return { status: response.status, range: null, resource: null, reason: null }
    }
    const body = response.status !== 308 ? ((await response.json()) as Row) : {}
    if (response.status === 308) await response.body?.cancel()
    return {
      status: response.status,
      range: response.headers.get('range'),
      resource:
        response.status === 308
          ? null
          : {
              id: typeof body.id === 'string' ? body.id : null,
              status: { privacyStatus: body.status?.privacyStatus ?? null },
            },
      reason: null,
    }
  })
  function issueScope(r: FastifyRequest, connection: string) {
    const g = grant(r),
      c = conn(g.tenant, g.connection_id)
    const resources = JSON.parse(
      get('SELECT labels FROM resources WHERE conn=?', c.id)?.labels ?? '[]',
    )
    if (
      connection !== c.id ||
      c.provider !== 'hubspot' ||
      !c.active ||
      !JSON.parse(g.ops).includes(bundleOperation) ||
      !resources.includes(issueFolder)
    )
      fail(403, 'Issue publication unavailable')
    checkDispatch(g.tenant, c.provider, bundleOperation)
    return { tenant: g.tenant, actor: g.id, conn: c.id, revision: c.revision }
  }
  api.addContentTypeParser(
    ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    { parseAs: 'buffer', bodyLimit: 4194304 },
    (_r, body, done) => done(null, body),
  )
  api.post('/v1/hubspot/issue-assets', { bodyLimit: 4194304 }, async (r, reply) => {
    const q = z
      .object({ connection_id: name, file_name: z.string(), sha256: z.string() })
      .strict()
      .parse(r.query)
    const scope = issueScope(r, q.connection_id)
    const file = await issues.stage(
      scope,
      r.body as Buffer,
      q.file_name,
      String(r.headers['content-type']),
      q.sha256,
      () => {
        if (issueScope(r, q.connection_id).revision !== scope.revision)
          fail(409, 'Connection changed')
      },
    )
    return reply.code(201).send(file)
  })
  api.get('/v1/hubspot/issues/:id', async (r) => {
    const q = z.object({ connection_id: name }).strict().parse(r.query)
    return issues.inspect(issueScope(r, q.connection_id), id(r))
  })
  api.post('/v1/operations/:operation', async (r) => {
    const g = grant(r),
      b = invocation.parse(r.body),
      operation = (r.params as { operation: string }).operation
    if (operation !== b.operation_id + ':invoke') fail(400, 'Operation mismatch')
    if (b.connection_id !== g.connection_id || !JSON.parse(g.ops).includes(b.operation_id))
      fail(403, 'Outside grant')
    const c = conn(g.tenant, b.connection_id)
    if (
      c.provider === 'remote_gateway' ||
      (b.operation_id === c.provider + '.chat' &&
        get('SELECT 1 FROM model_leases WHERE grant_id=?', g.id))
    )
      fail(403, 'Use the metered chat endpoint for this grant')
    const a = providers[c.provider].actions.find((x) => x.id === b.operation_id)!
    attribute(g, c, a.id)
    const revision = connectorRevision(c.provider, a.id)
    const legacyOne =
      b.connector_revision === '1' &&
      !sourceOperation(a.id) &&
      c.provider !== 'google_sheets' &&
      !['google.gmail.messages.read_page', 'google.gmail.labels.list'].includes(a.id)
    if (b.connector_revision && b.connector_revision !== revision && !legacyOne)
      fail(400, 'Unknown connector revision')
    const hash = digest(
      canonical([b.operation_id, b.arguments, b.expect ?? null, b.connector_revision ?? null]),
    )
    if (
      a.id.startsWith('loops.contacts.') &&
      ['loops.contacts.import_chunk', 'loops.contacts.inspect_batch'].includes(a.id)
    ) {
      checkDispatch(g.tenant, c.provider, a.id)
      if (
        b.expect &&
        (!fenced(r) ||
          b.expect.connection_revision !== String(c.revision) ||
          b.expect.external_identity !== deviceIdentity(g, c))
      )
        fail(400, 'connection_binding_changed')
      const labels: string[] = JSON.parse(
        get('SELECT labels FROM resources WHERE conn=?', c.id)?.labels || '[]',
      )
      return batch({
        tenant: g.tenant,
        conn: c.id,
        actor: g.id,
        op: a.id,
        key: b.idempotency_key,
        revision: c.revision,
        args: b.arguments,
        lists: labels,
        token: await credential(c),
        reauthorize: () => {
          grant(r)
          checkDispatch(g.tenant, c.provider, a.id)
          if (conn(g.tenant, c.id).revision !== c.revision) fail(409, 'Connection changed')
        },
      })
    }
    if (
      a.id === c.provider + '.chat' &&
      get('SELECT grant_id FROM model_leases WHERE grant_id=?', g.id)
    )
      fail(409, 'Use the lease-aware chat endpoint for this grant')
    const old = get(
      'SELECT * FROM runs WHERE actor=? AND conn=? AND idem=?',
      g.id,
      c.id,
      b.idempotency_key,
    )
    if (old && old.hash !== hash) fail(400, 'request_changed_under_key')
    if (old?.outcome) {
      const result = open(old.outcome, old.id + '/outcome')
      return {
        ...result,
        ...(a.id.endsWith('.upload_session.create')
          ? { result: { upload_url: null, relay_seal: null, replayed: true } }
          : {}),
        receipt: { ...result.receipt, replayed: true },
      }
    }
    if (old?.state === 'running') return { status: 'ambiguous', execution_id: old.id }
    checkDispatch(g.tenant, c.provider, a.id)
    if (
      !c.active ||
      (old && old.revision !== c.revision) ||
      (b.expect &&
        (!fenced(r) ||
          b.expect.external_identity !== deviceIdentity(g, c) ||
          b.expect.connection_revision !== String(c.revision)))
    )
      fail(400, 'connection_binding_changed')
    const gmail =
      a.id.startsWith('google.gmail.') &&
      ['google.gmail.labels.list', 'google.gmail.messages.read_page'].includes(a.id)
    const ex = old?.id ?? 'exec_' + randomUUID(),
      effect = a.method !== 'GET' && !['tiktok.status', 'tiktok.creator_info'].includes(a.id)
    if (old?.state === 'denied') return { status: 'refused', execution_id: ex }
    const stored = storedCredential(c)
    let secret = typeof stored === 'string' ? stored : stored.access_token
    let request: ReturnType<typeof buildRequest>
    try {
      request = buildRequest(
        c.provider,
        a.id,
        a.id === 'google.gmail.messages.read_page' ? {} : b.arguments,
        secret,
      )
    } catch {
      return fail(422, 'Invalid operation arguments')
    }
    if (
      ['google_sheets', 'supabase_data'].includes(c.provider) ||
      ['revolut.business.transactions.read_page', 'revolut.transactions.list'].includes(a.id)
    ) {
      const allowed: string[] = JSON.parse(
        get('SELECT labels FROM resources WHERE conn=?', c.id)?.labels || '[]',
      )
      if (
        !allowed.includes(
          String(
            b.arguments[
              c.provider === 'google_sheets'
                ? 'spreadsheet_id'
                : c.provider === 'revolut'
                  ? 'account_id'
                  : 'table'
            ],
          ),
        )
      )
        fail(403, 'Resource outside connection')
    }
    const upload = a.id.endsWith('.upload_session.create') ? uploadRequest(a.id, b.arguments) : null
    const scope = a.id === bundleOperation ? issueScope(r, c.id) : null
    const bundle = scope ? issues.manifest(scope, b.arguments) : null
    const template = templateOps.includes(a.id)
      ? templatePlan(
          a.id,
          b.arguments,
          JSON.parse(get('SELECT labels FROM resources WHERE conn=?', c.id)?.labels ?? '[]'),
        )
      : null
    let draftId: string | null = null
    if (a.id === 'hubspot.newsletter.update_draft') {
      const creator = get(
        "SELECT id,outcome FROM runs WHERE id=? AND tenant=? AND conn=? AND revision=? AND op='hubspot.newsletter.create_draft' AND state='confirmed'",
        name.parse(b.arguments.creation_execution_id),
        g.tenant,
        c.id,
        c.revision,
      )
      draftId = creator && open(creator.outcome, creator.id + '/outcome').result?.remote_id
      if (!draftId || !/^\d{1,20}$/.test(draftId)) fail(403, 'Original draft creation unavailable')
    }
    const inspect = a.id.endsWith('.newsletter.inspect_draft'),
      structure = a.id === 'hubspot.newsletter.read_email_structure',
      threadRef = ['threads.container.publish', 'threads.container.status'].includes(a.id)
    let boundId: string | null = null
    if (inspect || threadRef || (structure && b.arguments.creation_execution_id)) {
      if (structure && b.arguments.email_id) fail(422, 'Choose a single reference')
      const op = threadRef ? 'threads.container.create' : c.provider + '.newsletter.create_draft'
      const made = get(
        "SELECT id,hash,outcome FROM runs WHERE tenant=? AND conn=? AND revision=? AND op=? AND id=? AND state='confirmed'",
        g.tenant,
        c.id,
        c.revision,
        op,
        name.parse(b.arguments.creation_execution_id),
      )
      if (!made || (inspect && b.arguments.creation_request_digest !== 'sha256:' + made.hash))
        return fail(403, 'Original creation unavailable')
      const result = open(made.outcome, made.id + '/outcome').result
      boundId = threadRef ? result.container_id : result.remote_id
      if (!boundId || !/^\d{1,40}$/.test(boundId)) fail(403, 'Invalid creation identity')
    } else if (structure) {
      boundId = z
        .string()
        .regex(/^\d{1,20}$/)
        .parse(b.arguments.email_id)
      if (
        !JSON.parse(
          get('SELECT labels FROM resources WHERE conn=?', c.id)?.labels ?? '[]',
        ).includes(boundId)
      )
        fail(403, 'Reference email not selected')
    }
    if (['threads.container.create', 'bluesky.post.create'].includes(a.id)) {
      const text = z.string().min(1).parse(b.arguments.text)
      if (
        /[\p{Cf}\p{Cs}\p{Co}]/u.test(text) ||
        text.replace(/[\r\n\t]/g, '').match(/\p{Cc}/u) ||
        (a.id.startsWith('threads')
          ? Array.from(text).length > 500
          : Buffer.byteLength(text) > 3000)
      )
        fail(422, 'Invalid post text')
      if (
        a.id === 'bluesky.post.create' &&
        (!/^did:[a-z]+:[A-Za-z0-9._:%-]+$/.test(c.identity) ||
          typeof stored !== 'string' ||
          !stored.trimStart().startsWith('{'))
      )
        fail(403, 'Verified Bluesky session required')
    }
    const standing =
      !old &&
      tx(() => {
        const day = iso(now()).slice(0, 10),
          limit =
            ['loops.newsletter.create_campaign', 'loops.newsletter.update_email_message'].includes(
              a.id,
            ) ||
            (a.id === 'hubspot.newsletter.update_draft' &&
              !JSON.stringify(b.arguments).match(
                /"(audience|audience_segment_id|audience_filter|mailing_list_id|mailing_list_ids|subscriber_filter|segment|segment_id|recipients|to)":/,
              ))
              ? get('SELECT daily FROM draft_limits WHERE actor=? AND until>?', g.id, now())
              : null
        const blocked =
          limit &&
          get(
            "SELECT id FROM runs WHERE conn=? AND hash=? AND state IN ('pending','denied')",
            c.id,
            hash,
          )
        const used = limit
          ? get('SELECT used FROM draft_usage WHERE actor=? AND day=?', g.id, day)?.used || 0
          : 0
        if (scope && bundle) issues.reserve(scope, bundle, ex)
        const reserve = !!limit && !blocked && used < limit.daily
        if (reserve) {
          run(
            'INSERT INTO draft_usage VALUES(?,?,1) ON CONFLICT(actor,day) DO UPDATE SET used=used+1',
            g.id,
            day,
          )
          event(g.tenant, 'Standing draft approval consumed', ex)
        }
        run(
          'INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?)',
          ex,
          g.tenant,
          g.id,
          c.id,
          a.id,
          b.idempotency_key,
          hash,
          c.revision,
          effect && !reserve ? 'pending' : 'running',
          seal(
            (() => {
              if (bundle)
                return {
                  schema: 'hubspot-issue/1',
                  ...bundle,
                  folder: issueFolder + bundle.issue_id,
                }
              const snapshot = approvalSnapshot(a.id, b.arguments, {
                device_id: g.id,
                device_name: g.label,
                application_id: null,
              })
              return snapshot
                ? { snapshot, snapshot_digest: snapshotDigest(snapshot) }
                : b.arguments
            })(),
            ex + '/preview',
          ),
          now(),
        )
        return reserve
      })
    if (effect && !standing && (!old || old.state === 'pending'))
      return {
        status: 'approval_required',
        execution_id: ex,
        approval_url: origin + '/approvals/' + ex,
      }
    if (old && !run("UPDATE runs SET state='running' WHERE id=? AND state='approved'", ex).changes)
      fail(409, 'Execution already claimed')
    let outcome: Row
    try {
      if (
        typeof stored !== 'string' ||
        (['bluesky', 'reddit_read', 'github_read'].includes(c.provider) &&
          stored.trimStart().startsWith('{'))
      ) {
        secret = await credential(c)
        grant(r)
        checkDispatch(g.tenant, c.provider, a.id)
        if (conn(g.tenant, c.id).revision !== c.revision) throw Error('Connection changed')
        request = buildRequest(
          c.provider,
          a.id,
          a.id === 'google.gmail.messages.read_page' ? {} : b.arguments,
          secret,
        )
      }
      if (inspect || structure) request.url.pathname += '/' + boundId
      if (a.id === 'threads.container.create')
        request.init.body = JSON.stringify({ media_type: 'TEXT', text: b.arguments.text })
      if (a.id === 'threads.container.status') {
        request.url.pathname = '/v1.0/' + boundId
        request.url.search = 'fields=id,status,error_message'
      }
      if (a.id === 'threads.container.publish') {
        if (
          !run(
            'INSERT OR IGNORE INTO threads_publications VALUES(?,?)',
            String(b.arguments.creation_execution_id),
            ex,
          ).changes
        )
          throw Error('Container already claimed')
        request.init.body = JSON.stringify({ creation_id: boundId })
      }
      if (a.id === 'bluesky.post.create')
        request.init.body = JSON.stringify({
          repo: c.identity,
          collection: 'app.bsky.feed.post',
          record: { $type: 'app.bsky.feed.post', text: b.arguments.text, createdAt: iso(now()) },
        })
      const loopUpdate = [
        'loops.newsletter.update_email_message',
        'loops.newsletter.update_campaign_audience',
      ].includes(a.id)
      const loopsCheck = () => {
        grant(r)
        checkDispatch(g.tenant, c.provider, a.id)
        const current = conn(g.tenant, c.id)
        if (!current.active || current.revision !== c.revision) fail(409, 'Connection changed')
      }
      const currentCampaign = async () => {
        const u = buildRequest(
            'loops',
            'loops.newsletter.get_campaign',
            { campaign_id: b.arguments.campaign_id },
            secret,
          ),
          res = await pacedLoops(c.id, u.url, u.init, now() + 30000, loopsCheck)
        if (!res.ok) {
          await res.body?.cancel()
          throw Error('Campaign unavailable')
        }
        const d = await res.json()
        if (d.id !== b.arguments.campaign_id || d.status !== 'Draft')
          throw Error('Campaign is no longer a draft')
      }
      if (loopUpdate) {
        const created = get(
          "SELECT child FROM loops_created WHERE conn=? AND revision=? AND kind='campaign' AND remote=?",
          c.id,
          c.revision,
          String(b.arguments.campaign_id),
        )
        if (
          !created ||
          (a.id.endsWith('update_email_message') && created.child !== b.arguments.email_message_id)
        )
          throw Error('Campaign was not created here')
        await currentCampaign()
      }
      if (
        a.id === 'loops.newsletter.complete_upload' &&
        !get(
          "SELECT remote FROM loops_created WHERE conn=? AND revision=? AND kind='upload' AND remote=? AND until>?",
          c.id,
          c.revision,
          String(b.arguments.email_asset_id),
          now(),
        )
      )
        throw Error('Upload unavailable')
      if (draftId) {
        request.url.pathname += '/' + draftId
        const before = await send(request.url, {
          headers: request.init.headers,
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
        })
        if (!before.ok) {
          await before.body?.cancel()
          throw Error('Draft unavailable')
        }
        const prior = await before.json()
        if (
          String(prior.id) !== draftId ||
          !['DRAFT', 'AUTOMATED_DRAFT'].includes(prior.state) ||
          prior.isPublished === true ||
          prior.isTransactional === true ||
          !['BATCH_EMAIL', 'AUTOMATED_EMAIL'].includes(prior.type)
        )
          throw Error('Draft not editable')
        grant(r)
        checkDispatch(g.tenant, c.provider, a.id)
        const current = conn(g.tenant, c.id)
        if (!current.active || current.revision !== c.revision) throw Error('Connection changed')
      }
      if (scope && bundle) {
        const result = await issues.sendFiles(scope, bundle, ex, secret, send, () => {
          if (issueScope(r, c.id).revision !== scope.revision) fail(409, 'Connection changed')
        })
        outcome = {
          execution_id: ex,
          status: result.state === 'complete' ? 'confirmed' : 'ambiguous',
          result: result.state === 'complete' ? result : null,
          receipt: { issue_bundle: result, request_digest: 'sha256:' + hash },
        }
      } else if (template) {
        const result = await writeTemplate(template, secret, send, () => {
          grant(r)
          checkDispatch(g.tenant, c.provider, a.id)
          const live = conn(g.tenant, c.id)
          if (!live.active || live.revision !== c.revision) fail(409, 'Connection changed')
        })
        outcome = {
          status: 'confirmed',
          execution_id: ex,
          result,
          receipt: {
            connector_revision: revision,
            request_digest: 'sha256:' + hash,
            result_digest: 'sha256:' + digest(canonical(result)),
          },
        }
      } else if (sourceOperation(a.id)) {
        const result = await readSource(
          a.id,
          request.url,
          request.init.headers,
          send,
          hash,
          () =>
            tx(() => {
              grant(r)
              checkDispatch(g.tenant, c.provider, a.id)
              const day = iso(now()).slice(0, 10),
                row = get('SELECT * FROM read_budgets WHERE conn=?', c.id)
              if (row && (row.until > now() || (row.day === day && row.used >= 2000)))
                throw new ReadFailure('RATE_LIMITED', 'read budget exhausted')
              run(
                'INSERT INTO read_budgets VALUES(?,?,1,0) ON CONFLICT(conn) DO UPDATE SET used=CASE WHEN day=excluded.day THEN used+1 ELSE 1 END,day=excluded.day',
                c.id,
                day,
              )
            }),
          (until) => {
            run('UPDATE read_budgets SET until=? WHERE conn=?', until, c.id)
          },
        )
        outcome = {
          status: 'confirmed',
          execution_id: ex,
          result,
          receipt: { connector_revision: revision, result_digest: 'sha256:' + result.body_sha256 },
        }
      } else if (a.id === 'revolut.receipts.get') {
        const res = await send(request.url, request.init)
        if (!res.ok || !res.body) {
          await res.body?.cancel()
          throw Error('Receipt unavailable')
        }
        const reader = res.body.getReader(),
          chunks: Buffer[] = []
        let size = 0
        for (;;) {
          const v = await reader.read()
          if (v.done) break
          size += v.value.length
          if (size > 10485760) {
            await reader.cancel()
            throw Error('Receipt too large')
          }
          chunks.push(Buffer.from(v.value))
        }
        const bytes = Buffer.concat(chunks),
          artifact = 'art_' + randomUUID(),
          sha = 'sha256:' + digest(bytes),
          mime =
            res.headers.get('content-type')?.split(';')[0]?.slice(0, 255) ??
            'application/octet-stream'
        grant(r)
        checkDispatch(g.tenant, c.provider, a.id)
        run(
          'INSERT INTO artifacts VALUES(?,?,?,?,?)',
          artifact,
          c.id,
          g.id,
          now() + 900000,
          seal({ binary: true, base64: bytes.toString('base64') }, artifact),
        )
        outcome = {
          status: 'confirmed',
          execution_id: ex,
          result: null,
          artifact: {
            artifact_id: artifact,
            content_sha256: sha,
            size_bytes: size,
            media_type: mime,
            filename: 'receipt',
          },
          receipt: { connector_revision: revision, result_digest: sha },
        }
      } else if (upload) {
        const response = await send(upload.url, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + secret,
            'Content-Type': 'application/json',
            'X-Upload-Content-Type': upload.mime,
            'X-Upload-Content-Length': String(upload.size),
          },
          body: upload.body ? JSON.stringify(upload.body) : undefined,
          redirect: 'error',
          signal: AbortSignal.timeout(60000),
        })
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (!response.ok || !location) throw Error('Session unavailable')
        const link = new URL(location)
        if (
          link.origin !== upload.url.origin ||
          link.pathname !== upload.url.pathname ||
          link.username ||
          link.password ||
          link.hash ||
          !link.searchParams.has('upload_id')
        )
          throw Error('Unexpected upload location')
        const proof = relay ? opaque() : null
        if (proof)
          run(
            'INSERT INTO uploads VALUES(?,?,?,?,?,?,?,?,?)',
            digest(proof),
            digest(location),
            g.id,
            c.id,
            c.revision,
            upload.size,
            upload.mime,
            now() + 86400000,
            a.id,
          )
        outcome = {
          status: 'confirmed',
          execution_id: ex,
          result: { upload_url: location, relay_seal: proof },
          receipt: { connector_revision: revision, result_digest: 'sha256:' + digest(ex) },
        }
      } else if (a.id === 'google.gmail.messages.read_page') {
        const labels = JSON.parse(
          get('SELECT labels FROM resources WHERE conn=?', c.id)?.labels || '[]',
        )
        const body = canonical(await gmailPage(b.arguments, labels, secret, send)),
          artifact = 'art_' + randomUUID(),
          sha = 'sha256:' + digest(body)
        run('DELETE FROM artifacts WHERE expires<=?', now())
        run(
          'INSERT INTO artifacts VALUES(?,?,?,?,?)',
          artifact,
          c.id,
          g.id,
          now() + 900000,
          seal(body, artifact),
        )
        outcome = {
          status: 'confirmed',
          execution_id: ex,
          result: null,
          artifact: {
            artifact_id: artifact,
            content_sha256: sha,
            size_bytes: Buffer.byteLength(body),
            media_type: 'application/json',
            filename: 'selected-artifact',
          },
          approval_url: null,
          normalized_error: null,
          receipt: { result_digest: sha, connector_revision: revision },
        }
      } else {
        const res =
          c.provider === 'loops'
            ? await pacedLoops(c.id, request.url, request.init, now() + 120000, () => {
                grant(r)
                checkDispatch(g.tenant, c.provider, a.id)
                const live = conn(g.tenant, c.id)
                if (!live.active || live.revision !== c.revision) fail(409, 'Connection changed')
              })
            : await send(request.url, request.init)
        if (!res.ok) {
          await res.body?.cancel()
          throw Error('Provider refused')
        }
        const reader = res.body?.getReader()
        const chunks: Buffer[] = []
        let size = 0
        if (reader)
          for (;;) {
            const item = await reader.read()
            if (item.done) break
            size += item.value.length
            if (size > 10 * 1024 * 1024) {
              await reader.cancel()
              throw Error('Response too large')
            }
            chunks.push(Buffer.from(item.value))
          }
        const raw = Buffer.concat(chunks).toString()
        if (raw.includes(secret)) throw Error('Sensitive response')
        let result = raw
          ? JSON.parse(raw, (k: string, v: unknown, ctx?: { source?: string }) =>
              c.provider === 'revolut' &&
              typeof v === 'number' &&
              ['balance', 'amount', 'fee', 'bill_amount', 'percentage'].includes(k)
                ? (ctx?.source ?? String(v))
                : /^(access_token|refresh_token|client_secret|api_key|password|authorization)$/i.test(
                      k,
                    )
                  ? undefined
                  : v,
            )
          : null
        if (['revolut.business.accounts.list', 'revolut.accounts.read'].includes(a.id)) {
          const ids: string[] = JSON.parse(
            get('SELECT labels FROM resources WHERE conn=?', c.id)?.labels || '[]',
          )
          result = result.filter((x: Row) => ids.includes(x.id))
        }
        if (inspect || structure) {
          const d = c.provider === 'kit' ? (result.broadcast ?? result) : result
          if (String(d.id) !== boundId) throw Error('Provider object identity changed')
          if (structure) {
            const word = (v: unknown, n = 80) =>
              ['string', 'number'].includes(typeof v)
                ? String(v)
                    .replace(/[^A-Za-z0-9_.:/@-]/g, '_')
                    .slice(0, n)
                : null
            const fields = (v: any) =>
              Object.keys(v ?? {})
                .sort()
                .slice(0, 50)
                .map((k) => word(k))
            result = {
              template_path: word(d.content?.templatePath, 200),
              widgets: Object.fromEntries(
                Object.entries(d.content?.widgets ?? {})
                  .slice(0, 100)
                  .map(([k, v]) => [word(k)!, word((v as Row)?.type ?? (v as Row)?.module_id)]),
              ),
              flex_areas: Object.fromEntries(
                Object.entries(d.content?.flexAreas ?? {})
                  .slice(0, 50)
                  .map(([k, v]) => [word(k)!, fields(v)]),
              ),
              subscription_id: word(d.subscriptionDetails?.subscriptionId),
              office_location_id: word(d.subscriptionDetails?.officeLocationId),
              state: word(d.state),
            }
          } else {
            const common = {
              observation_ref: c.provider + '-observation-' + randomUUID().replaceAll('-', ''),
              remote_id: boundId,
              observed_at: iso(now()),
              publication_authorization: 'not_authorized',
            }
            if (c.provider === 'kit')
              result = {
                ...common,
                provider_content_digest:
                  typeof d.content === 'string'
                    ? digest(
                        canonical({
                          subject: d.subject,
                          content: d.content,
                          preview_text: d.preview_text,
                        }),
                      )
                    : null,
                provider_version: d.updated_at ?? null,
                provider_result_digest: digest(canonical(d)),
                resource_url: request.url.href,
                resource_link_kind: 'authenticated_provider_api',
                verified_link: null,
                matches_creation_content: null,
                delivery_state:
                  d.public === false && d.send_at == null ? 'draft' : 'requires_review',
              }
            else {
              const content = {
                subject: d.subject ?? null,
                from_name: d.from?.fromName ?? null,
                plain_text: d.content?.plainTextVersion ?? null,
                body_html: d.content?.html ?? null,
              }
              result = {
                ...common,
                ...content,
                readable_digest: digest(
                  canonical(
                    Object.fromEntries(
                      Object.entries(content).filter(([, v]) => typeof v === 'string'),
                    ),
                  ),
                ),
                provider_version: d.updatedAt ?? null,
                provider_state: d.state ?? null,
                delivery_state: d.state === 'DRAFT' ? 'draft' : 'requires_review',
              }
            }
          }
        }
        if (a.id === 'threads.container.create') {
          result = {
            container_id: z.string().regex(/^\d+$/).parse(result.id),
            stage: 'created',
            creation_execution_id: ex,
          }
        }
        if (a.id === 'threads.container.publish') {
          result = { post_id: z.string().regex(/^\d+$/).parse(result.id), stage: 'published' }
        }
        if (a.id === 'threads.container.status') {
          if (String(result.id) !== boundId) throw Error('Container mismatch')
          result = { container_id: boundId, provider_status: z.string().parse(result.status) }
        }
        if (a.id === 'bluesky.post.create') {
          if (
            typeof result.cid !== 'string' ||
            !result.cid ||
            typeof result.uri !== 'string' ||
            !result.uri.startsWith('at://' + c.identity + '/app.bsky.feed.post/')
          )
            throw Error('Record identity changed')
          result = { uri: result.uri, cid: result.cid, stage: 'published' }
        }
        if (a.id === 'loops.newsletter.update_email_message') {
          if (result?.id !== b.arguments.email_message_id || !result.contentRevisionId)
            throw Error('Revision unconfirmed')
          await currentCampaign()
          result = {
            provider: 'loops',
            operation: 'update_email_message',
            delivery_state: 'draft',
            publication_authorization: 'not_authorized',
            remote_id: result.id,
            content_revision_id: result.contentRevisionId,
            lmx_sha256: digest(String(b.arguments.lmx)),
            warning_count: Array.isArray(result.warnings) ? result.warnings.length : 0,
          }
        }
        if (a.id === 'loops.newsletter.update_campaign_audience') {
          if (result?.id !== b.arguments.campaign_id || result.status !== 'Draft')
            throw Error('Draft unconfirmed')
          result = {
            provider: 'loops',
            operation: 'update_campaign_audience',
            delivery_state: 'draft',
            publication_authorization: 'not_authorized',
            remote_id: result.id,
            mailing_list_id: result.mailingListId ?? null,
            audience_segment_id: result.audienceSegmentId ?? null,
          }
        }
        if (
          a.id === 'loops.newsletter.create_upload' ||
          a.id === 'loops.newsletter.complete_upload'
        ) {
          const create = a.id.endsWith('create_upload'),
            id = z
              .string()
              .regex(/^[A-Za-z0-9_-]{1,80}$/)
              .parse(result?.emailAssetId),
            u = new URL(create ? result.presignedUrl : result.finalUrl)
          if (
            u.protocol !== 'https:' ||
            u.username ||
            u.password ||
            u.port ||
            u.hash ||
            (create
              ? u.hostname !== 'loops-assets.s3.amazonaws.com' || u.pathname !== '/uploads/' + id
              : !(u.hostname.endsWith('.loops.so') || u.hostname.endsWith('.vialoops.com')) ||
                id !== b.arguments.email_asset_id)
          )
            throw Error('Upload address refused')
          result = {
            provider: 'loops',
            operation: create ? 'create_upload' : 'complete_upload',
            publication_authorization: 'not_authorized',
            remote_id: id,
            ...(create
              ? { created_at: iso(now()), ...b.arguments, upload_url: u.href }
              : { final_url: u.href }),
          }
        }
        result =
          a.id === 'revolut.transactions.list'
            ? project('revolut.business.transactions.read_page', result, b.arguments).transactions
            : a.id === 'revolut.accounts.read'
              ? project('revolut.business.accounts.list', result, b.arguments).accounts
              : project(a.id, result, b.arguments)
        if (
          [
            'kit.newsletter.create_draft',
            'hubspot.newsletter.create_draft',
            'hubspot.newsletter.update_draft',
          ].includes(a.id)
        ) {
          const d = c.provider === 'kit' ? (result?.broadcast ?? result) : result
          if (
            !d ||
            (draftId && String(d.id) !== draftId) ||
            !['number', 'string'].includes(typeof d.id) ||
            !String(d.id) ||
            d.send_at ||
            d.public === true ||
            (d.state && d.state !== 'DRAFT')
          )
            throw Error('Unverified draft')
          result = {
            provider: c.provider,
            remote_id: String(d.id),
            delivery_state: 'draft',
            publication_authorization: 'not_authorized',
            verified_link: null,
            provider_result_digest: digest(canonical(d)),
          }
        }
        if (c.provider === 'google_sheets') result = sheetsResult(a.id, result)
        if (a.id === 'google.gmail.labels.list')
          result = z
            .object({ labels: z.array(z.object({ id: z.string(), name: z.string() })).max(10000) })
            .parse(result)
        outcome = {
          status: 'confirmed',
          execution_id: ex,
          result,
          receipt: {
            connector_revision: revision,
            request_digest: 'sha256:' + hash,
            result_digest: 'sha256:' + digest(canonical(result)),
          },
        }
      }
    } catch (e) {
      outcome = {
        status: effect ? 'ambiguous' : 'failed_safe',
        execution_id: ex,
        normalized_error:
          e instanceof GmailError || e instanceof ReadFailure
            ? { code: e.code, message: e.message }
            : gmail
              ? { code: 'REQUEST_REFUSED', message: 'gmail_response_invalid' }
              : { code: 'REQUEST_REFUSED', message: 'provider_unavailable' },
      }
    }
    const storedOutcome =
      sourceOperation(a.id) && outcome.result
        ? {
            ...outcome,
            result: Object.fromEntries(
              Object.entries(outcome.result).filter(([key]) => key !== 'body_base64'),
            ),
          }
        : outcome
    if (a.id === 'loops.newsletter.create_upload' && storedOutcome.result?.upload_url) {
      const { upload_url, ...rest } = storedOutcome.result
      outcome = { ...outcome, result: { ...outcome.result } }
      storedOutcome.result = { ...rest, upload_url: null }
    }
    tx(() => {
      if (outcome.status === 'confirmed') {
        if (a.id === 'loops.newsletter.create_campaign')
          run(
            "INSERT OR REPLACE INTO loops_created VALUES(?,?,'campaign',?,?,NULL)",
            c.id,
            c.revision,
            outcome.result.remote_id,
            outcome.result.email_message_id ?? null,
          )
        if (a.id === 'loops.newsletter.create_upload')
          run(
            "INSERT OR REPLACE INTO loops_created VALUES(?,?,'upload',?,NULL,?)",
            c.id,
            c.revision,
            outcome.result.remote_id,
            now() + 3600000,
          )
        if (a.id === 'loops.newsletter.complete_upload')
          run(
            "DELETE FROM loops_created WHERE conn=? AND revision=? AND kind='upload' AND remote=?",
            c.id,
            c.revision,
            outcome.result.remote_id,
          )
      }
      run(
        'UPDATE runs SET state=?,outcome=? WHERE id=?',
        outcome.status,
        seal(storedOutcome, ex + '/outcome'),
        ex,
      )
      event(g.tenant, a.id + ' · ' + outcome.status, ex)
    })
    return outcome
  })
  inbound(
    api,
    db,
    origin,
    (r) => {
      const s = session(r)
      if (s.role !== 'owner') fail(403, 'Owner required')
      if (r.method === 'POST') own(r, z.object({ connection_id: name }).parse(r.body).connection_id)
      return s.tenant
    },
    intakeBody,
    seal,
    open,
  )
  if (limits.engineBin) infrastructure = engines(db, limits.engineBin, feed.signal, feed.wakeAll)
  return api
}
