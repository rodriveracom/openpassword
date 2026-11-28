// Captures the README screenshots from a throwaway installation with made-up accounts and agents.
// No provider is contacted: the broker's outbound transport is replaced below.
// After `make build`: node --import tsx scripts/screenshots.ts OUTPUT_DIR
import { chromium, type Page } from 'playwright-core'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { service } from '../server/service.ts'

const out = resolve(process.argv[2] ?? '')
assert.ok(process.argv[2], 'Usage: node --import tsx scripts/screenshots.ts OUTPUT_DIR')
mkdirSync(out, { recursive: true })

const stub: typeof fetch = async (input) => {
  const url = new URL(String(input))
  if (url.hostname === 'api.github.com')
    return Response.json(
      url.pathname === '/user'
        ? { login: 'example-user', id: 1 }
        : [{ id: 2, name: 'example-service', full_name: 'example-org/example-service' }],
    )
  if (url.hostname === 'api.openai.com')
    return Response.json({
      id: 'chatcmpl-example',
      object: 'chat.completion',
      model: 'example-model',
      choices: [
        { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Done.' } },
      ],
      usage: { prompt_tokens: 420, completion_tokens: 180, total_tokens: 600 },
    })
  throw Error('The screenshot fixture does not contact ' + url.hostname)
}

const dir = mkdtempSync(join(tmpdir(), 'openpassword-screenshots-'))
const probe = createServer()
probe.listen(0, '127.0.0.1')
await once(probe, 'listening')
const port = (probe.address() as { port: number }).port
await new Promise<void>((ok) => probe.close(() => ok()))
const origin = 'http://localhost:' + port
const broker = service(dir, origin, stub)

async function post(page: Page, path: string, data: object) {
  const response = await page.request.post(origin + '/api' + path, { headers: { origin }, data })
  assert.equal(response.status(), 200, path + ' ' + (await response.text()))
  return response.json()
}
async function agent(token: string, path: string, body: object, key?: string) {
  const response = await fetch(origin + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'OpenPassword-Protocol-Version': '1',
      Authorization: 'Bearer ' + token,
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  assert.equal(response.status, 200, path + ' ' + text)
  return JSON.parse(text)
}

async function populate(page: Page) {
  const connect = async (provider: string, label: string, identity: string) =>
    (
      await post(page, '/admin/connections', {
        provider,
        label,
        external_identity: identity,
        secret: 'synthetic-screenshot-value',
      })
    ).connection_id as string
  const github = await connect('github_read', 'Engineering GitHub', 'example-org')
  const openai = await connect('openai', 'Product OpenAI', 'models@example.com')
  const loops = await connect('loops', 'Newsletter', 'editorial@example.com')
  const grant = async (label: string, connection: string, operations: string[], extra = {}) =>
    (
      await post(page, '/admin/grants', {
        label,
        connection_id: connection,
        operations,
        hours: 168,
        ...extra,
      })
    ).access_token as string
  const reviewer = await grant('Release reviewer', github, ['github.user.get', 'github.repos.list'])
  const support = await grant('Support assistant', openai, ['openai.chat'], {
    model_lease: {
      model: 'example-model',
      calls: 200,
      max_tokens: 512,
      tariff: {
        input: 2000000,
        output: 8000000,
        budget_micro_usd: 5000000,
        as_of: '2026-11-01',
        source: 'https://example.com/pricing',
      },
    },
  })
  const writer = await grant('Newsletter writer', loops, ['loops.newsletter.create_campaign'])
  const invoke = (token: string, connection: string, operation: string, args: object, key: string) =>
    agent(token, '/v1/operations/' + operation + ':invoke', {
      connection_id: connection,
      operation_id: operation,
      arguments: args,
      idempotency_key: key,
    })
  for (let i = 0; i < 6; i++)
    await invoke(reviewer, github, i % 2 ? 'github.repos.list' : 'github.user.get', {}, 'read-' + i)
  for (let i = 0; i < 9; i++)
    await agent(
      support,
      '/v1/chat/completions',
      {
        model: 'example-model',
        messages: [{ role: 'user', content: 'Summarize the open questions.' }],
        max_tokens: 256,
      },
      'chat-' + i,
    )
  for (const name of ['November product notes', 'Maintenance window announcement']) {
    const held = await invoke(writer, loops, 'loops.newsletter.create_campaign', { name }, name)
    assert.equal(held.status, 'approval_required')
  }
}

try {
  await broker.listen({ host: '127.0.0.1', port: Number(process.env.OPENPASSWORD_PORT || 4141) })
  const web = spawn(
    process.execPath,
    ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)],
    { stdio: 'ignore' },
  )
  try {
    let ready = false
    for (let i = 0; i < 100 && !ready; i++) {
      try {
        ready = (await fetch(origin + '/api/health')).ok
      } catch {}
      if (!ready) await delay(100)
    }
    assert.ok(ready, 'The console did not reach its broker')
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    })
    try {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 2,
        colorScheme: 'light',
      })
      await page.goto(origin)
      const code = await new Promise<string>((ok, no) =>
        execFile(
          process.execPath,
          ['public/openpassword-cli.cjs', 'setup-code'],
          {
            env: {
              ...process.env,
              HOME: dir,
              OPENPASSWORD_HOME: dir,
              OPENPASSWORD_BROKER: origin,
            },
          },
          (error, stdout) => (error ? no(Error('setup-code failed')) : ok(stdout.trim())),
        ),
      )
      await page.getByLabel('Setup code', { exact: true }).fill(code)
      await page.getByRole('button', { name: 'Continue to account' }).click()
      await page.getByLabel('Username').fill('operator')
      await page.getByLabel('Choose a password').fill('screenshot-fixture-only')
      await page.getByRole('button', { name: 'Create administrator' }).click()
      await page.getByRole('heading', { name: 'Your team vault' }).waitFor()
      await populate(page)

      const screens: [string, string, string][] = [
        ['connections', '/connections', 'Engineering GitHub'],
        ['grants', '/grants', 'Release reviewer'],
        ['approvals', '/approvals', 'November product notes'],
        ['consumption', '/consumption', 'Support assistant'],
        ['activity', '/activity', 'Live'],
      ]
      const shoot = async (name: string, path: string, expected: string) => {
        await page.goto(origin + path)
        await page.getByText(expected).first().waitFor()
        // Let fonts and the long-poll indicator settle before the picture.
        await page.evaluate(() => document.fonts.ready)
        await delay(800)
        const file = join(out, name + '.png')
        await page.screenshot({ path: file, animations: 'disabled' })
        console.log(createHash('sha256').update(readFileSync(file)).digest('hex'), name + '.png')
      }
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme })
        for (const [name, path, expected] of screens)
          await shoot(name + '-' + scheme, path, expected)
      }
      await page.emulateMedia({ colorScheme: 'light' })
      await page.setViewportSize({ width: 390, height: 844 })
      await shoot('phone-approvals-light', '/approvals', 'November product notes')
    } finally {
      await browser.close()
    }
  } finally {
    web.kill('SIGTERM')
  }
} finally {
  await broker.close()
  rmSync(dir, { recursive: true, force: true })
}
