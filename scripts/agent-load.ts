// Reviewer, on a gate host, without sudo. Synthetic upstream; real loopback HTTP and engines.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { service } from '../server/service.ts'
const agents = 60
const calls = Number(process.env.OPENPASSWORD_BENCH_CALLS_PER_AGENT ?? 5)
if (!Number.isInteger(calls) || calls < 3 || calls > 100)
  throw Error('Use 3 to 100 calls per agent')
const home = mkdtempSync(join(tmpdir(), 'op-load-'))
const api = service(
  home,
  undefined,
  async () =>
    new Response(
      new ReadableStream({
        async start(c) {
          c.enqueue(Buffer.from('data: {"choices":[]}\n\n'))
          await sleep(15)
          c.enqueue(
            Buffer.from(
              'data: {"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\ndata: [DONE]\n\n',
            ),
          )
          c.close()
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    ),
  false,
  false,
  { engineBin: resolve('engine-bin') },
)
const db = new DatabaseSync(join(home, 'vault.sqlite')),
  url = await api.listen({ host: '127.0.0.1', port: 0 })
let cookie = '',
  done = false,
  maxDepth = 0,
  lastEvent = 0,
  restarted = false
const latency: number[] = [],
  auditLag: number[] = [],
  spendLag: number[] = []
const usage = new Map<string, number>()
const depth = db.prepare('SELECT count(*) n FROM engine_events')
const settled = db.prepare("SELECT execution FROM model_charges WHERE state='settled'")
const timer = setInterval(() => {
  maxDepth = Math.max(maxDepth, Number(depth.get()!.n))
  for (const r of settled.all())
    if (!usage.has(String(r.execution))) usage.set(String(r.execution), performance.now())
}, 10)
async function call(path: string, body?: object, headers: Record<string, string> = {}) {
  const r = await fetch(url + path, {
    method: body ? 'POST' : 'GET',
    headers: { cookie, 'content-type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  })
  assert.equal(r.status, 200, path + ' ' + r.status)
  return r
}
function percentile(list: number[], p: number) {
  return +list.toSorted((a, b) => a - b)[Math.ceil(list.length * p) - 1].toFixed(1)
}
try {
  cookie = (
    await call('/admin/login', { token: readFileSync(join(home, 'operator.token'), 'utf8') })
  ).headers
    .get('set-cookie')!
    .split(';')[0]
  const c = await (
    await call('/admin/connections', {
      provider: 'openai',
      label: 'fixture',
      external_identity: 'fixture',
      secret: 'fixture',
    })
  ).json()
  const keys = []
  for (let i = 0; i < agents; i++) {
    const g = await (
      await call('/admin/grants', {
        label: 'agent' + i,
        connection_id: c.connection_id,
        operations: ['openai.chat'],
        hours: 1,
        model_lease: {
          model: 'example',
          max_tokens: 10,
          calls,
          tariff: {
            source: 'https://example.com',
            as_of: '2026-11-22',
            budget_micro_usd: 10000,
            input: 1000000,
            output: 2000000,
          },
        },
      })
    ).json()
    keys.push(g.access_token)
  }
  function workflowWorker() {
    const ps = execFileSync('ps', ['-Ao', 'pid=,ppid=,comm='], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
    const parents = new Set(ps.filter((r) => Number(r[1]) === process.pid).map((r) => r[0]))
    return ps.find(
      (r) => (parents.has(r[1]) || Number(r[1]) === process.pid) && /(?:^|\/)ephemeral$/.test(r[2]),
    )
  }
  let oldWorker = ''
  const initial = Number(db.prepare('SELECT max(id) n FROM events').get()!.n)
  async function watch() {
    const limit = performance.now() + 90000
    let cursor = initial
    while (!done || cursor < lastEvent) {
      assert.ok(performance.now() < limit, 'Activity replay timed out')
      const page = await (await call('/admin/activity?wait=150&after=' + cursor)).json()
      for (const e of page.events) {
        assert.ok(e.id > cursor)
        cursor = e.id
        auditLag.push(Date.now() - e.at)
      }
    }
  }
  const watchers = Promise.all([watch(), watch()])
  watchers.catch(() => {})
  const started = performance.now()
  const cpu = process.cpuUsage(),
    rss = process.memoryUsage.rss()
  const timings = new Map<string, number>()
  await Promise.all(
    keys.map(async (key, i) => {
      for (let n = 0; n < calls; n++) {
        if (i === 0 && n === 2) {
          const worker = workflowWorker()
          assert.ok(worker)
          process.kill(Number(worker[0]), 'SIGTERM')
          oldWorker = worker[0]
        }
        const id = 'synthetic-' + i + '-' + n,
          t = performance.now()
        const res = await call(
          '/v1/chat/completions',
          {
            model: 'example',
            max_tokens: 10,
            stream: true,
            messages: [{ role: 'user', content: 'fixture' }],
          },
          { authorization: 'Bearer ' + key, 'idempotency-key': id },
        )
        assert.match(await res.text(), /\[DONE\]/)
        latency.push(performance.now() - t)
        const row = db.prepare('SELECT id FROM runs WHERE idem=?').get(id)
        assert.ok(row)
        timings.set(String(row.id), t)
      }
    }),
  )
  const requestsEnd = performance.now()
  lastEvent = Number(db.prepare('SELECT max(id) n FROM events').get()!.n)
  done = true
  const deadline = performance.now() + 60000
  while ((Number(depth.get()!.n) || usage.size < agents * calls) && performance.now() < deadline)
    await sleep(10)
  await watchers
  const drained = performance.now()
  for (const [id, t] of timings) {
    const seen = usage.get(id)
    assert.ok(seen)
    spendLag.push(seen - t)
  }
  assert.equal(Number(depth.get()!.n), 0)
  assert.equal(usage.size, agents * calls)
  const workspace = await (await call('/admin/workspace')).json()
  assert.equal(
    workspace.billing.reduce((v: number, r: { spent: number }) => v + r.spent, 0),
    8 * agents * calls,
  )
  assert.equal(
    auditLag.length,
    2 * Number(db.prepare('SELECT count(*) n FROM events WHERE id>?').get(initial)!.n),
  )
  for (let i = 0; i < 100; i++) {
    const current = workflowWorker()
    if (
      current &&
      oldWorker &&
      current[0] !== oldWorker &&
      (await (await call('/health')).json()).status === 'ok'
    ) {
      restarted = true
      break
    }
    await sleep(100)
  }
  assert.ok(restarted, 'Replacement workflow worker did not reach readiness')
  const used = process.cpuUsage(cpu)
  console.log(
    JSON.stringify({
      agents,
      calls: latency.length,
      watchers: 2,
      restarted,
      request_ms: { p95: percentile(latency, 0.95), p99: percentile(latency, 0.99) },
      settled_visible_from_request_ms: {
        p95: percentile(spendLag, 0.95),
        p99: percentile(spendLag, 0.99),
      },
      audit_visible_from_event_ms: {
        p95: percentile(auditLag, 0.95),
        p99: percentile(auditLag, 0.99),
      },
      max_sampled_queue: maxDepth,
      catchup_ms: Math.round(drained - requestsEnd),
      requests_duration_ms: Math.round(requestsEnd - started),
      broker_and_driver_cpu_ms: (used.user + used.system) / 1000,
      broker_and_driver_rss_start_mib: rss / 1048576,
      broker_and_driver_rss_end_mib: process.memoryUsage.rss() / 1048576,
    }),
  )
} finally {
  done = true
  clearInterval(timer)
  await api.close()
  db.close()
  rmSync(home, { recursive: true, force: true })
}
