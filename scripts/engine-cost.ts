// Gate maintainer, on a Linux gate host, from the checkout, without sudo.
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import { EngineCli } from '../server/engine-cli.ts'
import { execFileSync } from 'node:child_process'
const home = mkdtempSync(join(tmpdir(), 'op-cost-'))
const broker = fork('tests/fixtures/engine-broker.ts', [home], {
  execArgv: ['--import', 'tsx'],
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  env: { ...process.env, TMPDIR: home },
})
try {
  const [url] = await once(broker, 'message')
  for (let i = 0; i < 100; i++) {
    if ((await (await fetch(url + '/health')).json()).status === 'ok') break
    await sleep(50)
  }
  function sample() {
    const rows = readdirSync('/proc')
      .filter((p) => /^\d+$/.test(p))
      .flatMap((p) => {
        try {
          const stat = readFileSync('/proc/' + p + '/stat', 'utf8')
            .split(') ')[1]
            .split(' ')
          return [
            {
              pid: Number(p),
              parent: Number(stat[1]),
              ticks: Number(stat[11]) + Number(stat[12]),
              rss: Number(stat[21]),
            },
          ]
        } catch {
          return []
        }
      })
    const family = new Set([broker.pid])
    for (let i = 0; i < 4; i++)
      for (const row of rows) if (family.has(row.parent)) family.add(row.pid)
    return rows
      .filter((r) => family.has(r.pid))
      .reduce((s, r) => ({ ticks: s.ticks + r.ticks, rss: s.rss + r.rss, count: s.count + 1 }), {
        ticks: 0,
        rss: 0,
        count: 0,
      })
  }
  await sleep(500)
  const before = sample(),
    start = performance.now()
  await sleep(5000)
  const after = sample(),
    elapsed = performance.now() - start
  console.log(
    JSON.stringify({
      processes: after.count,
      idle_window_ms: Math.round(elapsed),
      cpu_ms: ((after.ticks - before.ticks) * 1000) / Number(execFileSync('getconf', ['CLK_TCK'])),
      summed_rss_mib: (after.rss * Number(execFileSync('getconf', ['PAGESIZE']))) / 1048576,
    }),
  )
  const cli = new EngineCli(join(process.cwd(), 'engine-bin/ephemeral'), join(home, 'bench.sqlite'))
  try {
    await cli.call({
      op: 'register',
      name: 'bench',
      version: 1,
      steps: [{ kind: 'activity', name: 'one' }],
    })
    const samples = []
    for (let i = 0; i < 100; i++) {
      const t = performance.now(),
        id = 'r' + i
      await cli.call({
        op: 'start-once',
        id,
        name: 'bench',
        version: 1,
        queue: 'bench',
        value: null,
      })
      const task = await cli.call({ op: 'poll', queue: 'bench', leaseMS: 10000 })
      await cli.call({ op: 'finish', id, token: task.Token, value: null })
      samples.push(performance.now() - t)
    }
    samples.sort((a, b) => a - b)
    console.log(
      JSON.stringify({
        runs: 100,
        workflow_start_poll_finish_ms: { median: samples[49], p95: samples[94] },
      }),
    )
  } finally {
    cli.close()
  }
} finally {
  const exit = once(broker, 'exit')
  broker.kill()
  await exit
  rmSync(home, { recursive: true, force: true })
}
