import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { service } from '../server/service.ts'
import { discardPending } from '../server/passkeys.ts'
import { formTarget } from '../server/delegation.ts'
for (const action of [false, true])
  test(
    action
      ? 'action delegation checks, rotates refresh credentials and revokes reused families'
      : 'identity-only app requires activation, same-session consent and a single PKCE exchange',
    async (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'op-delegate-')),
        origin = 'http://localhost:3000',
        api = service(dir, origin)
      t.after(async () => {
        await api.close()
        rmSync(dir, { recursive: true, force: true })
      })
      const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
        api.inject({ method: 'POST', url, payload, headers })
      const auth = await post('/admin/login', {
          token: readFileSync(join(dir, 'operator.token'), 'utf8'),
        }),
        h = { cookie: String(auth.headers['set-cookie']).split(';')[0] }
      const callback = 'https://app.example.invalid/callback',
        registration = (
          await post(
            '/admin/apps',
            {
              label: 'Example',
              callback,
              audience: 'app.example.invalid',
              days: 1,
              classes: action ? ['conversation.read'] : [],
            },
            h,
          )
        ).json(),
        app = registration.id
      const verifier = 'v'.repeat(43),
        q = new URLSearchParams({
          application_id: app,
          redirect_uri: callback,
          state: 's'.repeat(43),
          code_challenge_method: 'S256',
          classes: action ? 'conversation.read' : '',
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        })
      const begin = () => api.inject({ url: '/delegate?' + q })
      assert.equal((await begin()).statusCode, 403)
      await post('/admin/apps/' + app, { active: true }, h)
      const jump = new URL(String((await begin()).headers.location)),
        page = await api.inject({ url: jump.pathname + jump.search, headers: h })
      const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1],
        attempt = jump.searchParams.get('attempt')
      const confirmed = await post('/delegate/confirm', { csrf, attempt }, { ...h, origin })
      const location = new URL(String(confirmed.headers.location))
      assert.equal(location.origin, 'https://app.example.invalid')
      assert.equal(location.searchParams.get('state'), 's'.repeat(43))
      const body = {
        grant_type: 'authorization_code',
        application_id: app,
        redirect_uri: callback,
        code: location.searchParams.get('code'),
        code_verifier: verifier,
      }
      assert.equal(
        (await post('/delegate/exchange', { ...body, code_verifier: 'z'.repeat(43) })).statusCode,
        401,
      )
      const answer = (await post('/delegate/exchange', body)).json(),
        pieces = answer.delegation.split('.')
      const key = (await api.inject({ url: '/.well-known/openpassword-delegation-keys.json' })).json()
        .keys[0]
      assert.equal(
        verify(
          null,
          Buffer.from(pieces.slice(0, 2).join('.')),
          createPublicKey({
            key: { kty: 'OKP', crv: 'Ed25519', x: key.public_key },
            format: 'jwk',
          }),
          Buffer.from(pieces[2], 'base64url'),
        ),
        true,
      )
      assert.deepEqual(answer.principal.classes, action ? ['conversation.read'] : [])
      if (action) {
        const claims = JSON.parse(Buffer.from(pieces[1], 'base64url').toString())
        const check = {
          request_id: 'a'.repeat(32),
          gid: claims.gid,
          sub: claims.sub,
          org: claims.org,
          hiss: claims.hiss,
          aud: claims.aud,
          app,
          class: 'conversation.read',
          jti: claims.jti,
        }
        const checkHeaders = { authorization: 'Bearer ' + registration.check_credential }
        assert.equal((await post('/v1/delegation/check', check)).statusCode, 401)
        assert.equal((await post('/v1/delegation/check', check, checkHeaders)).json().valid, true)
        assert.equal(
          (
            await post('/v1/delegation/check', { ...check, class: 'attention.write' }, checkHeaders)
          ).json().valid,
          false,
        )
        const refresh = (token: string) =>
          post('/delegate/exchange', {
            grant_type: 'refresh',
            application_id: app,
            refresh_credential: token,
          })
        const rotated = (await refresh(answer.refresh_credential)).json()
        assert.ok(rotated.refresh_credential)
        assert.notEqual(rotated.refresh_credential, answer.refresh_credential)
        assert.equal((await refresh(answer.refresh_credential)).statusCode, 401)
        assert.equal((await refresh(rotated.refresh_credential)).statusCode, 401)
        assert.equal((await post('/v1/delegation/check', check, checkHeaders)).json().valid, false)
      } else {
        assert.equal(answer.refresh_credential, undefined)
        assert.equal((await post('/admin/delegation/signing-key/rotate', {}, h)).statusCode, 200)
        assert.equal(
          (
            await post('/delegate/status', { application_id: app, delegation: answer.delegation })
          ).json().grant,
          'active',
        )
      }
      assert.equal((await post('/delegate/exchange', body)).statusCode, 401)
    },
  )

