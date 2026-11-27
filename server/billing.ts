import { Refusal } from './refusal.ts'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
const integer = z.number().int().nonnegative().max(1000000000)
const path = z.string().regex(/^[a-zA-Z_][a-zA-Z_0-9]*(?:\.[a-zA-Z_][a-zA-Z_0-9]*){0,3}$/)
const mapping = z
  .object({
    prompt: path,
    completion: path,
    cache_read: path.optional(),
    cache_write: path.optional(),
    reasoning: path.optional(),
    cache_read_in_prompt: z.boolean().default(true),
    cache_write_in_prompt: z.boolean().default(true),
    reasoning_in_completion: z.boolean().default(true),
  })
  .strict()
export const tariff = z
  .object({
    budget_micro_usd: z.number().int().positive().max(1000000000000),
    input: integer,
    output: integer,
    cache_read: integer.optional(),
    cache_write: integer.optional(),
    reasoning: integer.optional(),
    reasoning_allowance_tokens: integer.max(1000000).default(0),
    mapping: mapping.optional(),
    source: z.url({ protocol: /^https$/ }),
    as_of: z.iso.date(),
  })
  .strict()
type Tariff = z.infer<typeof tariff>
const price = (tokens: number, rate: number) =>
  Number((BigInt(tokens) * BigInt(rate) + 999999n) / 1000000n)
export function reserveCost(
  t: Tariff,
  body: { messages: { role: string }[]; max_tokens: number },
  size: number,
) {
  const input =
    size + 16 * body.messages.length + (body.messages.some((m) => m.role === 'system') ? 64 : 0)
  return (
    price(input, Math.max(t.input, t.cache_read ?? 0, t.cache_write ?? 0)) +
    price(body.max_tokens + t.reasoning_allowance_tokens, Math.max(t.output, t.reasoning ?? 0)) +
    5
  )
}
export function charge(t: Tariff, raw: unknown) {
  const value = (p: string | undefined, optional: boolean) => {
    if (!p) return 0
    let result: unknown = raw
    for (const key of p.split('.')) {
      if (!result || typeof result !== 'object' || !Object.hasOwn(result, key))
        return optional ? 0 : null
      result = (result as Record<string, unknown>)[key]
    }
    return integer.safeParse(result).success ? Number(result) : null
  }
  const m = t.mapping ?? {
    prompt: 'prompt_tokens',
    completion: 'completion_tokens',
    cache_read: 'prompt_tokens_details.cached_tokens',
    cache_write: 'prompt_tokens_details.cache_write_tokens',
    reasoning: 'completion_tokens_details.reasoning_tokens',
    cache_read_in_prompt: true,
    cache_write_in_prompt: true,
    reasoning_in_completion: true,
  }
  const input = value(m.prompt, false),
    output = value(m.completion, false),
    read = value(m.cache_read, !t.mapping),
    write = value(m.cache_write, !t.mapping),
    reason = value(m.reasoning, !t.mapping)
  if (input === null || output === null || read === null || write === null || reason === null)
    return null
  const uncached =
    input - (m.cache_read_in_prompt ? read : 0) - (m.cache_write_in_prompt ? write : 0)
  const visible = output - (m.reasoning_in_completion ? reason : 0)
  if (
    uncached < 0 ||
    visible < 0 ||
    (read && t.cache_read === undefined) ||
    (write && t.cache_write === undefined) ||
    (reason && t.reasoning === undefined)
  )
    return null
  return (
    price(uncached, t.input) +
    price(read, t.cache_read ?? 0) +
    price(write, t.cache_write ?? 0) +
    price(visible, t.output) +
    price(reason, t.reasoning ?? 0)
  )
}
export function billing(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS model_budgets(grant_id TEXT PRIMARY KEY,tariff TEXT,available INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS model_charges(execution TEXT PRIMARY KEY,grant_id TEXT,reserved INTEGER,charged INTEGER,state TEXT,created INTEGER);
 CREATE INDEX IF NOT EXISTS model_charge_grant ON model_charges(grant_id,created);`)
  return {
    configure(id: string, t: Tariff) {
      db.prepare('INSERT INTO model_budgets VALUES(?,?,?)').run(
        id,
        JSON.stringify(t),
        t.budget_micro_usd,
      )
    },
    claim(
      id: string,
      ex: string,
      body: { messages: { role: string }[]; max_tokens: number },
      bytes: number,
    ) {
      const b = db.prepare('SELECT tariff FROM model_budgets WHERE grant_id=?').get(id)
      if (!b) return false
      const amount = reserveCost(tariff.parse(JSON.parse(String(b.tariff))), body, bytes)
      if (
        !db
          .prepare(
            'UPDATE model_budgets SET available=available-? WHERE grant_id=? AND available>=?',
          )
          .run(amount, id, amount).changes
      )
        throw new Refusal(402, 'Model budget exhausted')
      db.prepare("INSERT INTO model_charges VALUES(?,?,?,NULL,'reserved',?)").run(
        ex,
        id,
        amount,
        Date.now(),
      )
      return true
    },
    finish(ex: string, usage: unknown, confirmed: boolean) {
      const b = db
        .prepare(
          "SELECT c.*,b.tariff FROM model_charges c JOIN model_budgets b USING(grant_id) WHERE execution=? AND state='reserved'",
        )
        .get(ex)
      if (!b) return
      const amount = confirmed ? charge(tariff.parse(JSON.parse(String(b.tariff))), usage) : null
      if (amount === null || amount > Number(b.reserved)) {
        db.prepare("UPDATE model_charges SET state='held' WHERE execution=?").run(ex)
        return
      }
      db.prepare("UPDATE model_charges SET charged=?,state='settled' WHERE execution=?").run(
        amount,
        ex,
      )
      db.prepare('UPDATE model_budgets SET available=available+? WHERE grant_id=?').run(
        Number(b.reserved) - amount,
        b.grant_id,
      )
    },
  }
}
// Buffer partial UTF-8 lines across SSE chunks. Only complete usage frames can settle a reservation.
export class StreamUsage {
  private decoder = new TextDecoder()
  private line = ''
  usage: unknown
  feed(chunk: Uint8Array) {
    this.line += this.decoder.decode(chunk, { stream: true })
    const parts = this.line.split(/\r?\n/)
    this.line = parts.pop() || ''
    if (this.line.length > 1048576) throw Error('SSE line too long')
    for (const part of parts)
      if (part.startsWith('data:')) {
        const payload = part.slice(5).trim()
        if (payload && payload !== '[DONE]') {
          const value = JSON.parse(payload)
          if (value.usage) this.usage = value.usage
        }
      }
  }
}
