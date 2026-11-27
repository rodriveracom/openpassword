import { Refusal } from './refusal.ts'
import { templatePlan, writeTemplate } from './template.ts'
import { bundleHash, templateOps } from './template-preview.ts'
import { buildRequest } from '../packages/connectors/index.ts'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import { z } from 'zod'
import { digest } from './store.ts'
export const bundleOperation = 'hubspot.files.upload_bundle'
// A connection's upload folder is its one selected resource written as an absolute folder, such as
// /newsletter-assets/. Template directories are relative, so the two cannot be confused.
export function uploadFolder(resources: unknown): string | null {
  const absolute = (Array.isArray(resources) ? resources : []).filter(
    (r): r is string => typeof r === 'string' && r.startsWith('/'),
  )
  return absolute.length === 1 &&
    /^\/(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}\/){1,5}$/.test(absolute[0])
    ? absolute[0]
    : null
}
const sha = z.string().regex(/^[a-f0-9]{64}$/)
const filename = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/)
const mime = z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const file = z
  .object({
    file_name: filename,
    content_type: mime,
    artifact_id: z.string().regex(/^hsa_[0-9a-f]{32}$/),
    sha256: sha,
    size_bytes: z.number().int().min(1).max(4194304),
  })
  .strict()
const schema = z
  .object({
    issue_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
    files: z.array(file).min(1).max(20),
    bundle_sha256: sha,
    template_files: z
      .array(z.object({ path: z.string(), content: z.string() }).strict())
      .max(20)
      .default([]),
    update_draft: z
      .object({
        creation_execution_id: z.string().min(1).max(200),
        draft: z.record(z.string(), z.unknown()),
      })
      .strict()
      .nullish(),
  })
  .strict()
