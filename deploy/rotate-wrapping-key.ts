// Service identity, on the stopped broker host. Arguments name private key files.
import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EngineCli } from '../server/engine-cli.ts'
import { claimEngineOwner } from '../server/engines.ts'
import { rotateWrappingKey } from '../server/store.ts'
const [home, oldKey, newKey] = process.argv.slice(2)
if (!home || !oldKey || !newKey)
  throw Error('Expected vault directory and two absolute wrapping key paths')
process.umask(0o077)
const lock = claimEngineOwner(home)
const dir = mkdtempSync(join(tmpdir(), 'openpassword-offline-'))
const cli = new EngineCli(
  fileURLToPath(new URL('../engine-bin/ephemeral', import.meta.url)),
  join(dir, 'job.sqlite'),
  dir,
)
try {
  const id = randomUUID()
  await cli.call({
    op: 'register',
    name: 'rotate',
    version: 1,
    steps: [{ kind: 'activity', name: 'rewrap' }],
  })
  await cli.call({
    op: 'start-once',
    id,
    name: 'rotate',
    version: 1,
    queue: 'maintenance',
    value: null,
  })
  const task = await cli.call({ op: 'poll', queue: 'maintenance', leaseMS: 60000 })
  if (task?.Run !== id || task.Activity !== 'rewrap') throw Error('Rotation lease unavailable')
  rotateWrappingKey(home, oldKey, newKey)
  await cli.call({ op: 'finish', id, token: task.Token, value: null })
  console.log('Verified the vault master key under the replacement wrapping key.')
} finally {
  cli.close()
  lock.close()
  rmSync(dir, { recursive: true, force: true })
}
