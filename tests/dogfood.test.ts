import test from 'node:test'
import assert from 'node:assert/strict'
import { fork, execFileSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'

test(
  'engine-backed crash recovery, backup replay and synchronous revocation',
  { timeout: 90000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'op-engine-test-'))
    let child: ChildProcess | undefined,
      url = '',
      cookie = '',
      bearer = ''
    async function kill() {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exit = once(child, 'exit')
        child.kill('SIGKILL')
        await exit
      }
    }
    t.after(async () => {
      await kill()
      rmSync(dir, { recursive: true, force: true })
    })
    async function start(path = dir) {
      child = fork('tests/fixtures/engine-broker.ts', [path], {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        env: { ...process.env, TMPDIR: dir },
      })
      const [origin] = await once(child, 'message')
      url = origin
      for (let i = 0; i < 100; i++) {
        if ((await (await fetch(url + '/health')).json()).status === 'ok') return
        await sleep(50)
      }
      assert.fail('engines unavailable')
    }
    async function request(
      method: string,
      path: string,
      data?: object,
      status = 200,
      extra: Record<string, string> = {},
    ) {
      const response = await fetch(url + path, {
        method,
        headers: {
          cookie,
          authorization: 'Bearer ' + bearer,
          'openpassword-protocol-version': '1',
          ...(data ? { 'content-type': 'application/json' } : {}),
          ...extra,
        },
        body: data ? JSON.stringify(data) : undefined,
      })
      assert.equal(response.status, status, method + ' ' + path)
      return response
    }
    const post = async (
      path: string,
      data: object,
      status = 200,
      headers: Record<string, string> = {},
    ) => (await request('POST', path, data, status, headers)).json()
    await start()
    cookie = (
      await request('POST', '/admin/login', {
        token: readFileSync(join(dir, 'operator.token'), 'utf8'),
      })
    ).headers
      .get('set-cookie')!
      .split(';')[0]
    const connection = (
      await post('/admin/connections', {
        provider: 'x',
        label: 'Private label',
        external_identity: 'Private account',
        secret: 'never-in-engines',
      })
    ).connection_id
    const pair = await post('/v1/device/authorizations', { device_name: 'synthetic' })
    await kill()
    await start()
    const grant = {
      connection_id: connection,
      label: 'publisher',
      operations: ['x.publish'],
      hours: 1,
      user_code: pair.user_code,
    }
    const { device_id } = await post('/admin/grants', grant)
    await kill()
    await start()
    const retry = { 'idempotency-key': randomUUID() }
    const redeem = () => post('/v1/device/token', { device_code: pair.device_code }, 200, retry)
    const issued = await redeem()
    await kill()
    await start()
    assert.deepEqual(await redeem(), issued)
    bearer = issued.access_token
    const op = {
      connection_id: connection,
      operation_id: 'x.publish',
      idempotency_key: 'one',
      arguments: { text: 'example' },
      expect: { external_identity: 'Private account', connection_revision: '1' },
    }
    const invoke = () =>
      post('/v1/operations/x.publish:invoke', op, 200, {
        'openpassword-capabilities': 'expected-binding',
      })
    const approval = await invoke()
    assert.equal(approval.status, 'approval_required')
    await kill()
    await start()
    const db = new DatabaseSync(join(dir, 'vault.sqlite'))
    t.after(() => db.close())
    // Freeze the actual scheduler, persist the human decision, and kill the broker
    // before it can receive a lease. The new broker must apply that one decision.
    const table = execFileSync('ps', ['-Ao', 'pid=,ppid=,comm='], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
    const guardians = table.filter((row) => Number(row[1]) === child!.pid).map((row) => row[0])
    const worker = table.find(
      (row) => guardians.includes(row[1]) && /(?:^|\/)ephemeral$/.test(row[2]),
    )
    assert.ok(worker)
    const pid = Number(worker[0])
    process.kill(pid, 'SIGSTOP')
    try {
      const decision = await post('/admin/approvals/' + approval.execution_id, { approve: true })
      assert.equal(decision.pending, true)
      assert.equal(
        db.prepare('SELECT state FROM runs WHERE id=?').get(approval.execution_id)?.state,
        'pending',
      )
      await kill()
    } finally {
      try {
        process.kill(pid, 'SIGCONT')
      } catch {}
    }

    await start()
    let recovered = await invoke()
    for (let attempt = 0; recovered.status === 'approval_required' && attempt < 100; attempt++) {
      await sleep(50)
      recovered = await invoke()
    }
    assert.equal(recovered.status, 'confirmed')
    assert.equal(db.prepare('SELECT count(*) AS n FROM grants').get()?.n, 1)
    assert.equal(db.prepare('SELECT count(*) AS n FROM runs').get()?.n, 1)
    const previous = (await (await request('GET', '/admin/activity?wait=0')).json()).cursor
    const started = performance.now()
    await request('DELETE', '/admin/grants/' + device_id)
    const revoked = performance.now()
    await request('GET', '/v1/whoami', undefined, 401)
    t.diagnostic(
      'Revocation HTTP round-trip ' +
        (revoked - started).toFixed(2) +
        ' ms; next authorized call refused in ' +
        (performance.now() - revoked).toFixed(2) +
        ' ms',
    )
    await kill()
    await start()
    const replay = async () =>
      (await (await request('GET', '/admin/activity?after=' + previous + '&wait=1000')).json())
        .events
    let events = await replay()
    for (
      let i = 0;
      i < 40 && !events.some((x: { action: string }) => x.action === 'Access revoked');
      i++
    ) {
      await sleep(50)
      events = await replay()
    }
    assert.equal(events.filter((x: { action: string }) => x.action === 'Access revoked').length, 1)
    const begin = performance.now()
    db.exec(
      "BEGIN; WITH RECURSIVE n(i) AS(SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<500) INSERT INTO events(tenant,actor,subject,action,at) SELECT 'default','system','private fixture','Synthetic',0 FROM n; COMMIT",
    )
    for (let i = 0; i < 1000 && db.prepare('SELECT 1 FROM engine_events LIMIT 1').get(); i++)
      await sleep(20)
    assert.ok(!db.prepare('SELECT 1 FROM engine_events LIMIT 1').get())
    t.diagnostic(
      'Delivered 500 committed audit rows through gateway in ' +
        (performance.now() - begin).toFixed(1) +
        ' ms',
    )
    // Seed already-expiring durable intents without waiting ten minutes.
    db.prepare(
      "INSERT INTO pairs VALUES('test-expiry','synthetic-code','synthetic-user','test',1,NULL)",
    ).run()
    db.prepare(
      "INSERT INTO cli_hosts(id,tenant,label,ticket,expires) VALUES('test-expiry','default','label','synthetic-ticket',1)",
    ).run()
    db.prepare("INSERT INTO model_charges VALUES('synthetic-execution',?,100,5,'settled',1)").run(
      device_id,
    )
    db.prepare("UPDATE model_charges SET charged=6 WHERE execution='synthetic-execution'").run()
    for (
      let i = 0;
      i < 100 &&
      (db.prepare("SELECT 1 FROM pairs WHERE id='test-expiry'").get() ||
        db.prepare("SELECT 1 FROM cli_hosts WHERE id='test-expiry' AND ticket IS NOT NULL").get());
      i++
    )
      await sleep(50)
    assert.equal(db.prepare("SELECT 1 FROM pairs WHERE id='test-expiry'").get(), undefined)
    assert.equal(
      db.prepare("SELECT ticket FROM cli_hosts WHERE id='test-expiry'").get()?.ticket,
      null,
    )
    assert.deepEqual(
      db
        .prepare("SELECT charged FROM engine_accounting WHERE kind='meter' ORDER BY seq")
        .all()
        .map((row) => row.charged),
      [5, 6],
    )
    const engineDirs = readdirSync(dir).filter(
      (name) => name.startsWith('openpassword-stream-') || name.startsWith('openpassword-flow-'),
    )
    assert.ok(engineDirs.length >= 2)
    for (const name of engineDirs) {
      for (const entry of readdirSync(join(dir, name), { withFileTypes: true, recursive: true })) {
        if (!entry.isFile()) continue
        const bytes = readFileSync(join(entry.parentPath, entry.name))
        for (const marker of [
          'never-in-engines',
          'Private account',
          bearer,
          pair.device_code,
          'synthetic-ticket',
          'synthetic-execution',
          device_id,
        ]) {
          assert.ok(!bytes.includes(marker), 'fixture data reached an engine')
        }
      }
    }
    const snapshot = join(dir, 'snapshot')
    mkdirSync(snapshot, { mode: 0o700 })
    execFileSync(process.execPath, ['deploy/backup/snapshot.mjs', dir, snapshot])
    assert.deepEqual(readdirSync(snapshot).sort(), ['master.key', 'operator.token', 'vault.sqlite'])
    await kill()
    await start(snapshot)
    await request('GET', '/v1/whoami', undefined, 401)
    assert.ok((await replay()).length > 0)
  },
)

test('offline wrapping-key workflow is replayable and refuses a competing owner', async () => {
  const { store } = await import('../server/store.ts')
  const { writeFileSync } = await import('node:fs')
  const { randomBytes } = await import('node:crypto')
  const { claimEngineOwner } = await import('../server/engines.ts')
  const dir = mkdtempSync(join(tmpdir(), 'op-rewrap-'))
  try {
    const a = join(dir, 'previous'),
      b = join(dir, 'replacement'),
      vault = join(dir, 'vault')
    for (const key of [a, b]) writeFileSync(key, randomBytes(32).toString('hex'), { mode: 0o600 })
    const before = store(vault, a),
      cipher = before.seal('synthetic', 'item')
    before.db.close()
    const run = () =>
      execFileSync(process.execPath, ['deploy/rotate-wrapping-key.ts', vault, a, b], {
        stdio: 'pipe',
      })
    const lock = claimEngineOwner(vault)
    try {
      assert.throws(run)
    } finally {
      lock.close()
    }
    run()
    run()
    assert.throws(() => store(vault, a))
    const after = store(vault, b)
    assert.equal(after.open(cipher, 'item'), 'synthetic')
    after.db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
