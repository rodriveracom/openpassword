'use client'
import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  FolderKey,
  History,
  KeyRound,
  LockKeyhole,
  MoreHorizontal,
  Plus,
  Search,
  Shield,
  UserRound,
} from 'lucide-react'

type Item = { id: string; title: string; username: string; updated: number }
type Listing = { rows: Item[]; page: number; total: number }
type Audit = { id: number; action: string; at: number }
type Request = (path: string, body?: unknown) => Promise<any>
type Props = {
  relationships: (item: Item) => React.ReactNode
  path: string
  workspace: string
  role: string
  revision: number
  request: Request
  open: (modal: string, id?: string) => void
}
// A visual bookmark derived solely from the public record ID.
function ItemMark({ id }: { id: string }) {
  let hash = 0
  for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0
  return (
    <span
      aria-hidden="true"
      className={'recordMark tone' + (hash % 4)}
      data-shape={(hash >>> 3) % 3}
    >
      {[0, 1, 2, 3].map((n) => (
        <i
          key={n}
          style={{ transform: 'rotate(' + ((hash % 60) + n * (18 + ((hash >>> 8) % 14))) + 'deg)' }}
        />
      ))}
      <b />
    </span>
  )
}
function when(at: number) {
  const d = new Date(at),
    now = new Date()
  if (d.toDateString() !== now.toDateString())
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  const mins = Math.max(0, Math.floor((now.getTime() - at) / 60000))
  return mins === 0 ? 'Just now' : mins < 60 ? mins + ' min ago' : Math.floor(mins / 60) + ' hr ago'
}
function Time({ at }: { at: number }) {
  return (
    <time dateTime={new Date(at).toISOString()} title={new Date(at).toISOString()}>
      {when(at)}
    </time>
  )
}
function Notice({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="vaultNotice" role="alert">
      <Shield />
      <h2>{message}</h2>
      {retry && <button onClick={retry}>Try again</button>}
    </div>
  )
}
export function VaultReader({
  path,
  workspace,
  role,
  revision,
  request,
  open,
  relationships,
}: Props) {
  const [, , id, section] = path.split('/')
  const [q, Q] = useState(''),
    [page, P] = useState(1),
    [list, L] = useState<Listing>(),
    [error, E] = useState(''),
    [attempt, A] = useState(0)
  const search = useRef<HTMLInputElement>(null),
    last = useRef(''),
    scroll = useRef(0)
  const writable = role !== 'viewer'
  useEffect(() => {
    let active = true
    if (id) return
    E('')
    const timer = setTimeout(
      () => {
        request('admin/items?q=' + encodeURIComponent(q) + '&page=' + page)
          .then((data) => {
            if (active) L(data)
          })
          .catch((e) => {
            if (active) {
              E(e.message)
              L(undefined)
            }
          })
      },
      q ? 120 : 0,
    )
    return () => {
      clearTimeout(timer)
      active = false
    }
  }, [q, page, id, revision, attempt, request])
  useEffect(() => {
    if (id || !list || !last.current) return
    const el = document.getElementById('row-' + last.current)
    if (el) {
      el.focus({ preventScroll: true })
      window.scrollTo(0, scroll.current)
      last.current = ''
    }
  }, [id, list])
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => {
      if (!id && (e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        search.current?.focus()
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [id])
  if (id)
    return (
      <Detail
        key={id + '/' + section}
        {...{ id, workspace, writable, request, open, relationships }}
        audit={section === 'history'}
      />
    )
  return (
    <div className="vaultContent">
      <div className="vaultIntro directoryCover">
        <div>
          <div className="vaultTab">
            <FolderKey size={16} /> {workspace}
          </div>
          <h1>Vault items</h1>
          <p>Shared passwords and secure notes.</p>
          <div className="coverEngraving" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
        </div>
        {writable && (
          <button className="primary" onClick={() => open('item')}>
            <Plus size={17} /> Add item
          </button>
        )}
      </div>
      <section className="directory" aria-label="Vault directory">
        <div className="directoryTools">
          <label className="find">
            <Search size={18} />
            <input
              ref={search}
              aria-label="Search vault items"
              placeholder="Search by item or account"
              maxLength={256}
              value={q}
              onChange={(e) => {
                Q(e.target.value)
                P(1)
                L(undefined)
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' || e.key === 'Enter') {
                  e.preventDefault()
                  document.querySelector<HTMLAnchorElement>('.vaultRow')?.focus()
                }
              }}
            />
            {q ? (
              <button
                className="clearFilter"
                aria-label="Clear vault search"
                onClick={() => {
                  Q('')
                  P(1)
                  search.current?.focus()
                }}
              >
                ×
              </button>
            ) : (
              <kbd>Ctrl / ⌘ K</kbd>
            )}
          </label>
          <span aria-live="polite">
            {list && list.total.toLocaleString() + ' ' + (list.total === 1 ? 'item' : 'items')}
          </span>
        </div>
        {error ? (
          <Notice message={error} retry={() => A(attempt + 1)} />
        ) : !list ? (
          <p className="vaultNotice" role="status">
            Loading items…
          </p>
        ) : !list.total ? (
          <div className="vaultNotice">
            <img width="72" src="/brand/mator-searching.webp" alt="" />
            <h2>{q ? 'No matching items' : 'Your vault is ready'}</h2>
            <p>
              {q
                ? 'Try another item name or account.'
                : 'Shared logins and notes will appear here.'}
            </p>
            {q && (
              <button
                onClick={() => {
                  Q('')
                  P(1)
                }}
              >
                Clear search
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="listLabels">
              <span>Item / account</span>
              <span>Last changed</span>
            </div>
            {list.rows.map((i) => (
              <a
                id={'row-' + i.id}
                key={i.id}
                className="vaultRow"
                href={'/vault/' + i.id}
                onKeyDown={(e) => {
                  const next =
                    e.key === 'ArrowDown'
                      ? e.currentTarget.nextElementSibling
                      : e.key === 'ArrowUp'
                        ? e.currentTarget.previousElementSibling
                        : null
                  if (next instanceof HTMLAnchorElement) {
                    e.preventDefault()
                    next.focus()
                  }
                }}
                onClick={(e) => {
                  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
                  e.preventDefault()
                  last.current = i.id
                  scroll.current = window.scrollY
                  history.pushState(null, '', e.currentTarget.href)
                  window.scrollTo(0, 0)
                }}
              >
                <ItemMark id={i.id} />
                <span className="rowText">
                  <strong>{i.title}</strong>
                  <small>{i.username || workspace}</small>
                </span>
                <Time at={i.updated} />
                <ChevronRight size={17} />
              </a>
            ))}
            {list.total > 30 && (
              <div className="pager">
                <button
                  aria-label="Previous page"
                  disabled={list.page === 1}
                  onClick={() => P(list.page - 1)}
                >
                  <ChevronLeft />
                </button>
                <span>
                  Page {list.page} of {Math.ceil(list.total / 30)}
                </span>
                <button
                  aria-label="Next page"
                  disabled={list.page * 30 >= list.total}
                  onClick={() => P(list.page + 1)}
                >
                  <ChevronRight />
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}
function Detail({
  id,
  workspace,
  writable,
  request,
  open,
  audit,
  relationships,
}: {
  relationships: Props['relationships']
  id: string
  workspace: string
  writable: boolean
  request: Request
  open: Props['open']
  audit: boolean
}) {
  const [item, I] = useState<Item>(),
    [events, H] = useState<Audit[]>([]),
    [before, B] = useState<number[]>(() => {
      const n = Number(new URLSearchParams(location.search).get('before'))
      return Number.isSafeInteger(n) && n > 0 ? [n] : []
    }),
    [error, E] = useState(''),
    [value, V] = useState<string | null>(null),
    [msg, M] = useState(''),
    [busy, S] = useState(false)
  const epoch = useRef(0)
  useEffect(() => {
    let active = true
    const cursor = before.at(-1)
    Promise.all([
      request('admin/items/' + id),
      audit ? request('admin/items/' + id + '/history' + (cursor ? '?before=' + cursor : '')) : [],
    ])
      .then(([item, events]) => {
        if (active) {
          I(item)
          H(events)
        }
      })
      .catch((e) => {
        if (active) E(e.message)
      })
    return () => {
      active = false
    }
  }, [id, audit, before, request])
  useEffect(() => {
    const hide = () => {
      epoch.current++
      V(null)
      M('')
      S(false)
    }
    const visibility = () => {
      if (document.hidden) hide()
    }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', hide)
    return () => {
      epoch.current++
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pagehide', hide)
    }
  }, [])
  useEffect(() => {
    if (value === null) return
    const timer = setTimeout(() => V(null), 30000)
    return () => clearTimeout(timer)
  }, [value])
  async function access(copy: boolean) {
    const ticket = ++epoch.current
    S(true)
    M('')
    try {
      const result = await request('admin/items/' + id + '/reveal', {})
      if (ticket !== epoch.current) return
      if (copy) {
        await navigator.clipboard.writeText(result.value)
        if (ticket === epoch.current) M('Value copied')
      } else V(result.value)
    } catch (e) {
      if (ticket === epoch.current) {
        V(null)
        const failure = e as Error & { status?: number }
        if (failure.status === 401 || failure.status === 403) {
          I(undefined)
          E(failure.message)
        } else M(failure.message)
      }
    } finally {
      if (ticket === epoch.current) S(false)
    }
  }
  function auditPage(next: number[]) {
    B(next)
    const cursor = next.at(-1)
    history.replaceState(null, '', location.pathname + (cursor ? '?before=' + cursor : ''))
  }
  const back = audit ? '/vault/' + id : '/vault'
  return (
    <div className="vaultContent reader">
      <a
        className="backlink"
        href={back}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey) return
          e.preventDefault()
          history.pushState(null, '', back)
        }}
      >
        <ArrowLeft size={16} />
        {audit ? 'Back to item' : 'Back to vault'}
      </a>
      {error ? (
        <Notice message={error} />
      ) : !item ? (
        <p role="status">Loading item…</p>
      ) : (
        <>
          <div className="vaultIntro recordHeader">
            <ItemMark id={id} />
            <div>
              <div className="vaultTab">
                <KeyRound size={16} />
                {audit ? 'Item activity' : 'Vault item'}
              </div>
              <h1>{item.title}</h1>
              <p>{workspace}</p>
            </div>
          </div>
          {audit ? (
            <section className="readerCard">
              <h2>Activity history</h2>
              {events.length === 0 ? (
                <p>No visible events.</p>
              ) : (
                events.slice(0, 30).map((e) => (
                  <div id={'event-' + e.id} className="field" key={e.id}>
                    <a href={'#event-' + e.id}>{e.action}</a>
                    <small>{new Date(e.at).toISOString()}</small>
                  </div>
                ))
              )}
              <div className="pager">
                {before.length > 0 && (
                  <button onClick={() => auditPage(before.slice(0, -1))}>Newer</button>
                )}
                {events.length > 30 && (
                  <button onClick={() => auditPage([...before, events[29].id])}>Older</button>
                )}
              </div>
            </section>
          ) : (
            <>
              <div className="recordLayout">
                <section className="readerCard">
                  <div className="cardTitle">
                    <h2>Credential fields</h2>
                    <LockKeyhole size={19} />
                  </div>
                  <div className="field">
                    <label>
                      <UserRound size={15} /> Account
                    </label>
                    <code>{item.username || 'No account specified'}</code>
                  </div>
                  <div className="field">
                    <label>
                      <KeyRound size={15} /> Stored value
                    </label>
                    <code
                      aria-label={value === null ? 'Value hidden' : 'Revealed value'}
                      className={value === null ? 'masked' : ''}
                    >
                      {value ?? '••••  ••••  ••••'}
                    </code>
                    {writable ? (
                      <div className="fieldActions">
                        <button
                          disabled={busy}
                          aria-label={value === null ? 'Reveal stored value' : 'Hide stored value'}
                          onClick={() => (value === null ? access(false) : V(null))}
                        >
                          {value === null ? <Eye size={16} /> : <EyeOff size={16} />}{' '}
                          {value === null ? 'Reveal' : 'Hide'}
                        </button>
                        <button
                          disabled={busy}
                          aria-label="Copy stored value"
                          onClick={() => access(true)}
                        >
                          <Copy size={16} />
                          Copy
                        </button>
                      </div>
                    ) : (
                      <small>Your viewer role permits access to item metadata.</small>
                    )}
                    <span role="status">{msg}</span>
                  </div>
                </section>
                <section className="recordContext">
                  {relationships(item)}
                  <div className="readerMeta">
                    <div>
                      <span>Last changed</span>
                      <Time at={item.updated} />
                    </div>
                    <div>
                      <span>Your access</span>
                      <strong>{writable ? 'Reveal and manage' : 'Metadata only'}</strong>
                    </div>
                  </div>
                  <a className="auditLink" href={'/vault/' + id + '/history'}>
                    <History size={17} />
                    Item activity
                    <ArrowRight size={17} />
                  </a>
                  {writable && (
                    <details className="itemMenu">
                      <summary>
                        <MoreHorizontal size={16} />
                        More actions
                      </summary>
                      <button onClick={() => open('deleteItem', id)}>Delete item</button>
                    </details>
                  )}
                </section>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
