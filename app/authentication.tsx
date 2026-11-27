'use client'
import { usePasskey } from './passkeys-client'
import { useEffect, useState, type FormEvent } from 'react'
type Request = (path: string, body?: unknown, method?: string) => Promise<any>
const labels: Record<string, string> = { google: 'Google', github: 'GitHub', apple: 'Apple' }
export function ConsoleLogin({
  request,
  done,
}: {
  request: Request
  done: (setup: boolean) => Promise<void>
}) {
  const [status, setStatus] = useState<{ setup: boolean; origin: string; providers: string[] }>()
  const [member, setMember] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [code, setCode] = useState(''),
    [account, setAccount] = useState(false),
    [remote, setRemote] = useState(false),
    [system, setSystem] = useState(false)
  useEffect(() => {
    setMember(new URLSearchParams(location.search).get('member') === '1')
    request('auth/status')
      .then(setStatus)
      .catch((e) => setError(e.message))
    if (new URLSearchParams(location.search).get('signin') === 'failed')
      setError('Sign-in was unsuccessful. Try the linked account or use your password.')
  }, [request])
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const data = Object.fromEntries(new FormData(e.currentTarget))
    setBusy(true)
    setError('')
    try {
      if (member) await request('admin/login', data)
      else
        await request(
          status?.setup ? 'auth/setup' : 'auth/password',
          status?.setup ? { ...data, token: code } : data,
        )
      await done(!!status?.setup && !member)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const setup = status?.setup && !member
  return (
    <section className="loginForm">
      <h1>
        {setup
          ? account
            ? 'Create your administrator account'
            : 'Set up your team vault'
          : member
            ? 'Workspace member sign-in'
            : 'Sign in to OpenPassword'}
      </h1>
      {status && location.origin !== status.origin ? (
        <p role="alert">
          This broker is configured for {status.origin}. On the deployment host, set
          OPENPASSWORD_WEB_ORIGIN to this console’s HTTPS origin and restart the broker, or open the
          configured address through a local tunnel.
        </p>
      ) : (
        status && (
          <>
            {setup && !account ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  setAccount(true)
                  setError('')
                }}
              >
                <p>First, confirm you manage this installation. Where is OpenPassword running?</p>
                <div className="setupChoice">
                  {['On this computer', 'On a remote server'].map((label, i) => (
                    <button
                      type="button"
                      key={label}
                      aria-pressed={remote === !!i}
                      onClick={() => {
                        setRemote(!!i)
                        setSystem(!!i)
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <label>
                  Installation type
                  <select
                    value={system ? 'system' : 'user'}
                    onChange={(e) => setSystem(e.target.value === 'system')}
                  >
                    <option value="user">User installation</option>
                    <option value="system">Systemd service</option>
                  </select>
                </label>
                <p>
                  {remote
                    ? 'On your computer, run this with the OpenPassword CLI. Replace user@host with your trusted SSH account.'
                    : system
                      ? 'On the deployment host, run this as the deployment operator.'
                      : 'In a terminal on this computer, run this as the user who started OpenPassword.'}{' '}
                  {system
                    ? 'The service installation requires sudo on the deployment host.'
                    : 'No sudo is needed.'}
                </p>
                <code className="setupCommand">
                  {remote
                    ? 'openpassword setup-code --ssh user@host' + (system ? '' : ' --user')
                    : system
                      ? 'sudo cat /var/lib/openpassword/operator.token | /opt/openpassword/current/node/bin/node /opt/openpassword/current/public/openpassword-cli.cjs setup-code --operator-stdin'
                      : 'openpassword setup-code'}
                </code>
                <label>
                  Setup code
                  <input
                    type="password"
                    autoComplete="off"
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </label>
                <small>Paste the code printed by the CLI. It expires after ten minutes.</small>
                <button className="primary">Continue to account</button>
              </form>
            ) : (
              <form onSubmit={submit} key={String(setup) + String(member)}>
                {!setup && !member && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true)
                      try {
                        const { id, options } = await request('auth/passkey/begin', {})
                        await request('auth/passkey/finish', {
                          id,
                          response: await usePasskey(options),
                        })
                        await done(false)
                      } catch {
                        setError('Passkey sign-in did not complete.')
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    Use a passkey
                  </button>
                )}
                {setup && (
                  <p>
                    This account manages people and shared logins in your workspace.{' '}
                    <button
                      type="button"
                      onClick={() => {
                        setAccount(false)
                        setError('')
                      }}
                    >
                      Change setup code
                    </button>
                  </p>
                )}
                {member && (
                  <label>
                    Workspace access token
                    <input required type="password" name="token" autoComplete="off" />
                  </label>
                )}
                {!member && (
                  <>
                    <label>
                      Username
                      <input name="username" autoComplete="username" maxLength={80} required />
                    </label>
                    <label>
                      {setup ? 'Choose a password (12 characters minimum)' : 'Password'}
                      <input
                        type="password"
                        name="password"
                        minLength={setup ? 12 : 1}
                        maxLength={256}
                        autoComplete={setup ? 'new-password' : 'current-password'}
                        required
                      />
                    </label>
                  </>
                )}
                <button className="primary" disabled={busy}>
                  {setup ? 'Create administrator' : 'Sign in'}
                </button>
              </form>
            )}
            {setup && account && (
              <details>
                <summary>Create administrator with social sign-in</summary>
                <BootstrapSocial
                  code={code}
                  request={request}
                  origin={status.origin}
                  error={setError}
                />
              </details>
            )}
            {!setup &&
              !member &&
              status.providers.map((p) => (
                <button
                  key={p}
                  disabled={busy}
                  onClick={async () => {
                    try {
                      setBusy(true)
                      location.assign((await request('auth/' + p + '/start', { link: false })).url)
                    } catch (e) {
                      setError((e as Error).message)
                      setBusy(false)
                    }
                  }}
                >
                  Continue with {labels[p]}
                </button>
              ))}
            {!status.setup && (
              <button
                onClick={() => {
                  setMember(!member)
                  setError('')
                }}
              >
                {member ? 'Administrator sign-in' : 'Use a workspace access token'}
              </button>
            )}
          </>
        )
      )}
      {!status && !error && <p>Loading sign-in options…</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
type Provider = { provider: string; client: string; callback: string; linked: boolean }
export function Authentication({ request }: { request: Request }) {
  const [apps, A] = useState<Provider[]>([]),
    [message, M] = useState(''),
    [busy, B] = useState(false)
  async function load() {
    A(await request('admin/authentication'))
  }
  useEffect(() => {
    load().catch((e) => M(e.message))
  }, [])
  async function act(f: () => Promise<void>) {
    B(true)
    M('')
    try {
      await f()
      await load()
    } catch (e) {
      M((e as Error).message)
    } finally {
      B(false)
    }
  }
  return (
    <section className="authentication">
      <h2>Authentication</h2>
      <p>Configure the OAuth apps available to profiles on this installation.</p>
      {apps.map((p) => (
        <details key={p.provider}>
          <summary>
            {labels[p.provider]} · {p.linked ? 'Linked' : p.client ? 'Ready to link' : 'Optional'}
          </summary>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const form = e.currentTarget,
                data = Object.fromEntries(new FormData(form))
              void act(async () => {
                await request('admin/authentication/' + p.provider, data)
                form.reset()
                window.dispatchEvent(new Event('signin-apps-updated'))
                M('Saved. You can link this provider under My profile.')
              })
            }}
          >
            <p>
              <a
                href={
                  p.provider === 'google'
                    ? 'https://console.cloud.google.com/auth/clients'
                    : p.provider === 'apple'
                      ? 'https://developer.apple.com/account/resources/identifiers/list'
                      : 'https://github.com/settings/developers'
                }
                target="_blank"
                rel="noreferrer"
              >
                Open {labels[p.provider]} developer settings
              </a>
            </p>
            <label>
              Callback URL
              <input value={p.callback} readOnly onFocus={(e) => e.target.select()} />
            </label>
            <label>
              {p.provider === 'apple' ? 'Services ID' : 'Client ID'}
              <input name="client" defaultValue={p.client} required />
            </label>
            <label>
              {p.provider === 'apple' ? 'Apple signed client secret (JWT)' : 'Client secret'}
              <input type="password" name="secret" autoComplete="new-password" required />
            </label>
            <button disabled={busy}>Save credentials</button>
          </form>
          {p.client && (
            <>
              <button
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    location.assign(
                      (await request('auth/' + p.provider + '/start', { link: true })).url,
                    )
                  })
                }
              >
                Link my {labels[p.provider]} account
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    await request('admin/authentication/' + p.provider, undefined, 'DELETE')
                    window.dispatchEvent(new Event('signin-apps-updated'))
                  })
                }
              >
                Remove {labels[p.provider]} sign-in
              </button>
            </>
          )}
        </details>
      ))}
      {message && <p role="status">{message}</p>}
    </section>
  )
}

