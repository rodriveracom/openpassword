import { EngineCli } from '../../server/engine-cli.ts'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
// Consistent copy of the vault for backup. Usage: node snapshot.mjs <data-dir> <out-dir>
// Uses SQLite's online backup, so it is safe while the broker runs. It must run as the identity
// that owns the data directory (opening a WAL database can create or change its -shm/-wal files).
import { DatabaseSync, backup } from 'node:sqlite'
import { copyFileSync, existsSync, statSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
const [dir, out] = process.argv.slice(2)
if (!dir || !out) throw Error('usage: snapshot.mjs <data-dir> <out-dir>')
if (!existsSync(join(dir, 'vault.sqlite'))) throw Error('no vault.sqlite in the data directory')
if (!existsSync(join(dir, 'master.key'))) throw Error('no master.key in the data directory')
// The workflow carries no path, key, recipient, or snapshot content.
const workerDir = mkdtempSync(join(out, '.workflow-'))
const cli = new EngineCli(
  fileURLToPath(new URL('../../engine-bin/ephemeral', import.meta.url)),
  join(workerDir, 'job.sqlite'),
)
try {
  const id = randomUUID()
  await cli.call({
    op: 'register',
    name: 'backup',
    version: 1,
    steps: [{ kind: 'activity', name: 'snapshot' }],
  })
  await cli.call({ op: 'start-once', id, name: 'backup', version: 1, queue: 'backup', value: null })
  const task = await cli.call({ op: 'poll', queue: 'backup', leaseMS: 86400000 })
  if (task?.Run !== id || task.Activity !== 'snapshot') throw Error('Snapshot job unavailable')
  const src = new DatabaseSync(join(dir, 'vault.sqlite'))
  try {
    await backup(src, join(out, 'vault.sqlite'))
  } finally {
    src.close()
  }
  for (const f of ['master.key', 'operator.token']) {
    if (!existsSync(join(dir, f))) continue
    copyFileSync(join(dir, f), join(out, f))
    chmodSync(join(out, f), 0o600)
  }
  const snap = new DatabaseSync(join(out, 'vault.sqlite'))
  snap.exec('PRAGMA journal_mode=DELETE')
  const check = snap.prepare('PRAGMA integrity_check').get()
  snap.close()
  if (!check || Object.values(check)[0] !== 'ok')
    throw Error('the snapshot failed its integrity check')
  await cli.call({ op: 'finish', id, token: task.Token, value: null })
} finally {
  cli.close()
  rmSync(workerDir, { recursive: true, force: true })
}
console.log(JSON.stringify({ ok: true, vault_bytes: statSync(join(out, 'vault.sqlite')).size }))
