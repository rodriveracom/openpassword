import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  createPrivateKey,
  createPublicKey,
} from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { opaque, digest } from './store.ts'
import type { StepUp } from './passkeys.ts'
const actionClass = z.enum(['conversation.read', 'conversation.write', 'attention.write'])
const classList = z
  .array(actionClass)
  .max(3)
  .refine((v) => new Set(v).size === v.length)
type Session = { token: string; tenant: string; role: string; member: string | null }
type Row = Record<string, any>
const strictCode = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  appId = z.string().regex(/^app_[0-9a-f-]{36}$/)
const iso = (t: number) => new Date(t).toISOString(),
  enc = (v: object) => Buffer.from(JSON.stringify(v, Object.keys(v).sort())).toString('base64url')
const esc = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
// Asks the authenticator when the form is submitted, then posts the same form with the assertion in it.
const approvalScript = (nonce: string, options: unknown) =>
  '<script nonce="' +
  nonce +
  '">const o=' +
  JSON.stringify(options).replace(/</g, '\\u003c') +
  ';const f=document.querySelector("form");f.addEventListener("submit",async e=>{e.preventDefault();try{const c=await navigator.credentials.get({publicKey:PublicKeyCredential.parseRequestOptionsFromJSON(o)});f.elements.approval.value=JSON.stringify(c.toJSON());f.submit()}catch{document.getElementById("failed").textContent="Passkey approval did not complete. Reload to try again."}})</script>'
