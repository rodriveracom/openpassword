import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { activate, recoverPending, snapshotStore, restoreStore, resolveDataDir, refuseHostProofDowngrade, refuseVaultDowngrade, enforcesHostProof, dependentsOf } from '../deploy/upgrade.ts'

type Snap = { version: string | null; units: (string | null)[] }
const old: Snap = { version: '0.3.1', units: ['old-broker', 'old-web'] }
const next: Snap = { version: '0.4.0', units: ['new-broker', 'new-web'] }
type Rec = Snap & { dependents?: string[]; provisional?: true; published?: true; discard?: string; store?: string | null; data?: string; phase?: 'forward'; target?: Snap }

// A model of the host: the journal, the vault copy, the store schema and what is running. Every operation can
// be interrupted before it runs (`crashAt`), and the candidate can fail at any of its boundaries.
class Crash extends Error {}
type Host = ReturnType<typeof newHost>
function newHost() {
  return {
    pending: null as Rec | null,
    snapshots: new Set<string>(),
    snapshotSchema: new Map<string, number>(),
    schema: 1,
    release: old.version as string | null,
    running: 'old' as 'old' | 'private' | 'public' | 'none',
    oldServing: false, // the old release is up and may have acknowledged writes
    previous: null as string | null | undefined, // what previous.json names; undefined until written
    ingress: true, // a host unit that requires the console: systemd stops it with ours
    calls: 0,
    log: [] as string[],
  }
}
function host(
  opts: { crashAt?: number; candidate?: 'ok' | 'fail-after-migration' | 'fail-public' | 'grant-slips-in'; backup?: 'ok' | 'fail' },
  shared?: Host,
) {
  const h = shared ?? newHost()
  const tick = (name: string) => {
    h.log.push(name)
    if (++h.calls === opts.crashAt) throw new Crash(name)
  }
  const ops = {
    dependents: () => (h.ingress ? ['edge.service'] : []),
    revive: (names: string[]) => {
      tick('revive')
      assert.equal(h.running, 'public', 'dependents start only after the services are public')
      if (names.includes('edge.service')) h.ingress = true
    },
    save: (s: Rec) => {
      tick('save')
      if (s.store) {
        assert.ok(h.snapshots.has(s.store), 'the journal must never name a missing vault copy')
        assert.equal(s.data, '/state/openpassword', 'the journal records the state directory path with the copy')
      }
      h.pending = JSON.parse(JSON.stringify(s))
    },
    drain: async () => tick('drain'),
    stop: () => {
      tick('stop')
      h.running = 'none'
      h.ingress = false
    },
    fence: () => {
      tick('fence')
      assert.equal(h.running, 'none', 'the decisive check runs with the writer stopped')
      if (opts.candidate === 'grant-slips-in') throw Error('host-bound grant appeared during the drain')
    },
    backup: () => {
      tick('backup')
      if (opts.backup === 'fail') throw Error('state directory missing')
      h.snapshots.add('snap')
      h.snapshotSchema.set('snap', h.schema)
      return { store: 'snap', data: '/state/openpassword' }
    },
    prove: async (t: Snap) => {
      tick('prove')
      assert.equal(h.running, 'none')
      h.release = t.version
      h.running = 'private'
      h.schema = 2 // the candidate migrates the real store
      tick('prove-after-migration')
      if (opts.candidate === 'fail-after-migration') throw Error('candidate not ready')
      h.running = 'none'
    },
    publish: async (t: Snap) => {
      tick('publish ' + t.version)
      h.ingress = false // publish stops our services before starting them
      assert.equal(h.running === 'private' ? 'x' : 'ok', 'ok', 'publish stops the private candidate first')
      h.release = t.version
      if (t.version === old.version) {
        h.running = 'public'
        h.oldServing = true
      } else {
        if (opts.candidate === 'fail-public') throw Error('public start failed')
        h.running = 'public'
      }
    },
    healthy: async (t: Snap) => {
      tick('healthy')
      return h.running === 'public' && h.release === t.version
    },
    restore: (loc: { store: string; data: string }) => {
      const store = loc.store
      tick('restore')
      assert.equal(loc.data, '/state/openpassword', 'the restore uses the path from the journal')
      assert.equal(h.running, 'none', 'restore only with the services stopped')
      assert.ok(!h.oldServing, 'a restore must never follow the old release accepting writes')
      assert.ok(h.snapshots.has(store), 'the vault copy must exist when it is restored')
      h.schema = h.snapshotSchema.get(store)!
    },
    discard: (store: string) => {
      tick('discard')
      assert.ok(h.pending === null || h.pending.store !== store, 'the copy is deleted only after the journal stops naming it')
      h.snapshots.delete(store)
    },
    finish: (_s: Snap, store: string | null) => {
      tick('finish')
      h.previous = store
    },
    clear: () => {
      tick('clear')
      h.pending = null
    },
  }
  return { h, ops }
}
// The state the host must be in once any run, interrupted or not, has been recovered.
function consistent(h: Host) {
  const oldSide = h.release === old.version && h.schema === 1
  const newSide = h.release === next.version && h.schema === 2
  assert.ok(oldSide || newSide, 'release ' + h.release + ' with schema ' + h.schema + ' after ' + h.log.join(','))
  assert.equal(h.pending, null, 'the journal is cleared')
  assert.equal(h.running, 'public')
  assert.ok(h.ingress, 'the dependent unit is running again after ' + h.log.join(','))
  if (h.release === next.version) assert.equal(h.previous, 'snap', 'previous.json exists and names the copy')
}

