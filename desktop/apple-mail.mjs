import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'

const provider = 'apple'
const account = 'Apple Mail'
const preference = 'mail.apple.connected'
const maxResults = 20
const windowDays = 45

// The raw terms are from com.apple.mail's installed Mail.sdef. A variable
// target lets osacompile compile this script without contacting Mail.
// apve = application version; inmb = Inbox; mssg = message; rdrc = received
// date; subj = subject; sndr = sender; ID = Mail's local integer identifier.
const preamble = `
use framework "Foundation"
use scripting additions

on clipped(v, maxChars)
  if v is missing value then return ""
  set s to v as text
  if (length of s) > maxChars then return text 1 thru maxChars of s
  return s
end clipped

`

// 'inbox' belongs to the application, not to Mail's account class. Resolve
// an account by immutable ID, then its named Inbox and that mailbox's owner.
const resolveAccount = `
    tell application id mailID
      considering case
        set candidates to get (every «class mact» whose «property ID  » is wantedID and «property isac» is true)
        if (count candidates) is not 1 then return "ACCOUNT_GONE"
        set selectedAccount to a reference to «class mact» id wantedID
        if (get «property ID  » of selectedAccount) is not wantedID then return "ACCOUNT_GONE"
      end considering
    end tell`

const resolveInbox = `
    tell application id mailID
      ignoring case
        set folders to get (every «class mbxp» of selectedAccount whose «property pnam» is "INBOX")
      end ignoring
      if (count folders) is not 1 then return "INBOX_GONE"
      set inboxName to get «property pnam» of item 1 of folders
      set selectedInbox to a reference to «class mbxp» inboxName of «class mact» id wantedID
      considering case
        if (get «property ID  » of «property mact» of selectedInbox) is not wantedID then return "INBOX_GONE"
      end considering
    end tell`

const knownErrors = `  on error number errNo
    if errNo is -1743 or errNo is -1744 then return "DENIED"
    if errNo is -1712 then return "TIMEOUT"
    return "UNAVAILABLE"
  end try
end run`

const encodeRows = `    set bytes to current application's NSJSONSerialization's dataWithJSONObject:rows options:0 |error|:(missing value)
    return (current application's NSString's alloc()'s initWithData:bytes encoding:4) as text`

function accountScript(select) {
  return preamble + `
on run argv
  set mailID to "com.apple.mail"
  try
    ${select ? `set wantedID to item 2 of argv
    ${resolveAccount}
    ${resolveInbox}
    set accountRefs to {selectedAccount}` : `tell application id mailID
      set accountRefs to get (every «class mact» whose «property isac» is true)
    end tell`}
    if (count accountRefs) > 256 then return "ACCOUNT_LIMIT"
    set rows to current application's NSMutableArray's array()
    repeat with accountRef in accountRefs
      tell application id mailID
        set nativeID to get «property ID  » of accountRef
        set nativeName to get «property pnam» of accountRef
        set addresses to get «property emad» of accountRef
      end tell
      if (count addresses) > 0 then
        set row to current application's NSMutableDictionary's dictionary()
        row's setObject:(nativeID as text) forKey:"id"
        row's setObject:(my clipped(nativeName, 160)) forKey:"label"
        row's setObject:(item 1 of addresses as text) forKey:"email"
        rows's addObject:row
      end if
    end repeat
${encodeRows}
${knownErrors}
`
}

