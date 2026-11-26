// Only a matched message read from a connected account can be applied to a role.
export function createEmployerReview({ jobMail, mail, getJob, recordUpdate, now = Date.now }) {
  const results = new Map()
  const accountRevisions = new Map()
  const id = (provider, jobId, key) => JSON.stringify([provider, jobId, key])
  const revision = provider => accountRevisions.get(provider) || 0
  function forget(provider) {
    accountRevisions.set(provider, revision(provider) + 1)
    for (const [key, item] of results) if (item.provider === provider) results.delete(key)
  }
  async function scan(params) {
    const original = revision(params.provider)
    const page = await jobMail.scan(params)
    if (revision(params.provider) !== original) throw new Error('The mailbox changed. Check for updates again.')
    for (const match of page?.matches || []) {
      const key = id(params.provider, match.jobId, match.message.key)
      results.delete(key)
      results.set(key, { provider: params.provider, match, expires: now() + 15 * 60_000 })
    }
    for (const [key, item] of results) if (item.expires <= now() || results.size > 256) results.delete(key)
    return page
  }
  async function review({ provider, jobId, messageKey, interviewAt }) {
    const key = id(provider, jobId, messageKey)
    const item = results.get(key)
    if (!item || item.expires <= now()) throw new Error('Check for employer updates again to review this message.')
    const accounts = await mail.settings()
    if (results.get(key) !== item || !accounts.some(a => a.provider === provider && a.email && a.email === item.match.message.account && !a.error)) {
      throw new Error('This mailbox connection changed. Check for updates again.')
    }
    const { match } = item
    const job = getJob(jobId)
    if (!job || job.company !== match.company || job.title !== match.title || job.url !== match.jobUrl) {
      throw new Error('The tracked role changed. Check for employer updates again.')
    }
    return recordUpdate({jobId, message:match.message, purpose:match.purpose, interviewAt})
  }
  return { scan, review, forget }
}