for (const candidate of ['ok', 'fail-after-migration', 'fail-public'] as const)
  test('activation without interruption: ' + candidate, async () => {
    const { h, ops } = host({ candidate })
    const r = activate(old, next, ops)
    if (candidate === 'ok') {
      await r
      consistent(h)
      assert.equal(h.release, next.version)
      assert.ok(h.snapshots.has('snap'), 'the copy stays for the operator')
    } else if (candidate === 'fail-after-migration') {
      await assert.rejects(r, /candidate not ready/)
      consistent(h)
      assert.equal(h.release, old.version)
      assert.equal(h.schema, 1, 'the old release gets the old schema back')
      assert.ok(!h.snapshots.has('snap'))
    } else {
      // The candidate was proven privately, so rollback was disarmed before public traffic: fix forward only.
      await assert.rejects(r, /public start failed/)
      assert.equal(h.pending?.phase, 'forward')
      assert.equal(h.release, next.version)
      assert.equal(h.schema, 2, 'no restore after the point of no return')
      assert.ok(!h.log.includes('restore'))
      assert.deepEqual(h.pending?.dependents, ['edge.service'], 'recovery still knows what to start')
    }
  })

test('a grant created during the drain refuses the move with the old release kept', async () => {
  const { h, ops } = host({ candidate: 'grant-slips-in' })
  await assert.rejects(activate(old, next, ops), /host-bound grant appeared/)
  assert.ok(!h.log.includes('backup') && !h.log.includes('prove'), 'neither the copy nor the candidate ran')
  assert.equal(h.release, old.version)
  assert.equal(h.running, 'public')
  assert.ok(h.ingress)
  assert.equal(h.schema, 1)
  assert.equal(h.pending, null)
})

test('a vault copy that cannot be taken aborts before the candidate runs', async () => {
  const { h, ops } = host({ backup: 'fail' })
  await assert.rejects(activate(old, next, ops), /state directory missing/)
  assert.ok(!h.log.includes('prove'), 'the candidate never started')
  assert.equal(h.schema, 1)
  assert.equal(h.release, old.version)
})

