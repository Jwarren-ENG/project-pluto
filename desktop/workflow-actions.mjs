import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'

const tasks = {
  run: 'Run the configured job search cycle. Review current sources, check employer listings and deduplicate against existing roles and receipts before preparing applications.',
  status: 'Review the status of tracked roles. Match each response to the role, record its evidence and show interviews or recruiter follow-ups that need attention.',
  'interview-prep': 'Prepare for the next confirmed interview. Use the job posting, the actual submitted materials when recorded, the interview invitation and my confirmed experience.',
}

export function managedSummary(settings) {
  if (settings?.configured !== true) return null
  return {
    configured: true, tracker: settings.tracker, vault: settings.vault,
    ok: settings.ok === true, lastCompleted: settings.lastCompleted || null,
  }
}

export function workflowTask(skill, folders, managed, desktopDatabase) {
  if (!Object.hasOwn(tasks, skill)) throw new Error('Choose a Job Kit task.')
  const workspace = folders.kit || managed?.workspacePath
  if (!workspace) throw new Error('Connect a private job workspace first.')
  const vault = folders.vault || managed?.vaultPath
  const useManaged = !folders.kit && managed?.configured
  const instructions = useManaged && managed.skillPath ? managed.skillPath :
    (managed?.kitPath ? path.join(managed.kitPath, 'skills', skill, 'SKILL.md') :
    'https://github.com/Jwarren-ENG/lockedin-job-kit/blob/main/skills/' + skill + '/SKILL.md')
  return [
    tasks[skill], 'Use my existing local workspace ' + JSON.stringify(workspace) + '.',
    'Follow the installed job workflow for this task. Skill reference ' + JSON.stringify(instructions) + '.',
    'Read my current profile, permission choices, schedule, active run locks and existing evidence before acting. Use the same tracker and identifiers as my other runs. Leave unresolved facts for me to answer.',
    desktopDatabase && 'Also check the connected Project Pluto database ' + JSON.stringify(desktopDatabase) + ' in read-only mode. Its jobs, submissions and events tables contain the dashboard’s local edits and immutable receipts. Compare matching roles, preserve both sources when they disagree and resolve any submission uncertainty before retrying. Record confirmed outcomes in the existing tracker so the next refresh can bring them back into Pluto.',
    'Count a submission only with a role-matched receipt or my explicit confirmation. Preserve uncertain submissions and previous outcomes.',
    vault && 'Update my connected Obsidian vault at ' + JSON.stringify(vault) + ' if my current permissions allow it.',
  ].filter(Boolean).join('\n\n')
}

export function vaultAddress(folders, managed) {
  const vault = folders.vault || managed?.vaultPath
  if (!vault) throw new Error('Connect an Obsidian vault first.')
  if (!folders.vault && managed?.vaultHome) {
    const home = path.resolve(vault, managed.vaultHome)
    if (!home.startsWith(path.resolve(vault) + path.sep)) throw new Error('Invalid vault home.')
    return 'obsidian://open?path=' + encodeURIComponent(home)
  }
  return 'obsidian://open?vault=' + encodeURIComponent(path.basename(vault))
}

// A separate local synchronizer watches this fixed directory. The request has
// no executable content. Existing host schedules keep ownership of job actions.
export async function requestManagedRefresh(directory) {
  const folder = path.join(directory, 'workflow-requests')
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const request = randomUUID()
  const temp = path.join(folder, request + '.tmp')
  try {
    await writeFile(temp, JSON.stringify({ request }), { flag: 'wx', mode: 0o600 })
    await rename(temp, path.join(folder, 'sync.json'))
  } finally { await rm(temp, { force: true }) }
}
