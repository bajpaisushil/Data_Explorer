/**
 * End-to-end smoke test against a running dev or preview server.
 *
 *   npm run dev            # in one shell
 *   npm run test:e2e       # in another
 *
 * It drives the real app in a real browser: generates a million rows through
 * the worker, exercises the scaled-spacer virtualization at both extremes of
 * the scroll range, then search, filter, group, saved views, the storage
 * panel, an IndexedDB round trip across a page reload, and clearing storage.
 *
 * This is not decoration. It caught two bugs no unit test could: rows that
 * rendered off-screen because a sticky layer sat after an 8,000,000px spacer,
 * and a profiling pass that starved the grid of its data for five seconds.
 *
 * ROWS=10000 npm run test:e2e   # faster run, skips the scaled-spacer path
 */
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const OUT = process.env.E2E_OUT || './e2e/screenshots'
const BASE = process.env.E2E_BASE || 'http://localhost:3000/'
const ROWS = Number(process.env.ROWS || 1000000)

const fails = []
const notes = []
function check(name, cond, detail = '') {
  if (cond) notes.push(`  PASS  ${name}`)
  else {
    fails.push(`${name}${detail ? ' :: ' + detail : ''}`)
    notes.push(`  FAIL  ${name} ${detail}`)
  }
}

await mkdir(OUT, { recursive: true })

const browser = await chromium.launch({
  // Set E2E_CHROME to a local Chrome/Chromium binary, or run
  // `npx playwright install chromium` first.
  executablePath: process.env.E2E_CHROME || undefined,
  channel: process.env.E2E_CHROME ? undefined : 'chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const ctx = await browser.newContext({ viewport: { width: 1500, height: 940 } })
const page = await ctx.newPage()

const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))

const grid = () => page.locator('[role="grid"]')
const statusText = () => page.locator('footer').innerText()

async function gridScrollTo(fraction) {
  await page.evaluate((f) => {
    const el = document.querySelector('[role="grid"]')
    el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * f)
  }, fraction)
  await page.waitForTimeout(1300)
}

console.log(`\n=== 1. generate ${ROWS.toLocaleString()} rows ===`)
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('text=DataForge', { timeout: 30000 })
await page.selectOption('select[aria-label="Number of rows to generate"]', String(ROWS))
const t0 = Date.now()
await page.click('text=E-commerce orders')
await page.waitForSelector('[role="gridcell"]', { timeout: 300000 })
const genMs = Date.now() - t0
console.log(`  generated + parsed + first window in ${(genMs / 1000).toFixed(1)}s`)

const rowCountAttr = Number(await grid().getAttribute('aria-rowcount'))
check('aria-rowcount equals the dataset size', rowCountAttr === ROWS, `got ${rowCountAttr}`)
const status1 = await statusText()
check('status bar reports the full row count', status1.includes(ROWS.toLocaleString('en-US')), status1.replace(/\n/g, ' | '))
await page.screenshot({ path: `${OUT}/e2e-01-million.png` })

console.log('\n=== 2. the scaled-spacer path (the reason this test exists) ===')
const scrollInfo = await page.evaluate(() => {
  const el = document.querySelector('[role="grid"]')
  return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
})
console.log(`  scrollHeight=${scrollInfo.scrollHeight.toLocaleString()} clientHeight=${scrollInfo.clientHeight}`)
// 1,000,000 x 32px = 32,000,000px, past the engine ceiling, so the spacer must be capped.
check(
  'scroll spacer is capped below the browser element-height ceiling',
  scrollInfo.scrollHeight < 9_000_000,
  `scrollHeight=${scrollInfo.scrollHeight}`,
)

await gridScrollTo(1)
const lastIdx = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[role="row"][aria-rowindex]')]
    .map((r) => Number(r.getAttribute('aria-rowindex')))
    .filter((n) => n > 1)
  return rows.length ? Math.max(...rows) : -1
})
// aria-rowindex is 1-based with the header at 1, so the final data row is ROWS + 1.
check('scrolling fully to the bottom lands exactly on the last row', lastIdx === ROWS + 1, `got aria-rowindex ${lastIdx}, expected ${ROWS + 1}`)
const bottomCells = await page.locator('[role="gridcell"]').count()
check('rows are still rendered at the bottom of the scroll range', bottomCells > 0, `cells=${bottomCells}`)
await page.screenshot({ path: `${OUT}/e2e-02-bottom.png` })

await gridScrollTo(0.5)
const midCells = await page.locator('[role="gridcell"]').count()
const midBlank = await page.locator('.df-skeleton').count()
check('rows load after a jump to the middle of a million', midCells > 0 && midBlank === 0, `cells=${midCells} skeletons=${midBlank}`)
await page.screenshot({ path: `${OUT}/e2e-03-middle.png` })

await gridScrollTo(0)
const topIdx = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[role="row"][aria-rowindex]')]
    .map((r) => Number(r.getAttribute('aria-rowindex')))
    .filter((n) => n > 1)
  return rows.length ? Math.min(...rows) : -1
})
check('scrolling back to the top lands on row 1', topIdx === 2, `got ${topIdx}`)

console.log('\n=== 3. search narrows the result set ===')
await page.fill('input[aria-label="Search every column"]', 'Japan')
await page.waitForTimeout(3500)
const status2 = await statusText()
const matched = Number((status2.match(/([\d,]+) of ([\d,]+) rows/) || [])[1]?.replace(/,/g, '') || -1)
check('search reduces the matched row count', matched > 0 && matched < ROWS, `matched=${matched}`)
await page.screenshot({ path: `${OUT}/e2e-04-search.png` })
await page.fill('input[aria-label="Search every column"]', '')
await page.waitForTimeout(2500)

