import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, accessSync, constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { Client } from './dostoevsky/index.js'
import { EngineCli } from './engine-cli.ts'
import { installEngineSchema } from './engine-schema.ts'

export function engines(
  db: DatabaseSync,
  bin: string,
  wake: (tenant: string, actor: string) => void,
  wakeAll: () => void,
) {
  for (const binary of ['ephemeral', 'dostoevsky-gateway'])
    accessSync(join(bin, binary), constants.X_OK)
  installEngineSchema(db)
  let stopped = false
  let shutdownStream = () => {}
  let shutdownWorker = () => {}
  let streamHealthy = false,
    workerHealthy = false
  // Start each epoch from durable broker receipts. Epochs have no restore or downgrade dependency.
  async function stream() {
    const dir = mkdtempSync(join(tmpdir(), 'openpassword-stream-'))
    const token = randomBytes(32).toString('base64url')
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('./engine-guardian.ts', import.meta.url)),
        'stream',
        dir,
        join(bin, 'dostoevsky-gateway'),
        '-listen',
        '127.0.0.1:0',
        '-data',
        dir,
        '-max-journal-mib',
        '16',
      ],
      {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { NODE_ENV: 'production', DOSTOEVSKY_TOKEN: token },
      },
    )
    child.on('error', () => {})
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    shutdownStream = () => child.stdin.end()
    let active = true
    const batch = db.prepare(
      'SELECT seq,kind,source FROM engine_events WHERE seq>? ORDER BY seq LIMIT 64',
    )
    const ack = db.prepare('DELETE FROM engine_events WHERE seq=?')
    const advance = db.prepare('UPDATE engine_cursor SET visible=MAX(visible,?) WHERE id=1')
    const scope = db.prepare('SELECT tenant,actor FROM events WHERE id=?')
    try {
      const first = await lines.next()
      const port = /^listening 127\.0\.0\.1:(\d+) \(tls=false\)$/.exec(first.value ?? '')?.[1]
      if (!port) throw Error('Stream startup failed')
      const client = new Client('http://127.0.0.1:' + port, token)
      let sent = 0,
        received = 0
      streamHealthy = true
      // One upstream long poll fans out to authorization-scoped subscribers.
      const read = async () => {
        for (let offset = 0n; active && !stopped && received < 8192; ) {
          const record = await client.read('events', 0, offset, 1000)
          if (!record) continue
          const row = db
            .prepare('SELECT seq,kind,source FROM engine_events WHERE seq=?')
            .get(Number(record.id))
          if (
            !row ||
            record.offset !== offset ||
            new TextDecoder().decode(record.value) !== row.kind
          )
            throw Error('Stream receipt mismatch')
          db.exec('BEGIN IMMEDIATE')
          try {
            if (row.kind === 'activity') advance.run(row.source)
            ack.run(row.seq)
            db.exec('COMMIT')
          } catch (error) {
            db.exec('ROLLBACK')
            throw error
          }
          if (row.kind === 'activity') {
            const audience = scope.get(row.source)
            if (audience) wake(String(audience.tenant), String(audience.actor))
          }
          received++
          offset++
        }
      }
      const publish = async () => {
        let cursor = 0
        while (active && !stopped && received < 8192) {
          const rows = sent < 8192 ? batch.all(cursor) : []
          if (!rows.length) {
            await sleep(25)
            continue
          }
          for (const row of rows) {
            if (!active || stopped || sent === 8192) break
            await client.publish('events', new TextEncoder().encode(String(row.kind)), {
              id: String(row.seq),
            })
            cursor = Number(row.seq)
            sent++
          }
        }
      }
      const readers = read(),
        writers = publish()
      try {
        await Promise.race([readers, writers])
      } finally {
        active = false
        shutdownStream()
        await Promise.allSettled([readers, writers])
      }
    } finally {
      streamHealthy = false
      shutdownStream()
    }
  }
  async function workflows() {
    const dir = mkdtempSync(join(tmpdir(), 'openpassword-flow-'))
    const cli = new EngineCli(join(bin, 'ephemeral'), join(dir, 'flows.sqlite'), dir)
    shutdownWorker = () => cli.close()
    db.exec(
      'DROP TABLE IF EXISTS temp.engine_started; CREATE TEMP TABLE engine_started(id TEXT PRIMARY KEY, signaled INTEGER DEFAULT 0)',
    )
    try {
      await cli.call({
        op: 'register',
        name: 'gate',
        version: 1,
        steps: [
          { kind: 'signal', name: 'ready' },
          { kind: 'activity', name: 'apply', attempts: 10 },
        ],
      })
      workerHealthy = true
      let finished = 0
      while (!stopped && finished < 2048) {
        const jobs = db
          .prepare(
            'SELECT id FROM engine_jobs WHERE id NOT IN(SELECT id FROM engine_started) LIMIT 32',
          )
          .all()
        for (const j of jobs) {
          await cli.call({
            op: 'start-once',
            id: j.id,
            name: 'gate',
            version: 1,
            queue: 'work',
            value: null,
          })
          db.prepare('INSERT INTO engine_started(id) VALUES(?)').run(j.id)
        }
        const ready = db
          .prepare(
            'SELECT j.id FROM engine_jobs j JOIN engine_started s ON s.id=j.id WHERE s.signaled=0 AND (j.ready>0 OR j.due<=?) LIMIT 32',
          )
          .all(Date.now())
        for (const j of ready) {
          await cli.call({ op: 'signal', id: j.id, key: 'decision', name: 'ready', value: null })
          db.prepare('UPDATE engine_started SET signaled=1 WHERE id=?').run(j.id)
        }
        const task = await cli.call({ op: 'poll', queue: 'work', leaseMS: 10000 })
        if (!task) {
          if (!jobs.length && !ready.length) await sleep(200)
          continue
        }
        const j = db.prepare('SELECT * FROM engine_jobs WHERE id=?').get(task.Run)
        if (j) {
          db.exec('BEGIN IMMEDIATE')
          try {
            if (j.kind === 'pair')
              db.prepare('DELETE FROM pairs WHERE id=? AND expires<=?').run(j.ref, Date.now())
            if (j.kind === 'host')
              db.prepare(
                'UPDATE cli_hosts SET ticket=NULL WHERE id=? AND expires<=? AND ticket IS NOT NULL',
              ).run(j.ref, Date.now())
            if (j.kind === 'approval' && Number(j.ready) >= 2) {
              const decision = j.ready === 2 ? 'approved' : 'denied'
              const applied = db
                .prepare("UPDATE runs SET state=? WHERE id=? AND state='pending'")
                .run(decision, j.ref)
              if (
                applied.changes &&
                db
                  .prepare("UPDATE batches SET state=? WHERE approval=? AND state='pending'")
                  .run(decision, j.ref).changes
              )
                db.prepare('INSERT OR IGNORE INTO batch_decisions VALUES(?,?)').run(
                  j.ref,
                  Date.now(),
                )
            }
            if (j.kind === 'revocation') {
              db.prepare(
                "UPDATE runs SET state='denied' WHERE actor=? AND state IN ('approved','pending')",
              ).run(j.ref)
              wakeAll()
            }
            if (j.kind === 'rotation') {
              db.prepare(
                "UPDATE runs SET state='denied' WHERE state IN ('approved','pending') AND conn=(SELECT subject FROM events WHERE id=?) AND revision < (SELECT revision FROM connections WHERE id=runs.conn)",
              ).run(j.ref)
              wakeAll()
            }
            db.prepare('DELETE FROM engine_jobs WHERE id=?').run(j.id)
            db.exec('COMMIT')
          } catch (error) {
            db.exec('ROLLBACK')
            throw error
          }
        }
        await cli.call({ op: 'finish', id: task.Run, token: task.Token, value: null })
        finished++
      }
    } finally {
      workerHealthy = false
      cli.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
  async function supervise(start: () => Promise<void>) {
    while (!stopped) {
      try {
        await start()
      } catch {
        if (!stopped) {
          console.error('OpenPassword engine restarting')
          await sleep(500)
        }
      }
    }
  }
  const tasks = [supervise(stream), supervise(workflows)]
  return {
    healthy: () => streamHealthy && workerHealthy,
    async close() {
      stopped = true
      shutdownStream()
      shutdownWorker()
      await Promise.all(tasks)
    },
  }
}

export function claimEngineOwner(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const lock = new DatabaseSync(join(dir, 'engine-owner.sqlite'))
  try {
    lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
    return lock
  } catch {
    lock.close()
    throw Error('Another broker or offline maintenance operation owns this vault')
  }
}
