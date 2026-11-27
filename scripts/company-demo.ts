import { createInterface } from 'node:readline/promises'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'

export async function capture(page: Page, name: string) {
  if (process.env.OPENPASSWORD_DEMO_LIVE === '1') {
    await page.bringToFront()
    const terminal = createInterface({ input: process.stdin, output: process.stdout })
    try {
      await terminal.question(name + ' · press Enter to continue ')
    } finally {
      terminal.close()
    }
  }
  const dir = process.env.OPENPASSWORD_DEMO_CAPTURES
  if (!dir) return
  await mkdir(dir, { recursive: true })
  await page.screenshot({ path: join(dir, name + '.png'), animations: 'disabled' })
}

export async function companyDemo(owner: Page, browser: Browser, origin: string) {
  await owner.getByRole('button', { name: 'Add shared login' }).waitFor()
  await capture(owner, '02-owner')
  await owner.getByRole('button', { name: 'Add shared login' }).click()
  await owner.getByLabel('Item title').fill('Support desk')
  await owner.getByLabel('Username (optional)').fill('support@example.com')
  const fixture = 'synthetic-demo-value'
  await owner.getByLabel('Password or secure note').fill(fixture)
  await owner.getByRole('button', { name: 'Save item' }).click()
  await owner.getByRole('button', { name: 'Add teammate' }).click()
  await owner.getByLabel('Member name').fill('Jane')
  await owner.getByRole('dialog').getByRole('combobox').selectOption('editor')
  await capture(owner, '03-role')
  await owner.getByRole('button', { name: 'Create member token' }).click()
  const token = await owner
    .getByRole('dialog')
    .getByLabel('Member access token', { exact: true })
    .inputValue()
  const memberAddress = await owner.getByLabel('Member sign-in address').inputValue()
  assert.equal(memberAddress, origin + '/?member=1')
  await owner.getByRole('button', { name: 'Close dialog' }).click()
  const jane = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await jane.goto(memberAddress)
  await jane.getByLabel('Workspace access token').fill(token)
  await jane.getByRole('button', { name: 'Sign in', exact: true }).click()
  await jane.getByRole('link', { name: /Support desk/ }).click()
  await jane.getByLabel('Value hidden').waitFor()
  assert.equal((await jane.request.get(origin + '/api/admin/team-overview')).status(), 403)
  await capture(jane, '04-jane')
  await jane.getByRole('button', { name: 'Reveal stored value' }).click()
  assert.equal(await jane.getByLabel('Revealed value').textContent(), fixture)
  await jane.getByRole('button', { name: 'Hide stored value' }).click()
  await owner.reload()
  await owner.getByText('Jane accessed the stored value in Support desk', { exact: true }).waitFor()
  await capture(owner, '05-access-record')
  await owner.getByRole('link', { name: 'View item history' }).click()
  await owner.getByRole('link', { name: 'Vault item revealed' }).waitFor()
  await owner.goBack()
  await owner.getByRole('button', { name: 'Revoke access for Jane' }).click()
  await owner.getByRole('dialog').getByRole('button', { name: 'Revoke access' }).click()
  await owner.getByText('editor · Revoked').waitFor()
  await jane.getByRole('button', { name: 'Reveal stored value' }).click()
  await jane.getByText('Membership revoked', { exact: true }).waitFor()
  assert.equal(await jane.getByRole('button', { name: 'Reveal stored value' }).count(), 0)
  assert.equal(await jane.getByLabel('Revealed value').count(), 0)
  await capture(jane, '06-offboarding')
  console.log(
    'PASS: owner setup, workspace item, editor sign-in, owner-only overview, masked reveal, attributed history, revocation in existing member session.',
  )
}
