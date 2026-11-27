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
  // Connection-local triggers are hints only. The committed outbox survives rollback,
  // external writers and restarts. Every wait also has a fallback deadline.
  function hint(name: string, table: string, changes: string[]) {
    let notify: (() => void) | undefined
    let pending = false
    const wake = () => {
      pending = true
      notify?.()
    }
    db.function(name, () => {
      wake()
      return null
    })
    for (const op of changes)
      db.exec(
        `CREATE TEMP TRIGGER ${name}_${op} AFTER ${op} ON main.${table} BEGIN SELECT ${name}(); END`,
      )
    return {
      wake,
      wait: (ms: number) =>
        new Promise<void>((resolve) => {
          if (pending) {
            pending = false
            resolve()
            return
          }
          const finish = () => {
            pending = false
            clearTimeout(timer)
            notify = undefined
            resolve()
          }
          const timer = setTimeout(finish, ms)
          notify = finish
        }),
    }
  }
  const streamHint = hint('stream_hint', 'engine_events', ['INSERT'])
  const flowHint = hint('flow_hint', 'engine_jobs', ['INSERT', 'UPDATE'])
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
      '/bin/sh',
      [
        fileURLToPath(new URL('./engine-guardian.sh', import.meta.url)),
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
      'SELECT seq,kind,source FROM engine_events WHERE seq>? ORDER BY seq LIMIT ?',
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
      function encode(rows: ReturnType<typeof batch.all>) {
        return JSON.stringify(
          rows.map((row) => {
            if (!['activity', 'usage', 'meter'].includes(String(row.kind)))
              throw Error('Invalid event class')
            return [Number(row.seq), row.kind]
          }),
        )
      }
      const read = async () => {
        for (let offset = 0n; active && !stopped && received < 8192; ) {
          const record = await client.read('events', 0, offset, 10000)
          if (!record) continue
          const bytes = new TextDecoder().decode(record.value)
          const entries: unknown = JSON.parse(bytes)
          if (
            !Array.isArray(entries) ||
            !entries.length ||
            entries.length > 64 ||
            record.offset !== offset
          )
            throw Error('Invalid stream batch')
          const rows = batch.all(0, entries.length)
          if (
            record.id !== String(rows[0]?.seq) ||
            bytes !== encode(rows) ||
            rows.length !== entries.length
          )
            throw Error('Stream receipt mismatch')
          const audiences = new Map<string, [string, string]>()
          db.exec('BEGIN IMMEDIATE')
          try {
            for (const row of rows) {
              if (row.kind === 'activity') {
                advance.run(row.source)
                const audience = scope.get(row.source)
                if (audience) {
                  const pair: [string, string] = [String(audience.tenant), String(audience.actor)]
                  audiences.set(JSON.stringify(pair), pair)
                }
              }
              ack.run(row.seq)
            }
            db.exec('COMMIT')
          } catch (error) {
            db.exec('ROLLBACK')
            throw error
          }
          for (const pair of audiences.values()) wake(...pair)
          received += rows.length
          if (received === 8192) streamHint.wake()
          offset++
        }
      }
      const publish = async () => {
        let cursor = 0
        while (active && !stopped && received < 8192) {
          const rows = sent < 8192 ? batch.all(cursor, Math.min(64, 8192 - sent)) : []
          if (!rows.length) {
            await streamHint.wait(1000)
            continue
          }
          await client.publish('events', new TextEncoder().encode(encode(rows)), {
            id: String(rows[0].seq),
          })
          cursor = Number(rows.at(-1)!.seq)
          sent += rows.length
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
          if (!jobs.length && !ready.length) {
            const next = db
              .prepare('SELECT MIN(due) AS due FROM engine_jobs WHERE ready=0 AND due IS NOT NULL')
              .get()?.due
            await flowHint.wait(
              Math.max(1, Math.min(1000, next == null ? 1000 : Number(next) - Date.now())),
            )
          }
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
      streamHint.wake()
      flowHint.wake()
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