function BootstrapSocial({
  code,
  request,
  origin,
  error,
}: {
  request: Request
  origin: string
  code: string
  error: (m: string) => void
}) {
  const [provider, P] = useState('google')
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault()
        const setup = Object.fromEntries(new FormData(e.currentTarget))
        try {
          location.assign(
            (
              await request('auth/' + provider + '/start', {
                link: false,
                setup: { ...setup, token: code },
              })
            ).url,
          )
        } catch (ex) {
          error((ex as Error).message)
        }
      }}
    >
      <label>
        Sign-in provider
        <select value={provider} onChange={(e) => P(e.target.value)}>
          {Object.entries(labels).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <p>Register this callback in your provider’s web application settings.</p>
      <input
        aria-label="Registration callback"
        value={origin + '/api/auth/' + provider + '/callback'}
        readOnly
      />
      <label>
        {provider === 'apple' ? 'Services ID' : 'OAuth client ID'}
        <input name="client" required />
      </label>
      <label>
        {provider === 'apple' ? 'Apple signed client secret (JWT)' : 'OAuth client secret'}
        <input name="secret" type="password" required />
      </label>
      <button>Continue with {labels[provider]}</button>
    </form>
  )
}
export function Profile({ request }: { request: Request }) {
  const [profile, P] = useState<{
      role: string
      username?: string
      providers: { provider: string; linked: number }[]
    }>(),
    [message, M] = useState('')
  const [keys, setKeys] = useState<{ id: string; label: string }[]>([])
  async function load() {
    P(await request('profile'))
    setKeys(await request('profile/passkeys'))
  }
  useEffect(() => {
    const refresh = () => load().catch((e) => M(e.message))
    refresh()
    window.addEventListener('signin-apps-updated', refresh)
    return () => window.removeEventListener('signin-apps-updated', refresh)
  }, [])
  async function act(fn: () => Promise<void>) {
    try {
      await fn()
      await load()
      M('Profile updated.')
    } catch (e) {
      M((e as Error).message)
    }
  }
  return (
    <section className="authentication">
      <h2>My profile</h2>
      <p>Workspace role · {profile?.role}</p>
      <details>
        <summary>Sign-in passkeys</summary>
        {keys.map((k) => (
          <p key={k.id}>
            {k.label}{' '}
            <button
              onClick={() =>
                act(() =>
                  request('profile/passkeys/' + encodeURIComponent(k.id), undefined, 'DELETE'),
                )
              }
            >
              Remove passkey
            </button>
          </p>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const f = new FormData(e.currentTarget)
            e.currentTarget.reset()
            void act(async () => {
              const { id, options } = await request('profile/passkeys/begin', {
                password: f.get('password'),
              })
              await request('profile/passkeys/finish', {
                id,
                label: f.get('label'),
                response: await usePasskey(options, true),
              })
            })
          }}
        >
          <label>
            Passkey name
            <input name="label" required maxLength={80} />
          </label>
          <label>
            Current sign-in password
            <input type="password" name="password" required autoComplete="current-password" />
          </label>
          <button>Add passkey</button>
        </form>
      </details>
      <details>
        <summary>
          {profile?.username ? 'Change username or password' : 'Add username and password'}
        </summary>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const form = e.currentTarget,
              data = Object.fromEntries(new FormData(form))
            void act(async () => {
              await request('profile/password', data)
              form.reset()
            })
          }}
        >
          <label>
            Username
            <input name="username" defaultValue={profile?.username} required />
          </label>
          {profile?.username && (
            <label>
              Current password
              <input
                name="current_password"
                type="password"
                required
                autoComplete="current-password"
              />
            </label>
          )}
          <label>
            New password
            <input
              name="password"
              type="password"
              minLength={12}
              autoComplete="new-password"
              required
            />
          </label>
          <button>Save password</button>
        </form>
        {profile?.username && (
          <button onClick={() => act(() => request('profile/password', undefined, 'DELETE'))}>
            Remove password
          </button>
        )}
      </details>
      {profile?.providers.map(({ provider, linked }) => (
        <button
          key={provider}
          onClick={() =>
            act(async () => {
              if (linked) await request('profile/' + provider, undefined, 'DELETE')
              else
                location.assign((await request('auth/' + provider + '/start', { link: true })).url)
            })
          }
        >
          {linked ? 'Unlink' : 'Link'} {labels[provider]}
        </button>
      ))}
      {message && <p role="status">{message}</p>}
    </section>
  )
}
