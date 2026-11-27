// Invoked by upgrade.sh under its exclusive flock, after verification of the staged archive.
import * as fs from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const root = '/opt/openpassword'
const releases = join(root, 'releases')
const state = join(root, 'upgrade-state')
const units = ['openpassword-broker.service', 'openpassword-web.service']
const unitDir = '/etc/systemd/system'
const dataLink = '/var/lib/openpassword'
const semver = /^\d+\.\d+\.\d+$/
// `dependents`: other units that were running and that systemd stops along with ours. The journal acts on it;
// previous.json carries it too, where nothing reads it.
// `provisional`: read before the drain, to be read again before the first stop. A list without the mark is final.
type Snapshot = { version: string | null; units: (string | null)[]; dependents?: string[]; provisional?: true }
// Pending record: the old configuration plus the vault copy taken before the candidate first started.
// `published`: the release answered its readiness checks; only the host's own units may still be down.
// `discard`: a vault copy already restored from, to delete before the journal is cleared.
type Pending = Snapshot & {
  store?: string | null
  data?: string
  phase?: 'forward'
  target?: Snapshot
  published?: true
  discard?: string
}
type Loc = { store: string; data: string }
function ensure(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(message)
}
function run(cmd: string, args: string[], timeout = 180000) {
  const p = spawnSync(cmd, args, { encoding: 'utf8', timeout })
  ensure(!p.error && p.status === 0, cmd + ' failed (status ' + (p.status ?? 'unavailable') + ')')
  return p.stdout.trim()
}
function syncDir(dir: string) {
  const fd = fs.openSync(dir, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}
function atomic(file: string, content: string, mode = 0o600) {
  const temp = file + '.' + randomUUID()
  const fd = fs.openSync(temp, 'wx', mode)
  try {
    fs.writeFileSync(fd, content)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(temp, file)
  syncDir(dirname(file))
}
function clear(file: string) {
  fs.rmSync(file, { force: true })
  syncDir(dirname(file))
}
function releasePath(v: string) {
  ensure(semver.test(v), 'Invalid release version')
  return join(releases, v)
}
function active() {
  const link = join(root, 'current')
  if (!fs.lstatSync(link, { throwIfNoEntry: false })) return null
  const real = fs.realpathSync(link),
    v = basename(real)
  ensure(
    fs.lstatSync(link).isSymbolicLink() && real === releasePath(v),
    'Unexpected current layout',
  )
  return v
}
function snapshot(): Snapshot {
  return {
    version: active(),
    units: units.map((u) =>
      fs.existsSync(join(unitDir, u)) ? fs.readFileSync(join(unitDir, u), 'utf8') : null,
    ),
  }
}
const sha = (f: string) => createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const manifestName = '.manifest.json'
type Manifest = {
  dir: { uid: number; gid: number; mode: number }
  files: Record<string, { sha256: string; uid: number; gid: number; mode: number }>
}
// SQLite's integrity check on a scratch copy, so that opening the vault cannot touch the evidence.
function integrity(dir: string, names: string[]) {
  const scratch = fs.mkdtempSync(join(tmpdir(), 'op-snap-'))
  try {
    for (const name of names) fs.copyFileSync(join(dir, name), join(scratch, name))
    const db = new DatabaseSync(join(scratch, 'vault.sqlite'))
    try {
      const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]
      ensure(rows.length === 1 && rows[0].integrity_check === 'ok', 'Vault failed its integrity check')
    } finally {
      db.close()
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}
function fsyncFile(f: string) {
  const fd = fs.openSync(f, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}
// A failed activation must not leave an older release on a store that the candidate migrated.
// Copy every file of the stopped state directory (vault, sidecars, keys) with owner and mode, check the
// bytes, run the integrity check, and save a manifest of what was verified. A missing directory is an error.
export function snapshotStore(dataDir: string | null, dest: string) {
  ensure(dataDir && fs.existsSync(dataDir), 'The state directory is missing: no vault copy can be taken')
  const names = fs.readdirSync(dataDir)
  ensure(names.includes('vault.sqlite'), 'Vault database missing from the state directory')
  ensure(!names.includes(manifestName), 'Unexpected entry in the state directory: ' + manifestName)
  const dst = fs.lstatSync(dataDir)
  const manifest: Manifest = { dir: { uid: dst.uid, gid: dst.gid, mode: dst.mode & 0o7777 }, files: {} }
  fs.mkdirSync(dest, { mode: 0o700 })
  for (const name of names) {
    const src = join(dataDir, name),
      st = fs.lstatSync(src)
    ensure(st.isFile() && !st.isSymbolicLink(), 'Unexpected entry in the state directory: ' + name)
    const out = join(dest, name)
    fs.copyFileSync(src, out, fs.constants.COPYFILE_EXCL)
    fs.chownSync(out, st.uid, st.gid)
    fs.chmodSync(out, st.mode & 0o7777)
    fs.utimesSync(out, st.atime, st.mtime)
    const digest = sha(out)
    ensure(digest === sha(src), 'Snapshot copy differs from the source: ' + name)
    fsyncFile(out)
    manifest.files[name] = { sha256: digest, uid: st.uid, gid: st.gid, mode: st.mode & 0o7777 }
  }
  integrity(dest, names)
  atomic(join(dest, manifestName), JSON.stringify(manifest))
  syncDir(dest)
}
// Services must be stopped. Stages and verifies a complete replacement beside the live directory, then swaps it in;
// the live directory is untouched unless the staged copy matches the manifest and passes the integrity check.
// Safe to repeat after an interruption at any point.
export function restoreStore(dataDir: string, snap: string) {
  const manifest = JSON.parse(fs.readFileSync(join(snap, manifestName), 'utf8')) as Manifest
  const names = Object.keys(manifest.files)
  ensure(names.includes('vault.sqlite'), 'Vault snapshot is incomplete')
  const present = fs.readdirSync(snap).filter((n) => n !== manifestName)
  ensure(
    present.length === names.length && names.every((n) => present.includes(n)),
    'Vault snapshot does not match its manifest',
  )
  for (const n of names) ensure(sha(join(snap, n)) === manifest.files[n].sha256, 'Vault snapshot was altered: ' + n)
  const staged = dataDir + '.restore',
    replaced = dataDir + '.replaced'
  fs.rmSync(staged, { recursive: true, force: true })
  if (!fs.existsSync(dataDir) && fs.existsSync(replaced)) fs.renameSync(replaced, dataDir)
  fs.rmSync(replaced, { recursive: true, force: true })
  fs.mkdirSync(staged, { mode: 0o700 })
  for (const n of names) {
    const f = manifest.files[n],
      out = join(staged, n)
    fs.copyFileSync(join(snap, n), out, fs.constants.COPYFILE_EXCL)
    fs.chownSync(out, f.uid, f.gid)
    fs.chmodSync(out, f.mode)
    ensure(sha(out) === f.sha256, 'Staged file differs from the manifest: ' + n)
    fsyncFile(out)
  }
  integrity(staged, names)
  fs.chownSync(staged, manifest.dir.uid, manifest.dir.gid)
  fs.chmodSync(staged, manifest.dir.mode)
  syncDir(staged)
  if (fs.existsSync(dataDir)) fs.renameSync(dataDir, replaced)
  fs.renameSync(staged, dataDir)
  syncDir(dirname(dataDir))
  fs.rmSync(replaced, { recursive: true, force: true })
}
// The state directory path, resolved without requiring the directory to exist: a restore interrupted between its two
// renames leaves the live path absent. DynamicUser keeps /var/lib/<name> as a link to /var/lib/private/<name>.
export function resolveDataDir(link = dataLink) {
  const st = fs.lstatSync(link, { throwIfNoEntry: false })
  if (!st) return null
  return st.isSymbolicLink() ? resolve(dirname(link), fs.readlinkSync(link)) : link
}
const dataDir = () => resolveDataDir()
// A release enforces host proof when it ships server/hosts.ts. Moving to one that does not turns every host-bound
// grant (and every unredeemed host-bound enrollment token) into a plain bearer credential: an authorization downgrade.
export const enforcesHostProof = (releaseDir: string) => fs.existsSync(join(releaseDir, 'server/hosts.ts'))
export function hostBoundCredentials(vault: string, now = Date.now()) {
  const db = new DatabaseSync(vault, { readOnly: true })
  try {
    const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)
    const count = (sql: string) => Number((db.prepare(sql).get(now) as { n: number }).n)
    const grants =
      has('grants') && has('host_grants')
        ? count('SELECT count(*) AS n FROM grants g JOIN host_grants hg ON hg.grant_id=g.id WHERE g.active=1 AND g.expires>?')
        : 0
    const pairs =
      has('pairs') && has('host_pairs')
        ? count('SELECT count(*) AS n FROM host_pairs hp JOIN pairs p ON p.id=hp.pair WHERE p.grant_id IS NULL AND p.expires>?')
        : 0
    return { grants, pairs }
  } finally {
    db.close()
  }
}
export function refuseHostProofDowngrade(fromDir: string | null, toDir: string | null, dataDir: string | null, now = Date.now()) {
  if (!fromDir || !toDir || !enforcesHostProof(fromDir) || enforcesHostProof(toDir)) return
  const from = basename(fromDir),
    to = basename(toDir)
  ensure(dataDir, 'The state directory is missing: host-bound grants cannot be checked')
  const { grants, pairs } = hostBoundCredentials(join(dataDir, 'vault.sqlite'), now)
  ensure(
    grants === 0 && pairs === 0,
    'Refusing to move from ' + from + ' to ' + to + ', which does not enforce host proof: ' + grants +
      ' active host-bound grant(s) and ' + pairs +
      ' unredeemed host-bound enrollment token(s) would become plain bearer credentials. Revoke them in the console first, then retry.',
  )
}
export function refuseVaultDowngrade(targetDir: string | null, stateDir: string | null) {
  if (!targetDir || !stateDir) return
  const vault = join(stateDir, 'vault.sqlite')
  if (!fs.existsSync(vault)) return
  const db = new DatabaseSync(vault, { readOnly: true })
  try {
    if (!fs.existsSync(join(targetDir,'server/engines.ts')) && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='engine_cursor'").get())
      throw Error('Restore the matching pre-upgrade snapshot before starting a release without workflow support.')
    if (!fs.existsSync(join(targetDir, 'server/passkeys.ts'))) {
      const has = (name: string) =>
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
      const needsPolicy =
        (has('passkeys') && db.prepare('SELECT 1 FROM passkeys LIMIT 1').get()) ||
        (has('model_custodians') && db.prepare('SELECT 1 FROM model_custodians LIMIT 1').get())
      ensure(
        !needsPolicy,
        'Refusing to activate a release without passkey approval or remote gateway custody support.',
      )
    }
    if (fs.existsSync(join(targetDir, 'server/private-migration.ts'))) return
    const migrated = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='private_generations'").get()
      && db.prepare('SELECT 1 FROM private_generations LIMIT 1').get()
    ensure(!migrated, 'Refusing to activate a release that cannot safely write upgraded private vaults.')
  } finally {
    db.close()
  }
}
function point(version: string | null) {
  const link = join(root, 'current')
  if (!version) {
    clear(link)
    return
  }
  const tmp = link + '.' + randomUUID()
  fs.symlinkSync(releasePath(version), tmp)
  fs.renameSync(tmp, link)
  syncDir(root)
}
export function verifyRelease(
  tree: string,
  digest: string,
  v: string,
  commit: string,
  arch: string,
) {
  const meta = JSON.parse(fs.readFileSync(join(tree, 'RELEASE.json'), 'utf8'))
  ensure(
    meta.name === 'openpassword' &&
      meta.platform === 'linux' &&
      meta.version === v &&
      meta.commit === commit &&
      process.platform === 'linux' &&
      meta.arch === arch &&
      arch === process.arch,
    'Release identity mismatch',
  )
  ensure(meta.node === 'v24.19.0' && process.version === meta.node, 'Unexpected Node version')
  for (const file of [
    'server/main.ts',
    '.next/BUILD_ID',
    'packages/cli/dist/index.js',
    'node_modules/tsx/package.json',
    'node_modules/next/dist/bin/next',
    '.next/server/server-reference-manifest.json',
    '.next/server/server-reference-manifest.js',
    ...units.map((u) => 'deploy/systemd/' + u),
  ])
    ensure(fs.statSync(join(tree, file)).isFile(), 'Missing ' + file)
  ensure(
    fs.readFileSync(join(tree, '.next/BUILD_ID'), 'utf8').trim() === commit,
    'Console build ID mismatch',
  )
  ensure(
    createHash('sha256')
      .update(fs.readFileSync(join(tree, 'node/bin/node')))
      .digest('hex') === meta.node_binary_sha256,
    'Node digest mismatch',
  )
  ensure(/^[a-f0-9]{64}$/.test(digest), 'Invalid archive digest')
}
const probeCode = `
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { service } from './server/service.ts';
const home=mkdtempSync(join(tmpdir(),'op-check-'));
try {
 const api=service(home,undefined,undefined,undefined,false,{engineBin:join(process.cwd(),'engine-bin')});
 try {const url=await api.listen({host:'127.0.0.1',port:0});
 let ready=false; for(let attempt=0;attempt<100;attempt++){if((await (await fetch(url+'/health')).json()).status==='ok'){ready=true;break} await new Promise(resolve=>setTimeout(resolve,100))} if(!ready) throw Error('Broker unavailable');
 } finally {await api.close()}
} finally {rmSync(home,{recursive:true,force:true})}`
function preflight(version: string) {
  const path = releasePath(version)
  const node = fs.existsSync(join(path, 'node/bin/node'))
    ? [join(path, 'node/bin/node')]
    : ['/usr/bin/env', 'node']
  const base = [
    '--quiet',
    '--wait',
    '--pipe',
    '-p',
    'DynamicUser=yes',
    '-p',
    'PrivateTmp=yes',
    '-p',
    'ProtectHome=yes',
    '-p',
    'NoNewPrivileges=yes',
    '-p',
    'ProtectSystem=strict',
    '-p',
    'InaccessiblePaths=-/var/lib/openpassword -/var/lib/private',
    '-p',
    'WorkingDirectory=' + path,
    ...node,
  ]
  const runtime = run('systemd-run', [...base, '-p', 'process.version'])
  if (node.length === 1) ensure(runtime === 'v24.19.0', 'Bundled service Node mismatch')
  run('systemd-run', [...base, '--import', 'tsx', '--input-type=module', '-e', probeCode])
  run('systemd-run', [...base, 'node_modules/next/dist/bin/next', '--version'])
}
function baseUrl() {
  const port = Number(process.env.OPENPASSWORD_WEB_PORT || 3000)
  ensure(Number.isInteger(port) && port > 0 && port <= 65535, 'Invalid console port')
  return 'http://127.0.0.1:' + port
}
async function health() {
  const res = await fetch(baseUrl() + '/api/health', {
    signal: AbortSignal.timeout(2500),
    redirect: 'error',
  })
  ensure(res.ok, 'Health HTTP ' + res.status)
  return await res.json()
}
async function drain() {
  const h = await health()
  if (!h.drain_supported) return
  run('systemctl', ['kill', '--kill-who=main', '--signal=SIGUSR2', units[0]])
  const end = Date.now() + 90000
  while (Date.now() < end) {
    const s = await health()
    if (s.status === 'draining' && s.in_flight === 0) return
    await sleep(200)
  }
  console.error('Drain deadline reached. Continuing with service shutdown.')
}
async function ready(v: string) {
  const end = Date.now() + 40000
  let last: unknown
  do {
    try {
      ensure((await health()).status === 'ok', 'Broker is unavailable')
      const r = await fetch(baseUrl() + '/', {
        signal: AbortSignal.timeout(2500),
        redirect: 'error',
      })
      ensure(r.ok && (await r.text()).includes('OpenPassword'), 'Console unavailable')
      for (const u of units) {
        const pid = run('systemctl', ['show', '-p', 'MainPID', '--value', u])
        ensure(
          /^[1-9]\d*$/.test(pid) && fs.realpathSync('/proc/' + pid + '/cwd') === releasePath(v),
          'Service release mismatch: ' + u,
        )
        const node = join(releasePath(v), 'node/bin/node')
        if (fs.existsSync(node))
          ensure(fs.realpathSync('/proc/' + pid + '/exe') === node, 'Service Node mismatch: ' + u)
      }
      return
    } catch (e) {
      last = e
      await sleep(300)
    }
  } while (Date.now() < end)
  throw Error('Readiness failed: ' + String(last))
}
function stop() {
  for (const unit of [...units].reverse()) {
    const loaded = run('systemctl', ['show', '-p', 'LoadState', '--value', unit])
    if (loaded !== 'not-found') run('systemctl', ['stop', unit])
  }
}
// A unit the host adds on top of ours (an HTTPS ingress with Requires=openpassword-web.service, say) is stopped by
// systemd when ours stops, and starting ours does not start it again. These are the relations that carry a stop.
const stopCarriers = ['RequiredBy', 'RequisiteOf', 'BoundBy', 'ConsistsOf', 'PropagatesStopTo']
export function dependentsOf(roots: string[], show: (unit: string) => string) {
  const seen = new Set(roots),
    queue = [...roots],
    running: string[] = []
  for (let unit = queue.shift(); unit; unit = queue.shift()) {
    const properties = new Map(
      show(unit)
        .split('\n')
        .map((line): [string, string] => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    )
    // Only what was running is started again: a unit the operator had stopped stays stopped.
    if (!roots.includes(unit) && ['active', 'activating', 'reloading'].includes(properties.get('ActiveState') || ''))
      running.push(unit)
    for (const property of stopCarriers)
      for (const next of (properties.get(property) || '').split(/\s+/).filter(Boolean))
        if (!seen.has(next)) {
          seen.add(next)
          queue.push(next)
        }
  }
  return running
}
const showDependencies = (unit: string) =>
  run('systemctl', ['show', ...['ActiveState', ...stopCarriers].flatMap((p) => ['-p', p]), '--', unit])
function revive(dependents: string[]) {
  if (dependents.length) run('systemctl', ['start', '--', ...dependents])
}
// While a candidate is proven against the real store it listens on a private port and the console is stopped,
// so no public request can reach it. The runtime drop-in lives in /run and cannot survive a reboot.
const probePort = 4151
const probeFile = '/run/systemd/system/openpassword-broker.service.d/zz-upgrade-probe.conf'
function probeOn() {
  fs.mkdirSync(dirname(probeFile), { recursive: true })
  atomic(probeFile, '[Service]\nEnvironment=OPENPASSWORD_PORT=' + probePort + '\n', 0o644)
}
function probeOff() {
  if (fs.existsSync(dirname(probeFile))) clear(probeFile)
}
function install(target: Snapshot) {
  point(target.version)
  units.forEach((unit, i) => {
    const content = target.units[i],
      path = join(unitDir, unit)
    if (content === null) clear(path)
    else atomic(path, content, 0o644)
  })
}
async function proveBroker(v: string) {
  const end = Date.now() + 40000
  let last: unknown
  do {
    try {
      const r = await fetch('http://127.0.0.1:' + probePort + '/health', { signal: AbortSignal.timeout(2500) })
      ensure(r.ok && (await r.json()).status === 'ok', 'Candidate broker is unavailable')
      const pid = run('systemctl', ['show', '-p', 'MainPID', '--value', units[0]])
      ensure(
        /^[1-9]\d*$/.test(pid) && fs.realpathSync('/proc/' + pid + '/cwd') === releasePath(v),
        'Service release mismatch: ' + units[0],
      )
      return
    } catch (e) {
      last = e
      await sleep(300)
    }
  } while (Date.now() < end)
  throw Error('Candidate readiness failed: ' + String(last))
}
// Starts only the broker, on the private port, against the real store (it may migrate it). Leaves it stopped.
async function prove(target: Snapshot) {
  ensure(target.version, 'Nothing to prove')
  install(target)
  probeOn()
  run('systemctl', ['daemon-reload'])
  try {
    run('systemctl', ['start', units[0]])
    await proveBroker(target.version)
  } finally {
    run('systemctl', ['stop', units[0]])
    probeOff()
  }
}
// The public start: normal ports, both units, full readiness.
async function publish(target: Snapshot) {
  stop()
  probeOff()
  install(target)
  run('systemctl', ['daemon-reload'])
  if (target.version) {
    run('systemctl', ['start', ...units])
    await ready(target.version)
  }
}
type Ops = {
  dependents: () => string[]
  revive: (units: string[]) => void
  save: (s: Pending) => void
  drain: () => Promise<void>
  stop: () => void
  fence: () => void
  backup: () => Loc
  prove: (s: Snapshot) => Promise<void>
  publish: (s: Snapshot) => Promise<void>
  healthy: (s: Snapshot) => Promise<boolean>
  restore: (loc: Loc) => void
  discard: (store: string) => void
  finish: (s: Snapshot, store: string | null) => void
  clear: () => void
}
const plain = (s: Snapshot): Snapshot => ({ version: s.version, units: s.units, dependents: s.dependents })
// Read as late as possible, just before the first stop, and journaled before it. A final list is kept: after a stop
// the running set no longer says what has to come back. An activation requires the reading; a rollback or recovery
// must get the services back even if it keeps failing, so it falls back to the list taken before the drain.
function noteDependents(record: Pending, ops: Ops, required = false): Pending {
  if (record.dependents && !record.provisional) return record
  let dependents = record.dependents ?? []
  try {
    dependents = ops.dependents()
  } catch (error) {
    if (required) throw error
    console.error('Could not list the units that depend on the services; check them afterwards: ' + (error as Error).message)
  }
  const noted: Pending = { ...record, dependents }
  delete noted.provisional
  ops.save(noted)
  return noted
}
// The services first, then a checkpoint, then the host's own units. A retry after one of those failed to start must
// not stop services that are already healthy, which would take the others down again.
async function bringUp(record: Pending, release: Snapshot, ops: Ops) {
  if (!(record.published && (await ops.healthy(release)))) {
    await ops.publish(release)
    ops.save({ ...record, published: true })
  }
  ops.revive(record.dependents ?? [])
  // While the journal still names it, so that an interruption here leaves the next run able to delete it.
  if (record.discard) ops.discard(record.discard)
  ops.clear()
}
// Put the old release back. Order matters across a crash: the journal says "restored" before the old service can
// accept a write, and the vault copy is deleted only after the journal no longer names it as the copy to restore from.
export async function restoreOld(old: Pending, loc: Loc | null, ops: Ops) {
  let record = noteDependents(old, ops)
  ops.stop()
  if (loc) {
    ops.restore(loc)
    // The journal stops naming the copy as a store, and keeps its path so that whichever run finishes deletes it.
    record = { ...plain(record), store: null, discard: loc.store }
    ops.save(record)
  }
  await bringUp(record, plain(record), ops)
}
// The journal after an interruption. A committed activation is finished forward (and its metadata rewritten, which
// is idempotent); anything else is rolled back, to the state directory path the journal recorded.
export async function recoverPending(p: Pending, ops: Ops) {
  if (p.phase === 'forward' && p.target) {
    const record = noteDependents(p, ops)
    ops.finish(plain(record), p.store ?? null)
    await bringUp(record, p.target, ops)
    return 'forward'
  }
  // The old release was already back and ready: nothing is restored again.
  if (p.published) {
    await bringUp(p, plain(p), ops)
    return 'rollback'
  }
  ensure(!p.store || p.data, 'The journal names a vault copy without its state directory')
  await restoreOld(p, p.store ? { store: p.store, data: p.data! } : null, ops)
  return 'rollback'
}
export async function activate(current: Snapshot, target: Snapshot, ops: Ops) {
  // A first reading while nothing has changed yet: if it fails here, the activation stops with nothing to undo.
  let old: Pending = { ...current, dependents: ops.dependents(), provisional: true }
  ops.save(old)
  let loc: Loc | null = null
  try {
    if (old.version) await ops.drain()
    old = noteDependents(old, ops, true)
    ops.stop()
    ops.fence() // the decisive downgrade check, with the writer stopped
    if (old.version) {
      loc = ops.backup()
      ops.save({ ...old, store: loc.store, data: loc.data })
    }
    await ops.prove(target)
  } catch (error) {
    // Said first: if the rollback fails too, its error is the one that reaches the caller.
    console.error('Activation failed, restoring the previous release: ' + (error as Error).message)
    await restoreOld(old, loc, ops)
    throw error
  }
  // Proven against the real store on a private port. Rollback is disarmed before any public traffic: from here a
  // failure is fixed forward. The record keeps the old configuration and the copy so that recovery can rewrite
  // previous.json; it is never restored from in this phase.
  const record: Pending = { ...old, store: loc?.store ?? null, data: loc?.data, phase: 'forward', target }
  ops.save(record)
  ops.finish(old, loc?.store ?? null)
  await bringUp(record, target, ops)
}
async function main() {
  ensure(process.getuid?.() === 0, 'Requires root and the upgrade.sh lock')
  const pending = join(state, 'pending.json'),
    previous = join(state, 'previous.json')
  const [action, tree, digest, version, commit, arch] = process.argv.slice(2)
  let decisive = () => {}
  const ops: Ops = {
    dependents: () => dependentsOf(units, showDependencies),
    revive,
    save: (s) => atomic(pending, JSON.stringify(s)),
    drain: async () => {
      if (action !== '--rollback') return drain()
      try {
        await drain()
      } catch {
        console.error('Rolling back unavailable broker')
      }
    },
    stop,
    fence: () => decisive(),
    backup: () => {
      const data = dataDir()
      const made = join(state, 'store-' + randomUUID())
      snapshotStore(data, made)
      return { store: made, data: data! }
    },
    prove,
    publish,
    healthy: async (s) => {
      if (!s.version || active() !== s.version) return false
      return ready(s.version).then(
        () => true,
        () => false,
      )
    },
    restore: (loc) => restoreStore(loc.data, loc.store),
    discard: (store) => fs.rmSync(store, { recursive: true, force: true }),
    // previous.json names the vault copy for the operator. --rollback never restores it: the newer release has written since.
    finish: (s, store) => atomic(previous, JSON.stringify({ ...s, store })),
    clear: () => clear(pending),
  }
  if (fs.existsSync(pending)) {
    const how = await recoverPending(JSON.parse(fs.readFileSync(pending, 'utf8')), ops)
    console.log(how === 'forward' ? 'Completed the committed activation.' : 'Recovered previous service configuration.')
  }
  if (action === '--recover') return
  const old = snapshot()
  let target: Snapshot
  if (action === '--rollback') {
    target = JSON.parse(fs.readFileSync(previous, 'utf8'))
    ensure(target.version, 'First installation has no previous release')
    target = { version: target.version, units: target.units }
  } else {
    ensure(action === '--install', 'Unknown operation')
    verifyRelease(tree, digest, version, commit, arch)
    const dest = releasePath(version),
      receipt = '.openpassword-archive-sha256'
    if (fs.existsSync(dest)) {
      ensure(
        fs.readFileSync(join(dest, receipt), 'utf8') === digest,
        'Version already installed with different provenance',
      )
    } else {
      atomic(join(tree, receipt), digest)
      fs.chmodSync(tree, 0o755)
      fs.renameSync(tree, dest)
      syncDir(releases)
    }
    target = {
      version,
      units: units.map((u) => fs.readFileSync(join(dest, 'deploy/systemd', u), 'utf8')),
    }
  }
  if (old.version === target.version && old.version) {
    await ready(old.version)
    console.log('Already active: ' + old.version)
    return
  }
  const fenceNow = () => {
    const targetDir = target.version && releasePath(target.version)
    const stateDir = dataDir()
    refuseHostProofDowngrade(old.version && releasePath(old.version), targetDir, stateDir)
    refuseVaultDowngrade(targetDir, stateDir)
  }
  decisive = fenceNow
  fenceNow() // early refusal for the operator; the decisive check repeats with the services stopped
  preflight(target.version!)
  let keep: string | null = null
  if (fs.existsSync(previous)) keep = (JSON.parse(fs.readFileSync(previous, 'utf8')) as Pending).store ?? null
  for (const n of fs.readdirSync(state).filter((n) => n.startsWith('store-')))
    if (join(state, n) !== keep) fs.rmSync(join(state, n), { recursive: true, force: true })
  await activate(old, target, ops)
  console.log('Ready: ' + target.version)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e.message)
    process.exitCode = 1
  })
