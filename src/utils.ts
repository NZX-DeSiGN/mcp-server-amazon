import fs from 'fs'
import puppeteer from 'puppeteer'
import { COOKIES_FILE_PATH, AMAZON_COOKIES, IS_BROWSER_VISIBLE, REUSE_BROWSER, BROWSER_IDLE_TIMEOUT_MS, BLOCK_ASSETS } from './config.js'

/** Get the current timestamp like "2024-06-06_15-30-45" */
export function getTimestamp() {
  const now = new Date()
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(
    now.getSeconds()
  )}`
}

/**
 * Load the exported Amazon cookies, or return an empty list when the file is missing.
 *
 * Missing cookies is not fatal: anonymous scraping (product search, product details,
 * public reviews) works fine without them, and mock mode needs no network at all.
 * Tools that really need a session call `throwIfNotLoggedIn()` once the page is loaded.
 */
export function loadAmazonCookiesFile() {
  if (!fs.existsSync(COOKIES_FILE_PATH)) {
    console.error(
      `[WARN] No cookies file found at ${COOKIES_FILE_PATH}. Running anonymously - ` +
        'cart, orders and full review pages will not be available. ' +
        'Create it by logging into Amazon and exporting your cookies.'
    )
    return []
  }

  try {
    const json = JSON.parse(fs.readFileSync(COOKIES_FILE_PATH, 'utf-8'))
    console.error('[INFO] Loaded Amazon cookies from file')
    return json.map((cookie: any) => ({
      ...cookie,
      // Ensure sameSite is set to a valid value
      sameSite: cookie.sameSite || 'Lax',
    }))
  } catch (error: any) {
    throw new Error(`Error reading or parsing ${COOKIES_FILE_PATH}: ${error.message}`)
  }
}

// ##################################
// Shared browser
// ##################################

/**
 * One Chrome is shared by every tool call and closed again once nothing has used it for
 * BROWSER_IDLE_TIMEOUT_MS. Launching costs ~180ms - worth avoiding on every call - but an
 * idle browser holds a few hundred MB, which is not worth keeping for a server that spends
 * most of its life waiting.
 */
let sharedBrowser: puppeteer.Browser | null = null
let launchInFlight: Promise<puppeteer.Browser> | null = null
let pagesInUse = 0
let idleTimer: NodeJS.Timeout | null = null

async function launchBrowser(): Promise<puppeteer.Browser> {
  const browser = await puppeteer.launch({
    headless: !IS_BROWSER_VISIBLE,
    devtools: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
    defaultViewport: null,
  })

  if (AMAZON_COOKIES?.length > 0) {
    await browser.setCookie(...AMAZON_COOKIES)
    console.error('[INFO] Set Amazon cookies in the browser')
  } else {
    console.error('[WARN] No Amazon cookies found, proceeding without them')
  }

  return browser
}

async function acquireBrowser(): Promise<puppeteer.Browser> {
  if (sharedBrowser?.connected) return sharedBrowser
  // Concurrent calls must not each launch their own Chrome
  if (launchInFlight) return launchInFlight

  launchInFlight = launchBrowser()
    .then(browser => {
      sharedBrowser = browser
      // Chrome can die on its own; drop the handle so the next call relaunches
      browser.on('disconnected', () => {
        if (sharedBrowser === browser) sharedBrowser = null
      })
      return browser
    })
    .finally(() => {
      launchInFlight = null
    })

  return launchInFlight
}

function cancelIdleClose() {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

function scheduleIdleClose() {
  cancelIdleClose()
  if (pagesInUse > 0 || !sharedBrowser) return

  if (!REUSE_BROWSER) {
    void closeSharedBrowser()
    return
  }
  if (BROWSER_IDLE_TIMEOUT_MS === 0) return

  idleTimer = setTimeout(() => {
    if (pagesInUse === 0) {
      console.error(`[INFO] Closing idle browser after ${BROWSER_IDLE_TIMEOUT_MS}ms without activity`)
      void closeSharedBrowser()
    }
  }, BROWSER_IDLE_TIMEOUT_MS)
  // Never let the idle timer keep the process alive on its own
  idleTimer.unref?.()
}

export async function closeSharedBrowser(): Promise<void> {
  cancelIdleClose()
  const browser = sharedBrowser
  sharedBrowser = null
  if (browser) await browser.close().catch(() => {})
}

/**
 * Run `fn` with a fresh page on the shared browser, then close the page (not the browser).
 * Always use this rather than launching Chrome directly, so the reuse accounting stays correct.
 */
export async function withPage<T>(fn: (page: puppeteer.Page) => Promise<T>, options: WithPageOptions = {}): Promise<T> {
  cancelIdleClose()
  pagesInUse++

  let page: puppeteer.Page | undefined
  try {
    const browser = await acquireBrowser()
    page = await browser.newPage()
    await preparePage(page, options)
    return await fn(page)
  } finally {
    if (page) await page.close().catch(() => {})
    pagesInUse--
    scheduleIdleClose()
  }
}

export interface WithPageOptions {
  /**
   * Set for flows that click Amazon's widgets: nothing is blocked, so the page renders and
   * behaves like a real one. Scraping flows leave it off and skip the useless bytes.
   */
  interactive?: boolean
}

/** Resource kinds a scraper never reads - the HTML is all cheerio ever sees */
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font', 'stylesheet'])

/** Ad, beacon and metrics endpoints; blocking them also stops them from delaying the page */
const BLOCKED_HOSTS = /unagi\.|fls-na|fls-eu|adsystem|advertising\.amazon|csm\/showads|paets\.advertising|\/x\/px\?/

async function preparePage(page: puppeteer.Page, options: WithPageOptions): Promise<void> {
  if (BLOCK_ASSETS && !options.interactive) {
    await page.setRequestInterception(true)
    page.on('request', request => {
      if (BLOCKED_RESOURCE_TYPES.has(request.resourceType()) || BLOCKED_HOSTS.test(request.url())) {
        void request.abort().catch(() => {})
        return
      }
      void request.continue().catch(() => {})
    })
  }

  // Remove automation indicators
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    })
  })

  // Set user agent to match real browser
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
  )

  // Set viewport
  await page.setViewport({ width: 1366, height: 768 })
}

/**
 * Navigate, then let the caller wait for the selector it actually needs.
 *
 * The scrapers used `networkidle2`, which waits for Amazon's ad and telemetry traffic to go
 * quiet - 1.9s to 4.5s per page, over 90% of a request. The content is ready long before
 * that: every scraper's waitForSelector returns in under 10ms once the DOM is parsed. So
 * wait for `domcontentloaded` and rely on those selectors, which is what actually gates the
 * data being present.
 *
 * Pass `waitUntil: 'load'` for flows that click Amazon's own widgets: those need the page's
 * JavaScript to have booted, not just the markup to exist.
 */
export async function navigate(
  page: puppeteer.Page,
  url: string,
  options: { waitUntil?: puppeteer.PuppeteerLifeCycleEvent; timeout?: number } = {}
): Promise<void> {
  await page.goto(url, {
    waitUntil: options.waitUntil ?? 'domcontentloaded',
    timeout: options.timeout ?? 30000,
  })
}

// Do not leave a Chrome behind when the MCP server stops
for (const signal of ['exit', 'SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void closeSharedBrowser()
  })
}

export async function downloadImageAsBase64(url: string): Promise<string> {
  const response = await fetch(url)
  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  const b64 = buffer.toString('base64')
  return `${b64}`
}

/**
 * Detect Amazon's sign-in wall.
 *
 * Amazon does not always render the classic `#ap_email` / `#signInSubmit` form: pages that
 * require a session (orders, the full reviews list) redirect to `/ap/signin?openid...`,
 * which serves a "Sign-In" portal page without those selectors. Checking the URL first is
 * what makes this reliable - matching on the form alone silently parses an empty page.
 */
