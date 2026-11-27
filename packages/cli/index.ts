#!/usr/bin/env node
import { enroll, serveHost, proof } from './host.js'
import { OpenPassword, type DeviceTokens } from '@openpassword/client'
import { mkdirSync, existsSync, readFileSync, unlinkSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { Writable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

const [cmd, ...args] = process.argv.slice(2)
const origin = process.env.OPENPASSWORD_BROKER || 'http://127.0.0.1:4141'
const dir = join(homedir(), '.config/openpassword'),
  file = join(dir, Buffer.from(new URL(origin).origin).toString('base64url') + '.json')
process.umask(0o077)
const agentClient = (token?: string) => new OpenPassword(origin, token, proof)
async function identity<T>(
  fn: (
    previous: DeviceTokens | undefined,
    save: (value: DeviceTokens | null) => void,
  ) => Promise<T>,
  readOnly = false,
) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(dir, 'devices.sqlite'))
  db.exec(
    'PRAGMA busy_timeout=95000; CREATE TABLE IF NOT EXISTS identities(origin TEXT PRIMARY KEY,tokens TEXT);',
  )
  db.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE')
  const profile = process.env.OPENPASSWORD_AGENT?.trim()
  const key = profile ? JSON.stringify([new URL(origin).origin, profile]) : new URL(origin).origin
  try {
    const record = db.prepare('SELECT tokens FROM identities WHERE origin=?').get(key)
    const legacy = !profile && !record && existsSync(file)
    const previous = record
      ? JSON.parse(String(record.tokens))
      : legacy
        ? JSON.parse(readFileSync(file, 'utf8'))
        : undefined
    const save = (value: DeviceTokens | null) => {
      if (value)
        db.prepare('INSERT OR REPLACE INTO identities VALUES(?,?)').run(key, JSON.stringify(value))
      else db.prepare('DELETE FROM identities WHERE origin=?').run(key)
    }
    if (legacy && !readOnly) save(previous)
    const result = await fn(previous, save)
    db.exec('COMMIT')
    if (legacy && !readOnly) unlinkSync(file)
    return result
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw e
  } finally {
    db.close()
  }
}
async function tokens(revoke = false) {
  if (!revoke) {
    const previous = await identity(async (value) => value, true)
    if (previous && Date.parse(previous.access_expires_at) > Date.now() + 30000) return previous
  }
  return identity(async (previous, save) => {
    if (!previous) throw Error('Pair this device first')
    let current = previous
    if (Date.parse(current.access_expires_at) <= Date.now() + 30000) {
      current = await agentClient().refresh(current.refresh_token)
      save(current)
    }
    if (revoke) {
      await agentClient(current.access_token).request('/v1/device/revoke', {})
      save(null)
    }
    return current
  })
}
async function main() {
  if (cmd === 'vault-deposit') {
    if (args.length || process.stdin.isTTY) throw Error('Supply only the one-time receipt on stdin')
    let ticket = ''
    for await (const part of process.stdin) {
      if (part.length + ticket.length > 46) throw Error('Invalid deposit receipt')
      ticket += part.toString('ascii')
    }
    ticket = ticket.trim()
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw Error('Invalid deposit receipt')
    await new OpenPassword(origin).request('/v1/vault/deposits', {ticket})
    console.log('Private item saved')
    return
  }
  if (cmd === 'harness') {
    const { prepareHarness, targets } = await import('./harness.js')
    if (args.length === 1 && args[0] === 'list') {
      console.log(targets.join('\n'))
      return
    }
    if (
      !(args.length === 3 || (args.length === 4 && args[3] === '--standalone')) ||
      args[0] !== 'prepare'
    )
      throw Error(
        'Usage: openpassword harness list | harness prepare TARGET NEW_DIRECTORY [--standalone]',
      )
    console.log(prepareHarness(args[1], args[2], args[3] === '--standalone'))
    return
  }
  if (cmd === 'version') {
    console.log('OpenPassword CLI 0.5.0 · protocol 1')
    return
  }
  if (cmd === 'setup-code') {
    if (args[0] === '--ssh' && (args.length === 2 || (args.length === 3 && args[2] === '--user'))) {
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/.test(args[1]))
        throw Error('Use an SSH host or SSH config alias.')
      const remote =
        args[2] === '--user'
          ? 'openpassword setup-code'
          : 'sudo -n cat /var/lib/openpassword/operator.token | /opt/openpassword/current/node/bin/node /opt/openpassword/current/public/openpassword-cli.cjs setup-code --operator-stdin'
      const ssh = spawnSync(
        'ssh',
        [
          '-o',
          'ClearAllForwardings=yes',
          '-o',
          'ForwardAgent=no',
          '-o',
          'StrictHostKeyChecking=yes',
          '-T',
          '--',
          args[1],
          remote,
        ],
        { stdio: 'inherit' },
      )
      if (ssh.error || ssh.status !== 0)
        throw Error(
          'Remote setup failed. Verify the SSH host key and operator access. For password-based sudo, use an interactive SSH session.',
        )
      return
    }
    if (
      args.length &&
      !(args.length === 1 && args[0] === '--operator-stdin' && !process.stdin.isTTY)
    )
      throw Error('Usage: openpassword setup-code [--ssh user@host [--user]]')
    const token = readFileSync(
      args.length
        ? 0
        : join(process.env.OPENPASSWORD_HOME || join(homedir(), '.openpassword'), 'operator.token'),
      'utf8',
    ).trim()
    if (!token) throw Error('Host authorization unavailable')
    const port = Number(process.env.OPENPASSWORD_PORT || 4141)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid broker port')
    const code = randomBytes(32).toString('base64url')
    const hash = createHash('sha256').update(code).digest('hex')
    const issued = Date.now()
    const hostKey = createHash('sha256').update(token).digest()
    const proof = createHmac('sha256', hostKey)
      .update('OpenPassword/setup/v1/' + issued + '/' + hash)
      .digest('hex')
    const response = await fetch('http://127.0.0.1:' + port + '/auth/setup-code', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash, issued, proof }),
    })
    if (!response.ok)
      throw Error(
        'Broker declined setup. Check the installed version and whether an administrator already exists.',
      )
    const result = (await response.json()) as { origin: string }
    console.error(
      'Enter this code at ' + new OpenPassword(result.origin).origin + ' within 10 minutes:',
    )
    console.log(code)
    return
  }
  const client = agentClient()
  if (cmd === 'host' && args.length === 1 && args[0] === 'status') {
    console.log(JSON.stringify(await client.request('/v1/hosts/self')))
    return
  }
  if (cmd === 'host' && args[0] === 'serve' && args.length === 1) {
    if (!process.env.OPENPASSWORD_HOST_SOCKET)
      throw Error('Set OPENPASSWORD_HOST_SOCKET to a Unix socket in a service-owned directory')
    serveHost(client.origin, process.env.OPENPASSWORD_HOST_SOCKET)
    return
  }
  if (cmd === 'mcp') {
    const { serve } = await import('./mcp.js')
    // Serialize refreshes in this process before acquiring the cross-process SQLite lock.
    let pending: Promise<DeviceTokens> | undefined
    await serve(async () => {
      pending ??= tokens().finally(() => {
        pending = undefined
      })
      return agentClient((await pending).access_token)
    })
    return
  }
  if (cmd === 'connect' || (cmd === 'host' && args.length === 1 && args[0] === 'connect')) {
    if (cmd === 'connect' && args.length)
      throw Error('Paste the enrollment token at the prompt or provide it on stdin.')
    if (process.stdin.isTTY)
      process.stderr.write(
        cmd === 'host' ? 'Host enrollment token (hidden): ' : 'Agent enrollment token (hidden): ',
      )
    const input = createInterface({
      input: process.stdin,
      terminal: !!process.stdin.isTTY,
      output: new Writable({
        write(_data, _encoding, done) {
          done()
        },
      }),
    })
    let ticket: string
    try {
      const answer = await input[Symbol.asyncIterator]().next()
      ticket = String(answer.value ?? '').trim()
    } finally {
      input.close()
      if (process.stdin.isTTY) process.stderr.write('\n')
    }
    if (!ticket) throw Error('An enrollment token is required.')
    if (cmd === 'host') {
      await enroll(client.origin, ticket)
      return
    }
    await identity(async (previous, save) => {
      if (previous)
        throw Error(
          'Profile already paired. Choose another OPENPASSWORD_AGENT or revoke this profile first.',
        )
      save(await client.redeem(ticket))
    })
    console.log(
      JSON.stringify(await agentClient((await tokens()).access_token).request('/v1/whoami')),
    )
    return
  }
  if (cmd === 'forget') {
    await identity(async (_previous, save) => save(null))
    console.log('Local agent profile removed. Revoke any live grant in the web console.')
    return
  }
  if (cmd === 'pair') {
    if (await identity(async (existing) => !!existing, true))
      throw Error(
        'Agent profile already paired. Choose a different OPENPASSWORD_AGENT or revoke the existing grant first.',
      )
    const p = await client.pair(args[0] || process.env.OPENPASSWORD_AGENT || 'CLI')
    if (process.env.OPENPASSWORD_HOST_SOCKET)
      console.log('Approve request', p.pairing_id, 'under Access grants at', client.origin)
    else console.log('Open', p.verification_url, 'and approve code', p.user_code)
    while (Date.now() < Date.parse(p.expires_at)) {
      await new Promise((r) => setTimeout(r, p.interval_seconds * 1000))
      try {
        const pair = await client.redeem(p.device_code)
        await identity(async (previous, save) => {
          if (previous) throw Error('Profile already paired; choose a dedicated OPENPASSWORD_AGENT')
          save(pair)
        })
        console.log('Device paired')
        return
      } catch (e) {
        const status = (e as { status?: number }).status
        if (status === 429)
          await new Promise((done) => setTimeout(done, 10000 + Math.random() * 3000))
        else if (status !== 428) throw e
      }
    }
    throw Error('Pairing expired')
  }
  if (
    ![
      'connections',
      'invoke',
      'artifact',
      'invoke-json',
      'operation',
      'revoke',
      'whoami',
      'activity',
      'watch',
      'capabilities',
      'models',
      'chat',
    ].includes(cmd)
  )
    throw Error(
      'Usage: openpassword vault-deposit < receipt | harness list | harness prepare TARGET NEW_DIRECTORY [--standalone] | operation OPERATION_ID REQUEST_KEY | invoke-json | host connect | host serve | host status | setup-code | connect | whoami | activity | watch | capabilities | models | chat MODEL MAX_TOKENS KEY < prompt.txt | pair [name] | mcp | connections | invoke CONNECTION OPERATION KEY JSON | artifact ID [SHA256] | revoke',
    )
  if (cmd === 'watch') {
    let cursor: number | undefined = args.length ? Number(args[0]) : undefined
    if (
      args.length > 1 ||
      (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0))
    ) {
      throw Error('Usage: openpassword watch [last-event-id]')
    }
    let delay = 500
    while (true) {
      try {
        const live = agentClient((await tokens()).access_token)
        const page: { events: unknown[]; cursor: number } = await live.request(
          '/v1/activity' + (cursor === undefined ? '' : '?after=' + cursor),
        )
        for (const event of page.events) console.log(JSON.stringify(event))
        cursor = page.cursor
        delay = 500
      } catch (error) {
        const status = (error as { status?: number }).status
        if (!(error instanceof TypeError || status === 429 || (status && status >= 500)))
          throw error
        await new Promise((done) => setTimeout(done, delay + Math.random() * 250))
        delay = Math.min(10000, delay * 2)
      }
    }
  }
  const t = await tokens(cmd === 'revoke')
  if (cmd === 'revoke') return
  const bound = agentClient(t.access_token)
  if (cmd === 'invoke-json' || cmd === 'operation') {
    if (process.stdin.isTTY || (cmd === 'invoke-json' ? args.length !== 0 : args.length !== 2))
      throw Error(
        'Use invoke-json < request.json or operation OPERATION_ID REQUEST_KEY < arguments.json',
      )
    const { z } = await import('zod')
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of process.stdin) {
      bytes += chunk.length
      if (bytes > 65536) throw Error('Invocation exceeds 64 KiB')
      chunks.push(chunk)
    }
    let payload: unknown
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw Error('Invalid invocation JSON')
    }
    const field = z.string().min(1)
    if (cmd === 'operation') {
      const caps = await bound.request<{
        connection_id: string
        connection_revision: string
        external_identity: string
        operations: { id: string }[]
      }>('/v1/capabilities')
      if (!caps.operations.some((op) => op.id === args[0]))
        throw Error('Operation is unavailable to this grant')
      payload = {
        operation_id: args[0],
        idempotency_key: args[1],
        connection_id: caps.connection_id,
        arguments: payload,
        expect: {
          external_identity: caps.external_identity,
          connection_revision: caps.connection_revision,
        },
      }
    }
    const parsed = z
      .object({
        connection_id: field,
        operation_id: field,
        arguments: z.record(z.string(), z.unknown()),
        idempotency_key: field,
        expect: z
          .object({ external_identity: field, connection_revision: field })
          .strict()
          .optional(),
      })
      .strict()
      .safeParse(payload)
    if (!parsed.success) throw Error('Invalid invocation fields')
    const b = parsed.data
    console.log(
      JSON.stringify(
        await bound.invoke(
          b.connection_id,
          b.operation_id,
          b.arguments,
          b.idempotency_key,
          b.expect,
        ),
      ),
    )
    return
  }
  if (cmd === 'chat') {
    if (args.length !== 3 || process.stdin.isTTY)
      throw Error('Usage: openpassword chat MODEL MAX_TOKENS KEY < prompt.txt')
    console.log(
      JSON.stringify(
        await bound.chat(args[0], readFileSync(0, 'utf8'), Number(args[1]), args[2]),
        null,
        2,
      ),
    )
    return
  }
  if (cmd === 'artifact') {
    if (args.length < 1 || args.length > 2)
      throw Error('Usage: openpassword artifact ID [SHA256]')
    const want = args[1]?.replace(/^sha256:/, '')
    if (want !== undefined && !/^[0-9a-f]{64}$/.test(want)) throw Error('Invalid SHA-256')
    const bytes = await bound.artifact(args[0])
    if (want !== undefined && createHash('sha256').update(bytes).digest('hex') !== want)
      throw Error('Artifact differs from the expected digest')
    // The exact bytes, nothing added: the digest in the invoke receipt stays checkable.
    process.stdout.write(bytes)
    return
  }
  if (['whoami', 'activity', 'capabilities', 'models'].includes(cmd)) {
    console.log(JSON.stringify(await bound.request('/v1/' + cmd), null, 2))
    return
  }
  const result =
    cmd === 'connections'
      ? await bound.connections()
      : await bound.invoke(args[0], args[1], JSON.parse(args[3] || '{}'), args[2])
  console.log(JSON.stringify(result, null, 2))
}
main().catch((e) => {
  console.error(e.message)
  process.exitCode = 1
})
