'use client'
import { TeamOverview } from './team-overview'
import { PrivateVault } from './private-vault'
import { HostDirectory } from './host-directory'
import { usePasskey } from './passkeys-client'
import { Authentication, ConsoleLogin, Profile } from './authentication'
import { WorkspaceSwitcher } from './workspace-switcher'
import { ProviderDirectory } from './provider-directory'
import { Appearance } from './appearance'
import { ItemPicker } from './item-picker'
import { VaultReader } from './vault-reader'
import { ActivityFeed } from './activity-feed'
import { usePathname } from 'next/navigation'
import { Consumption } from './consumption'
import { ApprovalPreview } from './approval-preview'
import { sealInput } from './intake'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  Vault,
  Menu,
  KeyRound,
  Blocks,
  Activity,
  Unplug,
  ShieldCheck,
  ArrowUpRight,
  Search,
  Plus,
  ChevronRight,
  Building2,
  LockKeyhole,
  LogOut,
  Layers,
  Command,
  X,
  Copy,
  Check,
  RefreshCw,
} from 'lucide-react'
import type { Provider } from '../packages/connectors'
type Connection = {
  private_source: boolean
  vault_item: { id: string; title: string } | null
  expires_at: number | null
  access_expires_at: number | null
  organization_expires_at?: number | null
  recipient_expiries: Record<string, number>
  source: string
  visibility: string
  manage: boolean
  recipients: string[]
  id: string
  provider: string
  label: string
  identity: string
  active: number
  revision: number
}
type Grant = {
  host_revoked?: number
  host?: string
  model: string | null
  id: string
  label: string
  connection_id: string
  active: number
  expires: number
  ops: string
  connected_at: number | null
}
type Approval = { id: string; actor: string; conn: string; op: string; preview: unknown }
type Workspace = {
  managed_hosts: boolean
  hosts: { id: string; label: string; expires: number; revoked: number; enrolled: number }[]
  requests: { id: string; label: string; host: string }[]
  version: string
  directory: { id: string; label: string }[]
  operation_stops: string[]
  provider_stops: string[]
  billing: { label: string; available: number; spent: number; held: number }[]
  items: { id: string; title: string; username: string; updated: number }[]
  tenant: string
  role: string
  paused: boolean
  apps: { id: string; label: string; audience: string; active: number }[]
  members: { id: string; label: string; role: string; active: number }[]
  workspaces: { id: string; label: string }[]
  providers: Record<string, Provider>
  connections: Connection[]
  grants: Grant[]
  approvals: Approval[]
  events: { action: string; subject: string; at: number; actor: string }[]
}
const tabs = [
  ['Team overview', Building2],
  ['Vault items', LockKeyhole],
  ['Private vault', LockKeyhole],
  ['Connections', Vault],
  ['Integrations', Blocks],
  ['Access grants', KeyRound],
  ['Approvals', ShieldCheck],
  ['Consumption', Activity],
  ['Activity', Activity],
  ['Workspace', Building2],
] as const
type Tab = (typeof tabs)[number][0]
const paths: Record<Tab, string> = {
  'Team overview': '/team',
  Connections: '/connections',
  Integrations: '/integrations',
  'Access grants': '/grants',
  Approvals: '/approvals',
  Consumption: '/consumption',
  Activity: '/activity',
  'Vault items': '/vault',
  'Private vault': '/private-vault',
  Workspace: '/workspace',
}
const stamp = (n: number) => new Date(n).toLocaleString()
async function request(path: string, body?: unknown, method = body ? 'POST' : 'GET'): Promise<any> {
  const send = (proof?: string) =>
    fetch('/api/' + path, {
      method,
      cache: 'no-store',
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(proof ? { 'OpenPassword-Approval': proof } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  let r = await send(),
    data = await r.json()
  if (r.status === 428 && data.approval) {
    const { id, options } = data.approval
    const response = await usePasskey(options)
    const a = await request('profile/passkeys/approve', { id, response })
    r = await send(a.proof)
    data = await r.json()
  }
  if (!r.ok) throw Object.assign(Error(data.detail || 'Request failed'), { status: r.status })
  return data
}
function ExpiryField({
  label,
  name,
  initial,
}: {
  label: string
  name: string
  initial?: number | null
}) {
  const format = (value: number) => new Date(value).toISOString().slice(0, -1)
  const [value, setValue] = useState(initial ? format(initial) : '')
  return (
    <div>
      <label>
        {label} (UTC, optional)
        <input
          type="datetime-local"
          step="any"
          name={name}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <button type="button" onClick={() => setValue(format(Date.now() + 7 * 86400000))}>
        In 7 days
      </button>
      {value && (
        <button type="button" onClick={() => setValue('')}>
          No expiry
        </button>
      )}
    </div>
  )
}
function Brand() {
  return (
    <div className="brand">
      <span>
        <Vault size={26} />
      </span>
      OpenPassword
    </div>
  )
}
export default function Page() {
  const pathname = usePathname()
  const [navigation, setNavigation] = useState(false)
  const [w, W] = useState<Workspace | null>(null)
  const tab =
    pathname === '/' ||
    pathname.startsWith('/vault/') ||
    (pathname === '/team' && w && w.role !== 'owner')
      ? 'Vault items'
      : (tabs.find(([t]) => paths[t] === pathname)?.[0] ??
        (pathname === '/device'
          ? 'Access grants'
          : pathname.startsWith('/approvals/')
            ? 'Approvals'
            : 'Connections'))
  const [busy, B] = useState(false),
    [err, E] = useState(''),
    [q, Q] = useState(''),
    [modal, M] = useState(''),
    [selected, S] = useState(''),
    [grantId, G] = useState(''),
    [tokens, K] = useState(''),
    [checked, C] = useState<string[]>([]),
    [copied, CP] = useState(false)
  const [sourceItem, setSourceItem] = useState<{ id: string; title: string } | null>(null)
  const dialog = useRef<HTMLDialogElement>(null),
    search = useRef<HTMLInputElement>(null)
  const [revision, R] = useState(0)
  async function load() {
    const data = await request('admin/workspace?items=paged')
    W(data)
    R((r) => r + 1)
    return data as Workspace
  }
  useEffect(() => {
    load()
      .then((data) => {
        if (data.role === 'owner' && location.pathname === '/' && !location.search)
          history.replaceState(null, '', '/team')
      })
      .catch((e) => {
        if (e.status !== 401) E(e.message)
      })
    if (new URLSearchParams(location.search).has('signin')) {
      history.replaceState(null, '', '/workspace' + location.search)
      if (location.search.includes('signin=failed'))
        E('Social sign-in failed. Check the callback URL and try linking again.')
    }
  }, [])
  useEffect(() => {
    if (w && location.hash) {
      const target = document.getElementById(location.hash.slice(1))
      target?.focus()
      target?.scrollIntoView({ block: 'center' })
    }
  }, [w, pathname])
  useEffect(() => {
    if (modal) dialog.current?.showModal()
    else dialog.current?.close()
  }, [modal])
  useEffect(() => {
    const locked = (e: StorageEvent) => {
      if (e.key === 'openpassword.lock') {
        W(null)
        close()
      }
    }
    window.addEventListener('storage', locked)
    function key(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        search.current?.focus()
      }
    }
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener('storage', locked)
    }
  }, [])
  function close() {
    M('')
    K('')
    E('')
    CP(false)
  }
  async function work(f: () => Promise<void>) {
    if (busy) return
    B(true)
    E('')
    try {
      await f()
    } catch (e) {
      E((e as Error).message)
      if ((e as { status?: number }).status === 401) W(null)
    } finally {
      B(false)
    }
  }
  function go(t: Tab) {
    history.pushState(null, '', paths[t])
    Q('')
    E('')
  }
  function show(m: string, id = '') {
    setSourceItem(null)
    S(id)
    E('')
    K('')
    C([])
    G(
      w?.connections.find(
        (c) => c.active && (!c.access_expires_at || c.access_expires_at > Date.now()),
      )?.id || '',
    )
    M(m)
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const f = Object.fromEntries(form)
    const expiry = (key: string) => (form.get(key) ? Date.parse(String(form.get(key)) + 'Z') : null)
    await work(async () => {
      if (!w) return
      let sealed: Awaited<ReturnType<typeof sealInput>> | undefined
      if (['oauth', 'connection', 'rotate'].includes(modal) && !(modal !== 'oauth' && sourceItem)) {
        const field = modal === 'oauth' ? 'client_secret' : 'secret'
        sealed = await sealInput(String(f[field]), await request('admin/intake', {}))
        delete f[field]
      }
      if (modal === 'oauth') {
        if (selected === 'notion') {
          const a = await request('admin/oauth/notion', {
            label: f.label,
            ownership: f.ownership,
            expires_at: expiry('expires_at'),
            client_id: f.client_id,
            sealed,
          })
          location.assign(a.url)
          return
        }
        const data = await request('admin/oauth/google', {
          ...f,
          expires_at: expiry('expires_at'),
          ...(sourceItem ? { vault_item_id: sourceItem.id } : { sealed }),
          resources: String(f.resources || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        })
        location.assign(data.url)
        return
      }
      if (modal === 'app') {
        const a = await request('admin/apps', {
          label: f.label,
          callback: f.callback,
          audience: f.audience,
          days: Number(f.days),
          classes: form.getAll('classes'),
          member_write_allowed: f.member_write_allowed === 'on',
        })
        if (a.check_credential) {
          K(a.check_credential)
          await load()
          return
        }
      }
      if (modal === 'item') await request('admin/items', f)
      if (modal === 'deleteItem') {
        await request('admin/items/' + selected, undefined, 'DELETE')
        go('Vault items')
      }
      if (modal === 'member') {
        const a = await request('admin/members', { label: f.label, role: f.role })
        K(a.token)
        await load()
        return
      }
      if (modal === 'connection')
        await request('admin/connections', {
          ...f,
          expires_at: expiry('expires_at'),
          ...(sourceItem ? { vault_item_id: sourceItem.id } : { sealed }),
          resources: String(f.resources || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          provider: selected,
        })
      if (modal === 'sharing')
        await request('admin/connections/' + selected + '/sharing', {
          label: f.label,
          visibility: f.visibility,
          recipients: form.getAll('recipients'),
          expires_at: expiry('expires_at'),
          organization_expires_at: expiry('organization_expires_at'),
          recipient_expiries: Object.fromEntries(
            form.getAll('recipients').map((id) => [id, expiry('expires/' + id)]),
          ),
        })
      if (modal === 'rotate')
        await request(
          'admin/connections/' + selected + '/rotate',
          sourceItem ? { vault_item_id: sourceItem.id } : { sealed },
        )
      if (modal === 'revoke')
        await request(
          'admin/' +
            (tab === 'Workspace' || tab === 'Team overview'
              ? 'members'
              : tab === 'Access grants'
                ? 'grants'
                : 'connections') +
            '/' +
            selected,
          undefined,
          'DELETE',
        )
      if (modal === 'workspace') {
        const a = await request('admin/workspaces', { label: f.label })
        await request('admin/switch', a)
      }
      if (modal === 'grant') {
        if (
          f.budget &&
          (!f.model || !f.input_rate || !f.output_rate || !f.price_date || !f.price_source)
        )
          throw Error(
            'Enter the model, both rates, pricing date and pricing source for this budget.',
          )
        const a = await request('admin/grants', {
          host_request: f.host_request || undefined,
          connection_id: grantId,
          operations: checked,
          label: f.label,
          hours: Number(f.hours),
          enrollment: f.delivery === 'enroll' && !f.user_code,
          ...(f.user_code ? { user_code: f.user_code } : {}),
          ...(f.draft_limit ? { draft_limit: Number(f.draft_limit) } : {}),
          ...(f.model
            ? {
                model_lease: {
                  model: f.model,
                  calls: Number(f.calls),
                  max_tokens: Number(f.max_tokens),
                  ...(f.budget
                    ? {
                        tariff: {
                          budget_micro_usd: Number(f.budget),
                          input: Number(f.input_rate),
                          output: Number(f.output_rate),
                          source: f.price_source,
                          as_of: f.price_date,
                        },
                      }
                    : {}),
                },
              }
            : {}),
        })
        if (a.enrollment_token || a.access_token) {
          S(a.device_id)
          K(a.enrollment_token || JSON.stringify(a, null, 2))
          await load()
          return
        }
      }
      await load()
      close()
    })
  }
  const error = err && (
    <p role="alert" className="error">
      {err}
    </p>
  )
  if (!w)
    return (
      <main className="login">
        <section className="loginArt">
          <Brand />
          <div className="plate" aria-hidden="true">
            <div className="spindle">
              <Vault strokeWidth={0.9} />
            </div>
          </div>
          <div className="loginFoot">
            <LockKeyhole size={16} /> Credential vault
          </div>
        </section>
        <div className="loginPane">
          <Appearance />
          <ConsoleLogin
            request={request}
            done={async (setup) => {
              const data = await load()
              if (setup || (data.role === 'owner' && pathname === '/')) go('Team overview')
            }}
          />
          {error}
        </div>
      </main>
    )
  const active = w.connections.filter(
      (c) => c.active && (!c.access_expires_at || c.access_expires_at > Date.now()),
    ),
    name = w.workspaces.find((x) => x.id === w.tenant)?.label,
    selectedConnection = w.connections.find((x) => x.id === grantId)
  const includes = (...values: string[]) => values.join(' ').toLowerCase().includes(q.toLowerCase())
  const list = w.connections.filter((c) =>
    includes(c.label, c.identity, w.providers[c.provider].name, c.vault_item?.title || ''),
  )
  const btn = (text: string, fn: () => void) => (
    <button type="button" onClick={fn}>
      {text}
    </button>
  )
  const grantState = (g: Grant) =>
    !g.active
      ? 'Revoked'
      : g.expires <= Date.now()
        ? 'Expired'
        : g.host_revoked
          ? 'Host revoked'
          : w.managed_hosts && !g.host
            ? 'Host enrollment required'
            : 'Active'
  const agentLinks = (c: Connection) => {
    const grants = w.grants.filter((g) => g.connection_id === c.id)
    return (
      <div className="agentLinks">
        <strong>Agent grants visible to you</strong>
        {grants.length ? (
          <ul>
            {grants.map((g) => (
              <li key={g.id}>
                <a href={'/grants#' + g.id}>{g.label}</a>
                <small>
                  {grantState(g)} · expires {stamp(g.expires)}
                </small>
              </li>
            ))}
          </ul>
        ) : (
          <small>No visible grants.</small>
        )}
      </div>
    )
  }
  const startGrant = (c: Connection) => {
    show('grant')
    G(c.id)
  }
  const creation =
    w.role === 'viewer' && tab === 'Vault items'
      ? null
      : tab === 'Vault items'
        ? (['Add item', () => show('item')] as const)
        : tab === 'Connections'
          ? (['Add connection', () => show('connection', Object.keys(w.providers)[0])] as const)
          : tab === 'Access grants'
            ? (['Issue grant', () => show('grant')] as const)
            : null
  return (
    <div className="shell">
      <aside data-navigation={navigation ? 'open' : 'closed'}>
        <Brand />
        <button
          className="mobileNavToggle"
          aria-expanded={navigation}
          aria-controls="workspace-nav"
          onClick={() => setNavigation(!navigation)}
        >
          {navigation ? <X size={16} /> : <Menu size={16} />}Menu
        </button>
        <WorkspaceSwitcher
          current={w.tenant}
          spaces={w.workspaces}
          canCreate={w.role === 'owner'}
          create={() => show('workspace')}
          change={(id) =>
            void work(async () => {
              await request('admin/switch', { id })
              await load()
              if (pathname.startsWith('/vault/')) go('Vault items')
            })
          }
        />
        <nav id="workspace-nav" aria-label="Workspace navigation">
          {tabs
            .filter(([t]) => t !== 'Team overview' || w.role === 'owner')
            .map(([t, Icon]) => (
              <a href={paths[t]} key={t} aria-current={t === tab ? 'page' : undefined}>
                <Icon size={18} />
                {t}
                {t === 'Approvals' && w.approvals.length > 0 && <b>{w.approvals.length}</b>}
              </a>
            ))}
        </nav>
        <div className="version">
          OpenPassword <code>v{w.version}</code>
        </div>
        <a className="sourceLink" href="/v1/openapi.json">
          HTTP API reference
        </a>
        <a className="sourceLink" href="/openpassword-source.tar.gz" download>
          Download source
        </a>
        <button
          className="signout"
          onClick={() =>
            work(async () => {
              await request('admin/logout', {})
              try {
                localStorage.setItem('openpassword.lock', String(Date.now()))
              } catch {}
              W(null)
              close()
            })
          }
        >
          <LogOut size={16} /> Lock workspace
        </button>
      </aside>
      <main className="desk" data-section={tab}>
        <header>
          <span>
            {name} <ChevronRight size={14} /> {tab}
          </span>
          <div className="headActions">
            <Appearance />
            <button
              aria-label="Refresh workspace"
              disabled={busy}
              onClick={() =>
                work(async () => {
                  await load()
                })
              }
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </header>
        <div className="canvas">
          {tab === 'Team overview' ? (
            <TeamOverview
              key={w.tenant}
              name={name || w.tenant}
              members={w.members}
              revision={revision}
              request={request}
              open={show}
            />
          ) : tab === 'Private vault' ? (
            <PrivateVault key={w.tenant} providers={w.providers} request={request} />
          ) : tab === 'Vault items' ? (
            <>
              {error && !modal && error}
              <VaultReader
                key={w.tenant}
                path={pathname}
                workspace={name || w.tenant}
                role={w.role}
                revision={revision}
                request={request}
                open={show}
                relationships={(item) => {
                  const linked = w.connections.filter((c) => c.vault_item?.id === item.id)
                  return (
                    <div className="accessMap">
                      <h2>Agent access</h2>
                      {linked.length ? (
                        linked.map((c) => (
                          <div key={c.id}>
                            <a href={'/connections#' + c.id}>{c.label}</a>
                            <small>{w.providers[c.provider].name} connection</small>
                            {agentLinks(c)}
                          </div>
                        ))
                      ) : (
                        <p>No visible provider connections use this item.</p>
                      )}
                      {w.role !== 'viewer' && (
                        <button
                          onClick={() => {
                            show('connection', Object.keys(w.providers)[0])
                            setSourceItem(item)
                          }}
                        >
                          Use for a provider connection
                        </button>
                      )}
                    </div>
                  )
                }}
              />
            </>
          ) : (
            <>
              <div className="heading">
                <div>
                  <h1>{tab}</h1>
                  <p>
                    {
                      {
                        Consumption: 'Review API requests, billed units and estimated spend.',
                        Connections: 'Manage the accounts your people and agents can use.',
                        Integrations:
                          'Explore providers and the operations each connection supports.',
                        'Access grants':
                          'Give an agent access to specific operations on one account.',
                        Approvals: 'Review the exact request before a provider write.',
                        'Vault items': 'Store shared passwords and secure notes.',
                        Workspace: 'Manage workspace access and provider dispatch.',
                        Activity: 'Inspect recent access decisions and provider activity.',
                      }[tab]
                    }
                  </p>
                </div>
                {creation && (
                  <button
                    className="primary"
                    disabled={busy || (tab === 'Access grants' && !active.length)}
                    onClick={creation[1]}
                  >
                    <Plus size={17} />
                    {creation[0]}
                  </button>
                )}
              </div>
              {error && !modal && error}
              {tab === 'Connections' && (
                <div className="metrics">
                  {[
                    [Vault, 'Active connections', active.length],
                    [
                      KeyRound,
                      'Active grants',
                      w.grants.filter((x) => grantState(x) === 'Active').length,
                    ],
                    [ShieldCheck, 'Awaiting approval', w.approvals.length],
                  ].map(([I, label, n]) => {
                    const Icon = I as typeof Vault
                    return (
                      <div key={String(label)}>
                        <Icon size={19} />
                        <span>{String(label)}</span>
                        <strong>{String(n)}</strong>
                      </div>
                    )
                  })}
                </div>
              )}
              <section className="panel">
                <div className="toolbar">
                  <h2>
                    {tab === 'Connections'
                      ? 'Credential vault'
                      : tab === 'Integrations'
                        ? 'Provider directory'
                        : tab === 'Access grants'
                          ? 'Agent access'
                          : tab === 'Approvals'
                            ? 'Review queue'
                            : tab === 'Workspace'
                              ? 'Workspace settings'
                              : tab === 'Consumption'
                                ? 'Usage report'
                                : 'Recent events'}
                  </h2>
                  {tab !== 'Consumption' && (
                    <label className="search">
                      <Search size={15} />
                      <input
                        ref={search}
                        aria-label={'Search ' + tab}
                        value={q}
                        onChange={(e) => Q(e.target.value)}
                        placeholder="Search…"
                      />
                      <Command size={12} />K
                    </label>
                  )}
                </div>
                {tab === 'Consumption' && <Consumption key={w.tenant} request={request} />}
                {tab === 'Connections' &&
                  (list.length ? (
                    list.map((c) => (
                      <article key={c.id} id={c.id} tabIndex={-1}>
                        <div className="mark">
                          <Layers />
                        </div>
                        <div className="grow">
                          <strong>{c.label}</strong>
                          <small>
                            {w.providers[c.provider].name} · {c.source}
                            {c.access_expires_at && ' · Access ends ' + stamp(c.access_expires_at)}
                            {c.identity && ' · ' + c.identity}
                            {c.manage &&
                              ' · ' +
                                {
                                  private: 'Only you',
                                  specific: 'Specific people',
                                  organization: 'Whole organization',
                                }[c.visibility]}
                          </small>
                          <details
                            className="connectionAccess"
                            open={
                              (typeof window !== 'undefined' && location.hash === '#' + c.id) ||
                              undefined
                            }
                          >
                            <summary>Credential and agent access</summary>
                            <small>Credential source</small>
                            {c.vault_item ? (
                              <a href={'/vault/' + c.vault_item.id}>{c.vault_item.title}</a>
                            ) : c.private_source ? (
                              <a href="/private-vault">Copy delegated from your private vault</a>
                            ) : (
                              <span>Stored on this provider connection</span>
                            )}
                            {agentLinks(c)}
                            {active.some((x) => x.id === c.id) && (
                              <button onClick={() => startGrant(c)}>Give an agent access</button>
                            )}
                          </details>
                        </div>
                        <span className={'pill ' + (c.active ? 'ok' : '')}>
                          {!c.active
                            ? 'Revoked'
                            : c.access_expires_at && c.access_expires_at <= Date.now()
                              ? 'Expired'
                              : 'Active'}
                        </span>
                        {!!c.active && c.manage && (
                          <div className="actions">
                            {btn('Edit access', () => show('sharing', c.id))}
                            {btn('Rotate', () => show('rotate', c.id))}
                            <details className="dangerMenu">
                              <summary>More actions</summary>
                              {btn('Revoke', () => show('revoke', c.id))}
                            </details>
                          </div>
                        )}
                      </article>
                    ))
                  ) : (
                    <div className="empty">
                      <Vault />
                      <h3>{q ? 'No matching connections' : 'Your vault is ready'}</h3>
                      <p>
                        {q
                          ? 'Try a provider or account name.'
                          : 'Add a provider account, then grant access to the operations an agent needs.'}
                      </p>
                      {!q && btn('Browse integrations', () => go('Integrations'))}
                    </div>
                  ))}
                {tab === 'Integrations' && (
                  <ProviderDirectory
                    providers={w.providers}
                    query={q}
                    open={(id) => show('provider', id)}
                  />
                )}
                {tab === 'Access grants' &&
                  (w.grants.length ? (
                    w.grants
                      .filter((g) => {
                        const connection = w.connections.find((c) => c.id === g.connection_id)
                        return includes(
                          g.label,
                          g.id,
                          g.model || '',
                          g.ops,
                          connection?.label || '',
                          connection?.vault_item?.title || '',
                        )
                      })
                      .map((g) => (
                        <article key={g.id} id={g.id} tabIndex={-1}>
                          <KeyRound />
                          <div className="grow">
                            <strong>{g.label}</strong>
                            <small>
                              {g.host || 'Standalone grant'} · {grantState(g)} · Expires{' '}
                              {stamp(g.expires)}
                            </small>
                            {(() => {
                              const c = w.connections.find((c) => c.id === g.connection_id)
                              return c ? (
                                <div className="grantPath">
                                  <span>
                                    Provider connection{' '}
                                    <a href={'/connections#' + c.id}>{c.label}</a>
                                  </span>
                                  <span>
                                    Credential source{' '}
                                    {c.vault_item ? (
                                      <a href={'/vault/' + c.vault_item.id}>{c.vault_item.title}</a>
                                    ) : c.private_source ? (
                                      <a href="/private-vault">
                                        Copy delegated from your private vault
                                      </a>
                                    ) : (
                                      'Stored on connection'
                                    )}
                                  </span>
                                </div>
                              ) : (
                                <small>Connection unavailable</small>
                              )
                            })()}
                            <small>
                              Allowed operations · {JSON.parse(g.ops).join(', ')}
                              {g.model && ' · Model ' + g.model}
                            </small>
                            {g.connected_at && (
                              <small>Client connected {stamp(g.connected_at)}</small>
                            )}
                            <small>
                              Grant ID · <code>{g.id}</code>
                            </small>
                          </div>
                          {g.active && g.expires > Date.now()
                            ? btn('Revoke', () => show('revoke', g.id))
                            : null}
                        </article>
                      ))
                  ) : (
                    <div className="empty">
                      <KeyRound />
                      <h3>No grants issued</h3>
                      <p>
                        {active.length
                          ? 'Issue a grant to pair an agent or generate scoped credentials.'
                          : 'Add a connection to issue your first grant.'}
                      </p>
                    </div>
                  ))}
                {tab === 'Approvals' &&
                  (w.approvals.length ? (
                    w.approvals
                      .filter((a) => includes(a.op, a.id))
                      .map((a) => (
                        <article key={a.id}>
                          <div className="grow">
                            <strong>{a.op}</strong>
                            <small>
                              {w.grants.find((g) => g.id === a.actor)?.label} →{' '}
                              {w.connections.find((c) => c.id === a.conn)?.label}
                            </small>
                            <ApprovalPreview value={a.preview} />
                            <div className="actions">
                              {[true, false].map((approve) => (
                                <button
                                  key={String(approve)}
                                  disabled={busy}
                                  onClick={() =>
                                    work(async () => {
                                      await request('admin/approvals/' + a.id, {
                                        approve,
                                        ...(a.op === 'loops.contacts.import_chunk'
                                          ? {
                                              shown_manifest_sha256: (
                                                a.preview as { manifest_sha256: string }
                                              ).manifest_sha256,
                                            }
                                          : {}),
                                      })
                                      await load()
                                    })
                                  }
                                >
                                  {approve ? 'Approve request' : 'Deny'}
                                </button>
                              ))}
                            </div>
                          </div>
                        </article>
                      ))
                  ) : (
                    <div className="empty">
                      <ShieldCheck />
                      <h3>No pending requests</h3>
                      <p>Provider writes appear here before execution.</p>
                    </div>
                  ))}
                {tab === 'Workspace' && (
                  <>
                    <Profile request={request} />
                    {w.role === 'owner' && (
                      <HostDirectory
                        key={w.tenant}
                        hosts={w.hosts}
                        request={request}
                        reload={load}
                      />
                    )}
                    {w.role === 'owner' && <Authentication request={request} />}
                    {w.billing.map((b, i) => (
                      <article key={i}>
                        <div className="grow">
                          <strong>{b.label} · Model budget</strong>
                          <small>
                            {b.spent} spent · {b.held} reserved · {b.available} available
                            (micro-USD)
                          </small>
                        </div>
                      </article>
                    ))}
                    <article>
                      <ShieldCheck />
                      <div className="grow">
                        <strong>Provider dispatch</strong>
                        <small>
                          {w.paused ? 'Paused' : 'Running'} · Applies to all workspace agents
                        </small>
                      </div>
                      {w.role === 'owner' &&
                        btn(w.paused ? 'Resume dispatch' : 'Pause dispatch', () =>
                          work(async () => {
                            await request('admin/dispatch', { paused: !w.paused })
                            await load()
                          }),
                        )}
                    </article>
                    {w.role === 'owner' && (
                      <>
                        <details>
                          <summary>Provider dispatch controls</summary>
                          {Object.entries(w.providers).map(([p, v]) => (
                            <div key={p}>
                              <article>
                                <div className="grow">
                                  <strong>{v.name}</strong>
                                  <small>
                                    {w.provider_stops.includes(p) ? 'Paused' : 'Running'}
                                  </small>
                                </div>
                                {btn(w.provider_stops.includes(p) ? 'Resume' : 'Pause', () =>
                                  work(async () => {
                                    await request('admin/dispatch/' + p, {
                                      paused: !w.provider_stops.includes(p),
                                    })
                                    await load()
                                  }),
                                )}
                              </article>
                              <details>
                                <summary>{v.name} operations</summary>
                                {v.actions.map((a) => (
                                  <article key={a.id}>
                                    <strong className="grow">{a.id}</strong>
                                    {btn(
                                      w.operation_stops.includes(a.id) ? 'Resume' : 'Pause',
                                      () =>
                                        work(async () => {
                                          await request('admin/dispatch/' + p + '/' + a.id, {
                                            paused: !w.operation_stops.includes(a.id),
                                          })
                                          await load()
                                        }),
                                    )}
                                  </article>
                                ))}
                              </details>
                            </div>
                          ))}
                        </details>
                        <article>
                          <Building2 />
                          <div className="grow">
                            <strong>Team members</strong>
                            <small>
                              Editors manage connections and grants. Viewers can inspect inventory
                              and audit events.
                            </small>
                          </div>
                          {btn('Add member', () => show('member'))}
                        </article>
                        <article>
                          <div className="grow">
                            <strong>Identity applications</strong>
                            <small>
                              Allow an application to request a signed workspace identity.
                            </small>
                          </div>
                          {btn('Register app', () => show('app'))}
                        </article>
                        {w.apps
                          .filter((a) => includes(a.label, a.audience))
                          .map((a) => (
                            <article key={a.id}>
                              <div className="grow">
                                <strong>{a.label}</strong>
                                <small>
                                  {a.id} · {a.audience}
                                </small>
                              </div>
                              {btn(a.active ? 'Suspend' : 'Activate', () =>
                                work(async () => {
                                  await request('admin/apps/' + a.id, { active: !a.active })
                                  await load()
                                }),
                              )}
                            </article>
                          ))}
                        {w.members
                          .filter((m) => includes(m.label, m.role))
                          .map((m) => (
                            <article key={m.id}>
                              <div className="grow">
                                <strong>{m.label}</strong>
                                <small>{m.role}</small>
                              </div>
                              {m.active ? btn('Revoke', () => show('revoke', m.id)) : 'Revoked'}
                            </article>
                          ))}
                      </>
                    )}
                  </>
                )}
                {tab === 'Activity' && <ActivityFeed key={w.tenant} query={q} />}
              </section>
            </>
          )}
        </div>
      </main>
      <dialog ref={dialog} onCancel={close} aria-labelledby="dialog-title">
        <div className="dialogHead">
          <h2 id="dialog-title">
            {
              (
                {
                  item: 'Add vault item',
                  deleteItem: 'Delete vault item',
                  app: 'Register identity application',
                  member: tokens ? 'Member access token' : 'Add workspace member',
                  oauth:
                    selected === 'notion'
                      ? 'Connect Notion with OAuth'
                      : 'Connect Google with OAuth',
                  connection: 'Add connection',
                  provider: w.providers[selected]?.name,
                  sharing: 'Edit access',
                  rotate: 'Rotate credential',
                  revoke: 'Revoke access',
                  grant: tokens ? 'Agent credentials' : 'Issue access grant',
                  workspace: 'New workspace',
                } as Record<string, string>
              )[modal]
            }
          </h2>
          <button aria-label="Close dialog" onClick={close}>
            <X size={18} />
          </button>
        </div>
        {modal === 'provider' ? (
          <>
            <p>{w.providers[selected]?.group}</p>
            <ul>
              {w.providers[selected]?.actions.map((a) => (
                <li key={a.id}>
                  <code>{a.id}</code>
                  <small>{a.method === 'GET' ? 'Read' : 'Approval required'}</small>
                </li>
              ))}
            </ul>
            {
              <button className="primary" onClick={() => M('connection')}>
                Connect account <ArrowUpRight size={16} />
              </button>
            }
          </>
        ) : tokens ? (
          <>
            {modal === 'grant' &&
              (() => {
                const issued = w.grants.find((g) => g.id === selected)
                if (!issued) return null
                const connection = w.connections.find((c) => c.id === issued.connection_id)
                return (
                  <section className="itemPicker">
                    <strong>
                      {issued.label} can use {connection?.label || 'the provider connection'}
                    </strong>
                    <span>
                      {JSON.parse(issued.ops).join(', ')}
                      {issued.model && ' · ' + issued.model}
                    </span>
                    <span>Grant expires {stamp(issued.expires)}</span>
                    <a href={'/grants#' + issued.id} onClick={close}>
                      View or revoke grant
                    </a>
                  </section>
                )
              })()}
            <p>
              {modal === 'member'
                ? 'Send the sign-in address and token through a private channel. The token grants workspace access until you revoke the member.'
                : modal === 'app'
                  ? 'Copy the action-check credential now and provide it to the registered application.'
                  : modal === 'grant' && !tokens.startsWith('{')
                    ? 'On the client machine, set OPENPASSWORD_BROKER to this server, run openpassword connect and paste this single-use token. It expires within 10 minutes.'
                    : 'Copy these credentials now. The access token expires in 15 minutes or when the grant ends.'}
            </p>
            {modal === 'grant' && !tokens.startsWith('{') && (
              <>
                <a href="/openpassword-cli.cjs" download="openpassword">
                  Download CLI (Node.js 24+)
                </a>
                <pre>{`export OPENPASSWORD_BROKER=${location.origin}\nopenpassword connect`}</pre>
              </>
            )}
            {modal === 'member' ? (
              <>
                <label>
                  Member sign-in address
                  <input readOnly value={location.origin + '/?member=1'} />
                </label>
                <label>
                  Member access token
                  <input readOnly type="password" value={tokens} autoComplete="off" />
                </label>
              </>
            ) : (
              <pre>{tokens}</pre>
            )}
            <button
              onClick={() =>
                work(async () => {
                  await navigator.clipboard.writeText(tokens)
                  CP(true)
                })
              }
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}{' '}
              {copied ? 'Copied' : modal === 'member' ? 'Copy member token' : 'Copy credentials'}
            </button>
          </>
        ) : (
          <form onSubmit={submit}>
            {modal === 'connection' && (
              <>
                <label>
                  Provider
                  <select value={selected} onChange={(e) => S(e.target.value)}>
                    {Object.entries(w.providers).map(([id, p]) => (
                      <option key={id} value={id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Connection name
                  <input name="label" required placeholder="Editorial account" />
                </label>
                <label>
                  Account identity
                  <input name="external_identity" required placeholder="team@example.com" />
                </label>
              </>
            )}
            {modal === 'connection' &&
              [
                'google_workspace',
                'google_sheets',
                'supabase_data',
                'revolut',
                'loops',
                'hubspot',
              ].includes(selected) && (
                <label>
                  {selected === 'google_workspace'
                    ? 'Authorized Gmail label IDs'
                    : selected === 'google_sheets'
                      ? 'Authorized spreadsheet IDs'
                      : selected === 'revolut'
                        ? 'Authorized Revolut account IDs'
                        : selected === 'hubspot'
                          ? 'Authorized template directories (end each with /)'
                          : selected === 'loops'
                            ? 'Authorized Loops list IDs'
                            : 'Authorized database tables'}{' '}
                  (comma-separated)
                  <input name="resources" placeholder="INBOX, Label_123" />
                </label>
              )}
            {modal === 'connection' &&
              !sourceItem &&
              selected === 'google_workspace' &&
              btn('Sign in with Google instead', () => M('oauth'))}
            {modal === 'connection' &&
              !sourceItem &&
              selected === 'notion' &&
              btn('Authorize with Notion', () => M('oauth'))}
            {modal === 'oauth' && (
              <>
                <p>Register this redirect URI in your OAuth client settings.</p>
                <code>
                  {location.origin}/api/oauth/{selected === 'notion' ? 'notion' : 'google'}/callback
                </code>
                <label>
                  Connection name
                  <input name="label" required />
                </label>
                <label>
                  Client ID
                  <input name="client_id" required />
                </label>
                <label>
                  Client secret
                  <input name="client_secret" type="password" required />
                </label>
                {selected !== 'notion' && (
                  <>
                    <label>
                      Authorized Gmail label IDs (optional)
                      <input name="resources" />
                    </label>
                    <label>
                      Access scope
                      <select name="scope">
                        {[
                          'drive.readonly',
                          'drive.file',
                          'documents',
                          'presentations',
                          'calendar.events',
                          'gmail.readonly',
                          'spreadsheets',
                          'calendar.readonly',
                          'youtube.readonly',
                          'youtube.upload',
                        ].map((v) => (
                          <option key={v} value={'https://www.googleapis.com/auth/' + v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
              </>
            )}
            {['connection', 'oauth'].includes(modal) && (
              <label>
                Credential owner
                <select
                  name="ownership"
                  defaultValue={w.role === 'owner' ? 'organization' : 'personal'}
                >
                  <option value="personal">Me · private until shared</option>
                  {w.role === 'owner' && (
                    <option value="organization">Organization · everyone in this workspace</option>
                  )}
                </select>
              </label>
            )}
            {['connection', 'oauth'].includes(modal) && (
              <ExpiryField label="Credential expiry" name="expires_at" />
            )}
            {modal === 'sharing' &&
              (() => {
                const c = w.connections.find((x) => x.id === selected)!
                return (
                  <>
                    <label>
                      Connection name
                      <input name="label" defaultValue={c.label} required />
                    </label>
                    <label>
                      Who can use this credential?
                      <select name="visibility" defaultValue={c.visibility}>
                        {c.source !== 'Organization' && (
                          <>
                            <option value="private">Only me</option>
                            <option value="specific">Specific people</option>
                          </>
                        )}
                        <option value="organization">Whole organization</option>
                      </select>
                    </label>
                    <ExpiryField
                      label="Credential expiry"
                      name="expires_at"
                      initial={c.expires_at}
                    />
                    <ExpiryField
                      label="Whole-organization sharing expiry"
                      name="organization_expires_at"
                      initial={c.organization_expires_at}
                    />
                    {c.source !== 'Organization' && (
                      <fieldset>
                        <legend>People with access when “Specific people” is selected</legend>
                        {w.directory.map((m) => (
                          <div key={m.id}>
                            <label>
                              <input
                                type="checkbox"
                                name="recipients"
                                value={m.id}
                                defaultChecked={c.recipients.includes(m.id)}
                              />
                              {m.label}
                            </label>
                            <ExpiryField
                              label={m.label + ' sharing expiry'}
                              name={'expires/' + m.id}
                              initial={c.recipient_expiries[m.id]}
                            />
                          </div>
                        ))}
                      </fieldset>
                    )}
                  </>
                )
              })()}
            {['connection', 'rotate'].includes(modal) && w.role !== 'viewer' && (
              <ItemPicker request={request} selected={sourceItem} select={setSourceItem} />
            )}
            {modal === 'rotate' && <p>Existing grants will use the replacement credential.</p>}
            {['connection', 'rotate'].includes(modal) && !sourceItem && (
              <label>
                {selected === 'supabase_data'
                  ? 'Credential JSON with project and key'
                  : selected === 'twilio'
                    ? 'Account SID and auth token (SID:token)'
                    : 'Provider credential'}
                <input type="password" autoComplete="new-password" name="secret" required />
              </label>
            )}
            {modal === 'revoke' && (
              <p>
                Revoke access for{' '}
                <strong>
                  {w.connections.find((c) => c.id === selected)?.label ||
                    w.grants.find((g) => g.id === selected)?.label ||
                    w.members.find((m) => m.id === selected)?.label}
                </strong>
                ? New calls using this access will be refused.
              </p>
            )}
            {modal === 'deleteItem' && <p>Delete this vault item from the workspace?</p>}
            {modal === 'item' && (
              <>
                <p>
                  This item is stored in the shared workspace vault. For a credential only you can
                  unlock, use <a href="/private-vault">your private vault</a>.
                </p>
                <label>
                  Item title
                  <input name="title" required />
                </label>
                <label>
                  Username (optional)
                  <input name="username" />
                </label>
                <label>
                  Password or secure note
                  <textarea name="value" required autoComplete="off" />
                </label>
              </>
            )}
            {modal === 'app' && (
              <>
                <label>
                  Application name
                  <input name="label" required />
                </label>
                <label>
                  HTTPS callback URL
                  <input name="callback" type="url" required />
                </label>
                <label>
                  Audience
                  <input name="audience" required placeholder="app.example.com" />
                </label>
                <label>
                  Registration duration (days)
                  <input name="days" type="number" min="1" max="365" defaultValue="30" required />
                </label>
              </>
            )}
            {modal === 'app' && (
              <fieldset>
                <legend>Delegated actions (optional)</legend>
                {['conversation.read', 'conversation.write', 'attention.write'].map((c) => (
                  <label key={c}>
                    <input type="checkbox" name="classes" value={c} />
                    {c}
                  </label>
                ))}
                <label>
                  <input type="checkbox" name="member_write_allowed" />
                  Allow editors to consent to write actions
                </label>
              </fieldset>
            )}
            {modal === 'member' && (
              <>
                <label>
                  Member name
                  <input name="label" required />
                </label>
                <label>
                  Role
                  <select name="role" defaultValue="viewer">
                    <option value="viewer">Viewer · inventory and audit</option>
                    <option value="editor">Editor · reveal shared logins and manage access</option>
                  </select>
                </label>
              </>
            )}
            {modal === 'workspace' && (
              <label>
                Workspace name
                <input name="label" required />
              </label>
            )}
            {modal === 'grant' && (
              <>
                <label>
                  Agent name
                  <input name="label" required />
                </label>
                <label>
                  Connection
                  <select
                    value={grantId}
                    onChange={(e) => {
                      G(e.target.value)
                      C([])
                    }}
                  >
                    {active.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label} · {c.source}
                      </option>
                    ))}
                  </select>
                </label>
                <fieldset>
                  <legend>Allowed operations</legend>
                  <p>
                    The agent can run the selected operations through OpenPassword. The provider
                    credential stays in the vault.
                  </p>
                  {selectedConnection &&
                    w.providers[selectedConnection.provider].actions.map((a) => (
                      <label className="check" key={a.id}>
                        <input
                          type="checkbox"
                          checked={checked.includes(a.id)}
                          onChange={(e) =>
                            C(
                              e.target.checked
                                ? [...checked, a.id]
                                : checked.filter((x) => x !== a.id),
                            )
                          }
                        />
                        {a.id}
                      </label>
                    ))}
                </fieldset>
                {w.role === 'owner' &&
                  checked.some((op) =>
                    [
                      'loops.newsletter.create_campaign',
                      'loops.newsletter.update_email_message',
                      'hubspot.newsletter.update_draft',
                    ].includes(op),
                  ) && (
                    <label>
                      Preapproved unsent drafts per UTC day (optional)
                      <input name="draft_limit" type="number" min="1" max="100" />
                    </label>
                  )}
                <label>
                  Grant duration (hours)
                  <input type="number" min="1" max="720" defaultValue="24" name="hours" required />
                </label>{' '}
                <button
                  type="button"
                  onClick={(e) => {
                    const field = e.currentTarget.form?.elements.namedItem(
                      'hours',
                    ) as HTMLInputElement
                    field.value = '168'
                  }}
                >
                  Set to 7 days
                </button>
                {selectedConnection?.access_expires_at && (
                  <small>
                    Access ends no later than {stamp(selectedConnection.access_expires_at)}.
                  </small>
                )}
                {!!selectedConnection &&
                  checked.includes(selectedConnection.provider + '.chat') && (
                    <fieldset>
                      <legend>Standing model access (optional)</legend>
                      <label>
                        Authorized model
                        <input name="model" placeholder="Exact provider model ID" />
                      </label>
                      <label>
                        Maximum requests
                        <input name="calls" type="number" min="1" max="10000" defaultValue="10" />
                      </label>
                      <label>
                        Maximum output tokens per request
                        <input
                          name="max_tokens"
                          type="number"
                          min="1"
                          max="32768"
                          defaultValue="1024"
                        />
                      </label>
                      <details>
                        <summary>Monetary budget (optional)</summary>
                        <label>
                          Budget in micro-USD
                          <input name="budget" type="number" min="1" />
                        </label>
                        <label>
                          Input micro-USD per million tokens
                          <input name="input_rate" type="number" min="0" />
                        </label>
                        <label>
                          Output micro-USD per million tokens
                          <input name="output_rate" type="number" min="0" />
                        </label>
                        <label>
                          Pricing source
                          <input name="price_source" type="url" />
                        </label>
                        <label>
                          Pricing date
                          <input name="price_date" type="date" />
                        </label>
                      </details>
                    </fieldset>
                  )}
                {w.managed_hosts ? (
                  <label>
                    Requesting agent and approved host
                    <select name="host_request" required defaultValue="">
                      <option value="">Choose a pending request</option>
                      {w.requests.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label} on {r.host} · {r.id}
                        </option>
                      ))}
                    </select>
                    <small>Run openpassword pair on the agent, then refresh this page.</small>
                  </label>
                ) : (
                  <>
                    {' '}
                    <label>
                      Credential delivery
                      <select name="delivery">
                        <option value="enroll">One-time CLI enrollment token</option>
                        <option value="api">API access and refresh tokens</option>
                      </select>
                    </label>
                    <label>
                      Existing CLI pairing code (optional)
                      <input name="user_code" />
                    </label>
                  </>
                )}
              </>
            )}
            {error}
            <button className="primary" disabled={busy || (modal === 'grant' && !checked.length)}>
              {
                (
                  {
                    item: 'Save item',
                    deleteItem: 'Delete item',
                    app: 'Register application',
                    member: 'Create member token',
                    oauth: selected === 'notion' ? 'Continue to Notion' : 'Continue to Google',
                    connection: 'Save connection',
                    sharing: 'Save changes',
                    rotate: 'Rotate credential',
                    grant: 'Issue grant',
                    revoke: 'Revoke access',
                    workspace: 'Create workspace',
                  } as Record<string, string>
                )[modal]
              }
            </button>
          </form>
        )}
      </dialog>
    </div>
  )
}
