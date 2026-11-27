import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { service } from '../server/service.ts'
import { OpenPassword } from '../packages/client/index.ts'

const headers = { 'openpassword-protocol-version': '1' }

test('a refused request reports the broker explanation as one short line', async (t) => {
  let body = '{"detail":"Expired pairing","public":true}'
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { status: 400, headers }))
  const client = new OpenPassword('http://localhost')
  const message = async (call: Promise<unknown>) => {
    const error = (await call.then(
      () => assert.fail('the request was accepted'),
      (e: unknown) => e,
    )) as Error & { status?: number }
    assert.equal(error.status, 400)
    return error.message
  }

  // An expired pairing gets its own instruction; other calls keep the broker's words.
  assert.equal(await message(client.redeem('code')), 'Pairing expired. Start a new pairing request.')
  assert.equal(
    await message(client.artifact('art_123e4567-e89b-12d3-a456-426614174000')),
    'Broker returned 400: Expired pairing',
  )

  // Terminal controls, direction overrides and line breaks never reach the caller.
  body = JSON.stringify({ public: true, detail: 'one\r\ntwo\u001b[2J‮three four' })
  assert.equal(await message(client.redeem('code')), 'Broker returned 400: one two [2J three four')

  body = JSON.stringify({ public: true, detail: 'x'.repeat(3000) })
  assert.equal(await message(client.redeem('code')), 'Broker returned 400: ' + 'x'.repeat(200))

  for (body of [
    '',
    'not json',
    'null',
    '{"public":true,"detail":{"nested":true}}',
    '{"public":true,"detail":" "}',
    // Unmarked, or marked with something other than true: never passed on.
    '{"detail":"framework text"}',
    '{"public":"true","detail":"framework text"}',
    // Longer than the read limit.
    JSON.stringify({ public: true, detail: 'x'.repeat(5000) }),
  ])
    assert.equal(await message(client.redeem('code')), 'Broker returned 400', body.slice(0, 80))
})

test('a refusal body that never ends leaves the status alone', async (t) => {
  let cancelled = false
  const endless = new ReadableStream({
    start: (controller) => controller.enqueue(new TextEncoder().encode('{"public":true,')),
    cancel: () => {
      cancelled = true
    },
  })
  t.mock.method(globalThis, 'fetch', async () => new Response(endless, { status: 400, headers }))
  await assert.rejects(new OpenPassword('http://localhost').redeem('code'), {
    message: 'Broker returned 400',
  })
  assert.ok(cancelled)
})

test('the broker marks its own refusals public and nothing else', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'op-refusal-')),
    api = service(dir)
  t.after(async () => {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const redeem = (payload: string) =>
    api.inject({
      method: 'POST',
      url: '/v1/device/token',
      headers: { 'openpassword-protocol-version': '1', 'content-type': 'application/json' },
      payload,
    })
  const expired = await redeem('{"device_code":"unknown"}')
  assert.equal(expired.statusCode, 400)
  assert.deepEqual(expired.json(), { detail: 'Expired pairing', public: true })
  // A framework parse error and a validation error carry no mark.
  for (const payload of ['{', '{}']) {
    const refused = await redeem(payload)
    assert.ok(refused.statusCode >= 400 && refused.statusCode < 500, refused.body)
    assert.equal(refused.json().public, undefined, refused.body)
  }
})