function scanScript(scoped) {
  const inbox = scoped ? 'selectedInbox' : '«property inmb»'
  return preamble + `
on run argv
  set mailID to "com.apple.mail"
  try
    ${scoped ? `if item 1 of argv is not "scan" or (count argv) is not 4 then return "INVALID"
    set wantedID to item 3 of argv
    set expectedEmail to item 4 of argv
    ${resolveAccount}
    tell application id mailID
      set addresses to get «property emad» of selectedAccount
    end tell
    if (count addresses) is 0 then return "ACCOUNT_GONE"
    ignoring case
      if (item 1 of addresses as text) is not expectedEmail then return "ACCOUNT_GONE"
    end ignoring
    ${resolveInbox}` : `if item 1 of argv is "connect" then
      tell application id mailID to get «property apve»
      return "true"
    end if
    if item 1 of argv is not "scan" or (count argv) is not 2 then return "INVALID"`}
    set companyName to item 2 of argv
    set ceilingDate to current date
    set firstDate to ceilingDate - (${windowDays} * days)
    set spanSeconds to ceilingDate - firstDate
    set hits to {}
    repeat 72 times
      set floorDate to ceilingDate - spanSeconds
      tell application id mailID
        set hitCount to count (every «class mssg» of ${inbox} whose «property rdrc» ≥ floorDate and «property rdrc» ≤ ceilingDate and («property subj» contains companyName or «property sndr» contains companyName))
        if hitCount ≤ ${maxResults} then
          if hitCount > 0 then set batchHits to get (every «class mssg» of ${inbox} whose «property rdrc» ≥ floorDate and «property rdrc» ≤ ceilingDate and («property subj» contains companyName or «property sndr» contains companyName))
        end if
      end tell
      if hitCount ≤ ${maxResults} then
        if hitCount > 0 then set hits to hits & batchHits
        if (count hits) ≥ ${maxResults} or floorDate ≤ firstDate then exit repeat
        set ceilingDate to floorDate - 1
        set spanSeconds to ceilingDate - firstDate
      else
        if spanSeconds ≤ 0 then return "TOO_MANY"
        set spanSeconds to spanSeconds div 2
      end if
    end repeat
    set rows to current application's NSMutableArray's array()
    repeat with hitRef in hits
      if (rows's |count|() as integer) ≥ ${maxResults} then exit repeat
      tell application id mailID
        ${scoped ? `considering case
          if (get «property ID  » of «property mact» of «property mbxp» of hitRef) is not wantedID then return "INBOX_GONE"
        end considering` : ''}
        set msgID to get «property ID  » of hitRef
        set msgFrom to get «property sndr» of hitRef
        set msgSubject to get «property subj» of hitRef
        set msgDate to get «property rdrc» of hitRef
      end tell
      set stamp to current application's NSDate's dateWithTimeInterval:0 sinceDate:msgDate
      set row to current application's NSMutableDictionary's dictionary()
      row's setObject:(msgID as text) forKey:"id"
      row's setObject:(my clipped(msgFrom, 320)) forKey:"from"
      row's setObject:(my clipped(msgSubject, 500)) forKey:"subject"
      row's setObject:(stamp's timeIntervalSince1970()) forKey:"seconds"
      rows's addObject:row
    end repeat
${encodeRows}
${knownErrors}
`
}

function clean(value, max) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

function employer(company) {
  if (typeof company !== 'string' || company.length > 160 || !company.trim() ||
      /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(company) || !/[\p{L}\p{N}]/u.test(company)) {
    throw new Error('Choose a tracked employer before checking Apple Mail.')
  }
  return company.normalize('NFKC').trim()
}

function nativeRun(mode, args, script, signal, executeFile) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Apple Mail check cancelled.'))
    const argv = ['-l', 'AppleScript', '-', mode, ...args]
    const child = executeFile('/usr/bin/osascript', argv, { shell: false, encoding: 'utf8', signal,
      timeout: mode === 'scan' ? 20000 : 90000, killSignal: 'SIGKILL', maxBuffer: 96 * 1024,
      env: { PATH: '/usr/bin:/bin' } }, (error, stdout) => {
      if (signal.aborted) return reject(new Error('Apple Mail check cancelled.'))
      if (error?.killed) return reject(new Error('Apple Mail took too long to respond. Try again.'))
      if (error) return reject(new Error('Couldn’t run the Apple Mail check. Verify that Mail is installed.'))
      resolve(stdout.trim())
    })
    child.stdin.on('error', () => { /* The exit callback handles a closed child. */ })
    child.stdin.end(script)
  })
}

