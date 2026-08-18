import fs from 'fs'
import puppeteer from 'puppeteer'
import { COOKIES_FILE_PATH, AMAZON_COOKIES, IS_BROWSER_VISIBLE } from './config.js'

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

export async function createBrowserAndPage(): Promise<{ browser: puppeteer.Browser; page: puppeteer.Page }> {
  // Launch Puppeteer
  const browser = await puppeteer.launch({
    headless: !IS_BROWSER_VISIBLE,
    devtools: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
    defaultViewport: null,
  })

  // Set cookies if available
  if (AMAZON_COOKIES?.length > 0) {
    await browser.setCookie(...AMAZON_COOKIES)
    console.error('[INFO] Set Amazon cookies in the browser')
  } else {
    console.error('[WARN] No Amazon cookies found, proceeding without them')
  }

  const page = await browser.newPage()

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

  return { browser, page }
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