console.log('\n=== 4. filter ===')
await page.click('button:has-text("Filter")')
await page.waitForTimeout(600)
await page.selectOption('select[aria-label="Column"]', { label: 'country' })
await page.waitForTimeout(400)
await page.selectOption('select[aria-label="Condition"]', 'eq')
await page.fill('input[aria-label="Value"]', 'Japan')
await page.click('button:has-text("Apply filter")')
await page.waitForTimeout(4000)
const status3 = await statusText()
const filtered = Number((status3.match(/([\d,]+) of ([\d,]+) rows/) || [])[1]?.replace(/,/g, '') || -1)
check('filter narrows the result set', filtered > 0 && filtered < ROWS, `matched=${filtered}`)
check('filter chip is shown', (await page.locator('text=country').count()) > 0)
await page.screenshot({ path: `${OUT}/e2e-05-filter.png` })

console.log('\n=== 5. group ===')
await page.click('button:has-text("Group")')
await page.waitForTimeout(600)
const catBox = page.locator('label:has-text("category") input[type="checkbox"]').first()
if (await catBox.count()) {
  await catBox.check()
  await page.waitForTimeout(4000)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)
  const status4 = await statusText()
  check('grouping reports a group count', /groups/.test(status4), status4.replace(/\n/g, ' | '))
  const groupCells = await page.locator('[role="gridcell"]').count()
  check('grouped rows render', groupCells > 0, `cells=${groupCells}`)
  await page.screenshot({ path: `${OUT}/e2e-06-group.png` })
  // Ungroup so later steps see plain rows again.
  await page.click('button:has-text("category")').catch(() => {})
  await page.waitForTimeout(600)
  await page.click('text=Stop grouping').catch(() => {})
  await page.waitForTimeout(3000)
} else {
  notes.push('  SKIP  grouping (category checkbox not found)')
}
await page.keyboard.press('Escape')

console.log('\n=== 6. saved views ===')
await page.click('button:has-text("Views")')
await page.waitForTimeout(800)
await page.fill('input[aria-label="Name this view"]', 'Japan only')
await page.click('button:has-text("Save current view")')
await page.waitForTimeout(2500)
check('the saved view appears in the list', (await page.locator('aside >> text=Japan only').count()) > 0)
await page.screenshot({ path: `${OUT}/e2e-07-views.png` })

console.log('\n=== 7. memory & storage panel ===')
await page.click('footer button:has-text("stored")').catch(async () => {
  await page.click('button[aria-label="More actions"]')
  await page.click('text=Memory')
})
await page.waitForTimeout(2500)
const panelText = await page.locator('aside').innerText().catch(() => '')
check('storage panel reports in-tab column memory', /Column memory/i.test(panelText), panelText.slice(0, 160))
check('storage panel reports browser usage', /used/i.test(panelText))
await page.screenshot({ path: `${OUT}/e2e-08-storage.png` })

console.log('\n=== 8. persist to IndexedDB and reload ===')
await page.click('footer button:has-text("Save locally")')
// A million rows is a lot of bytes; give it room.
await page.waitForSelector('text=/Saved to this browser/i', { timeout: 300000 }).catch(() => {})
await page.waitForTimeout(3000)
await page.screenshot({ path: `${OUT}/e2e-09-saved.png` })

await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('text=Saved in this browser', { timeout: 60000 }).catch(() => {})
await page.waitForTimeout(2500)
const landing = await page.locator('body').innerText()
check('the saved dataset survives a page reload', /Saved in this browser/.test(landing), landing.slice(0, 200))
check('landing screen reports storage usage', /used/.test(landing))
await page.screenshot({ path: `${OUT}/e2e-10-reload.png` })

const savedRow = page.locator('li button:has-text("ecommerce")').first()
if (await savedRow.count()) {
  await savedRow.click()
  await page.waitForSelector('[role="gridcell"]', { timeout: 300000 })
  await page.waitForTimeout(2000)
  const reloadedCount = Number(await grid().getAttribute('aria-rowcount'))
  check('reloading from IndexedDB restores every row', reloadedCount === ROWS, `got ${reloadedCount}`)
  const firstCell = await page.locator('[role="gridcell"]').first().innerText()
  check('restored cells hold real values', firstCell.trim().length > 0, `first cell="${firstCell}"`)
  await page.screenshot({ path: `${OUT}/e2e-11-restored.png` })
} else {
  check('saved dataset is listed for reopening', false, 'no saved dataset row found')
}

console.log('\n=== 9. clear storage ===')
await page.click('button:has-text("Clear all")').catch(() => {})
await page.waitForTimeout(3000)
await page.screenshot({ path: `${OUT}/e2e-12-cleared.png` })

console.log('\n---------------- RESULTS ----------------')
console.log(notes.join('\n'))
console.log('\nCONSOLE ERRORS:', errors.length ? '\n' + errors.slice(0, 15).join('\n') : '(none)')
console.log('\nFAILURES:', fails.length ? '\n - ' + fails.join('\n - ') : '(none)')
console.log('\nRESULT:', fails.length || errors.length ? 'PROBLEMS FOUND' : 'ALL CLEAR')

await browser.close()
