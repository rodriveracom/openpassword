import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { service } from '../server/service.ts'
import { digest } from '../server/store.ts'
import { bundleOperation, uploadFolder } from '../server/issue-files.ts'

test('HubSpot issue stages bound images, approves once, substitutes the returned URL and preserves partial receipts across restart', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'op-issue-'))
  const assetURL = 'https://files.hubspotusercontent.net/assets/cover.png'
  let uploads = 0,
    templates = 0,
    reject = false
  const send: typeof fetch = async (url, opts) => {
    assert.equal(new URL(String(url)).hostname, 'api.hubapi.com')
    const form = opts?.body as FormData
    if (String(url).includes('/files/v3/files')) {
      uploads++
      if (reject) return new Response(null, { status: 429 })
      assert.equal(form.get('folderPath'), '/example-assets/issue-one')
      assert.equal((form.get('file') as Blob).size, bytes.length)
      return Response.json({ id: '42', url: assetURL })
    }
    assert.ok(String(url).includes('/draft/content/news/template.html'))
    assert.equal(await (form.get('file') as Blob).text(), '<img src="' + assetURL + '">')
    templates++
    return new Response()
  }
  let app = service(dir, undefined, send),
    cookie = '',
    bearer = ''
  t.after(async () => {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const req = async (
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
    expected = 200,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.inject({
      method,
      url,
      payload,
      headers: {
        'openpassword-protocol-version': '1',
        cookie,
        authorization: 'Bearer ' + bearer,
        ...headers,
      },
    })
    assert.equal(res.statusCode, expected, res.body)
    return res
  }
  cookie = String(
    (
      await req('POST', '/admin/login', {
        token: readFileSync(join(dir, 'operator.token'), 'utf8'),
      })
    ).headers['set-cookie'],
  ).split(';')[0]
  const c = (
    await req('POST', '/admin/connections', {
      provider: 'hubspot',
      label: 'Test portal',
      external_identity: '6711345',
      secret: 'example',
      resources: ['/example-assets/', 'news/'],
    })
  ).json().connection_id
  const pair = (await req('POST', '/v1/device/authorizations', { device_name: 'Publisher' })).json()
  await req('POST', '/admin/grants', {
    label: 'Publisher',
    connection_id: c,
    operations: [bundleOperation],
    hours: 1,
    user_code: pair.user_code,
  })
  bearer = (await req('POST', '/v1/device/token', { device_code: pair.device_code })).json()
    .access_token
  const bytes = await sharp({ create: { width: 4, height: 2, channels: 3, background: 'blue' } })
    .png()
    .toBuffer()
  const stage = '/v1/hubspot/issue-assets?connection_id=' + c + '&file_name=cover.png&sha256='
  await req('POST', stage + '0'.repeat(64), bytes, 422, { 'content-type': 'image/png' })
  const file = (
    await req('POST', stage + digest(bytes), bytes, 201, { 'content-type': 'image/png' })
  ).json()
  const url = '/v1/operations/' + bundleOperation + ':invoke'
  const args = {
    issue_id: 'issue-one',
    files: [file],
    bundle_sha256: digest(JSON.stringify([[file.file_name, file.sha256]])),
    template_files: [{ path: 'news/template.html', content: '<img src="${asset:cover.png}">' }],
  }
  const body = {
    connection_id: c,
    operation_id: bundleOperation,
    connector_revision: 'hubspot.newsroom@5',
    arguments: args,
    idempotency_key: 'one',
  }
  const pending = (await req('POST', url, body)).json()
  assert.equal(pending.status, 'approval_required')
  assert.equal(uploads, 0)
  // The approver is shown the folder the dispatch below uploads to.
  const shown = (await req('GET', '/admin/workspace'))
    .json()
    .approvals.find((a: { id: string }) => a.id === pending.execution_id)
  assert.equal(shown.preview.folder, '/example-assets/issue-one')
  await req('POST', '/admin/approvals/' + pending.execution_id, { approve: true })
  const result = (await req('POST', url, body)).json()
  assert.equal(result.result?.state, 'complete', JSON.stringify(result))
  assert.equal(templates, 1)
  await app.close()
  app = service(dir, undefined, send)
  assert.equal((await req('POST', url, body)).json().receipt.replayed, true)
  const inspect = (await req('GET', '/v1/hubspot/issues/issue-one?connection_id=' + c)).json()
  assert.equal(inspect.steps.length, 2)
  assert.equal(inspect.steps[0].url, assetURL)
  assert.equal(uploads, 1)
  await req('POST', url, { ...body, idempotency_key: 'conflict' }, 409)
  reject = true
  const other = { ...body, idempotency_key: 'two', arguments: { ...args, issue_id: 'issue-two' } }
  const second = (await req('POST', url, other)).json()
  await req('POST', '/admin/approvals/' + second.execution_id, { approve: true })
  const partial = (await req('POST', url, other)).json()
  assert.equal(partial.status, 'ambiguous')
  assert.equal(partial.receipt.issue_bundle.files[0].state, 'refused')
  assert.equal(templates, 1)
})

test('the upload folder is the one absolute folder among the selected resources', () => {
  assert.equal(uploadFolder(['news/', '/example-assets/']), '/example-assets/')
  assert.equal(uploadFolder(['/team/news_2.0/']), '/team/news_2.0/')
  for (const resources of [
    [],
    ['news/'],
    ['/one/', '/two/'],
    ['/'],
    ['/no-trailing-slash'],
    ['//double/'],
    ['/up/../'],
    ['/.hidden/'],
    ['/with space/'],
    ['/a/b/c/d/e/f/'],
    '/not-a-list/',
    null,
  ])
    assert.equal(uploadFolder(resources), null, JSON.stringify(resources))
})
