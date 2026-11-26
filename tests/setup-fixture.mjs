// Feature smoke tests begin at Today. First-run behavior has its own desktop suite.
export async function enterFixtureWorkspace(page) {
  const today = page.getByRole('heading', {name:'Today',exact:true})
  const skip = page.getByRole('button', {name:'Skip setup',exact:true})
  await today.or(skip).first().waitFor()
  if (await skip.isVisible()) await skip.click()
  await today.waitFor()
}