function decode(output) {
  if (output === 'ACCOUNT_GONE') throw Object.assign(new Error('The selected Apple Mail account changed or is no longer enabled. Disconnect and choose an account again.'), { code: 'APPLE_ACCOUNT_GONE' })
  if (output === 'INBOX_GONE') throw new Error('Couldn’t identify an Inbox belonging to the selected Apple Mail account.')
  if (output === 'ACCOUNT_LIMIT') throw new Error('Apple Mail returned too many accounts.')
  if (output === 'DENIED') throw new Error('Allow Pluto to control Mail in System Settings → Privacy & Security → Automation, then reconnect.')
  if (output === 'TIMEOUT') throw new Error('Apple Mail took too long to respond. Try again.')
  if (output === 'TOO_MANY') throw new Error('Too many matching Apple Mail messages arrived at once. Review this employer in Mail.')
  if (typeof output !== 'string' || Buffer.byteLength(output) > 96 * 1024) throw new Error('Apple Mail returned an unreadable response.')
  try { return JSON.parse(output) } catch { throw new Error('Couldn’t read from Apple Mail. Open Mail and check the account setup.') }
}

function messages(rows, company, source, selection) {
  if (!Array.isArray(rows) || rows.length > maxResults) throw new Error('Apple Mail returned an unreadable response.')
  const matches = new Map()
  const phrase = company.toLocaleLowerCase()
  const time = Date.now()
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !/^\d{1,20}$/.test(row.id) || !Number.isFinite(row.seconds)) continue
    const millis = Math.round(row.seconds * 1000)
    if (millis < time - windowDays * 86400000 - 60000 || millis > time + 60000) continue
    const from = clean(row.from, 320), subject = clean(row.subject, 500)
    if (![from, subject].some(text => text.normalize('NFKC').toLocaleLowerCase().includes(phrase))) continue
    const key = createHash('sha256').update(JSON.stringify(selection ? [source, selection.id, row.id] : [provider, row.id])).digest('hex')
    matches.set(key, { provider: source, key, account: selection?.email || account, from, subject: subject || '(No subject)', receivedAt: new Date(millis).toISOString(), preview: '', url: '' })
  }
  return [...matches.values()].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
}

const scopedProviders = new Set(['gmail', 'outlook'])
const bindingKey = source => 'mail.apple.binding.' + source
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 256 && id === clean(id, 256)
const validEmail = email => typeof email === 'string' && email.length <= 320 && email === clean(email, 320) && /^[^\s@<>]+@[^\s@<>]+$/.test(email)

function validBinding(binding) {
  return validId(binding?.id) && validEmail(binding.email) && !binding.removed
}

function accountRows(rows) {
  if (!Array.isArray(rows) || rows.length > 256) throw new Error('Apple Mail returned an unreadable account list.')
  const ids = new Set()
  return rows.flatMap(row => {
    if (!validId(row?.id) || !validEmail(row.email)) return []
    if (ids.has(row.id)) throw new Error('Apple Mail returned ambiguous account identifiers.')
    ids.add(row.id)
    return [{ id: row.id, label: clean(row.label, 160) || row.email, email: row.email }]
  })
}

