import { Refusal } from './refusal.ts'
import type { DatabaseSync } from 'node:sqlite'

export type Audience = { tenant: string; actor?: string }
const key = (scope: Audience) => JSON.stringify([scope.tenant, scope.actor ?? null])

// SQLite owns the cursor and payload. In-memory notifications only wake matching readers.
export function activity(db: DatabaseSync, journal = false) {
  db.exec('CREATE INDEX IF NOT EXISTS events_actor_cursor ON events(tenant,actor,id)')
  if (journal)
    db.exec(
      'CREATE TABLE IF NOT EXISTS engine_cursor(id INTEGER PRIMARY KEY CHECK(id=1), visible INTEGER NOT NULL)',
    )
  const queries = [false, true].map((scoped) => {
    const where =
      ' FROM events WHERE tenant=?' +
      (journal ? ' AND id <= (SELECT visible FROM engine_cursor WHERE id=1)' : '') +
      (scoped ? ' AND actor=?' : '')
    const fields = 'SELECT id,action,subject,at,actor'
    return {
      latest: db.prepare(fields + where + ' ORDER BY id DESC LIMIT 100'),
      after: db.prepare(fields + where + ' AND id>? ORDER BY id LIMIT 100'),
    }
  })
  const waiting = new Map<string, Set<() => void>>()
  let count = 0
  function read(scope: Audience, after?: number) {
    const args = scope.actor === undefined ? [scope.tenant] : [scope.tenant, scope.actor]
    const query = queries[args.length - 1]
    const events =
      after === undefined ? query.latest.all(...args).reverse() : query.after.all(...args, after)
    return { events, cursor: Number(events.at(-1)?.id ?? after ?? 0) }
  }
  return {
    wakeAll() {
      for (const group of waiting.values()) for (const wake of group) wake()
    },
    signal(tenant: string, actor: string) {
      for (const scope of [{ tenant }, { tenant, actor }])
        for (const wake of waiting.get(key(scope)) ?? []) wake()
    },
    async poll(
      authorize: () => Audience,
      after: number | undefined,
      signal: AbortSignal,
      wait: number,
    ) {
      const scope = authorize()
      const page = read(scope, after)
      // No await between the durable read and registration on the broker event loop.
      if (after === undefined || page.events.length || !wait || signal.aborted) return page
      const k = key(scope)
      const group = waiting.get(k) ?? new Set<() => void>()
      if (count >= 4096 || group.size >= 512)
        throw new Refusal(429, 'Activity listener limit reached')
      await new Promise<void>((resolve) => {
        function wake() {
          clearTimeout(timer)
          signal.removeEventListener('abort', wake)
          group.delete(wake)
          if (!group.size) waiting.delete(k)
          count--
          resolve()
        }
        const timer = setTimeout(wake, wait)
        signal.addEventListener('abort', wake, { once: true })
        waiting.set(k, group)
        group.add(wake)
        count++
      })
      if (key(authorize()) !== k)
        throw new Refusal(409, 'Workspace changed')
      return read(scope, after)
    },
  }
}