// Interrupt the run before every operation, for each candidate outcome, then recover from the journal alone.
for (const candidate of ['ok', 'fail-after-migration', 'fail-public', 'grant-slips-in'] as const)
  test('interruption at every boundary recovers consistently: ' + candidate, async () => {
    // The boundaries this outcome crosses: every operation of an uninterrupted run is one place to interrupt.
    const clean = host({ candidate })
    await activate(old, next, clean.ops).catch(() => undefined)
    const total = clean.h.calls
    assert.ok(total >= 5, 'the outcome crosses several boundaries')
    let interrupted = 0
    for (let crashAt = 1; crashAt <= total + 5; crashAt++) {
      const { h, ops } = host({ crashAt, candidate })
      let crashed = false
      try {
        await activate(old, next, ops)
      } catch (e) {
        if (e instanceof Crash) crashed = true
        else if (!/candidate not ready|public start failed|host-bound grant appeared/.test(String(e))) throw e
      }
      if (!crashed) continue
      interrupted++
      // Power returns: nothing is running; the journal and the vault copy remain. Recovery runs without faults.
      // The ingress is down too once anything was stopped, so only the journal can say to start it.
      h.running = 'none'
      if (h.log.includes('stop')) h.ingress = false
      const journal = h.pending
      if (!journal) {
        assert.equal(h.schema, 1, 'interrupted before the first journal write: nothing was touched')
        continue
      }
      const seen = h.log.length
      const rec = host({ candidate: 'ok' }, h)
      const how = await recoverPending(journal, rec.ops)
      consistent(h)
      if (journal.phase === 'forward') {
        assert.equal(how, 'forward')
        assert.equal(h.release, next.version, 'a committed activation finishes forward')
        assert.ok(!h.log.slice(seen).includes('restore'), 'no restore after the point of no return')
        assert.equal(h.previous, 'snap', 'forward recovery rewrites previous.json')
      }
    }
    assert.equal(interrupted, total, 'every boundary of this outcome was interrupted')
  })

test('interrupting the recovery itself never replays a restore over writes the old release accepted', async () => {
  for (let crashAt = 1; crashAt <= 12; crashAt++) {
    const { h, ops } = host({ candidate: 'fail-after-migration' })
    // Interrupt the rollback after the candidate has failed.
    h.snapshots.add('snap')
    h.snapshotSchema.set('snap', 1)
    h.schema = 2
    h.running = 'none'
    h.ingress = false
    h.pending = { ...old, dependents: ['edge.service'], store: 'snap', data: '/state/openpassword' }
    let n = 0
    const crashy = Object.fromEntries(
      Object.entries(ops).map(([k, f]) => [
        k,
        (...a: unknown[]) => {
          if (++n === crashAt) throw new Crash(k)
          return (f as unknown as (...x: unknown[]) => unknown)(...a)
        },
      ]),
    ) as unknown as typeof ops
    let crashed = false
    try {
      await recoverPending(h.pending, crashy)
    } catch (e) {
      if (!(e instanceof Crash)) throw e
      crashed = true
    }
    if (!crashed) continue
    h.running = 'none'
    const journal = h.pending
    if (journal) await recoverPending(journal, ops)
    assert.equal(h.pending, null)
    assert.equal(h.schema, 1)
    assert.equal(h.release, old.version)
    assert.ok(h.ingress)
    assert.ok(!h.snapshots.has('snap'), 'interrupted at ' + crashAt + ': the restored copy is still deleted')
  }
})

test('running units that systemd stops with ours are found, through chains, and stopped ones are left alone', () => {
  const graph: Record<string, string> = {
    'broker.service': 'ActiveState=active\nRequiredBy=web.service backup.service\nBoundBy=\nConsistsOf=',
    'web.service': 'ActiveState=active\nRequiredBy=edge.service\nBoundBy=\nConsistsOf=sidecar.service',
    'edge.service': 'ActiveState=active\nRequiredBy=\nBoundBy=metrics.service',
    'sidecar.service': 'ActiveState=activating\nRequiredBy=web.service',
    'metrics.service': 'ActiveState=active',
    'backup.service': 'ActiveState=inactive\nRequiredBy=',
  }
  assert.deepEqual(
    dependentsOf(['broker.service', 'web.service'], (unit) => graph[unit]),
    ['edge.service', 'sidecar.service', 'metrics.service'],
  )
  assert.deepEqual(dependentsOf(['broker.service'], () => 'ActiveState=inactive\nRequiredBy='), [])
})

