import { companyDemo, capture } from './company-demo.ts'
import { newVaultKey, encryptPrivate, importVaultKey } from '../app/private-crypto.ts'
import { chromium } from 'playwright-core'
import { createServer as createTlsServer } from 'node:https'
import { createHash } from 'node:crypto'
import { spawn, execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { service } from '../server/service.ts'
import { createServer } from 'node:net'
import { once } from 'node:events'
const demo = process.argv.includes('--company')
const dir = mkdtempSync(join(tmpdir(), 'openpassword-browser-'))
const probe = createServer()
probe.listen(0, '127.0.0.1')
await once(probe, 'listening')
const port = (probe.address() as { port: number }).port
await new Promise<void>((ok) => probe.close(() => ok()))
const origin = 'http://localhost:' + port
const broker = service(dir, origin)
try {
  await broker.listen({ host: '127.0.0.1', port: Number(process.env.OPENPASSWORD_PORT || 4141) })
  const web = spawn(
    process.execPath,
    ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)],
    { stdio: 'ignore' },
  )
  try {
    let ready = false
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(origin + '/api/health')).ok) {
          ready = true
          break
        }
      } catch {}
      await delay(100)
    }
    assert.ok(ready, 'Production console did not reach its isolated broker')
    const browser = await chromium.launch({
      headless: !(demo && process.env.OPENPASSWORD_DEMO_LIVE === '1'),
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      args:
        process.env.OPENPASSWORD_BROWSER_SINGLE_PROCESS === '1'
          ? ['--no-sandbox', '--single-process', '--no-zygote', '--disable-gpu']
          : [],
    })
    async function exerciseConsole() {
      // The application callback below uses a throwaway self-signed certificate.
      const p = await browser.newPage({ ignoreHTTPSErrors: true })
      await p.goto(origin)
      const cli = (command: string, input = '') =>
        new Promise<string>((resolve, reject) => {
          const child = execFile(
            process.execPath,
            ['public/openpassword-cli.cjs', ...command.split(' ')],
            {
              env: {
                ...process.env,
                HOME: dir,
                OPENPASSWORD_HOME: dir,
                OPENPASSWORD_BROKER: origin,
              },
            },
            (err, stdout) =>
              err ? reject(Error('Test CLI failed: ' + command)) : resolve(stdout.trim()),
          )
          child.stdin!.end(input)
        })
      if (demo) {
        await p.setViewportSize({ width: 1280, height: 800 })
        await p.getByRole('button', { name: 'On a remote server' }).click()
        await capture(p, '01-operator')
        await p.getByRole('button', { name: 'On this computer' }).click()
      }
      await p.getByLabel('Setup code', { exact: true }).fill(await cli('setup-code'))
      await p.getByRole('button', { name: 'Continue to account' }).click()
      await p.getByLabel('Username').fill('operator')
      await p.getByLabel('Choose a password').fill('browser-only-fixture')
      await p.getByRole('button', { name: 'Create administrator' }).click()
      await p.getByRole('heading', { name: 'Your team vault' }).waitFor()
      if (demo) return companyDemo(p, browser, origin)
      const contract = await p.request.get(origin + '/v1/openapi.json')
      assert.equal(contract.status(), 200)
      assert.equal((await contract.json()).openapi, '3.1.0')
      const pair = await p.request.post(origin + '/v1/device/authorizations', {
        headers: { 'OpenPassword-Protocol-Version': '1' },
        data: { device_name: 'remote client' },
      })
      assert.equal(pair.status(), 200)
      assert.equal((await pair.json()).verification_url, origin + '/device')
      await p.getByRole('link', { name: 'Workspace', exact: true }).click()
      await p.getByRole('heading', { name: 'Authentication' }).waitFor()
      await p.getByText('Google · Optional').click()
      assert.equal(
        await p.locator('details[open]').getByLabel('Callback URL').inputValue(),
        origin + '/api/auth/google/callback',
      )
      await p.getByRole('link', { name: 'Connections', exact: true }).click()
      await p.getByRole('button', { name: 'Add connection' }).click()
      await p.getByRole('dialog').locator('select').first().selectOption('github_read')
      await p.getByLabel('Credential owner').selectOption('personal')
      await p.getByRole('button', { name: 'In 7 days', exact: true }).click()
      assert.ok(await p.getByLabel('Credential expiry').inputValue())
      await p.getByLabel('Connection name').fill('Engineering')
      await p.getByLabel('Account identity').fill('demo@example.com')
      await p.getByLabel('Provider credential').fill('synthetic-browser-only')
      await p.getByRole('button', { name: 'Save connection' }).click()
      await p.getByText('Engineering', { exact: true }).waitFor()
      await p.getByRole('button', { name: 'Edit access' }).click()
      await p.getByLabel('Who can use this credential?').selectOption('organization')
      await p.getByRole('button', { name: 'Save changes' }).click()
      await p.getByText(/Owned by you.*Whole organization/).waitFor()
      await p.getByRole('link', { name: 'Access grants', exact: true }).click()
      await p.getByRole('button', { name: 'Issue grant' }).click()
      await p.getByLabel('Agent name').fill('Test device')
      await p.getByLabel('github.user.get', { exact: true }).check()
      await p.getByRole('dialog').getByRole('button', { name: 'Issue grant' }).click()
      await p.getByText('Agent credentials', { exact: true }).waitFor()
      const ticket = await p.getByRole('dialog').locator('pre').last().innerText()
      const enrolled = JSON.parse(await cli('connect', ticket + '\n'))
      assert.deepEqual(JSON.parse(await cli('whoami')), enrolled)
      await p.getByRole('button', { name: 'Close dialog' }).click()
      assert.equal((await p.request.get(origin + '/openpassword-cli.cjs')).status(), 200)
      const challenge = await pair.json()
      await p.getByRole('button', { name: 'Issue grant' }).click()
      await p.getByLabel('Agent name').fill('Remote Codex')
      await p.getByLabel('Existing CLI pairing code (optional)').fill(challenge.user_code)
      await p.getByLabel('github.user.get', { exact: true }).check()
      await p.getByRole('dialog').getByRole('button', { name: 'Issue grant' }).click()
      const headers = { 'OpenPassword-Protocol-Version': '1' }
      await p.getByRole('dialog').waitFor({ state: 'hidden' })
      const redeemed = await p.request.post(origin + '/v1/device/token', {
        headers,
        data: { device_code: challenge.device_code },
      })
      assert.equal(redeemed.status(), 200)
      const token = await redeemed.json()
      const capabilities = await p.request.get(origin + '/v1/capabilities', {
        headers: { ...headers, Authorization: 'Bearer ' + token.access_token },
      })
      assert.equal(capabilities.status(), 200)
      assert.match(await capabilities.text(), /github.user.get/)
      await p.getByRole('link', { name: 'Activity', exact: true }).click()
      await p.getByText('Live', { exact: true }).waitFor()
      assert.equal(new URL(p.url()).pathname, '/activity')
      await p.request.delete(origin + '/api/admin/grants/' + token.device_id)
      await p.getByText('Access revoked', { exact: true }).waitFor()
      await p.reload()
      await p.getByText('Access revoked', { exact: true }).waitFor()
      await p.getByRole('link', { name: 'Consumption', exact: true }).click()
      await p.getByText('No brokered API requests in this period.').waitFor()
      await p.getByLabel('Group by').selectOption('agent')
      await p.goBack()
      await p.getByRole('heading', { name: 'Activity', exact: true }).waitFor()
      await p.goForward()
      await p.getByLabel('Group by').waitFor()
      await p.setViewportSize({ width: 390, height: 844 })
      await p.getByRole('button', { name: 'Menu', exact: true }).click()
      await p.getByRole('link', { name: 'Integrations', exact: true }).click()
      await p.getByLabel('Search Integrations').fill('Notion')
      await p.getByRole('button', { name: /Notion/ }).click()
      await p.getByRole('dialog').getByText('notion.pages.get').waitFor()
      await p.getByRole('button', { name: 'Close dialog' }).click()
      assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      const source = await p.request.get(origin + '/openpassword-source.tar.gz')
      assert.equal(source.status(), 200)
      assert.equal((await source.body()).subarray(0, 2).toString('hex'), '1f8b')
      if (!(await p.getByRole('button', { name: 'Lock workspace' }).isVisible()))
        await p.getByRole('button', { name: 'Menu', exact: true }).click()
      await p.getByRole('button', { name: 'Lock workspace' }).click()
      await p.getByLabel('Username').fill('operator')
      await p.getByLabel('Password', { exact: true }).fill('browser-only-fixture')
      await p.getByRole('button', { name: 'Sign in', exact: true }).click()
      await p.getByRole('button', { name: 'Menu', exact: true }).waitFor()
      await p.setViewportSize({ width: 1280, height: 900 })
      await p.goto(origin + '/private-vault')
      let recovery: string
      const legacy = process.env.OPENPASSWORD_TEST_LEGACY === '1'
      if (legacy) {
        recovery = newVaultKey()
        const api = origin + '/api/profile/vault'
        const { tenant, profile } = await (await p.request.get(api)).json()
        const check = await encryptPrivate(
          await importVaultKey(recovery),
          JSON.stringify(['OpenPassword.private.v1', tenant, profile, 'unlock']),
          'OpenPassword private vault',
        )
        assert.equal(
          (await p.request.post(api, { headers: { origin }, data: { check } })).status(),
          200,
        )
        await p.reload()
        await p.getByLabel('Private vault key', { exact: true }).fill(recovery)
      } else {
        await p.getByRole('button', { name: 'Create my private vault' }).click()
        recovery = await p
          .locator('label')
          .filter({ hasText: 'Save this private vault key' })
          .locator('code')
          .innerText()
        await p.getByLabel('Confirm your saved key').fill(recovery)
        await p.getByLabel('Vault passphrase').fill('synthetic browser passphrase')
      }
      await p.getByRole('button', { name: 'Unlock private vault' }).click()
      await p.getByRole('button', { name: 'Add private item' }).click()
      await p.getByLabel('Item name', { exact: true }).fill('Private synthetic credential')
      await p.getByLabel('Secret', { exact: true }).fill('synthetic-private-value')
      await p.getByRole('button', { name: 'Save private item' }).click()
      await p.getByRole('button', { name: 'Private synthetic credential' }).click()
      await p.getByRole('button', { name: 'Reveal secret' }).click()
      await p.getByText('synthetic-private-value', { exact: true }).waitFor()
      await p.getByRole('button', { name: 'Hide secret' }).click()
      await p.getByRole('button', { name: 'Delegate to gateway' }).click()
      await p.getByLabel('Provider', { exact: true }).selectOption('github_read')
      await p.getByLabel('Gateway connection name').fill('Delegated fixture')
      await p.getByLabel('Provider account identity').fill('synthetic-account')
      await p.getByRole('button', { name: 'Authorize gateway copy' }).click()
      await p.getByText(/Gateway copy created/).waitFor()
      if (legacy) {
        await p.getByRole('button', { name: 'Upgrade vault protection' }).click()
        recovery = await p
          .locator('label')
          .filter({ hasText: 'New private vault key' })
          .locator('code')
          .innerText()
        await p.getByLabel('Confirm saved new key').fill(recovery)
        await p.getByLabel('New vault passphrase').fill('synthetic browser passphrase')
        await p.getByLabel('Confirm new passphrase').fill('synthetic browser passphrase')
        await p.getByRole('button', { name: 'Upgrade and lock vault' }).click()
        await p.getByLabel('Private vault key', { exact: true }).waitFor()
        await p.reload()
      } else {
        await p.getByRole('button', { name: 'Lock private vault' }).click()
      }
      await p.getByLabel('Private vault key', { exact: true }).fill(recovery)
      await p.getByLabel('Vault passphrase').fill('synthetic browser passphrase')
      await p.getByRole('button', { name: 'Unlock private vault' }).click()
      await p.getByRole('button', { name: 'Private synthetic credential' }).click()
      await p.getByRole('link', { name: 'Delegated fixture' }).waitFor()
      await p.getByRole('button', { name: 'Reveal secret' }).click()
      await p.getByText('synthetic-private-value', { exact: true }).waitFor()
      const ownerCookies = await p.context().cookies()
      const member = await p.request.post(origin + '/api/admin/members', {
        data: { label: 'Jane', role: 'viewer' },
      })
      assert.equal(member.status(), 200)
      await p.request.post(origin + '/api/admin/login', {
        data: { token: (await member.json()).token },
      })
      const memberCookies = await p.context().cookies()
      await p.goto(origin + '/private-vault')
      await p.getByRole('button', { name: 'Create my private vault' }).click()
      const janeKey = await p
        .locator('label')
        .filter({ hasText: 'Save this private vault key' })
        .locator('code')
        .innerText()
      const unlock = async (key: string, creating = false) => {
        await p
          .getByLabel(creating ? 'Confirm your saved key' : 'Private vault key', { exact: true })
          .fill(key)
        await p.getByLabel('Vault passphrase', { exact: true }).fill('synthetic browser passphrase')
        await p.getByRole('button', { name: 'Unlock private vault' }).click()
      }
      await unlock(janeKey, true)
      await p.getByText('Human read access', { exact: true }).click()
      await p.getByRole('button', { name: 'Show my recipient card' }).click()
      const card = await p
        .locator('p')
        .filter({ hasText: 'Give this card to the owner' })
        .locator('code')
        .innerText()
      await p.context().addCookies(ownerCookies)
      await p.reload()
      await unlock(recovery)
      await p.getByRole('button', { name: 'Private synthetic credential' }).click()
      await p.getByText('Human read access', { exact: true }).click()
      await p.getByLabel('Verified recipient card', { exact: true }).fill(card)
      await p.getByRole('button', { name: 'Grant read access' }).click()
      await p.getByText('Read access granted.').waitFor()
      await p.context().addCookies(memberCookies)
      await p.reload()
      await unlock(janeKey)
      await p.getByText('Human read access', { exact: true }).click()
      await p.getByRole('button', { name: 'List shared items' }).click()
      await p.getByRole('button', { name: 'Reveal shared item' }).click()
      await p
        .getByText('Private synthetic credential — synthetic-private-value', { exact: true })
        .waitFor()
      await p.context().addCookies(ownerCookies)
      await p.reload()
      await unlock(recovery)
      await p.getByText('Human read access', { exact: true }).click()
      await p.getByRole('button', { name: 'List shared items' }).click()
      await p.getByRole('button', { name: 'Revoke read access' }).click()
      await p.getByText('Future reads revoked.').waitFor()
      await p.getByRole('button', { name: 'Private synthetic credential' }).click()
      await p.getByText('Human read access', { exact: true }).click()
      await p.getByText('Read groups', { exact: true }).click()
      await p.getByLabel('Group name', { exact: true }).fill('Review team')
      await p.getByLabel('Verified recipient cards, one per line').fill(card)
      await p.getByRole('button', { name: 'Save read group' }).click()
      await p
        .getByRole('button', { name: 'Share Private synthetic credential with Review team' })
        .click()
      await p.getByText('Read access granted to every group member.').waitFor()
      await p.getByRole('button', { name: 'Remove group and revoke its shares' }).click()
      await p.getByText('Group removed and future delivery revoked.').waitFor()
      await p.getByText('Recovery and device unlock', { exact: true }).click()
      await p.getByLabel('Confirm saved vault key').fill(recovery)
      await p.getByLabel('Confirm vault passphrase').fill('synthetic browser passphrase')
      const download = p.waitForEvent('download')
      await p.getByRole('button', { name: 'Download recovery file' }).click()
      const kit = join(dir, 'synthetic-recovery.json')
      await (await download).saveAs(kit)
      const code = await p
        .locator('p')
        .filter({ hasText: 'Save this recovery code separately' })
        .locator('code')
        .innerText()
      await p.getByRole('button', { name: 'Lock private vault' }).click()
      await p.getByText('Other ways to unlock', { exact: true }).click()
      await p.getByLabel('Recovery file', { exact: true }).setInputFiles(kit)
      await p.getByLabel('Offline recovery code').fill(code)
      await p.getByRole('button', { name: 'Unlock with recovery kit' }).click()
      await p.getByRole('button', { name: 'Private synthetic credential' }).waitFor()
      const cdp = await p.context().newCDPSession(p)
      await cdp.send('WebAuthn.enable')
      await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2',
          ctap2Version: 'ctap2_1',
          hasPrf: true,
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      })
      await p.getByText('Recovery and device unlock', { exact: true }).click()
      await p.getByLabel('Confirm saved vault key').fill(recovery)
      await p.getByLabel('Confirm vault passphrase').fill('synthetic browser passphrase')
      await p.getByLabel('Device name').fill('Synthetic device')
      await p.getByRole('button', { name: 'Enable 30-day device unlock' }).click()
      await p.getByText('Authenticator enabled on this browser for 30 days.').waitFor()
      await p.getByRole('button', { name: 'Lock private vault' }).click()
      await p.getByText('Other ways to unlock', { exact: true }).click()
      await p.getByRole('button', { name: 'Unlock with enrolled authenticator' }).click()
      await p.getByRole('button', { name: 'Private synthetic credential' }).waitFor()
      await p.getByText('Recovery and device unlock', { exact: true }).click()
      await p.getByRole('button', { name: 'Manage enrolled devices' }).click()
      await p.getByRole('button', { name: 'Revoke device' }).click()
      await p.getByText('Device revoked for future online unlocks.').waitFor()
      await p.getByRole('button', { name: 'Lock private vault' }).click()
      await p.getByText('Other ways to unlock', { exact: true }).click()
      await p.getByRole('button', { name: 'Unlock with enrolled authenticator' }).click()
      await p.getByText(/Could not verify unlock material/).waitFor()
      await p.goto(origin + '/workspace')
      await p.getByLabel('Host name').fill('Synthetic build host')
      await p.getByRole('button', { name: 'Issue host enrollment token' }).click()
      const ticketArea = p
        .locator('section')
        .filter({ has: p.getByRole('button', { name: 'Hide token' }) })
      const hostTicket = await ticketArea.locator('code').last().innerText()
      assert.match(await cli('host connect', hostTicket + '\n'), /Host enrolled/)
      await p.reload()
      await p
        .locator('article')
        .filter({ hasText: 'Synthetic build host' })
        .getByText('Connected', { exact: true })
        .waitFor()
      // A real application callback on another origin, registered before step-up is required.
      const keyFile = join(dir, 'callback.key'),
        certFile = join(dir, 'callback.crt')
      execFileSync(
        'openssl',
        [
          ...'req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost'.split(' '),
          '-keyout',
          keyFile,
          '-out',
          certFile,
        ],
        { stdio: 'ignore' },
      )
      const answers: URL[] = []
      const application = createTlsServer(
        { key: readFileSync(keyFile), cert: readFileSync(certFile) },
        (req, res) => {
          const url = new URL(String(req.url), 'https://localhost')
          if (url.pathname === '/callback') answers.push(url)
          res.end('Signed in to the synthetic application')
        },
      )
      application.listen(0, '127.0.0.1')
      await once(application, 'listening')
      // It must not keep the script alive if a later step fails.
      application.unref()
      const callback =
        'https://localhost:' + (application.address() as { port: number }).port + '/callback'
      const registered = await p.request.post(origin + '/api/admin/apps', {
        headers: { origin },
        data: { label: 'Synthetic application', callback, audience: 'app.example.com', days: 1 },
      })
      assert.equal(registered.status(), 200)
      const { id: applicationId } = await registered.json()
      const activated = await p.request.post(origin + '/api/admin/apps/' + applicationId, {
        headers: { origin },
        data: { active: true },
      })
      assert.equal(activated.status(), 200)
      await p.getByText('Sign-in passkeys', { exact: true }).click()
      await p.getByLabel('Passkey name').fill('Review authenticator')
      await p.getByLabel('Current sign-in password').fill('browser-only-fixture')
      await p.getByRole('button', { name: 'Add passkey' }).click()
      await p.getByRole('button', { name: 'Remove passkey' }).waitFor()
      const blocked = await p.request.post(origin + '/api/admin/hosts', {
        data: { label: 'Unapproved host' },
      })
      assert.equal(blocked.status(), 428)
      const proof = await p.evaluate(
        async ({ id, options }) => {
          const pk = PublicKeyCredential as typeof PublicKeyCredential & {
            parseRequestOptionsFromJSON(x: unknown): PublicKeyCredentialRequestOptions
          }
          const credential = (await navigator.credentials.get({
            publicKey: pk.parseRequestOptionsFromJSON(options),
          })) as PublicKeyCredential & { toJSON(): unknown }
          const result = await fetch('/api/profile/passkeys/approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, response: credential.toJSON() }),
          })
          return (await result.json()).proof
        },
        (await blocked.json()).approval,
      )
      assert.equal(typeof proof, 'string')
      for (const label of ['Modified host', 'Unapproved host']) {
        assert.equal(
          (
            await p.request.post(origin + '/api/admin/hosts', {
              data: { label },
              headers: { 'OpenPassword-Approval': proof },
            })
          ).status(),
          403,
        )
      }
      await p.getByLabel('Host name').fill('Passkey approved host')
      await p.getByRole('button', { name: 'Issue host enrollment token' }).click()
      await p.getByRole('button', { name: 'Hide token' }).waitFor()
      await p.request.post(origin + '/api/admin/logout', { data: {} })
      await p.goto(origin)
      await p.getByRole('button', { name: 'Use a passkey' }).click()
      await p.getByRole('button', { name: 'Lock workspace' }).waitFor()
      // Consent in a real browser: passkey approval, form post, and the redirect to the other origin.
      const verifier = 'v'.repeat(43),
        state = 's'.repeat(43)
      await p.goto(
        origin +
          '/delegate?' +
          new URLSearchParams({
            application_id: applicationId,
            redirect_uri: callback,
            state,
            code_challenge_method: 'S256',
            classes: '',
            code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          }),
      )
      await p.getByRole('heading', { name: 'Sign in to Synthetic application?' }).waitFor()
      await p.getByRole('button', { name: 'Confirm sign-in' }).click()
      await p.waitForURL((url) => url.href.startsWith(callback + '?'))
      await p.getByText('Signed in to the synthetic application').waitFor()
      assert.equal(answers.length, 1)
      assert.equal(answers[0].searchParams.get('state'), state)
      // The application's server redeems the code: no cookie and no Origin, unlike the page's requests.
      const exchange = await fetch(origin + '/delegate/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          application_id: applicationId,
          redirect_uri: callback,
          code: answers[0].searchParams.get('code'),
          code_verifier: verifier,
        }),
      })
      assert.equal(exchange.status, 200)
      application.closeAllConnections()
      application.close()
      console.log('App sign-in consent reached the callback on another origin and the code was redeemed.')
      console.log(
        'Recovery kit, passkey registration, approval challenge, authenticator-approved host and passwordless login passed.',
      )
      console.log(
        'Desktop login, sealed credential enrollment, scope selection, grant issuance, mobile search and details, source download, logout, private vault recovery and delegation, and host enrollment passed.',
      )
    }
    try {
      await exerciseConsole()
    } finally {
      await browser.close()
    }
  } finally {
    web.kill('SIGTERM')
  }
} finally {
  await broker.close()
  rmSync(dir, { recursive: true, force: true })
}
