import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { service } from '../server/service.ts'
import { scriptToNotebook, notebookToScript } from '../packages/connectors/local.ts'
test('workspace memberships, revocation and human-only vault items', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'op-roles-')),
    api = service(dir)
  t.after(async () => {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const post = (url: string, payload: object, cookie = '') =>
    api.inject({ method: 'POST', url, payload, headers: { cookie } })
  const login = async (token: string) =>
    String((await post('/admin/login', { token })).headers['set-cookie']).split(';')[0]
  const owner = await login(readFileSync(join(dir, 'operator.token'), 'utf8'))
  const editor = (
      await post('/admin/members', { role: 'editor', label: 'Team editor' }, owner)
    ).json(),
    viewer = (await post('/admin/members', { role: 'viewer', label: 'Team viewer' }, owner)).json()
  const e = await login(editor.token),
    v = await login(viewer.token)
  const item = (
    await post(
      '/admin/items',
      { title: 'Example', username: 'Example user', value: 'test password' },
      e,
    )
  ).json()
  assert.equal((await post('/admin/items/' + item.id + '/reveal', {}, v)).statusCode, 403)
  assert.equal(
    (await post('/admin/items/' + item.id + '/reveal', {}, e)).json().value,
    'test password',
  )
  assert.equal((await post('/admin/workspaces', { label: 'Other' }, e)).statusCode, 403)
  assert.equal((await post('/admin/dispatch', { paused: true }, e)).statusCode, 403)
  assert.equal((await post('/admin/dispatch', { paused: true }, owner)).json().paused, true)
  const b = await api.inject({ method: 'GET', url: '/admin/workspace', headers: { cookie: v } })
  assert.equal(b.json().items.length, 1)
  assert.ok(!b.body.includes('test password'))
  await api.inject({
    method: 'DELETE',
    url: '/admin/members/' + editor.member_id,
    headers: { cookie: owner },
  })
  assert.equal((await post('/admin/items/' + item.id + '/reveal', {}, e)).statusCode, 401)
  const overview = (cookie: string) =>
    api.inject({ url: '/admin/team-overview', headers: { cookie } })
  assert.equal((await overview(v)).statusCode, 403)
  const result = await overview(owner)
  assert.equal(result.json().access.member, 'Team editor')
  assert.equal(result.json().access.item, item.id)
  assert.ok(!result.body.includes('test password'))
  const second = (await post('/admin/workspaces', { label: 'Another team' }, owner)).json()
  await post('/admin/switch', second, owner)
  assert.deepEqual((await overview(owner)).json(), { item: null, access: null })
})
test('percent script notebook round trip preserves cell kind and source', () => {
  const source = '# %% [markdown]\n# Introduction\n# %%\nprint("example")\n'
  assert.equal(notebookToScript(scriptToNotebook(source)), source)
})
test('notebook semantic receipts retain cell IDs, attachments and unknown metadata', async () => {
  const { notebookSemantics, compareNotebookSemantics } = await import(
    '../packages/connectors/local.ts'
  )
  const source = {
    metadata: { jupytext: { text_representation: { jupytext_version: 'one' } } },
    cells: [
      {
        id: 'x',
        cell_type: 'code',
        metadata: { tags: ['lecture'] },
        source: ['x=1\r\n'],
        outputs: [],
        attachments: {},
      },
    ],
  }
  const rhs = structuredClone(source)
  rhs.metadata.jupytext.text_representation.jupytext_version = 'two'
  rhs.cells[0].source = ['x=1\n']
  const left = notebookSemantics(JSON.stringify(source), 'ipynb'),
    compare = () => compareNotebookSemantics(left, notebookSemantics(JSON.stringify(rhs), 'ipynb'))
  assert.equal(compare().equivalent, true)
  rhs.cells[0].id = 'y'
  assert.equal(compare().mismatch, 'CELL_0:cell_id')
})
