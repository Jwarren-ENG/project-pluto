import { readFileSync } from 'node:fs'

export function publisherRegistrations(env = {}) {
  const result = {}
  const googleId = env.PLUTO_GOOGLE_DESKTOP_CLIENT_ID?.trim()
  const outlookId = env.PLUTO_OUTLOOK_DESKTOP_CLIENT_ID?.trim()
  if (googleId) {
    if (!/^[a-zA-Z0-9._-]{1,200}\.apps\.googleusercontent\.com$/.test(googleId)) throw new Error('Invalid Google desktop client ID.')
    const secret = env.PLUTO_GOOGLE_DESKTOP_CLIENT_SECRET?.trim() || ''
    if (secret.length > 512 || /\s/.test(secret)) throw new Error('Invalid Google desktop registration.')
    result.gmail = { clientId: googleId, clientSecret: secret }
  }
  if (outlookId) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(outlookId)) throw new Error('Invalid Outlook desktop client ID.')
    result.outlook = { clientId: outlookId }
  }
  return result
}

export function readRegistrations() {
  let installed = {}
  try {
    installed = JSON.parse(readFileSync(new URL('./oauth-build.json', import.meta.url), 'utf8'))
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  return { ...installed, ...publisherRegistrations(process.env) }
}
