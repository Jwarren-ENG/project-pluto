import { enterFixtureWorkspace } from './setup-fixture.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const directory = await mkdtemp(path.join(os.tmpdir(), 'pluto-discovery-ui-'))
const executablePath = process.env.PLUTO_SMOKE_EXECUTABLE
const launch = () => electron.launch({ executablePath, args: ['--user-data-dir=' + directory, ...(executablePath ? [] : ['.'])] })
let app
try {
  app = await launch()
  let page = await app.firstWindow()
  await enterFixtureWorkspace(page)
  const nav = (name) => page.getByRole('navigation').getByRole('button', { name, exact: true }).click()
  await nav('Discover')
  await page.getByRole('button', { name: 'Use the Simplify new grad list' }).click()
  await page.getByRole('button', { name: 'Add source', exact: true }).click()
  const checkbox = () => page.getByRole('checkbox', { name: /simplifyjobs/i })
  await checkbox().waitFor()
  await page.getByLabel('Role and location').fill('Product')
  await checkbox().uncheck()
  await page.waitForFunction(() => !document.querySelector('.discovery-source-list input')?.disabled)
  assert.equal(await page.getByRole('button', { name: 'Search saved sources' }).isDisabled(), true)
  await app.close()
  app = await launch()
  page = await app.firstWindow()
  await nav('Discover')
  assert.equal(await checkbox().isChecked(), false)
  await checkbox().check()
  // Replace network reads on this disposable process only. Checking sources through
  // the shipped IPC and renderer must not depend on a third-party board's uptime.
  const fixture = await app.evaluateHandle(() => {
    const requests = []
    globalThis.fetch = async address => {
      const url = new URL(address)
      if (url.hostname !== 'api.github.com') throw new Error('Unexpected network request in discovery test')
      requests.push(url.href)
      return new Response('| Company | Role | Location | Apply |\n| --- | --- | --- | --- |\n| Example | Product Analyst | NYC | [Apply](https://jobs.example.org/jobs/42) |')
    }
    return requests
  })
  await page.getByLabel('Role and location').fill('Product')
  await page.getByRole('button', { name: 'Search saved sources' }).click()
  await page.getByRole('heading', { name: 'Search results' }).waitFor()
  const rows = page.getByRole('button', { name: 'Review role' })
  assert.equal(await rows.count(), 1)
  assert.equal(await fixture.evaluate(calls => calls.length), 1)
  await page.getByRole('heading', { name: 'Product Analyst', exact: true }).waitFor()
  await rows.first().click()
  await page.getByRole('heading', { name: 'New application' }).waitFor()
  await nav('Discover')
  await page.getByRole('button', { name: /Remove SimplifyJobs/i }).click()
  await page.getByRole('button', { name: 'Search with Firecrawl' }).waitFor()
  assert.equal(await checkbox().count(), 0)
  await fixture.dispose()
  console.log('Verified source setup, persistence, search, role review and removal through the desktop app.')
} finally {
  await app?.close()
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
}
