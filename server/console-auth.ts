import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { randomBytes, scrypt, createHmac, timingSafeEqual, createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { passkeys } from './passkeys.ts'
import { z } from 'zod'
import { digest, opaque } from './store.ts'

import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose'
import { isIP } from 'node:net'
const derive = promisify(scrypt)
const credentials = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(256),
})
const services = {
  apple: [
    'https://appleid.apple.com/auth/authorize',
    'https://appleid.apple.com/auth/token',
    '',
    '',
  ],
  google: [
    'https://accounts.google.com/o/oauth2/v2/auth',
    'https://oauth2.googleapis.com/token',
    'https://openidconnect.googleapis.com/v1/userinfo',
    'openid',
  ],
  github: [
    'https://github.com/login/oauth/authorize',
    'https://github.com/login/oauth/access_token',
    'https://api.github.com/user',
    'read:user',
  ],
}
const idSchema = z.enum(['google', 'github', 'apple'])
function refuse(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode })
}
export function consoleAuth(
  api: FastifyInstance,
  db: DatabaseSync,
  origin: string,
  admin: string,
  session: (r: FastifyRequest) => { role: string; token: string; member: string | null },
  login: (reply: FastifyReply, member?: Record<string, any>) => void,
  seal: (v: unknown, c: string) => string,
  open: (v: string, c: string) => any,
  send: typeof fetch,
) {
  const appleKeys = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'), {
    [customFetch]: send,
  })
  db.exec(`CREATE TABLE IF NOT EXISTS console_owner(id INTEGER PRIMARY KEY CHECK(id=1),username TEXT,salt TEXT,hash TEXT);
    CREATE TABLE IF NOT EXISTS signin_apps(provider TEXT PRIMARY KEY,client TEXT,secret TEXT,subject TEXT);
    CREATE TABLE IF NOT EXISTS signin_attempts(state TEXT PRIMARY KEY,provider TEXT,browser TEXT,verifier TEXT,session TEXT,expires INTEGER);`)
  db.exec(`CREATE TABLE IF NOT EXISTS profile_password(id TEXT PRIMARY KEY,username TEXT UNIQUE,salt TEXT,hash TEXT);
    CREATE TABLE IF NOT EXISTS profile_identity(id TEXT,provider TEXT,subject TEXT,PRIMARY KEY(provider,subject),UNIQUE(id,provider));
    INSERT OR IGNORE INTO profile_password SELECT 'owner',username,salt,hash FROM console_owner WHERE hash IS NOT NULL;
    INSERT OR IGNORE INTO profile_identity SELECT 'owner',provider,subject FROM signin_apps WHERE subject IS NOT NULL;
    UPDATE console_owner SET username=NULL,salt=NULL,hash=NULL;
    UPDATE signin_apps SET subject=NULL;`)
  const profile = (r: FastifyRequest) => session(r).member || 'owner'
  function signIn(reply: FastifyReply, id: string) {
    if (id === 'owner') {
      login(reply)
      return
    }
    const member = db.prepare('SELECT * FROM members WHERE id=? AND active=1').get(id)
    if (!member) refuse(401, 'Membership revoked')
    login(reply, member)
  }
  passkeys(api, db, origin, session, signIn, async (id, password) => {
    const a = db.prepare('SELECT salt,hash FROM profile_password WHERE id=?').get(id)
    return (
      !!a &&
      timingSafeEqual(
        (await derive(password, String(a.salt), 64)) as Buffer,
        Buffer.from(String(a.hash), 'hex'),
      )
    )
  })
  function transaction(f: () => void) {
    db.exec('BEGIN IMMEDIATE')
    try {
      f()
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  db.exec(
    'CREATE TABLE IF NOT EXISTS setup_ticket(id INTEGER PRIMARY KEY CHECK(id=1), hash TEXT NOT NULL, issued INTEGER NOT NULL, expires INTEGER NOT NULL)',
  )
  api.post('/auth/setup-code', async (r) => {
    const hex = z.string().regex(/^[0-9a-f]{64}$/)
    const { hash, issued, proof } = z
      .object({ hash: hex, issued: z.number().int(), proof: hex })
      .parse(r.body)
    const expected = createHmac('sha256', Buffer.from(admin, 'hex'))
      .update('OpenPassword/setup/v1/' + issued + '/' + hash)
      .digest('hex')
    if (
      owner() ||
      Math.abs(Date.now() - issued) > 30000 ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(proof))
    )
      refuse(403, 'Setup unavailable')
    const saved = db
      .prepare(
        'INSERT INTO setup_ticket VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash, issued=excluded.issued, expires=excluded.expires WHERE excluded.issued > setup_ticket.issued',
      )
      .run(hash, issued, issued + 600000)
    if (!saved.changes) refuse(409, 'Generate a fresh code')
    db.prepare("DELETE FROM signin_attempts WHERE session='setup'").run()
    return { origin }
  })
  function createOwner() {
    db.prepare('INSERT INTO console_owner(id) VALUES(1)').run()
    db.prepare(
      'DELETE FROM sessions WHERE token NOT IN (SELECT session FROM session_members)',
    ).run()
  }
  function setupCode(token: string, consume: boolean) {
    if (owner()) refuse(409, 'Administrator already created')
    const ticket = db.prepare('SELECT hash,expires FROM setup_ticket WHERE id=1').get()
    const expected = ticket ? String(ticket.hash) : admin
    if (
      (ticket && Number(ticket.expires) <= Date.now()) ||
      !timingSafeEqual(Buffer.from(digest(token)), Buffer.from(expected))
    )
      refuse(403, 'Incorrect or expired setup code')
    // Keep the row after redemption so the host proof cannot become a browser code again.
    if (ticket && consume) db.prepare('UPDATE setup_ticket SET expires=0 WHERE id=1').run()
  }
  const methodCount = (id: string) =>
    Number(
      db
        .prepare(
          'SELECT (SELECT count(*) FROM profile_password WHERE id=?) + (SELECT count(*) FROM profile_identity WHERE id=?) AS n',
        )
        .get(id, id)?.n,
    )
  api.get('/profile', async (r) => {
    const id = profile(r)
    return {
      role: session(r).role,
      username: db.prepare('SELECT username FROM profile_password WHERE id=?').get(id)?.username,
      providers: db
        .prepare(
          'SELECT a.provider,i.subject IS NOT NULL AS linked FROM signin_apps a LEFT JOIN profile_identity i ON i.provider=a.provider AND i.id=?',
        )
        .all(id),
    }
  })
  api.post('/profile/password', async (r) => {
    const id = profile(r),
      b = credentials
        .extend({
          password: z.string().min(12).max(256),
          current_password: z.string().max(256).optional(),
        })
        .parse(r.body)
    const previous = db.prepare('SELECT salt,hash FROM profile_password WHERE id=?').get(id)
    if (
      previous &&
      (!b.current_password ||
        !timingSafeEqual(
          (await derive(b.current_password, String(previous.salt), 64)) as Buffer,
          Buffer.from(String(previous.hash), 'hex'),
        ))
    )
      refuse(403, 'Current sign-in password required')
    const salt = randomBytes(16).toString('hex'),
      hash = (await derive(b.password, salt, 64)) as Buffer
    if (profile(r) !== id) refuse(403, 'Session changed')
    if (
      db.prepare('SELECT id FROM profile_password WHERE username=? AND id!=?').get(b.username, id)
    )
      refuse(409, 'Username unavailable')
    const updated = previous
      ? db
          .prepare('UPDATE profile_password SET username=?,salt=?,hash=? WHERE id=? AND hash=?')
          .run(b.username, salt, hash.toString('hex'), id, previous.hash)
      : db
          .prepare('INSERT OR IGNORE INTO profile_password VALUES(?,?,?,?)')
          .run(id, b.username, salt, hash.toString('hex'))
    if (!updated.changes) refuse(409, 'Sign-in settings changed')
    return { ok: true }
  })
  api.delete('/profile/:method', async (r) => {
    const id = profile(r),
      method = z
        .enum(['password', 'google', 'github', 'apple'])
        .parse((r.params as { method: string }).method)
    if (methodCount(id) <= 1) refuse(409, 'Add another sign-in method first')
    if (method === 'password') db.prepare('DELETE FROM profile_password WHERE id=?').run(id)
    else db.prepare('DELETE FROM profile_identity WHERE id=? AND provider=?').run(id, method)
    return { ok: true }
  })
  const owner = () => db.prepare('SELECT * FROM console_owner WHERE id=1').get()
  const app = (p: string) => db.prepare('SELECT * FROM signin_apps WHERE provider=?').get(p)
  const callback = (p: string) => origin + '/api/auth/' + p + '/callback'
  const provider = (r: FastifyRequest) =>
    idSchema.parse((r.params as { provider: string }).provider)
  const requireOwner = (r: FastifyRequest) => {
    const s = session(r)
    if (s.role !== 'owner' || !owner()) refuse(403, 'Administrator account required')
    return s
  }
  api.get('/auth/status', async () => ({
    setup: !owner(),
    origin,
    providers: db
      .prepare('SELECT DISTINCT provider FROM profile_identity')
      .all()
      .map((x) => x.provider),
  }))
  api.post('/auth/setup', async (r, reply) => {
    const b = credentials
      .extend({ password: z.string().min(12).max(256), token: z.string().max(256) })
      .parse(r.body)
    if (owner()) refuse(409, 'Administrator already created')
    setupCode(b.token, false)
    const salt = randomBytes(16).toString('hex'),
      hash = (await derive(b.password, salt, 64)) as Buffer
    transaction(() => {
      setupCode(b.token, true)
      createOwner()
      db.prepare('INSERT INTO profile_password VALUES(?,?,?,?)').run(
        'owner',
        b.username,
        salt,
        hash.toString('hex'),
      )
    })
    login(reply)
    return { ok: true }
  })
  api.post('/auth/password', async (r, reply) => {
    const b = credentials.parse(r.body),
      a = db.prepare('SELECT * FROM profile_password WHERE username=?').get(b.username)
    if (!a) refuse(401, 'Invalid username or password')
    const hash = (await derive(b.password, String(a.salt), 64)) as Buffer
    if (!timingSafeEqual(hash, Buffer.from(String(a.hash), 'hex')) || b.username !== a.username)
      refuse(401, 'Invalid username or password')
    signIn(reply, String(a.id))
    return { ok: true }
  })
  api.get('/admin/authentication', async (r) => {
    requireOwner(r)
    return Object.keys(services).map((provider) => {
      const a = app(provider)
      return {
        provider,
        callback: callback(provider),
        client: String(a?.client ?? ''),
        linked: !!db
          .prepare("SELECT 1 FROM profile_identity WHERE id='owner' AND provider=?")
          .get(provider),
      }
    })
  })
  api.post('/admin/authentication/:provider', async (r) => {
    requireOwner(r)
    const p = provider(r),
      b = z
        .object({ client: z.string().trim().min(1).max(512), secret: z.string().min(1).max(2048) })
        .parse(r.body)
    if (
      app(p) &&
      app(p)?.client !== b.client &&
      db.prepare('SELECT 1 FROM profile_identity WHERE provider=?').get(p)
    )
      refuse(409, 'Unlink this provider from its profiles before changing client ID')
    db.prepare('INSERT OR REPLACE INTO signin_apps VALUES(?,?,?,NULL)').run(
      p,
      b.client,
      seal(b.secret, 'signin/' + p),
    )
    db.prepare('DELETE FROM signin_attempts WHERE provider=?').run(p)
    return { ok: true }
  })
  api.delete('/admin/authentication/:provider', async (r) => {
    requireOwner(r)
    const p = provider(r)
    for (const x of db.prepare('SELECT id FROM profile_identity WHERE provider=?').all(p))
      if (methodCount(String(x.id)) <= 1)
        refuse(409, 'A profile needs another sign-in method first')
    db.prepare('DELETE FROM profile_identity WHERE provider=?').run(p)
    db.prepare('DELETE FROM signin_apps WHERE provider=?').run(p)
    db.prepare('DELETE FROM signin_attempts WHERE provider=?').run(p)
    return { ok: true }
  })
  const stateCookie = (value: string, age: number) =>
    'op_signin=' +
    value +
    '; Path=/api/auth/; HttpOnly; SameSite=Lax; Max-Age=' +
    age +
    (origin.startsWith('https:') ? '; Secure' : '')
  api.post('/auth/:provider/start', async (r, reply) => {
    const p = provider(r),
      { link } = z.object({ link: z.boolean() }).parse(r.body)
    const bootstrap = z
      .object({
        setup: z
          .object({ token: z.string(), client: z.string().min(1), secret: z.string().min(1) })
          .optional(),
      })
      .parse(r.body).setup
    if (
      p === 'apple' &&
      (!origin.startsWith('https:') ||
        isIP(new URL(origin).hostname.replace(/[\[\]]/g, '')) ||
        new URL(origin).hostname === 'localhost')
    )
      refuse(422, 'Apple requires a registered HTTPS domain')
    if (bootstrap) {
      setupCode(bootstrap.token, true)
      db.prepare('INSERT OR REPLACE INTO signin_apps VALUES(?,?,?,NULL)').run(
        p,
        bootstrap.client,
        seal(bootstrap.secret, 'signin/' + p),
      )
      db.prepare('DELETE FROM signin_attempts WHERE provider=?').run(p)
    }
    const sessionId = bootstrap ? 'setup' : link ? session(r).token : null,
      a = app(p)
    if (!a) refuse(404, 'Sign-in provider unavailable')
    const state = opaque(),
      browser = opaque(),
      verifier = opaque()
    db.prepare('DELETE FROM signin_attempts WHERE expires<=?').run(Date.now())
    db.prepare('INSERT INTO signin_attempts VALUES(?,?,?,?,?,?)').run(
      digest(state),
      p,
      digest(browser),
      verifier,
      sessionId,
      Date.now() + 600000,
    )
    const url = new URL(services[p][0])
    url.search = new URLSearchParams({
      client_id: String(a.client),
      redirect_uri: callback(p),
      response_type: 'code',
      scope: services[p][3],
      state,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    }).toString()
    if (p === 'apple') {
      url.searchParams.delete('scope')
      url.searchParams.delete('code_challenge')
      url.searchParams.delete('code_challenge_method')
      url.searchParams.set('nonce', verifier)
      url.searchParams.set('response_mode', 'query')
    }
    reply.header('Set-Cookie', stateCookie(browser, 600))
    return { url: url.href }
  })
  api.get('/auth/:provider/callback', async (r, reply) => {
    const p = provider(r),
      { state, code } = r.query as Record<string, string>
    const browser = r.headers.cookie
      ?.split(/;\s*/)
      .find((v) => v.startsWith('op_signin='))
      ?.slice(10)
    if (!browser || typeof state !== 'string') return reply.redirect('/?signin=failed')
    const setupGeneration = () =>
      db.prepare('SELECT issued FROM setup_ticket WHERE id=1').get()?.issued
    const generation = setupGeneration()
    const t = db
      .prepare(
        'DELETE FROM signin_attempts WHERE state=? AND browser=? AND provider=? AND expires>? RETURNING *',
      )
      .get(digest(state), digest(browser), p, Date.now())
    reply.header('Set-Cookie', stateCookie('', 0))
    try {
      const a = app(p)
      if (
        !a ||
        !t ||
        !code ||
        (t.session === 'setup' ? !!owner() : t.session && session(r).token !== t.session)
      )
        return reply.redirect('/?signin=failed')
      const token = await send(services[p][1], {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: { Accept: 'application/json' },
        body: new URLSearchParams({
          client_id: String(a.client),
          client_secret: open(String(a.secret), 'signin/' + p),
          code,
          code_verifier: String(t.verifier),
          grant_type: 'authorization_code',
          redirect_uri: callback(p),
        }),
      })
      if (!token.ok) return reply.redirect('/?signin=failed')
      const body = await token.json()
      let sub: string
      if (p === 'apple') {
        const { payload } = await jwtVerify(body.id_token, appleKeys, {
          issuer: 'https://appleid.apple.com',
          audience: String(a.client),
          algorithms: ['RS256'],
          requiredClaims: ['exp', 'sub', 'nonce'],
        })
        if (payload.nonce !== t.verifier) throw Error('Invalid nonce')
        sub = z.string().min(1).parse(payload.sub)
      } else {
        const access = z.string().min(1).parse(body.access_token)
        const user = await send(services[p][2], {
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
          headers: {
            Authorization: 'Bearer ' + access,
            Accept: 'application/json',
            'User-Agent': 'OpenPassword',
          },
        })
        if (!user.ok) return reply.redirect('/?signin=failed')
        const info = await user.json()
        sub =
          p === 'google'
            ? z.string().min(1).parse(info.sub)
            : String(z.number().int().positive().parse(info.id))
      }
      if (app(p)?.secret !== a.secret) throw Error('Provider changed')
      if (t.session) {
        transaction(() => {
          let id = 'owner'
          if (t.session === 'setup') {
            if (owner() || generation !== setupGeneration()) throw Error('Setup changed')
            createOwner()
          } else {
            if (session(r).token !== t.session) throw Error('Session changed')
            id = profile(r)
          }
          db.prepare(
            'INSERT INTO profile_identity VALUES(?,?,?) ON CONFLICT(id,provider) DO UPDATE SET subject=excluded.subject',
          ).run(id, p, sub)
        })
        if (t.session === 'setup') login(reply)
      } else {
        const identity = db
          .prepare('SELECT id FROM profile_identity WHERE provider=? AND subject=?')
          .get(p, sub)
        if (!identity) throw Error('Unlinked identity')
        signIn(reply, String(identity.id))
      }
      return reply.redirect(t.session === 'setup' ? '/team' : t.session ? '/?signin=linked' : '/')
    } catch {
      return reply.redirect('/?signin=failed')
    }
  })
  return owner
}