for (const [drained, expected] of [['started', true], ['stopped', false]] as const)
  test('the dependent set is read after the drain: a unit ' + drained + ' during it', async () => {
    const { h, ops } = host({ candidate: 'ok' })
    h.ingress = !expected
    await activate(old, next, { ...ops, drain: async () => void (h.ingress = expected) })
    assert.equal(h.ingress, expected)
  })

test('a drain that fails still journals the dependents before the rollback stops anything', async () => {
  const { h, ops } = host({ candidate: 'ok' })
  h.ingress = false
  const drain = async () => {
    h.ingress = true
    throw Error('drain failed')
  }
  await assert.rejects(activate(old, next, { ...ops, drain }), /drain failed/)
  assert.ok(h.ingress)
  assert.equal(h.pending, null)
})

test('a dependent lookup that keeps failing after the drain still brings the old release back', async (t) => {
  t.mock.method(console, 'error', () => undefined)
  const { h, ops } = host({ candidate: 'ok' })
  let calls = 0
  const failing = {
    ...ops,
    dependents: () => {
      if (calls++) throw Error('unit listing failed')
      return ['edge.service']
    },
  }
  await assert.rejects(activate(old, next, failing), /unit listing failed/)
  assert.ok(!h.log.includes('backup') && !h.log.includes('prove'), 'the activation did not go on')
  assert.equal(h.release, old.version)
  assert.equal(h.running, 'public')
  assert.ok(h.ingress, 'the list read before the drain is used')
  assert.equal(h.pending, null)
  // A recovery of a journal that never got a list completes as well.
  h.running = 'none'
  h.pending = { ...old }
  assert.equal(await recoverPending(h.pending, failing), 'rollback')
  assert.equal(h.running, 'public')
  assert.equal(h.pending, null)
})

for (const [path, candidate] of [['forward', 'ok'], ['rollback', 'fail-after-migration']] as const)
  test('a dependent that fails to start is retried without stopping what is healthy: ' + path, async (t) => {
    const said = t.mock.method(console, 'error', () => undefined)
    const { h, ops } = host({ candidate })
    let sibling = true
    let broken = true
    const two = {
      ...ops,
      dependents: () => ['edge.service', 'sidecar.service'],
      stop: () => {
        ops.stop()
        sibling = false
      },
      publish: async (t: Snap) => {
        sibling = false
        await ops.publish(t)
      },
      revive: (names: string[]) => {
        if (names.includes('sidecar.service')) sibling = true
        if (broken) throw Error('edge failed to start')
        ops.revive(names)
      },
    }
    await assert.rejects(activate(old, next, two), /edge failed to start/)
    if (path === 'rollback')
      assert.match(String(said.mock.calls[0]?.arguments[0]), /candidate not ready/, 'the first error is not lost')
    assert.ok(h.pending?.published, 'the journal says the services themselves are up')
    assert.ok(sibling)
    // Still failing: another recovery stops and republishes nothing.
    const seen = h.log.length
    await assert.rejects(recoverPending(h.pending!, two), /edge failed to start/)
    broken = false
    assert.equal(await recoverPending(h.pending!, two), path)
    assert.ok(!h.log.slice(seen).some((x) => x === 'stop' || x === 'restore' || x.startsWith('publish')))
    assert.ok(h.ingress && sibling)
    assert.equal(h.pending, null)
    assert.equal(h.release, path === 'forward' ? next.version : old.version)
    assert.equal(h.snapshots.has('snap'), path === 'forward', 'a copy that was restored from is deleted; the other stays')
  })

test('a recorded dependent list without the provisional mark is kept while the unit is down', async () => {
  const { h, ops } = host({ candidate: 'ok' })
  Object.assign(h, { release: next.version, schema: 2, running: 'none', ingress: false })
  h.snapshots.add('snap')
  h.pending = { ...old, dependents: ['edge.service'], store: 'snap', data: '/state/openpassword', phase: 'forward', target: next }
  assert.equal(await recoverPending(h.pending, ops), 'forward')
  assert.ok(h.ingress)
  assert.equal(h.pending, null)
})

