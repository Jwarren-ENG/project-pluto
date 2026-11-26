// Feature smoke tests begin at Today. First-run behavior has its own desktop suite.
export async function enterFixtureWorkspace(page) {
  const today = page.getByRole('heading', {name:'Today',exact:true})
  const skip = page.getByRole('button', {name:'Skip setup',exact:true})
  await today.or(skip).first().waitFor()
  if (await skip.isVisible()) await skip.click()
  await today.waitFor()
}

// Every caller isolates Pluto with --user-data-dir. Windows Chromium also needs
// the native profile and temp locations while starting its renderer processes.
export function fixtureEnvironment(home) {
  const system = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|SystemRoot|WINDIR|LANG|LC_ALL|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)$/i.test(key)))
  if (process.platform === 'win32') return { ...system, CODEX_HOME: home }
  return { ...system, HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home,
    XDG_CACHE_HOME: home, CODEX_HOME: home, TMPDIR: home }
}
