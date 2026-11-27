// Operator workstation command. The broker streams ciphertext and never receives the identity.
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  closeSync,
  openSync,
  linkSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { open } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { EngineCli } from '../../server/engine-cli.ts'

type Settings = { source: string; destination: string }
type Receipt = { step: 'created' | 'encrypted' | 'delivered' | 'verified'; digest?: string }
const steps = ['encrypt', 'deliver', 'verify'] as const
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(
  process.env.OPENPASSWORD_BACKUP_JOBS || join(homedir(), '.openpassword-backup', 'jobs'),
)
const [command, arg, output] = process.argv.slice(2)
process.umask(0o077)
function privateDir(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const st = lstatSync(path)
  if (!st.isDirectory() || (st.mode & 0o077) !== 0 || st.uid !== process.getuid?.())
    throw Error('Use a private directory owned by the operator')
}
function sync(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
function write(path: string, data: unknown) {
  const temp = path + '.' + randomUUID()
  writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx', flush: true })
  renameSync(temp, path)
  sync(dirname(path))
}
async function hash(path: string) {
  const h = createHash('sha256')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!(await file.stat()).isFile()) throw Error('Expected a regular ciphertext file')
    for await (const chunk of file.createReadStream({ autoClose: false })) h.update(chunk)
    return h.digest('hex')
  } finally {
    await file.close()
  }
}
async function encrypt(source: string, target: string) {
  const local = source === 'local'
  const child = spawn(
    local ? 'bash' : 'ssh',
    local
      ? [join(here, 'backup.sh'), '--encrypt', '--direct']
      : [
          '-T',
          '-o',
          'BatchMode=yes',
          '-o',
          'StrictHostKeyChecking=yes',
          '-o',
          'ClearAllForwardings=yes',
          '-o',
          'ForwardAgent=no',
          '--',
          source,
          'sudo -n /opt/openpassword/current/deploy/backup/backup.sh --encrypt',
        ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
  const exit = once(child, 'close')
  try {
    const [, [code]] = await Promise.all([
      pipeline(child.stdout, createWriteStream(target, { flags: 'wx', mode: 0o600 })),
      exit,
    ])
    if (code !== 0 || lstatSync(target).size === 0) throw Error('Encrypted snapshot failed')
  } finally {
    child.kill()
  }
}
function idOf(value: string | undefined) {
  if (!value || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value))
    throw Error('Expected backup job UUID')
  return value
}
async function main() {
  privateDir(root)
  if (command === 'new') {
    if (
      !arg ||
      !output ||
      !(arg === 'local' || /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*$/.test(arg))
    )
      throw Error('Expected local or SSH host, and a private destination directory')
    const destination = resolve(output)
    privateDir(destination)
    const id = randomUUID(),
      dir = join(root, id)
    privateDir(dir)
    write(join(dir, 'settings.json'), { source: arg, destination })
    write(join(dir, 'receipt.json'), { step: 'created' })
    sync(root)
    console.log(id)
    return
  }
  const id = idOf(arg),
    dir = join(root, id)
  if (!existsSync(dir)) throw Error('Unknown backup job')
  privateDir(dir)
  const settings: Settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
  const path = join(dir, 'receipt.json'),
    receipt = (): Receipt => JSON.parse(readFileSync(path, 'utf8'))
  const spool = join(dir, 'archive.age'),
    destination = join(settings.destination, id + '.age')
  if (command === 'status') {
    const saved = receipt()
    const intact =
      !!saved.digest && existsSync(destination) && (await hash(destination)) === saved.digest
    console.log(
      JSON.stringify({
        id,
        ...saved,
        destination_intact: intact,
        restore_verified: saved.step === 'verified' && intact,
      }),
    )
    return
  }
  if (command !== 'resume') throw Error('Use new, status or resume')
  privateDir(settings.destination)
  const lock = new DatabaseSync(join(dir, 'owner.sqlite'))
  let cli: EngineCli | undefined
  try {
    lock.exec('BEGIN EXCLUSIVE')
    cli = new EngineCli(
      fileURLToPath(new URL('../../engine-bin/ephemeral', import.meta.url)),
      join(dir, 'workflow.sqlite'),
    )
    await cli.call({
      op: 'register',
      name: 'backup',
      version: 1,
      steps: steps.map((name) => ({ kind: 'activity', name, attempts: 100000 })),
    })
    await cli.call({
      op: 'start-once',
      id,
      name: 'backup',
      version: 1,
      queue: 'backup',
      value: null,
    })
    while (true) {
      const state = await cli.call({ op: 'describe', id })
      if (state.State === 'completed') break
      if (state.State === 'failed' || state.State === 'canceled')
        throw Error('Workflow ended without verification')
      const task = await cli.call({ op: 'poll', queue: 'backup', leaseMS: 5000 })
      if (!task) {
        await sleep(250)
        continue
      }
      if (task.Run !== id || !steps.includes(task.Activity)) throw Error('Unexpected backup lease')
      // The exclusive owner renews long-running work and releases its lease on completion.
      const leaseAbort = new AbortController()
      const heartbeat = (async () => {
        while (!leaseAbort.signal.aborted) {
          try {
            await sleep(1000, undefined, { signal: leaseAbort.signal })
          } catch {
            return
          }
          await cli!.call({ op: 'heartbeat', id, token: task.Token, leaseMS: 5000 })
        }
      })()
      heartbeat.catch(() => {})
      try {
        const prior = receipt()
        if (task.Activity === 'encrypt') {
          if (!existsSync(spool)) {
            const temp = spool + '.partial'
            rmSync(temp, { force: true })
            await encrypt(settings.source, temp)
            sync(temp)
            renameSync(temp, spool)
            sync(dir)
          }
          const digest = await hash(spool)
          if (prior.digest && digest !== prior.digest) throw Error('Spool checksum changed')
          write(path, { step: 'encrypted', digest })
        } else {
          if (!prior.digest) throw Error('Missing encryption receipt')
          if (task.Activity === 'deliver') {
            if (!existsSync(destination)) {
              const part = destination + '.partial'
              rmSync(part, { force: true })
              await pipeline(
                createReadStream(spool),
                createWriteStream(part, { flags: 'wx', mode: 0o600 }),
              )
              if ((await hash(part)) !== prior.digest) throw Error('Transfer checksum mismatch')
              sync(part)
              linkSync(part, destination)
              sync(settings.destination)
              unlinkSync(part)
            }
            if ((await hash(destination)) !== prior.digest)
              throw Error('Destination checksum mismatch')
            sync(settings.destination)
            write(path, { step: 'delivered', digest: prior.digest })
          } else {
            if ((await hash(destination)) !== prior.digest)
              throw Error('Destination checksum mismatch')
            if (prior.step !== 'verified') {
              const check = spawn(
                'bash',
                [join(here, 'operator-backup.sh'), 'check', destination],
                { stdio: ['inherit', 'ignore', 'ignore'] },
              )
              if ((await once(check, 'close'))[0] !== 0)
                throw Error('Operator restore check failed')
              if ((await hash(destination)) !== prior.digest) throw Error('Verified file changed')
              write(path, { step: 'verified', digest: prior.digest })
            }
          }
        }
      } finally {
        leaseAbort.abort()
        await heartbeat
      }
      await cli.call({ op: 'finish', id, token: task.Token, value: null })
    }
    const final = receipt()
    if (final.step !== 'verified' || !final.digest || (await hash(destination)) !== final.digest)
      throw Error('Verified destination unavailable')
    rmSync(spool, { force: true })
    rmSync(destination + '.partial', { force: true })
    sync(dir)
    console.log(
      JSON.stringify({ id, step: 'verified', file: basename(destination), digest: final.digest }),
    )
  } finally {
    cli?.close()
    lock.close()
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : 'Backup job failed')
  process.exitCode = 1
})
