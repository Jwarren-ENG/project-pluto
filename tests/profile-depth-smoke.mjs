import { enterFixtureWorkspace } from './setup-fixture.mjs'
// Run from a built checkout with node tests/profile-depth-smoke.mjs.
// Set PLUTO_SMOKE_EXECUTABLE to test a packaged app. PLUTO_PROFILE_SCREENSHOT saves the guide image.
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const resume = 'Morgan Rowan\nExperience\nTracked weekly stock levels for a campus bookshop.'
const work = {
  title: 'Finding missing book orders',
  context: 'Campus bookshop',
  action: 'Compared the delivery log with outstanding orders and flagged missing titles for the buyer.',
  result: 'The buyer could follow up before the next delivery.',
}
const outside = {
  title: 'Organizing a neighborhood book swap',
  context: 'Volunteer reading group',
  action: 'Grouped donated books by reading level and made a shelf map for volunteers.',
  result: 'Families could find the right shelf without waiting for a volunteer.',
}
const button = (scope, name) => scope.getByRole('button', { name, exact: true })
const label = (scope, name) => scope.getByLabel(name, { exact: true })
const heading = (scope, name) => scope.getByRole('heading', { name, exact: true })
const profile = page => page.evaluate(async () => (await window.pluto.call('workspace.snapshot', {})).profile)
const navigate = (page, panel) => button(page.getByRole('navigation'), panel).click()

async function desktop(userData, run, previous) {
  const home = path.join(userData, 'home')
  await mkdir(home, { recursive: true })
  // SQLite checkpoints the WAL when the previous process closes its last connection.
  // Only the workspace checkpoint crosses launches. Connections and OS settings start fresh.
  if (previous) await copyFile(path.join(previous, 'workspace.sqlite3'), path.join(userData, 'workspace.sqlite3'))
  const executablePath = process.env.PLUTO_SMOKE_EXECUTABLE && path.resolve(process.env.PLUTO_SMOKE_EXECUTABLE)
  const system = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|SystemRoot|WINDIR|LANG|LC_ALL|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)$/i.test(key)))
  const app = await electron.launch({
    executablePath,
    args: ['--user-data-dir=' + userData, '--disable-background-networking', '--disable-sync',
      '--disable-component-update', '--host-resolver-rules=MAP * ~NOTFOUND', ...(executablePath ? [] : ['.'])],
    env: { ...system, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
      XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home, CODEX_HOME: home,
      TEMP: home, TMP: home, TMPDIR: home },
    timeout: 45_000,
  })
  try {
    const identity = await app.evaluate(({ app }) => ({ userData: app.getPath('userData'), binary: process.execPath }))
    assert.equal(await realpath(identity.userData), await realpath(userData))
    if (executablePath) assert.equal(await realpath(identity.binary), await realpath(executablePath))
    const attemptedRequests = []
    await app.context().route(/^https?:\/\//, route => {
      attemptedRequests.push(new URL(route.request().url()).origin)
      return route.abort()
    })
    const page = await app.firstWindow()
    page.setDefaultTimeout(15_000)
    await enterFixtureWorkspace(page)
    const result = await run(page)
    assert.deepEqual(attemptedRequests, [], 'Profile used an external service')
    return result
  } finally {
    await app.close()
  }
}

async function startProfile(page) {
  await navigate(page, 'Profile')
  await heading(page, 'Start with your résumé').waitFor()
  await page.getByText('Paste résumé text', { exact: true }).click()
  await label(page, 'Résumé text').fill(resume)
  await button(page, 'Review facts').click()
  assert.equal(await label(page, 'Name').inputValue(), 'Morgan Rowan')
  assert.equal(await label(page, 'Fact 1').inputValue(), 'Tracked weekly stock levels for a campus bookshop.')
  await button(page, 'Continue to preferences').click()
  await label(page, 'Target roles').fill('Inventory Analyst')
}

async function fillStory(page, story) {
  await label(page, 'Story title').fill(story.title)
  await page.getByRole('textbox', { name: /^Context\b/ }).fill(story.context)
  await page.getByRole('textbox', { name: /^What you did\b/ }).fill(story.action)
  await page.getByRole('textbox', { name: /^Result or evidence\b/ }).fill(story.result)
}