// Store helpers against real SQLite files.
function fixture() {
  const dir = fs.mkdtempSync(join(tmpdir(), 'op-upg-'))
  const data = join(dir, 'data')
  fs.mkdirSync(data, { mode: 0o700 })
  const db = new DatabaseSync(join(data, 'vault.sqlite'))
  db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE items(id TEXT PRIMARY KEY, v TEXT); INSERT INTO items VALUES ('a','old-value'); PRAGMA user_version=1")
  db.close()
  fs.writeFileSync(join(data, 'master.key'), 'old-master-key\n', { mode: 0o600 })
  fs.writeFileSync(join(data, 'operator.token'), 'old-token\n', { mode: 0o600 })
  return { dir, data, snap: join(dir, 'snap') }
}
const schema = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return {
      version: (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      columns: (db.prepare('PRAGMA table_info(items)').all() as { name: string }[]).map((c) => c.name),
      // node:sqlite rows have a null prototype; compare plain copies.
      rows: db.prepare('SELECT * FROM items ORDER BY id').all().map((r) => ({ ...r })),
    }
  } finally {
    db.close()
  }
}
function migrate(data: string) {
  const db = new DatabaseSync(join(data, 'vault.sqlite'))
  db.exec("ALTER TABLE items ADD COLUMN owner TEXT; UPDATE items SET v='migrated'; INSERT INTO items VALUES ('b','new','x'); PRAGMA user_version=2")
  db.close()
  fs.writeFileSync(join(data, 'master.key'), 'wrapped-master-key\n', { mode: 0o600 })
  fs.writeFileSync(join(data, 'extra.state'), 'new\n')
}
const cleanup = (d: string) => fs.rmSync(d, { recursive: true, force: true })

test('a restore after migration returns the old schema, keys and data, and removes new files', () => {
  const f = fixture()
  try {
    const before = schema(join(f.data, 'vault.sqlite'))
    snapshotStore(f.data, f.snap)
    migrate(f.data)
    restoreStore(f.data, f.snap)
    assert.deepEqual(schema(join(f.data, 'vault.sqlite')), before)
    assert.equal(before.version, 1)
    assert.ok(!before.columns.includes('owner'))
    assert.equal(fs.readFileSync(join(f.data, 'master.key'), 'utf8'), 'old-master-key\n')
    assert.ok(!fs.existsSync(join(f.data, 'extra.state')))
    assert.ok(!fs.existsSync(f.data + '.restore') && !fs.existsSync(f.data + '.replaced'))
    restoreStore(f.data, f.snap) // repeatable
  } finally {
    cleanup(f.dir)
  }
})

test('a damaged or altered copy is refused and the live directory is left untouched', () => {
  const f = fixture()
  try {
    snapshotStore(f.data, f.snap)
    migrate(f.data)
    const live = fs.readFileSync(join(f.data, 'master.key'), 'utf8')
    fs.appendFileSync(join(f.snap, 'master.key'), 'tampered')
    assert.throws(() => restoreStore(f.data, f.snap), /altered/)
    assert.equal(fs.readFileSync(join(f.data, 'master.key'), 'utf8'), live)
    fs.writeFileSync(join(f.snap, 'master.key'), 'old-master-key\n')
    fs.rmSync(join(f.snap, 'operator.token'))
    assert.throws(() => restoreStore(f.data, f.snap), /manifest/)
    assert.equal(fs.readFileSync(join(f.data, 'master.key'), 'utf8'), live)
    assert.equal(schema(join(f.data, 'vault.sqlite')).version, 2)
  } finally {
    cleanup(f.dir)
  }
})

test('a restore interrupted between the two renames completes on retry', () => {
  const f = fixture()
  try {
    snapshotStore(f.data, f.snap)
    migrate(f.data)
    fs.renameSync(f.data, f.data + '.replaced') // the live directory moved aside, the staged one not yet in place
    restoreStore(f.data, f.snap)
    assert.equal(schema(join(f.data, 'vault.sqlite')).version, 1)
    assert.ok(!fs.existsSync(f.data + '.replaced'))
  } finally {
    cleanup(f.dir)
  }
})

