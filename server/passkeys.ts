import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { randomBytes, createHmac } from 'node:crypto'
import { z } from 'zod'
import { digest, opaque } from './store.ts'
type Session = { token: string; member: string | null; tenant?: string }
// Every console change under /admin/ and /profile/ needs a fresh passkey approval once a profile has a passkey. The
// routes below are the only exceptions: session handling, the approval ceremony itself, routine private-vault writes
// of client-encrypted data, and the sealing ticket that precedes an approved connection change. Add to this list only
// with a reason. App sign-in confirmation (/delegate/confirm) is a form post outside these prefixes; it asks for the
// same approval through the stepUp decorator below.
export const approvalExempt: ReadonlySet<string> = new Set([
  '/admin/login',
  '/admin/logout',
  '/admin/switch',
  '/admin/intake',
  '/profile/passkeys/approve',
  '/profile/passkeys/finish',
  '/profile/vault',
  '/profile/vault/items',
  '/profile/vault/deposits',
  '/profile/vault/upgrade',
  '/profile/vault/upgrade/:id/item',
])
// Approval for a page that posts a plain form: the challenge goes out with the page and the assertion comes back in it.
export type StepUp = {
  offer(profile: string, session: string, binding: string): Promise<{ id: string; options: unknown } | null>
  confirm(profile: string, session: string, binding: string, id?: string, assertion?: string): Promise<void>
}
// Pending approvals of one profile, in every session it holds. Other profiles keep theirs.
export function discardPending(db: DatabaseSync, profile: string) {
  db.prepare(
    `DELETE FROM pk_attempts WHERE purpose IN ('action','proof') AND scope IN
     (SELECT s.token FROM sessions s LEFT JOIN session_members m ON m.session=s.token WHERE COALESCE(m.member,'owner')=?)`,
  ).run(profile)
}
export function passkeys(
  api: FastifyInstance,
  db: DatabaseSync,
  origin: string,
  session: (r: FastifyRequest) => Session,
  signIn: (r: FastifyReply, id: string) => void,
  confirmPassword: (id: string, value: string) => Promise<boolean>,
) {
  const rpID = new URL(origin).hostname
  const fail = (): never => {
    throw Object.assign(Error('Passkey verification failed or expired'), { statusCode: 403 })
  }
  db.exec(`CREATE TABLE IF NOT EXISTS passkeys(id TEXT PRIMARY KEY,profile TEXT,handle TEXT,pub BLOB,counter INTEGER,label TEXT);
 CREATE INDEX IF NOT EXISTS passkeys_profile ON passkeys(profile);
 CREATE TABLE IF NOT EXISTS pk_attempts(id TEXT PRIMARY KEY,purpose TEXT,scope TEXT,challenge TEXT,binding TEXT,expires INTEGER);
 CREATE INDEX IF NOT EXISTS pk_expiry ON pk_attempts(expires);`)
  function issue(purpose: string, scope: string, challenge: string, binding = '') {
    const token = opaque()
    db.prepare('DELETE FROM pk_attempts WHERE expires<=?').run(Date.now())
    db.prepare('INSERT INTO pk_attempts VALUES(?,?,?,?,?,?)').run(
      digest(token),
      purpose,
      scope,
      challenge,
      binding,
      Date.now() + 120000,
    )
    return token
  }
  function take(id: unknown, purpose: string, scope: string) {
    if (typeof id !== 'string') return fail()
    const a = db
      .prepare(
        'DELETE FROM pk_attempts WHERE id=? AND purpose=? AND scope=? AND expires>? RETURNING *',
      )
      .get(digest(id), purpose, scope, Date.now())
    return a ?? fail()
  }
  const creds = (p: string) =>
    db.prepare('SELECT id,label FROM passkeys WHERE profile=? ORDER BY rowid').all(p)
  const user = (s: Session) => s.member || 'owner'
  api.get('/profile/passkeys', async (r) => creds(user(session(r))))
  api.post('/profile/passkeys/begin', async (r) => {
    const s = session(r),
      p = user(s),
      b = z.object({ password: z.string().max(256) }).parse(r.body)
    if (!(await confirmPassword(p, b.password)) || session(r).token !== s.token) fail()
    const handle = String(
      db.prepare('SELECT handle FROM passkeys WHERE profile=? LIMIT 1').get(p)?.handle ??
        randomBytes(32).toString('base64url'),
    )
    const options = await generateRegistrationOptions({
      rpName: 'OpenPassword',
      rpID,
      userID: Uint8Array.from(Buffer.from(handle, 'base64url')),
      userName: p,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: creds(p).map((c) => ({ id: String(c.id) })),
    })
    return { options, id: issue('enroll', s.token, options.challenge, handle) }
  })
  api.post('/profile/passkeys/finish', async (r) => {
    const s = session(r),
      b = z
        .object({ id: z.string(), label: z.string().trim().min(1).max(80), response: z.any() })
        .parse(r.body)
    const a = take(b.id, 'enroll', s.token)
    const v = await verifyRegistrationResponse({
      response: b.response,
      expectedOrigin: origin,
      expectedRPID: rpID,
      expectedChallenge: String(a.challenge),
      requireUserVerification: true,
    }).catch(fail)
    if (!v.verified || !v.registrationInfo || session(r).token !== s.token) return fail()
    const c = v.registrationInfo.credential
    db.prepare('INSERT INTO passkeys VALUES(?,?,?,?,?,?)').run(
      c.id,
      user(s),
      a.binding,
      c.publicKey,
      c.counter,
      b.label,
    )
    return { ok: true }
  })
  api.delete('/profile/passkeys/:id', async (r) => {
    const { id } = z.object({ id: z.string() }).parse(r.params),
      p = user(session(r))
    // An approval given with a retired credential must not outlive it, so both go or neither does.
    db.exec('BEGIN IMMEDIATE')
    try {
      if (!db.prepare('DELETE FROM passkeys WHERE profile=? AND id=?').run(p, id).changes) fail()
      discardPending(db, p)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    return { ok: true }
  })
  const authOptions = (p?: string) =>
    generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      allowCredentials: p ? creds(p).map((c) => ({ id: String(c.id) })) : undefined,
    })
  const cookie = 'op_pk'
  api.post('/auth/passkey/begin', async (_r, reply) => {
    const options = await authOptions(),
      nonce = opaque()
    reply.header(
      'Set-Cookie',
      cookie +
        '=' +
        nonce +
        '; HttpOnly; SameSite=Strict; Max-Age=120; Path=/' +
        (origin.startsWith('https:') ? '; Secure' : ''),
    )
    return { options, id: issue('login', digest(nonce), options.challenge) }
  })
  async function verify(id: string, challenge: string, response: any, profile?: string) {
    const c = db.prepare('SELECT * FROM passkeys WHERE id=?').get(id)
    if (
      !c ||
      (profile && c.profile !== profile) ||
      (response.response?.userHandle && response.response.userHandle !== c.handle)
    )
      return fail()
    const v = await verifyAuthenticationResponse({
      response,
      expectedOrigin: origin,
      expectedRPID: rpID,
      expectedChallenge: challenge,
      requireUserVerification: true,
      credential: {
        id,
        publicKey: Uint8Array.from(c.pub as Uint8Array),
        counter: Number(c.counter),
      },
    }).catch(fail)
    if (
      !v.verified ||
      !db
        .prepare('UPDATE passkeys SET counter=? WHERE id=? AND counter=?')
        .run(v.authenticationInfo.newCounter, id, c.counter).changes
    )
      return fail()
    return String(c.profile)
  }
  const assertion = z.object({
    id: z.string(),
    response: z.object({ id: z.string() }).passthrough(),
  })
  api.post('/auth/passkey/finish', async (r, reply) => {
    const b = assertion.parse(r.body),
      nonce = (r.headers.cookie || '')
        .split(/;\s*/)
        .find((c) => c.startsWith(cookie + '='))
        ?.slice(cookie.length + 1)
    if (!nonce) return fail()
    const a = take(b.id, 'login', digest(nonce))
    signIn(reply, await verify(b.response.id, String(a.challenge), b.response))
    return { ok: true }
  })
  api.post('/profile/passkeys/approve', async (r) => {
    const s = session(r),
      b = assertion.parse(r.body),
      a = take(b.id, 'action', s.token)
    await verify(b.response.id, String(a.challenge), b.response, user(s))
    if (session(r).token !== s.token) return fail()
    return { proof: issue('proof', s.token, '', String(a.binding)) }
  })
  const stepUp: StepUp = {
    async offer(profile, token, binding) {
      if (!creds(profile).length) return null
      const options = await authOptions(profile)
      return { id: issue('action', token, options.challenge, binding), options }
    },
    async confirm(profile, token, binding, id, assertion) {
      if (!creds(profile).length) return
      if (!id || !assertion) return fail()
      const a = take(id, 'action', token)
      if (a.binding !== binding) return fail()
      let credential: { id?: unknown }
      try {
        credential = JSON.parse(assertion)
      } catch {
        return fail()
      }
      if (typeof credential?.id !== 'string') return fail()
      await verify(credential.id, String(a.challenge), credential, profile)
    },
  }
  api.decorate('stepUp', stepUp)
  const bindingKey = randomBytes(32)
  api.addHook('preHandler', async (r, reply) => {
    if (!['POST', 'DELETE', 'PATCH', 'PUT'].includes(r.method)) return
    const path = r.routeOptions.url ?? ''
    const isConsole = path.startsWith('/admin/') || path.startsWith('/profile/')
    if (
      !(isConsole && !approvalExempt.has(path)) &&
      !(path === '/auth/:provider/start' && (r.body as { link?: boolean })?.link)
    )
      return
    const s = session(r),
      keys = creds(user(s))
    if (!keys.length) return
    const binding = createHmac('sha256', bindingKey)
      .update(JSON.stringify([s.tenant, r.method, r.url, r.body ?? null]))
      .digest('hex')
    const header = r.headers['openpassword-approval']
    if (header) {
      const proof = take(header, 'proof', s.token)
      if (proof.binding !== binding) fail()
      return
    }
    const options = await authOptions(user(s))
    return reply
      .code(428)
      .send({ approval: { id: issue('action', s.token, options.challenge, binding), options } })
  })
}