async function addStory(page, story, optIn) {
  await button(page, 'Add story').click()
  const permission = label(page, 'Use in application drafts')
  assert.equal(await permission.isChecked(), false, 'Each new story needs its own permission')
  await fillStory(page, story)
  if (optIn) await permission.check()
  await button(page, 'Save story').click()
  await label(page, 'Story title').waitFor({ state: 'hidden' })
}

function assertStory(profile, expected, useInDrafts) {
  const matches = profile.experienceStories.filter(row => row.title === expected.title)
  assert.equal(matches.length, 1)
  const [{ id, ...fields }] = matches
  assert.ok(id, 'A saved story has an ID')
  assert.deepEqual(fields, { ...expected, useInDrafts })
  return id
}

async function onboard(page) {
  const initial = await profile(page)
  await startProfile(page)
  await addStory(page, work, true)
  await addStory(page, outside, false)
  await button(page, 'Edit application answers').click()
  await fillScreeningAnswers(page)
  await button(page, 'Save answers').click()
  await button(page, 'Review profile').click()
  await heading(page, 'Confirm your profile').waitFor()
  assert.deepEqual(await profile(page), initial, 'Onboarding edits are staged until the profile is confirmed')
  await reviewPrivateAnswers(page, notice)
  const save = button(page, 'Save confirmed profile')
  assert.ok(await save.isDisabled())
  await page.getByRole('checkbox', { name: /I confirm these details/ }).check()
  await save.click()
  await heading(page, 'Your profile').waitFor()
  const stored = await profile(page)
  assert.equal(stored.resumeText, resume)
  assert.equal(stored.targetRoles, 'Inventory Analyst')
  assert.equal(stored.profileConfirmed, true)
  assertStory(stored, work, true)
  assertStory(stored, outside, false)
  assertAnswers(stored.applicationAnswers)
  return stored
}

const notice = 'Available after the bookshop inventory closes.'
const country = 'Canada'

async function fillScreeningAnswers(page) {
  await label(page, 'Notice period').fill(notice)
  await button(page, 'Add country').click()
  await label(page, 'Country').fill(country)
  const authorized = page.getByRole('combobox', { name: /^Authorized to work in this country/ })
  const sponsorship = page.getByRole('combobox', { name: /^Need employer sponsorship/ })
  assert.equal(await authorized.locator('option:checked').innerText(), 'Unanswered')
  assert.equal(await sponsorship.locator('option:checked').innerText(), 'Unanswered')
  await sponsorship.selectOption({ label: 'No' })
}

function assertAnswers(answers, expectedNotice = notice) {
  assert.equal(answers.notice, expectedNotice)
  assert.equal(answers.workAuthorization.length, 1)
  const [row] = answers.workAuthorization
  assert.ok(row.id)
  assert.equal(row.country, country)
  assert.equal(row.sponsorship, false)
  assert.equal(Object.hasOwn(row, 'authorized'), false)
}

async function reviewPrivateAnswers(page, expectedNotice) {
  const answers = page.getByRole('region', { name: 'Application answers', exact: true })
  const summary = answers.getByText('Review saved answers', { exact: true })
  assert.equal(await answers.getByText(expectedNotice, { exact: true }).isVisible(), false)
  await summary.click()
  await answers.getByText(expectedNotice, { exact: true }).waitFor()
  await answers.getByText(country, { exact: true }).waitFor()
  assert.match(await answers.innerText(), /Work authorization · Unanswered/)
  assert.match(await answers.innerText(), /Sponsorship needed · No/)
  await summary.click()
}