export async function isLoginPage(page: puppeteer.Page): Promise<boolean> {
  const url = page.url()
  if (/\/ap\/signin|\/ap\/cvf\/|\/errors\/validateCaptcha/.test(url)) return true
  if ((await page.$('#ap_email')) !== null || (await page.$('#ap_email_login')) !== null) return true
  if ((await page.$('#signInSubmit')) !== null || (await page.$('form[name="signIn"]')) !== null) return true
  return false
}

export async function throwIfNotLoggedIn(page: puppeteer.Page): Promise<void> {
  if (await isLoginPage(page)) {
    throw new Error(
      'You need to be logged in to access this feature. Amazon redirected to its sign-in page - ' +
        'your amazonCookies.json is missing or its session has expired. Log in to Amazon again and re-export your cookies.'
    )
  }
}

/**
 * Amazon ships the same string twice in a lot of nodes (desktop + mobile variants share a
 * container), so `.text()` yields "4.2  4.2" or "Verified PurchaseVerified Purchase".
 * Collapse whitespace and drop the duplicated half when the text is exactly doubled.
 */
export function cleanText(raw: string | undefined | null): string {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim()
  if (text.length < 2) return text

  // Exact "XX" duplication
  if (text.length % 2 === 0) {
    const half = text.slice(0, text.length / 2)
    if (half === text.slice(text.length / 2)) return half.trim()
  }
  // "X X" duplication (the two copies separated by the whitespace we collapsed)
  const spaced = text.match(/^(.+) \1$/)
  if (spaced) return spaced[1].trim()

  return text
}

/**
 * Map over `items` running at most `limit` tasks at once, keeping the results in input order.
 *
 * Used for batch tool calls: the point of accepting several ASINs in one call is to fetch
 * them concurrently, but firing twenty requests at Amazon from one session earns a captcha,
 * so the width stays bounded.
 *
 * `fn` is expected to resolve rather than throw - a batch must not lose every result because
 * one item failed. Callers wrap their own errors into the result value.
 */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index], index)
    }
  })

  await Promise.all(workers)
  return results
}

/**
 * A real ASIN is either "B" followed by nine alphanumerics, or a 10-digit ISBN-10 (books).
 *
 * Length alone is not enough. Asked for a 10-character string that is not an ASIN, Amazon
 * answers 200 with some *other* product's page and echoes the requested id back in
 * `input#ASIN`, the canonical link and `data-asin` - so nothing in the markup reveals the
 * mismatch, and a hallucinated id comes back as a confident, wrong product.
 */
const ASIN_PATTERN = /^(B[0-9A-Z]{9}|[0-9]{9}[0-9X])$/i

export function isValidAsin(asin: string): boolean {
  return ASIN_PATTERN.test(asin)
}

export function assertValidAsin(asin: string): void {
  if (!asin || !isValidAsin(asin)) {
    throw new Error(
      `Invalid ASIN "${asin}". An ASIN is "B" followed by 9 letters or digits (e.g. B0CSYRPPPM), or a 10-digit ISBN for books.`
    )
  }
}
