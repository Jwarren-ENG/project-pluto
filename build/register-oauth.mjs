import { writeFileSync } from 'node:fs'
import { publisherRegistrations } from '../desktop/oauth-registrations.mjs'

const registration = publisherRegistrations(process.env)
writeFileSync(new URL('../desktop/oauth-build.json', import.meta.url), JSON.stringify(registration), { mode: 0o600 })