test('the snapshot is refused for a missing directory, a corrupt vault or a linked entry', () => {
  assert.throws(() => snapshotStore(null, join(tmpdir(), 'op-never')), /state directory is missing/)
  const a = fixture()
  try {
    fs.writeFileSync(join(a.data, 'vault.sqlite'), 'not a database'.repeat(100))
    assert.throws(() => snapshotStore(a.data, a.snap), /integrity|database/i)
  } finally {
    cleanup(a.dir)
  }
  const b = fixture()
  try {
    fs.symlinkSync('/etc/hostname', join(b.data, 'link'))
    assert.throws(() => snapshotStore(b.data, b.snap), /Unexpected entry/)
  } finally {
    cleanup(b.dir)
  }
})

// The manual-downgrade fence, with a synthetic host-bound grant in a real vault file.
function fenceFixture() {
  const dir = fs.mkdtempSync(join(tmpdir(), 'op-fence-'))
  const data = join(dir, 'data')
  fs.mkdirSync(data)
  const release = (v: string, hosts: boolean) => {
    const d = join(dir, 'releases', v)
    fs.mkdirSync(join(d, 'server'), { recursive: true })
    if (hosts) fs.writeFileSync(join(d, 'server/hosts.ts'), '// host proof\n')
    return d
  }
  const db = new DatabaseSync(join(data, 'vault.sqlite'))
  db.exec(`CREATE TABLE grants(id TEXT PRIMARY KEY, active INTEGER, expires INTEGER);
    CREATE TABLE host_grants(grant_id TEXT PRIMARY KEY, host TEXT NOT NULL);
    CREATE TABLE pairs(id TEXT PRIMARY KEY, grant_id TEXT, expires INTEGER);
    CREATE TABLE host_pairs(pair TEXT PRIMARY KEY, host TEXT NOT NULL)`)
  return { dir, data, db, newer: release('0.4.0', true), older: release('0.3.1', false), also: release('0.4.1', true) }
}
test('a release that predates host proof is recognised by what it ships', () => {
  const f = fenceFixture()
  try {
    assert.equal(enforcesHostProof(f.newer), true)
    assert.equal(enforcesHostProof(f.older), false)
  } finally {
    f.db.close()
    cleanup(f.dir)
  }
})
test('the downgrade fence refuses while host-bound grants or enrollment tokens exist', () => {
  const f = fenceFixture()
  const now = 1_000_000
  try {
    f.db.exec("INSERT INTO grants VALUES('g1',1,2000000); INSERT INTO host_grants VALUES('g1','host_a')")
    assert.throws(() => refuseHostProofDowngrade(f.newer, f.older, f.data, now), /1 active host-bound grant\(s\) and 0 unredeemed/)
    // Revoked, expired or plain bearer grants do not count.
    f.db.exec("UPDATE grants SET active=0 WHERE id='g1'")
    refuseHostProofDowngrade(f.newer, f.older, f.data, now)
    f.db.exec("UPDATE grants SET active=1, expires=500 WHERE id='g1'")
    refuseHostProofDowngrade(f.newer, f.older, f.data, now)
    f.db.exec("INSERT INTO grants VALUES('g2',1,2000000)")
    refuseHostProofDowngrade(f.newer, f.older, f.data, now)
    // An unredeemed host-bound enrollment token would become a bearer token.
    f.db.exec("INSERT INTO pairs VALUES('p1',NULL,2000000); INSERT INTO host_pairs VALUES('p1','host_a')")
    assert.throws(() => refuseHostProofDowngrade(f.newer, f.older, f.data, now), /0 active host-bound grant\(s\) and 1 unredeemed/)
    f.db.exec("UPDATE pairs SET grant_id='g2' WHERE id='p1'")
    refuseHostProofDowngrade(f.newer, f.older, f.data, now)
  } finally {
    f.db.close()
    cleanup(f.dir)
  }
})
test('the fence applies only to a move to a release without host proof', () => {
  const f = fenceFixture()
  try {
    f.db.exec("INSERT INTO grants VALUES('g1',1,9999999999999); INSERT INTO host_grants VALUES('g1','host_a')")
    refuseHostProofDowngrade(f.newer, f.also, f.data) // both enforce
    refuseHostProofDowngrade(f.older, f.newer, f.data) // upgrade
    refuseHostProofDowngrade(null, f.older, f.data) // first installation
    assert.throws(() => refuseHostProofDowngrade(f.newer, f.older, null), /state directory is missing/)
    assert.throws(() => refuseHostProofDowngrade(f.newer, f.older, f.data), /Refusing to move from 0\.4\.0 to 0\.3\.1/)
  } finally {
    f.db.close()
    cleanup(f.dir)
  }
})
test('a vault from before host binding has nothing to fence', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'op-fence-'))
  try {
    const data = join(dir, 'data')
    fs.mkdirSync(data)
    new DatabaseSync(join(data, 'vault.sqlite')).close()
    const mk = (v: string, hosts: boolean) => {
      const d = join(dir, v)
      fs.mkdirSync(join(d, 'server'), { recursive: true })
      if (hosts) fs.writeFileSync(join(d, 'server/hosts.ts'), '')
      return d
    }
    refuseHostProofDowngrade(mk('0.4.0', true), mk('0.3.1', false), data)
  } finally {
    cleanup(dir)
  }
})

