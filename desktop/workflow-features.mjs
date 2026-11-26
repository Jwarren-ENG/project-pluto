export const featureNames = Object.freeze({
  studyGuides: 'Study guides',
  interviewPrep: 'Interview prep',
  emailCheck: 'Email checker',
  autoApply: 'Auto apply',
})

export function workflowFeatures(saved) {
  return Object.fromEntries(Object.keys(featureNames).map(key => [key, saved?.[key] === true]))
}

export function requireFeature(features, key) {
  if (!Object.hasOwn(featureNames, key)) throw new Error('Unknown optional workflow.')
  if (features?.[key] !== true) throw new Error('Turn on ' + featureNames[key] + ' in Connections first.')
}

export function hasDraftMaterial(profile) {
  if (!profile) return false
  const filled = value => typeof value === 'string' && Boolean(value.trim())
  const reviewed = Array.isArray(profile.confirmedFacts)
    ? profile.confirmedFacts.some(fact => filled(typeof fact === 'string' ? fact : fact?.text))
    : filled(profile.resumeText)
  return reviewed || filled(profile.summary) ||
    (Array.isArray(profile.experienceStories) && profile.experienceStories.some(story => story?.useInDrafts === true && filled(story.action)))
}
