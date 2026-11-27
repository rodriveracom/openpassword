'use client'
import { useEffect, useState } from 'react'
import { Check, KeyRound, Users, History, ChevronRight } from 'lucide-react'

type Summary = {
  item: { id: string; title: string } | null
  access: { id: number; item: string; title: string; member: string; at: number } | null
}
type Member = { id: string; label: string; active: number; role: string }
export function TeamOverview({
  name,
  members,
  revision,
  request,
  open,
}: {
  name: string
  members: Member[]
  revision: number
  request: (path: string) => Promise<Summary>
  open: (kind: string, id?: string) => void
}) {
  const [summary, set] = useState<Summary>(),
    [error, fail] = useState(''),
    [attempt, retry] = useState(0)
  useEffect(() => {
    let alive = true,
      seq = 0
    async function refresh() {
      const current = ++seq
      try {
        const s = await request('admin/team-overview')
        if (alive && current === seq) {
          set(s)
          fail('')
        }
      } catch (e) {
        if (alive && current === seq) fail((e as Error).message)
      }
    }
    void refresh()
    window.addEventListener('focus', refresh)
    return () => {
      alive = false
      window.removeEventListener('focus', refresh)
    }
  }, [revision, attempt, request])
  const editor = members.find((m) => m.active && m.role === 'editor')
  const stage = !summary?.item ? 0 : summary.access ? 3 : editor ? 2 : 1
  return (
    <section className="teamHome">
      <div className="teamHead">
        <span className="vaultTab">
          <Users size={16} />
          {name}
        </span>
        <h1>Your team vault</h1>
        <p>Keep shared logins in one place and see who uses them.</p>
      </div>
      {error ? (
        <p role="alert">
          {error} <button onClick={() => retry((n) => n + 1)}>Retry</button>
        </p>
      ) : !summary ? (
        <p role="status">Loading team access…</p>
      ) : (
        <>
          <section className="teamJourney" aria-label="Team setup">
            <div className="teamSection">
              <h2>First shared login</h2>
              <small>{stage === 3 ? 'Access recorded' : 'Step ' + (stage + 1) + ' of 3'}</small>
            </div>
            <ol>
              {[
                {
                  icon: KeyRound,
                  title: 'Save a shared login',
                  body: summary.item
                    ? summary.item.title
                    : 'Choose an account your team uses, such as a support desk.',
                },
                {
                  icon: Users,
                  title: 'Add a teammate',
                  body: summary.access
                    ? summary.access.member + ' · Access recorded'
                    : editor
                      ? editor.label + ' · Editor'
                      : 'Editors can reveal shared logins. Viewers can inspect the inventory.',
                },
                {
                  icon: History,
                  title: 'Check the access record',
                  body: summary.access
                    ? summary.access.member +
                      ' accessed the stored value in ' +
                      summary.access.title
                    : 'Have the editor sign in separately, open the item and choose Reveal.',
                },
              ].map(({ icon: Icon, title, body }, i) => (
                <li key={title} className={i === stage ? 'current' : ''}>
                  <span className="teamStep">
                    {i < stage ? <Check size={18} /> : <Icon size={18} />}
                  </span>
                  <div>
                    <h3>{title}</h3>
                    <p>{body}</p>
                    {i === 0 &&
                      (summary.item ? (
                        <a href={'/vault/' + summary.item.id}>Open item</a>
                      ) : (
                        <button className="primary" onClick={() => open('item')}>
                          Add shared login
                        </button>
                      ))}
                    {i === 1 && i === stage && (
                      <button className="primary" onClick={() => open('member')}>
                        Add teammate
                      </button>
                    )}
                    {i === 2 &&
                      (summary.access ? (
                        <a
                          href={
                            '/vault/' +
                            summary.access.item +
                            '/history?before=' +
                            (summary.access.id + 1) +
                            '#event-' +
                            summary.access.id
                          }
                        >
                          View item history <ChevronRight size={14} />
                        </a>
                      ) : (
                        i === stage && (
                          <button onClick={() => retry((n) => n + 1)}>Check for access</button>
                        )
                      ))}
                  </div>
                </li>
              ))}
            </ol>
          </section>
          <section className="teamJourney">
            <div className="teamSection">
              <h2>Workspace access</h2>
              <button onClick={() => open('member')}>Add member</button>
            </div>
            <p>
              Member roles apply to the whole shared workspace. Keep personal credentials in Private
              vault.
            </p>
            {members.length === 0 ? (
              <p>Only the administrator has access.</p>
            ) : (
              <ul className="teamMembers">
                {members.map((m) => (
                  <li key={m.id}>
                    <div>
                      <strong>{m.label}</strong>
                      <small>
                        {m.role} · {m.active ? 'Active' : 'Revoked'}
                      </small>
                    </div>
                    {!!m.active && (
                      <button
                        aria-label={'Revoke access for ' + m.label}
                        onClick={() => open('revoke', m.id)}
                      >
                        Revoke access
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </section>
  )
}