test('the state directory resolves from the link even while the live directory is absent', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'op-link-'))
  try {
    fs.mkdirSync(join(dir, 'private', 'openpassword'), { recursive: true })
    fs.symlinkSync('private/openpassword', join(dir, 'openpassword'))
    const live = join(dir, 'private', 'openpassword')
    assert.equal(resolveDataDir(join(dir, 'openpassword')), live)
    fs.renameSync(live, live + '.replaced') // an interruption between the two renames
    assert.equal(resolveDataDir(join(dir, 'openpassword')), live, 'the path still resolves')
    assert.equal(resolveDataDir(join(dir, 'missing')), null)
    fs.mkdirSync(join(dir, 'plain'))
    assert.equal(resolveDataDir(join(dir, 'plain')), join(dir, 'plain'))
  } finally {
    cleanup(dir)
  }
})

test('recovery restores through the resolved path after an interruption between the two renames', () => {
  const f = fixture()
  try {
    const link = join(f.dir, 'state-link')
    fs.symlinkSync('data', link)
    snapshotStore(f.data, f.snap)
    migrate(f.data)
    fs.renameSync(f.data, f.data + '.replaced') // live path now absent; staged copy not yet in place
    const resolved = resolveDataDir(link)
    assert.ok(resolved)
    restoreStore(resolved, f.snap) // what the controller's restore does with the journaled path
    assert.equal(schema(join(f.data, 'vault.sqlite')).version, 1)
    assert.ok(!fs.existsSync(f.data + '.replaced'))
  } finally {
    cleanup(f.dir)
  }
})

test('an upgraded vault prevents activation of a writer without generation checks', () => {
  const f = fenceFixture()
  try {
    refuseVaultDowngrade(f.older, f.data)
    f.db.exec('CREATE TABLE private_generations(id TEXT)')
    refuseVaultDowngrade(f.older, f.data)
    f.db.exec("INSERT INTO private_generations VALUES('synthetic')")
    assert.throws(() => refuseVaultDowngrade(f.older, f.data), /upgraded private vaults/)
    fs.writeFileSync(join(f.newer, 'server/private-migration.ts'), '// migration support')
    refuseVaultDowngrade(f.newer, f.data)
  } finally {
    f.db.close()
    cleanup(f.dir)
  }
})

test('enrolled passkeys prevent an installer downgrade that drops action approvals', () => {
  const f = fenceFixture()
  try {
    f.db.exec("CREATE TABLE passkeys(id TEXT);INSERT INTO passkeys VALUES('synthetic')")
    assert.throws(() => refuseVaultDowngrade(f.older, f.data), /passkey approval/)
  } finally {
    f.db.close()
    cleanup(f.dir)
  }
})
