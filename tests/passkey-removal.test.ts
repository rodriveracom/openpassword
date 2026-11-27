import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { service } from '../server/service.ts'

const origin = 'http://localhost:3000'
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest()

// The smallest ES256 authenticator the server's verifier accepts.
function authenticator() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  const id = sha256('example-credential').toString('base64url')
  const cose = Buffer.concat([
    Buffer.from('a5010203262001215820', 'hex'),
    Buffer.from(jwk.x!, 'base64url'),
    Buffer.from('225820', 'hex'),
    Buffer.from(jwk.y!, 'base64url'),
  ])
  let counter = 0
  function assert(challenge: string) {
    const count = Buffer.alloc(4)
    count.writeUInt32BE(++counter)
    // RP ID hash, then user-present and user-verified, then the signature counter.
    const data = Buffer.concat([sha256('localhost'), Buffer.from([0x05]), count])
    const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }))
    return {
      id,
      rawId: id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: client.toString('base64url'),
        authenticatorData: data.toString('base64url'),
        signature: sign('sha256', Buffer.concat([data, sha256(client)]), privateKey).toString(
          'base64url',
        ),
      },
    }
  }
  return { id, cose, assert }
}

test('removing a passkey drops it and its pending approvals together or not at all', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'passkey-removal-')),
    api = service(dir)
  const db = new DatabaseSync(join(dir, 'vault.sqlite'))
  t.after(async () => {
    db.close()
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const login = await api.inject({
    url: '/admin/login',
    method: 'POST',
    payload: { token: readFileSync(join(dir, 'operator.token'), 'utf8') },
  })
  const cookie = String(login.headers['set-cookie']).split(';')[0]
  const key = authenticator()
  db.prepare('INSERT INTO passkeys VALUES(?,?,?,?,?,?)').run(
    key.id,
    'owner',
    'handle',
    key.cose,
    0,
    'fixture',
  )
  const url = '/profile/passkeys/' + key.id
  const remove = (proof?: string) =>
    api.inject({
      method: 'DELETE',
      url,
      headers: { cookie, ...(proof ? { 'openpassword-approval': proof } : {}) },
    })
  async function approve() {
    const refused = await remove()
    assert.equal(refused.statusCode, 428, refused.body)
    const { id, options } = refused.json().approval
    const response = await api.inject({
      method: 'POST',
      url: '/profile/passkeys/approve',
      headers: { cookie },
      payload: { id, response: key.assert(options.challenge) },
    })
    assert.equal(response.statusCode, 200, response.body)
    return String(response.json().proof)
  }
  const count = (table: 'passkeys' | 'pk_attempts') =>
    Number(db.prepare('SELECT COUNT(*) AS n FROM ' + table).get()!.n)

  const first = await approve()
  // A second approval still pending, and a discard that fails.
  db.prepare('INSERT INTO pk_attempts VALUES(?,?,?,?,?,?)').run(
    'pending',
    'action',
    String(db.prepare('SELECT token FROM sessions').get()!.token),
    '',
    '',
    Date.now() + 60000,
  )
  db.exec(`CREATE TRIGGER refuse_discard BEFORE DELETE ON pk_attempts WHEN old.id='pending'
    BEGIN SELECT RAISE(ABORT,'discard refused'); END`)
  assert.equal((await remove(first)).statusCode, 500)
  assert.equal(count('passkeys'), 1, 'the passkey was removed although its approvals remain')

  db.exec('DROP TRIGGER refuse_discard')
  const removed = await remove(await approve())
  assert.equal(removed.statusCode, 200, removed.body)
  assert.equal(count('passkeys'), 0)
  assert.equal(count('pk_attempts'), 0)
})