type Scope = { tenant: string; actor: string; conn: string; revision: number; folder: string }
type Manifest = z.infer<typeof schema>
const denied = (message: string): never => {
  throw new Refusal(422, message)
}
export function issueFiles(
  db: DatabaseSync,
  seal: (v: unknown, a: string) => string,
  open: (v: string, a: string) => any,
) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS issue_assets(id TEXT PRIMARY KEY,tenant TEXT,actor TEXT,conn TEXT,rev INTEGER,expires INTEGER,size INTEGER,doc TEXT,content TEXT);CREATE INDEX IF NOT EXISTS issue_assets_scope ON issue_assets(tenant,actor);CREATE TABLE IF NOT EXISTS issue_runs(conn TEXT,issue TEXT,tenant TEXT,actor TEXT,rev INTEGER,execution TEXT,hash TEXT,PRIMARY KEY(conn,issue));CREATE TABLE IF NOT EXISTS issue_steps(exec TEXT,name TEXT,state TEXT,details TEXT,PRIMARY KEY(exec,name))',
  )
  async function stage(
    s: Scope,
    bytes: Buffer,
    name: string,
    media: string,
    hash: string,
    check: () => void,
  ) {
    const id = 'hsa_' + randomUUID().replaceAll('-', ''),
      doc = file.parse({
        file_name: name,
        content_type: media,
        artifact_id: id,
        sha256: hash,
        size_bytes: bytes.length,
      })
    if (digest(bytes) !== hash) denied('Digest mismatch')
    try {
      const image = sharp(bytes, { animated: true, limitInputPixels: 32000000, failOn: 'warning' })
      const meta = await image.metadata(),
        frames = meta.pages ?? 1,
        height = meta.pageHeight ?? meta.height
      if (
        media !== 'image/' + meta.format ||
        !meta.width ||
        !height ||
        meta.width * height > 16000000 ||
        frames > 120 ||
        meta.width * height * frames > 32000000
      )
        throw Error()
      await image.stats()
    } catch {
      denied('Invalid image')
    }
    check()
    db.prepare('DELETE FROM issue_assets WHERE expires<=?').run(Date.now())
    const used = db
      .prepare('SELECT SUM(size) AS bytes,SUM(actor=?) AS count FROM issue_assets WHERE tenant=?')
      .get(s.actor, s.tenant)!
    if (Number(used.bytes) + bytes.length > 64 * 1024 * 1024 || Number(used.count) >= 80)
      denied('Staging quota reached')
    db.prepare('INSERT INTO issue_assets VALUES(?,?,?,?,?,?,?,?,?)').run(
      id,
      s.tenant,
      s.actor,
      s.conn,
      s.revision,
      Date.now() + 86400000,
      bytes.length,
      JSON.stringify(doc),
      seal(bytes.toString('base64'), id),
    )
    return doc
  }
  function roots(s: Scope): string[] {
    return JSON.parse(
      String(db.prepare('SELECT labels FROM resources WHERE conn=?').get(s.conn)?.labels ?? '[]'),
    )
  }
  function resolveDraft(s: Scope, reference: string) {
    const row = db
      .prepare(
        "SELECT id,outcome FROM runs WHERE id=? AND actor=? AND tenant=? AND conn=? AND revision=? AND op='hubspot.newsletter.create_draft' AND state='confirmed'",
      )
      .get(reference, s.actor, s.tenant, s.conn, s.revision)
    const id = row && open(String(row.outcome), String(row.id) + '/outcome').result?.remote_id
    if (!id || !/^\d{1,20}$/.test(String(id))) denied('Original draft creation unavailable')
    return String(id)
  }
  function substitute(v: unknown, urls: Map<string, string>): any {
    if (typeof v === 'string')
      return v.replace(
        /\$\{asset:([A-Za-z0-9_.-]+)\}/g,
        (_, name) => urls.get(name) ?? denied('Unknown asset reference'),
      )
    if (Array.isArray(v)) return v.map((x) => substitute(x, urls))
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, urls)]))
    return v
  }
  function planTemplate(s: Scope, f: { path: string; content: string }, urls: Map<string, string>) {
    const content: string = substitute(f.content, urls)
    return templatePlan(
      templateOps[0],
      {
        files: [{ path: f.path, content }],
        bundle_sha256: bundleHash([[f.path, digest(content)]]),
      },
      roots(s),
    )
  }
  function manifest(s: Scope, input: unknown) {
    const b = schema.parse(input)
    if (
      new Set(b.files.map((f) => f.file_name.toLowerCase())).size !== b.files.length ||
      b.files.reduce((n, f) => n + f.size_bytes, 0) > 16777216 ||
      digest(JSON.stringify(b.files.map((f) => [f.file_name, f.sha256]))) !== b.bundle_sha256
    )
      denied('Invalid issue manifest')
    const placeholders = new Map(
      b.files.map((f) => [f.file_name, 'https://example.invalid/' + 'a'.repeat(2024)]),
    )
    if (
      Buffer.byteLength(JSON.stringify(b)) > 56000 ||
      new Set(b.template_files.map((f) => f.path)).size !== b.template_files.length
    )
      denied('Invalid issue plan')
    for (const f of b.template_files) planTemplate(s, f, placeholders)
    if (b.update_draft) {
      resolveDraft(s, b.update_draft.creation_execution_id)
      buildRequest(
        'hubspot',
        'hubspot.newsletter.update_draft',
        substitute(b.update_draft, placeholders),
        'validation',
      )
    }
    for (const f of b.files) {
      const row = db
        .prepare(
          'SELECT doc FROM issue_assets WHERE id=? AND conn=? AND tenant=? AND actor=? AND rev=? AND expires>?',
        )
        .get(f.artifact_id, s.conn, s.tenant, s.actor, s.revision, Date.now())
      if (!row || row.doc !== JSON.stringify(f)) denied('Staged asset unavailable')
    }
    return b
  }
  function reserve(s: Scope, b: Manifest, ex: string) {
    if (
      !db
        .prepare('INSERT OR IGNORE INTO issue_runs VALUES(?,?,?,?,?,?,?)')
        .run(s.conn, b.issue_id, s.tenant, s.actor, s.revision, ex, b.bundle_sha256).changes
    )
      throw new Refusal(409, 'Issue already reserved')
  }
  function inspect(s: Scope, issue: string) {
    const row = db
      .prepare(
        'SELECT execution,hash FROM issue_runs WHERE conn=? AND issue=? AND tenant=? AND actor=? AND rev=?',
      )
      .get(s.conn, issue, s.tenant, s.actor, s.revision)
    if (!row) throw new Refusal(404, 'Issue unavailable')
    return {
      issue_id: issue,
      approval_id: row.execution,
      bundle_sha256: row.hash,
      steps: db
        .prepare('SELECT name,state,details FROM issue_steps WHERE exec=? ORDER BY rowid')
        .all(row.execution)
        .map((r) => ({
          step_id: String(r.name).includes(':') ? r.name : 'file:' + r.name,
          state: r.state,
          ...JSON.parse(String(r.details)),
        })),
    }
  }
  async function sendFiles(
    s: Scope,
    b: Manifest,
    ex: string,
    token: string,
    send: typeof fetch,
    check: () => void,
  ) {
    const files = []
    let reason: string | null = null
    for (const f of b.files) {
      check()
      const asset = db
        .prepare('SELECT content FROM issue_assets WHERE id=? AND expires>?')
        .get(f.artifact_id, Date.now())
      if (!asset) {
        reason = 'asset_expired'
        break
      }
      const bytes = Buffer.from(open(String(asset.content), f.artifact_id), 'base64')
      if (digest(bytes) !== f.sha256) denied('Artifact changed')
      const form = new FormData()
      form.set('folderPath', s.folder + b.issue_id)
      form.set('fileName', f.file_name)
      form.set(
        'options',
        JSON.stringify({
          access: 'PUBLIC_NOT_INDEXABLE',
          overwrite: false,
          duplicateValidationStrategy: 'REJECT',
          duplicateValidationScope: 'EXACT_FOLDER',
        }),
      )
      form.set('file', new Blob([new Uint8Array(bytes)], { type: f.content_type }), f.file_name)
      db.prepare("INSERT INTO issue_steps VALUES(?,?,'claimed','{}')").run(ex, f.file_name)
      let state = 'confirmed',
        details: Record<string, string> = {}
      try {
        const res = await send('https://api.hubapi.com/files/v3/files', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token },
          body: form,
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
        })
        if (!res.ok) {
          await res.body?.cancel()
          if ([400, 401, 403, 404, 413, 415, 422, 429].includes(res.status)) state = 'refused'
          throw Error()
        }
        const reader = res.body!.getReader(),
          chunks: Buffer[] = []
        let size = 0
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.length
          if (size > 65536) {
            await reader.cancel()
            throw Error()
          }
          chunks.push(Buffer.from(part.value))
        }
        const { id, url } = JSON.parse(Buffer.concat(chunks).toString()),
          u = new URL(url)
        if (
          typeof id !== 'string' ||
          !/^\d{1,30}$/.test(id) ||
          typeof url !== 'string' ||
          url.length > 2048 ||
          /[^\x21-\x7e]|[<>"'\x60\\]/.test(url) ||
          u.protocol !== 'https:' ||
          u.username ||
          u.password ||
          u.port ||
          u.hash ||
          !/(^|\.)hubspotusercontent(?:\.(net|com)|-(na1|na2|eu1)\.net)$/.test(u.hostname)
        )
          throw Error()
        details = { id, url }
      } catch {
        if (state === 'confirmed') state = 'ambiguous'
        reason = state === 'refused' ? 'provider_refused' : 'outcome_unknown'
        details = { reason }
      }
      db.prepare('UPDATE issue_steps SET state=?,details=? WHERE exec=? AND name=?').run(
        state,
        JSON.stringify(details),
        ex,
        f.file_name,
      )
      files.push({ file_name: f.file_name, sha256: f.sha256, state, ...details })
      if (reason) break
    }
    const urls = new Map(
      files
        .filter((f) => 'url' in f)
        .map((f) => [f.file_name, String((f as Record<string, unknown>).url)]),
    )
    const templates: Record<string, unknown>[] = []
    let draft: Record<string, unknown> | null = null
    async function step(key: string, perform: () => Promise<Record<string, unknown>>) {
      check()
      db.prepare("INSERT INTO issue_steps VALUES(?,?,'claimed','{}')").run(ex, key)
      let result: Record<string, unknown>
      try {
        result = { ...(await perform()), state: 'confirmed' }
      } catch {
        reason = 'outcome_unknown'
        result = { state: 'ambiguous', reason }
      }
      db.prepare('UPDATE issue_steps SET state=?,details=? WHERE exec=? AND name=?').run(
        String(result.state),
        JSON.stringify(result),
        ex,
        key,
      )
      return result
    }
    for (const f of b.template_files) {
      if (reason) break
      templates.push(
        await step('template:' + digest(f.path), async () => {
          await writeTemplate(planTemplate(s, f, urls), token, send, check)
          return { path: f.path, environment: 'draft' }
        }),
      )
    }
    const update = b.update_draft
    if (!reason && update)
      draft = await step('draft:update', async () => {
        const id = resolveDraft(s, update.creation_execution_id)
        const req = buildRequest(
          'hubspot',
          'hubspot.newsletter.update_draft',
          substitute(update, urls),
          token,
        )
        req.url.pathname += '/' + id
        const confirm = async (res: Response) => {
          if (!res.ok) {
            await res.body?.cancel()
            throw Error('Draft unavailable')
          }
          const d = await res.json()
          if (
            String(d.id) !== id ||
            !['DRAFT', 'AUTOMATED_DRAFT'].includes(d.state) ||
            d.isPublished === true ||
            d.isTransactional === true ||
            !['BATCH_EMAIL', 'AUTOMATED_EMAIL'].includes(d.type)
          )
            throw Error('Draft state changed')
        }
        await confirm(
          await send(req.url, {
            headers: req.init.headers,
            signal: AbortSignal.timeout(15000),
            redirect: 'error',
          }),
        )
        check()
        await confirm(await send(req.url, req.init))
        return { remote_id: id, delivery_state: 'draft' }
      })
    return {
      issue_id: b.issue_id,
      bundle_sha256: b.bundle_sha256,
      state: reason ? 'partial' : 'complete',
      files,
      template_files: templates,
      draft,
      reason,
      not_started: b.files.slice(files.length).map((f) => f.file_name),
      approval_id: ex,
    }
  }
  return { stage, manifest, reserve, inspect, sendFiles }
}