async function revisitProfile(page, firstSave) {
  const stories = page.getByRole('region', { name: 'Experience stories', exact: true })
  const summary = story => stories.locator('summary').filter({ hasText: story.title })
  assert.match(await summary(work).innerText(), /Allowed in drafts/)
  assert.match(await summary(outside).innerText(), /Local only/)
  await summary(outside).click()
  await stories.getByText(outside.action, { exact: true }).waitFor()
  if (process.env.PLUTO_PROFILE_SCREENSHOT) {
    await page.evaluate(() => document.fonts.ready)
    await stories.evaluate(section => section.scrollIntoView({ block: 'center' }))
    const box = await stories.boundingBox()
    await page.screenshot({ path: process.env.PLUTO_PROFILE_SCREENSHOT, scale: 'css', animations: 'disabled',
      clip: { x: box.x - 10, y: box.y - 6, width: box.width + 20, height: box.height + 12 } })
  }
  await reviewPrivateAnswers(page, notice)
  // Check that cancelling a change also cancels changes to its drafting permission.
  await button(page, 'Edit story: ' + work.title).click()
  const permission = label(page, 'Use in application drafts')
  await page.getByRole('textbox', { name: /^What you did\b/ }).fill('Cancelled edit')
  await permission.uncheck()
  await button(page, 'Cancel').click()
  assert.deepEqual(await profile(page), firstSave)
  await button(page, 'Edit application answers').click()
  assert.equal(await label(page, 'Notice period').inputValue(), notice)
  await label(page, 'Notice period').fill('Cancelled notice')
  await button(page, 'Cancel').click()
  assert.deepEqual(await profile(page), firstSave)

  const changedWork = { ...work, result: 'The buyer recovered a box of missing books before the next delivery.' }
  await button(page, 'Edit story: ' + work.title).click()
  assert.equal(await permission.isChecked(), true)
  await page.getByRole('textbox', { name: /^Result or evidence\b/ }).fill(changedWork.result)
  await permission.uncheck()
  await button(page, 'Save story').click()
  await label(page, 'Story title').waitFor({ state: 'hidden' })

  const changedOutside = { ...outside, action: 'Made a shelf map with reading levels and walked volunteers through it.' }
  await button(page, 'Edit story: ' + outside.title).click()
  assert.equal(await permission.isChecked(), false)
  await page.getByRole('textbox', { name: /^What you did\b/ }).fill(changedOutside.action)
  await permission.check()
  await button(page, 'Save story').click()
  await label(page, 'Story title').waitFor({ state: 'hidden' })

  const updatedNotice = 'Two weeks after the inventory closes.'
  await button(page, 'Edit application answers').click()
  await label(page, 'Notice period').fill(updatedNotice)
  await button(page, 'Save answers').click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await reviewPrivateAnswers(page, updatedNotice)

  const stored = await profile(page)
  assert.equal(stored.experienceStories.length, 2)
  assert.equal(assertStory(stored, changedWork, false), assertStory(firstSave, work, true))
  assert.equal(assertStory(stored, changedOutside, true), assertStory(firstSave, outside, false))
  assertAnswers(stored.applicationAnswers, updatedNotice)
  return stored
}

async function checkOlderProfile(page) {
  // This is the saved shape before experience stories and private answers were introduced.
  const older = { name: 'Morgan Rowan', confirmedFacts: ['Worked in a bookshop.'], resumeText: resume }
  await page.evaluate(value => window.pluto.call('workspace.saveProfile', value), older)
  await page.reload()
  await heading(page, 'Today').waitFor()
  await navigate(page, 'Profile')
  await heading(page, 'Your profile').waitFor()
  await addStory(page, work, false)
  const { experienceStories, ...retained } = await profile(page)
  assert.deepEqual(retained, older)
  assertStory({ experienceStories }, work, false)
}

const directory = await mkdtemp(path.join(tmpdir(), 'pluto-profile-depth-'))
const first = path.join(directory, 'first')
const returning = path.join(directory, 'returning')
try {
  const firstSave = await desktop(first, onboard)
  const updated = await desktop(returning, async page => {
    await navigate(page, 'Profile')
    await heading(page, 'Your profile').waitFor()
    assert.deepEqual(await profile(page), firstSave, 'The confirmed profile survives a full restart')
    return revisitProfile(page, firstSave)
  }, first)
  await desktop(path.join(directory, 'after-edits'), async page => {
    await navigate(page, 'Profile')
    await heading(page, 'Your profile').waitFor()
    assert.deepEqual(await profile(page), updated, 'Returning applicant edits survive a full restart')
  }, returning)
  await desktop(path.join(directory, 'older'), checkOlderProfile)
  console.log('Profile onboarding, reviewed examples, private answers, cancellation, restart and older profile passed.')
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