test('consent to a new grant needs a passkey approval once one is enrolled', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'op-delegate-passkey-')),
    origin = 'http://localhost:3000',
    api = service(dir, origin)
  t.after(async () => {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
    api.inject({ method: 'POST', url, payload, headers })
  const auth = await post('/admin/login', { token: readFileSync(join(dir, 'operator.token'), 'utf8') }),
    h = { cookie: String(auth.headers['set-cookie']).split(';')[0] }
  const callback = 'https://app.example.invalid/callback'
  const app = (
    await post(
      '/admin/apps',
      { label: 'Example', callback, audience: 'app.example.invalid', days: 1, classes: [] },
      h,
    )
  ).json().id
  await post('/admin/apps/' + app, { active: true }, h)
  const db = new DatabaseSync(join(dir, 'vault.sqlite'))
  t.after(() => db.close())
  db.prepare('INSERT INTO passkeys VALUES(?,?,?,?,?,?)').run(
    'ZmFrZS1jcmVkZW50aWFs', 'owner', 'handle', new Uint8Array(1), 0, 'fixture',
  )
  const q = new URLSearchParams({
    application_id: app,
    redirect_uri: callback,
    state: 's'.repeat(43),
    code_challenge_method: 'S256',
    classes: '',
    code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'),
  })
  const jump = new URL(String((await api.inject({ url: '/delegate?' + q })).headers.location)),
    page = await api.inject({ url: jump.pathname + jump.search, headers: h })
  assert.match(String(page.headers['content-security-policy']), /script-src 'nonce-/)
  // The confirmation redirects to the application, so its origin and no other is an allowed target.
  assert.match(
    String(page.headers['content-security-policy']),
    /; form-action 'self' https:\/\/app\.example\.invalid;/,
  )
  const approval_id = /name="approval_id" value="([^"]+)"/.exec(page.body)![1],
    csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1],
    attempt = jump.searchParams.get('attempt')
  for (const extra of [{}, { approval_id, approval: '{"id":"unknown","response":{}}' }]) {
    const refused = await post('/delegate/confirm', { csrf, attempt, ...extra }, { ...h, origin })
    assert.equal(refused.statusCode, 403)
    assert.equal(refused.headers.location, undefined)
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM delegation_codes').get()!.n, 0)

  // Retiring a credential drops that profile's pending approvals and nobody else's.
  const session = String(db.prepare('SELECT token FROM sessions').get()!.token)
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run('other-session', 'w', Date.now() + 60000)
  db.prepare('INSERT INTO session_members VALUES(?,?)').run('other-session', 'other-member')
  db.exec('DELETE FROM pk_attempts')
  const add = db.prepare('INSERT INTO pk_attempts VALUES(?,?,?,?,?,?)')
  add.run('a', 'proof', session, '', '', Date.now() + 60000)
  add.run('b', 'proof', 'other-session', '', '', Date.now() + 60000)
  discardPending(db, 'owner')
  assert.deepEqual(db.prepare('SELECT id FROM pk_attempts').all().map((r) => r.id), ['b'])
})

test('only a plain callback origin is added as a form target', () => {
  assert.equal(formTarget('https://app.example.com/callback'), ' https://app.example.com')
  assert.equal(formTarget('https://App.Example.com:8443/a/b'), ' https://app.example.com:8443')
  assert.equal(formTarget('https://app.example.com:443/callback'), ' https://app.example.com')
  for (const callback of [
    "https://a;script-src.example.com/callback",
    "https://a'b.example.com/callback",
    'https://a,b.example.com/callback',
    'https://*.example.com/callback',
    'https://[::1]/callback',
    'http://app.example.com/callback',
  ])
    assert.equal(formTarget(callback), '', callback)
})

test('an application whose callback the confirmation page cannot reach is not registered', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'op-callback-host-')),
    api = service(dir)
  t.after(async () => {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const login = await api.inject({
    url: '/admin/login',
    method: 'POST',
    payload: { token: readFileSync(join(dir, 'operator.token'), 'utf8') },
  })
  const cookie = String(login.headers['set-cookie']).split(';')[0]
  const register = (callback: string) =>
    api.inject({
      url: '/admin/apps',
      method: 'POST',
      headers: { cookie },
      payload: { label: 'Example', callback, audience: 'app.example.com', days: 1 },
    })
  for (const callback of ['https://[::1]/callback', 'https://my_app.example.com/callback'])
    assert.equal((await register(callback)).statusCode, 422, callback)
  assert.equal((await register('https://app.example.com:8443/callback')).statusCode, 200)
})
