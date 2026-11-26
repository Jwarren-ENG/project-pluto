import { localDay } from './schedule.mjs'

export function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(value)
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value
}

// Calendar days have no instant. A timestamp belongs to the day at the viewer's location.
export function recordDate(value) {
  if (typeof value !== 'string' || !validDay(value.slice(0, 10))) return null
  if (value.length === 10) return { day: value, instant: null }
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/i.test(value)) return null
  const instant = new Date(value)
  return Number.isFinite(instant.valueOf()) ? { day: localDay(instant), instant } : null
}

export function formatRecordDate(value, dayOptions, timestampOptions = dayOptions) {
  const parsed = recordDate(value)
  if (!parsed) return 'Date unknown'
  if (parsed.instant) return parsed.instant.toLocaleString(undefined, timestampOptions)
  // UTC is only the formatter's calendar here. Never render a time for this value.
  return new Date(parsed.day).toLocaleDateString(undefined, { ...dayOptions, timeZone: 'UTC' })
}

// Unknown dates sort last in either direction. On one day, timed events retain their order.
export function compareRecordDates(a, b, direction = 1) {
  if (!a || !b) return Number(!a) - Number(!b)
  const dayOrder = a.day.localeCompare(b.day)
  const timeOrder = a.instant && b.instant ? a.instant - b.instant : Number(!!a.instant) - Number(!!b.instant)
  return direction * (dayOrder || timeOrder)
}

export function upcomingInterviews(jobs, { now = new Date(), includePending = false } = {}) {
  const today = localDay(now)
  return jobs.filter(job => job.stage === 'Interview')
    .map(job => ({ job, at: recordDate(job.interviewAt) }))
    .filter(({ job, at }) => at ? (at.instant ? at.instant >= now : at.day >= today) : includePending && job.interviewStatus !== 'canceled')
    .sort((a, b) => compareRecordDates(a.at, b.at))
    .map(({ job }) => job)
}