// Confirming is answered with a redirect to the application, and form-action governs that redirect too.
// Only the registered callback's origin is added. A host that is not a plain CSP source (it could end
// the directive, or is an IP literal in brackets) adds nothing.
export function formTarget(callback: string) {
  const { origin } = new URL(callback)
  return /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.?(:\d{1,5})?$/.test(origin) ? ' ' + origin : ''
}
export function delegation(
  api: FastifyInstance,
  db: DatabaseSync,
  origin: string,
  session: (r: FastifyRequest) => Session,
  seal: (v: unknown, id: string) => string,
  open: (v: string, id: string) => any,
  event: (t: string, a: string, s: string) => unknown,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS delegation_apps(id TEXT PRIMARY KEY,tenant TEXT,label TEXT,callback TEXT,audience TEXT,expires INTEGER,active INTEGER,version INTEGER);
 CREATE TABLE IF NOT EXISTS delegation_attempts(id TEXT PRIMARY KEY,app TEXT,version INTEGER,state TEXT,challenge TEXT,expires INTEGER,session TEXT,csrf TEXT);
 CREATE TABLE IF NOT EXISTS delegation_codes(hash TEXT PRIMARY KEY,gid TEXT,app TEXT,version INTEGER,challenge TEXT,session TEXT,tenant TEXT,sub TEXT,expires INTEGER,grant_end INTEGER,used INTEGER,revoked INTEGER);
 CREATE TABLE IF NOT EXISTS delegation_signer(id INTEGER PRIMARY KEY,envelope TEXT);`)
  const run = (sql: string, ...p: (string | number | null)[]) => db.prepare(sql).run(...p)
  const get = (sql: string, ...p: (string | number)[]) =>
    db.prepare(sql).get(...p) as Row | undefined
  db.exec(`CREATE TABLE IF NOT EXISTS delegation_retired(kid TEXT PRIMARY KEY,key TEXT,ended INTEGER);
  CREATE TABLE IF NOT EXISTS delegation_policies(app TEXT PRIMARY KEY,classes TEXT NOT NULL,member_write INTEGER NOT NULL,check_hash TEXT);
  CREATE TABLE IF NOT EXISTS delegation_scopes(attempt TEXT PRIMARY KEY,classes TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS delegation_grant_classes(gid TEXT PRIMARY KEY,classes TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS delegation_gid ON delegation_codes(gid);
  CREATE INDEX IF NOT EXISTS delegation_session ON delegation_codes(session);
  CREATE TABLE IF NOT EXISTS delegation_owner(id INTEGER PRIMARY KEY,subject TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS delegation_refresh(hash TEXT PRIMARY KEY,gid TEXT NOT NULL,used INTEGER NOT NULL);
  CREATE TRIGGER IF NOT EXISTS delegation_logout AFTER DELETE ON sessions BEGIN UPDATE delegation_codes SET revoked=1 WHERE session=OLD.token; END;`)
  const policy = (id: string) =>
    get('SELECT * FROM delegation_policies WHERE app=?', id) ?? {
      classes: '[]',
      member_write: 0,
      check_hash: null,
    }
  const allowed = (classes: string[], role: string, app: string) =>
    classes.every(
      (c) =>
        c === 'conversation.read' ||
        role === 'owner' ||
        (role === 'editor' && policy(app).member_write === 1),
    )
  const granted = (gid: string): string[] =>
    JSON.parse(
      get('SELECT classes FROM delegation_grant_classes WHERE gid=?', gid)?.classes || '[]',
    )
  run('INSERT OR IGNORE INTO delegation_owner VALUES(1,?)', randomUUID())
  const owner = get('SELECT subject FROM delegation_owner WHERE id=1')!.subject
  const humanIssuer = origin + '/auth/v1'
  const roleFor = (g: Row) =>
    g.sub === 'owner' || g.sub === owner
      ? 'owner'
      : get('SELECT role FROM members WHERE id=? AND tenant=? AND active=1', g.sub, g.tenant)?.role
  const current = (id: string) =>
    get('SELECT * FROM delegation_apps WHERE id=? AND active=1 AND expires>?', id, Date.now())
  const signingKey = () => {
    if (!get('SELECT id FROM delegation_signer WHERE id=1')) {
      const pair = generateKeyPairSync('ed25519')
      run(
        'INSERT OR IGNORE INTO delegation_signer VALUES(1,?)',
        seal(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), 'delegation/signing-key'),
      )
    }
    return createPrivateKey(
      open(
        get('SELECT envelope FROM delegation_signer WHERE id=1')!.envelope,
        'delegation/signing-key',
      ),
    )
  }
  const thumb = () =>
    digest(createPublicKey(signingKey()).export({ type: 'spki', format: 'pem' }).toString()).slice(
      0,
      20,
    )
  api.post('/admin/delegation/signing-key/rotate', async (r, reply) => {
    const s = session(r)
    if (s.role !== 'owner') return reply.code(403).send({ error: 'owner_required' })
    db.exec('BEGIN IMMEDIATE')
    try {
      const at = Math.floor(Date.now() / 1000),
        key = signingKey(),
        retired = thumb()
      run('DELETE FROM delegation_retired WHERE ended<?', at - 30 * 86400)
      run(
        'INSERT INTO delegation_retired VALUES(?,?,?)',
        retired,
        createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString(),
        at,
      )
      run('DELETE FROM delegation_signer WHERE id=1')
      const kid = thumb()
      event(s.tenant, 'Delegation signing key rotated', kid)
      db.exec('COMMIT')
      return { kid, retired }
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  })
  api.delete('/admin/delegation/grants/:id', async (r, reply) => {
    const s = session(r)
    if (s.role !== 'owner') return reply.code(403).send({ error: 'owner_required' })
    const gid = (r.params as { id: string }).id
    if (
      !run(
        'UPDATE delegation_codes SET revoked=1 WHERE tenant=? AND gid=? AND revoked=0',
        s.tenant,
        gid,
      ).changes
    )
      return reply.code(404).send({ error: 'unknown_grant' })
    event(s.tenant, 'Delegation revoked', gid)
    return reply.code(204).send()
  })
  api.get('/admin/apps', async (r) => {
    const s = session(r)
    return db
      .prepare(
        'SELECT id,label,callback,audience,expires,active FROM delegation_apps WHERE tenant=? ORDER BY label',
      )
      .all(s.tenant)
  })
  api.post('/admin/apps', async (r, reply) => {
    const s = session(r)
    if (s.role !== 'owner') return reply.code(403).send({ error: 'owner_required' })
    const b = z
      .object({
        label: z.string().trim().min(1).max(160),
        callback: z.url().max(1000),
        audience: z.string().regex(/^[a-zA-Z0-9.-]{1,200}$/),
        days: z.number().int().min(1).max(365),
        classes: classList.default([]),
        member_write_allowed: z.boolean().default(false),
      })
      .strict()
      .parse(r.body)
    const uri = new URL(b.callback)
    // A host the confirmation page cannot name as a form target could never complete a sign-in.
    if (
      uri.protocol !== 'https:' ||
      uri.username ||
      uri.password ||
      uri.hash ||
      uri.search ||
      !formTarget(b.callback)
    )
      return reply.code(422).send({ error: 'invalid_uri' })
    const id = 'app_' + randomUUID()
    run(
      'INSERT INTO delegation_apps VALUES(?,?,?,?,?,?,0,1)',
      id,
      s.tenant,
      b.label,
      b.callback,
      b.audience,
      Date.now() + b.days * 86400000,
    )
    const check = b.classes.length ? opaque() : null
    run(
      'INSERT INTO delegation_policies VALUES(?,?,?,?)',
      id,
      JSON.stringify(b.classes.sort()),
      Number(b.member_write_allowed),
      check ? digest(check) : null,
    )
    event(s.tenant, 'Identity application registered', id)
    return { id, ...(check ? { check_credential: check } : {}) }
  })
  api.post('/admin/apps/:id', async (r, reply) => {
    const s = session(r),
      id = (r.params as { id: string }).id
    if (s.role !== 'owner') return reply.code(403).send({ error: 'owner_required' })
    const { active } = z.object({ active: z.boolean() }).strict().parse(r.body)
    if (
      !run(
        'UPDATE delegation_apps SET active=?,version=version+1 WHERE id=? AND tenant=?',
        Number(active),
        id,
        s.tenant,
      ).changes
    )
      return reply.code(404).send({ error: 'unknown_application' })
    if (active) signingKey()
    event(
      s.tenant,
      active ? 'Identity application activated' : 'Identity application suspended',
      id,
    )
    return { active }
  })
  api.get('/.well-known/openpassword-jwks.json', async () => ({
    keys: !get('SELECT id FROM delegation_signer WHERE id=1')
      ? []
      : [
          {
            ...createPublicKey(signingKey()).export({ format: 'jwk' }),
            alg: 'EdDSA',
            use: 'sig',
            kid: thumb(),
          },
        ],
  }))
  api.get('/.well-known/openpassword-delegation-keys.json', async () => ({
    keys: get('SELECT id FROM delegation_signer WHERE id=1')
      ? [
          {
            kid: thumb(),
            alg: 'EdDSA',
            public_key: createPublicKey(signingKey()).export({ format: 'jwk' }).x,
            not_before: 0,
            not_after: 253402300799,
          },
        ]
      : [],
  }))
  api.get('/delegate', async (r, reply) => {
    const q = z
      .object({
        application_id: appId,
        redirect_uri: z.string(),
        state: strictCode,
        code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        code_challenge_method: z.literal('S256'),
        classes: z.string().max(120),
      })
      .strict()
      .safeParse(r.query)
    if (!q.success) return reply.code(400).send({ error: 'invalid_request' })
    const b = q.data,
      a = current(b.application_id)
    if (!a || a.callback !== b.redirect_uri)
      return reply.code(403).send({ error: 'application_refused' })
    const classes = classList.safeParse(b.classes ? b.classes.split(' ') : []),
      registered: string[] = JSON.parse(policy(a.id).classes)
    if (
      !classes.success ||
      (registered.length > 0 && !classes.data.length) ||
      !classes.data.every((c) => registered.includes(c))
    )
      return reply.code(403).send({ error: 'application_refused' })
    const id = 'att_' + opaque()
    run(
      'DELETE FROM delegation_scopes WHERE attempt IN (SELECT id FROM delegation_attempts WHERE expires<=?)',
      Date.now(),
    )
    run('DELETE FROM delegation_attempts WHERE expires<=?', Date.now())
    run(
      'INSERT INTO delegation_attempts VALUES(?,?,?,?,?,?,NULL,NULL)',
      id,
      a.id,
      a.version,
      b.state,
      b.code_challenge,
      Date.now() + 300000,
    )
    run('INSERT INTO delegation_scopes VALUES(?,?)', id, JSON.stringify(classes.data.sort()))
    return reply.redirect(origin + '/delegate/confirm?attempt=' + id, 303)
  })
  api.get('/delegate/confirm', async (r, reply) => {
    const s = session(r),
      { attempt } = z.object({ attempt: z.string() }).parse(r.query),
      t = get('SELECT * FROM delegation_attempts WHERE id=? AND expires>?', attempt, Date.now()),
      a = t && current(t.app)
    if (
      !t ||
      !a ||
      s.tenant !== a.tenant ||
      a.version !== t.version ||
      (t.session && s.token !== t.session)
    )
      return reply.code(403).send({ error: 'application_refused' })
    const classes: string[] = JSON.parse(
      get('SELECT classes FROM delegation_scopes WHERE attempt=?', attempt)?.classes || '[]',
    )
    if (!allowed(classes, s.role, a.id))
      return reply.code(403).send({ error: 'application_refused' })
    const csrf = opaque()
    run(
      'UPDATE delegation_attempts SET session=?,csrf=? WHERE id=?',
      s.token,
      digest(csrf),
      attempt,
    )
    // With an enrolled passkey, consent to a new grant needs a fresh approval, as console changes do.
    const approval = await api
      .getDecorator<StepUp>('stepUp')
      .offer(s.member || 'owner', s.token, 'delegate:' + attempt)
    const nonce = approval ? opaque() : ''
    return reply
      .type('text/html')
      .header(
        'Content-Security-Policy',
        "default-src 'none'; frame-ancestors 'none'; form-action 'self'" +
          formTarget(String(a.callback)) +
          "; style-src 'unsafe-inline'" +
          (approval ? "; script-src 'nonce-" + nonce + "'" : ''),
      )
      .send(
        '<!doctype html><meta name="viewport" content="width=device-width"><title>Confirm sign-in · OpenPassword</title><main style="max-width:34rem;margin:12vh auto;padding:2rem;font:1rem system-ui;color:#25221e"><strong>OpenPassword</strong><h1>Sign in to ' +
          esc(a.label) +
          '?</h1><p>Share your workspace identity with ' +
          esc(a.audience) +
          ' · ' +
          esc(classes.join(', ') || 'Identity only') +
          '.</p><form method="post" action="/delegate/confirm"><input type="hidden" name="attempt" value="' +
          esc(attempt) +
          '"><input type="hidden" name="csrf" value="' +
          csrf +
          '">' +
          (approval
            ? '<input type="hidden" name="approval_id" value="' +
              esc(approval.id) +
              '"><input type="hidden" name="approval">'
            : '') +
          '<button style="padding:.7rem 1rem">Confirm sign-in</button></form>' +
          (approval ? '<p role="alert" id="failed"></p>' : '') +
          '</main>' +
          (approval ? approvalScript(nonce, approval.options) : ''),
      )
  })
  api.addContentTypeParser(
    'application/x-www-form-urlencoded',
    // Room for a passkey assertion beside the consent fields.
    { parseAs: 'string', bodyLimit: 16384 },
    (_r, b, done) => done(null, Object.fromEntries(new URLSearchParams(String(b)))),
  )
  api.post('/delegate/confirm', async (r, reply) => {
    const s = session(r)
    if (r.headers.origin !== origin) return reply.code(403).send({ error: 'application_refused' })
    const { attempt, csrf, approval_id, approval } = z
      .object({
        attempt: z.string(),
        csrf: strictCode,
        approval_id: z.string().max(128).optional(),
        approval: z.string().max(12000).optional(),
      })
      .strict()
      .parse(r.body)
    await api
      .getDecorator<StepUp>('stepUp')
      .confirm(s.member || 'owner', s.token, 'delegate:' + attempt, approval_id, approval)
    if (session(r).token !== s.token)
      return reply.code(403).send({ error: 'application_refused' })
    const t = get(
        'SELECT * FROM delegation_attempts WHERE id=? AND session=? AND csrf=? AND expires>?',
        attempt,
        s.token,
        digest(csrf),
        Date.now(),
      ),
      a = t && current(t.app)
    if (!t || !a || a.tenant !== s.tenant || t.version !== a.version)
      return reply.code(403).send({ error: 'application_refused' })
    const scopes =
      get('SELECT classes FROM delegation_scopes WHERE attempt=?', attempt)?.classes || '[]'
    if (!allowed(JSON.parse(scopes), s.role, a.id))
      return reply.code(403).send({ error: 'application_refused' })
    const code = opaque(),
      gid = 'gid_' + randomUUID().replaceAll('-', ''),
      expiry = get('SELECT expires FROM sessions WHERE token=?', s.token)!.expires
    db.exec('BEGIN IMMEDIATE')
    try {
      if (!run('DELETE FROM delegation_attempts WHERE id=?', attempt).changes)
        throw Error('Attempt consumed')
      run(
        'INSERT INTO delegation_codes VALUES(?,?,?,?,?,?,?,?,?,?,0,0)',
        digest(code),
        gid,
        a.id,
        a.version,
        t.challenge,
        s.token,
        s.tenant,
        s.member || owner,
        Date.now() + 60000,
        Math.min(expiry, a.expires, scopes === '[]' ? Date.now() + 600000 : expiry),
      )
      run('INSERT INTO delegation_grant_classes VALUES(?,?)', gid, scopes)
      run('DELETE FROM delegation_scopes WHERE attempt=?', attempt)
      event(s.tenant, 'Identity granted', gid)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    const url = new URL(a.callback)
    url.search = new URLSearchParams({ code, state: t.state }).toString()
    return reply.redirect(url.href, 303)
  })
  api.post('/delegate/exchange', { bodyLimit: 4096 }, async (r, reply) => {
    if (r.headers.cookie || r.headers.origin)
      return reply.code(400).send({ error: 'invalid_request' })
    if ((r.body as Row)?.grant_type === 'refresh') {
      const request = z
        .object({
          grant_type: z.literal('refresh'),
          application_id: appId,
          refresh_credential: strictCode,
        })
        .strict()
        .safeParse(r.body)
      if (!request.success) return reply.code(401).send({ error: 'invalid_grant' })
      const f = get(
        'SELECT * FROM delegation_refresh WHERE hash=?',
        digest(request.data.refresh_credential),
      )
      const g =
        f &&
        get(
          'SELECT * FROM delegation_codes WHERE gid=? AND app=?',
          f.gid,
          request.data.application_id,
        )
      if (!g || !f) return reply.code(401).send({ error: 'invalid_grant' })
      const a = current(g.app),
        s = get('SELECT * FROM sessions WHERE token=? AND expires>?', g.session, Date.now()),
        role = roleFor(g)
      if (f.used) {
        run('UPDATE delegation_codes SET revoked=1 WHERE gid=?', g.gid)
        return reply.code(401).send({ error: 'invalid_grant' })
      }
      if (
        !a ||
        !s ||
        s.tenant !== g.tenant ||
        g.revoked ||
        a.version !== g.version ||
        g.grant_end <= Date.now() ||
        !role ||
        !allowed(granted(g.gid), role, a.id)
      )
        return reply.code(401).send({ error: 'invalid_grant' })
      db.exec('BEGIN IMMEDIATE')
      try {
        if (!run('UPDATE delegation_refresh SET used=1 WHERE hash=? AND used=0', f.hash).changes) {
          run('UPDATE delegation_codes SET revoked=1 WHERE gid=?', g.gid)
          db.exec('COMMIT')
          return reply.code(401).send({ error: 'invalid_grant' })
        }
        const result = issue(g, a, s)
        db.exec('COMMIT')
        return result
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    }
    const b = z
      .object({
        grant_type: z.literal('authorization_code'),
        application_id: appId,
        redirect_uri: z.string(),
        code: strictCode,
        code_verifier: strictCode,
      })
      .strict()
      .safeParse(r.body)
    if (!b.success)
      return reply.code((r.body as Row)?.grant_type === 'refresh' ? 401 : 400).send({
        error: (r.body as Row)?.grant_type === 'refresh' ? 'invalid_grant' : 'invalid_request',
      })
    const c = b.data,
      g = get('SELECT * FROM delegation_codes WHERE hash=?', digest(c.code)),
      a = current(c.application_id),
      now = Date.now()
    const s = g && get('SELECT * FROM sessions WHERE token=? AND expires>?', g.session, now)
    if (
      !g ||
      !a ||
      !s ||
      s.tenant !== a.tenant ||
      g.app !== a.id ||
      g.version !== a.version ||
      c.redirect_uri !== a.callback ||
      g.revoked ||
      g.expires <= now ||
      g.grant_end <= now ||
      createHash('sha256').update(c.code_verifier).digest('base64url') !== g.challenge ||
      !roleFor(g) ||
      !allowed(granted(g.gid), roleFor(g), a.id)
    )
      return reply.code(401).send({ error: 'invalid_grant' })
    if (
      !run('UPDATE delegation_codes SET used=1 WHERE hash=? AND used=0', digest(c.code)).changes
    ) {
      run('UPDATE delegation_codes SET revoked=1 WHERE hash=?', digest(c.code))
      return reply.code(401).send({ error: 'invalid_grant' })
    }
    return issue(g, a, s)
  })
  api.post('/v1/delegation/check', { bodyLimit: 4096 }, async (r, reply) => {
    const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(r.headers.authorization || ''),
      checker =
        bearer && get('SELECT app FROM delegation_policies WHERE check_hash=?', digest(bearer[1]))
    if (!checker) return reply.code(401).send({ error: 'unauthorized' })
    const parsed = z
      .object({
        request_id: z.string().regex(/^[a-f0-9]{32}$/),
        gid: z.string(),
        sub: z.string(),
        hiss: z.string(),
        org: z.string(),
        app: z.string(),
        aud: z.string(),
        class: z.string(),
        jti: z.string(),
      })
      .strict()
      .safeParse(r.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' })
    const b = parsed.data,
      g = get(
        'SELECT * FROM delegation_codes WHERE gid=? AND app=? AND tenant=? AND sub=? AND used=1 AND revoked=0 AND grant_end>?',
        b.gid,
        b.app,
        b.org,
        b.sub,
        Date.now(),
      ),
      a = current(b.app),
      role = g && roleFor(g)
    const valid = !!(
      /^[a-f0-9]{32}$/.test(b.jti) &&
      checker.app === b.app &&
      g &&
      a &&
      a.version === g.version &&
      b.aud === a.audience &&
      b.hiss === humanIssuer &&
      role &&
      granted(g.gid).includes(b.class) &&
      allowed([b.class], role, a.id) &&
      get(
        'SELECT token FROM sessions WHERE token=? AND tenant=? AND expires>?',
        g.session,
        g.tenant,
        Date.now(),
      )
    )
    return { request_id: b.request_id, valid }
  })
  api.post('/delegate/status', { bodyLimit: 4096 }, async (r, reply) => {
    const input = z
      .object({ application_id: appId, delegation: z.string().max(2048) })
      .strict()
      .safeParse(r.body)
    if (!input.success || r.headers.cookie || r.headers.origin)
      return reply.code(400).send({ error: 'invalid_request' })
    const a = get('SELECT * FROM delegation_apps WHERE id=?', input.data.application_id)
    if (!a) return reply.code(403).send({ error: 'application_refused' })
    try {
      const [h, p, sig, ...extra] = input.data.delegation.split('.')
      if (extra.length || !h || !p || !sig) throw Error()
      const header = JSON.parse(Buffer.from(h, 'base64url').toString())
      if (
        header.alg !== 'EdDSA' ||
        header.typ !== 'openpassword-human-delegation+jwt' ||
        typeof header.kid !== 'string'
      )
        throw Error()
      const retired =
        header.kid === thumb()
          ? null
          : get(
              'SELECT * FROM delegation_retired WHERE kid=? AND ended>=?',
              header.kid,
              Math.floor(Date.now() / 1000) - 30 * 86400,
            )
      if (header.kid !== thumb() && !retired) throw Error()
      const verifyKey = retired ? createPublicKey(retired.key) : createPublicKey(signingKey())
      if (!verify(null, Buffer.from(h + '.' + p), verifyKey, Buffer.from(sig, 'base64url')))
        throw Error()
      const b = JSON.parse(Buffer.from(p, 'base64url').toString())
      const g = get(
        'SELECT * FROM delegation_codes WHERE gid=? AND app=? AND sub=? AND tenant=?',
        b.gid,
        a.id,
        b.sub,
        b.org,
      )
      if (
        !g ||
        b.app !== a.id ||
        (retired && b.iat > retired.ended) ||
        b.iss !== origin ||
        b.aud !== a.audience ||
        granted(g.gid).length
      )
        throw Error()
      const live = get(
        'SELECT token FROM sessions WHERE token=? AND tenant=? AND expires>?',
        g.session,
        g.tenant,
        Date.now(),
      )
      return {
        grant: g.revoked ? 'revoked' : g.grant_end <= Date.now() || !live ? 'ended' : 'active',
        membership: roleFor(g) ? 'active' : 'inactive',
        registration: current(a.id) && g.version === a.version ? 'live' : 'inactive',
        checked_at: iso(Date.now()).replace(/\.\d{3}Z$/, 'Z'),
      }
    } catch {
      return reply.code(401).send({ error: 'invalid_grant' })
    }
  })
  function issue(g: Row, a: Row, s: Row) {
    const now = Date.now(),
      refresh = granted(g.gid).length ? opaque() : null
    if (refresh) run('INSERT INTO delegation_refresh VALUES(?,?,0)', digest(refresh), g.gid)
    const iat = Math.floor(now / 1000),
      exp = Math.min(iat + 900, Math.floor(g.grant_end / 1000)),
      claims = {
        iss: origin,
        aud: a.audience,
        sub: g.sub,
        hiss: humanIssuer,
        org: g.tenant,
        app: a.id,
        classes: granted(g.gid),
        gid: g.gid,
        iat,
        nbf: iat,
        exp,
        jti: randomUUID().replaceAll('-', ''),
      }
    const unsigned =
      enc({ alg: 'EdDSA', kid: thumb(), typ: 'openpassword-human-delegation+jwt' }) +
      '.' +
      enc(claims)
    return {
      ...(refresh ? { refresh_credential: refresh } : {}),
      delegation:
        unsigned + '.' + sign(null, Buffer.from(unsigned), signingKey()).toString('base64url'),
      expires_at: iso(exp * 1000),
      grant_id: g.gid,
      principal: {
        hiss: humanIssuer,
        sub: g.sub,
        org: g.tenant,
        app: a.id,
        classes: granted(g.gid),
        grant_expires_at: iso(g.grant_end),
        session_expires_at: iso(s.expires),
        effective_expires_at: iso(g.grant_end),
      },
    }
  }
}