export function createAppleMail({ prefs, platform = process.platform, executeFile = execFile }) {
  const active = new Map()
  let closed = false
  const available = platform === 'darwin'

  // Local settings can be displayed without launching Mail or prompting for access.
  function settings(source = provider) {
    const busy = active.get(source)?.kind || ''
    if (source === provider) return { provider, available, direct: true, email: available && prefs.get(preference) === true ? account : '', busy }
    if (!scopedProviders.has(source)) throw new Error('Choose a supported mail provider.')
    const binding = prefs.get(bindingKey(source))
    if (binding == null) return null
    const ready = available && validBinding(binding)
    return { provider: source, via: 'apple', email: validEmail(binding.email) ? binding.email : '', busy,
      ...(!ready && { error: 'Disconnect this Apple Mail connection and choose an available account.' }) }
  }

  async function operation(scope, kind, payload, work) {
    const pending = active.get(scope)
    if (payload?.cancel === true) {
      if (pending?.kind === kind) {
        pending.controller.abort()
        await pending.done.catch(() => {})
      }
      return null
    }
    if (!available || closed) throw new Error('Apple Mail is available in the running macOS app.')
    if (pending) throw new Error('An Apple Mail action is already in progress.')
    const controller = new AbortController()
    const task = { kind, controller }
    const invoke = async (mode, args, script) => {
      const raw = await nativeRun(mode, args, script, controller.signal, executeFile)
      if (controller.signal.aborted) throw new Error('Apple Mail check cancelled.')
      return decode(raw)
    }
    task.done = Promise.resolve().then(() => work(invoke, controller.signal)).finally(() => { active.delete(scope) })
    active.set(scope, task)
    return task.done
  }

  const appleAccounts = (payload = {}) => operation('picker', 'accounts', payload,
    async invoke => accountRows(await invoke('accounts', [], accountScript(false))))

  function connect(payload = {}) {
    const source = payload.provider ?? provider
    return operation(source, 'connect', payload, async (invoke, signal) => {
      if (source === provider) {
        if (Object.hasOwn(payload, 'appleAccountId')) throw new Error('Choose Gmail or Outlook to connect a specific mailbox.')
        if (await invoke('connect', [], scanScript(false)) !== true) throw new Error('Apple Mail did not confirm the connection.')
        if (signal.aborted) throw new Error('Apple Mail check cancelled.')
        prefs.set(preference, true)
        return { provider, email: account }
      }
      if (!scopedProviders.has(source) || !validId(payload.appleAccountId)) throw new Error('Choose an available Apple Mail account.')
      const rows = accountRows(await invoke('select', [payload.appleAccountId], accountScript(true)))
      if (rows.length !== 1 || rows[0].id !== payload.appleAccountId) throw new Error('The selected Apple Mail account is unavailable. Choose an account again.')
      const { id, email } = rows[0]
      if (signal.aborted) throw new Error('Apple Mail check cancelled.')
      prefs.set(bindingKey(source), { id, email })
      return { provider: source, via: 'apple', email }
    })
  }

  function scan(payload = {}) {
    const source = payload.provider ?? provider
    return operation(source, 'scan', payload, async (invoke, signal) => {
      const company = employer(payload.company)
      const scoped = source !== provider
      if (scoped && !scopedProviders.has(source)) throw new Error('Choose a supported mail provider.')
      const binding = scoped ? prefs.get(bindingKey(source)) : null
      if (scoped && !validBinding(binding)) throw new Error('Disconnect this Apple Mail connection and choose an available account.')
      if (!scoped && !settings().email) throw new Error('Connect Apple Mail before checking for replies.')
      const args = scoped ? [company, binding.id, binding.email] : [company]
      try {
        return messages(await invoke('scan', args, scanScript(scoped)), company, source, binding)
      } catch (error) {
        if (!signal.aborted && binding && error.code === 'APPLE_ACCOUNT_GONE') prefs.set(bindingKey(source), { ...binding, removed: true })
        throw error
      }
    })
  }

  async function disconnect(payload = {}) {
    const source = payload.provider ?? provider
    if (source !== provider && !scopedProviders.has(source)) throw new Error('Choose a supported mail provider.')
    const pending = active.get(source)
    pending?.controller.abort()
    if (source === provider) prefs.set(preference, false)
    else prefs.set(bindingKey(source), null)
    await pending?.done.catch(() => {})
    return { provider: source, email: '' }
  }
  function close() {
    closed = true
    for (const task of active.values()) task.controller.abort()
  }
  return { settings, appleAccounts, connect, disconnect, scan, close }
}
