import { loadAmazonCookiesFile } from './utils.js'

const __dirname = new URL('.', import.meta.url).pathname

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return defaultValue
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())
}

/** Run Chrome with a visible window (useful to debug scraping) - env: BROWSER_VISIBLE */
export const IS_BROWSER_VISIBLE = envFlag('BROWSER_VISIBLE', false)

/** Use local mock files instead of live scraping - env: USE_MOCK_RESPONSES */
export const USE_MOCKS = envFlag('USE_MOCK_RESPONSES', false)

/**
 * Dump the scraped HTML into `mocks/` on every live call - env: EXPORT_MOCKS
 * Off by default: each dump is several MB and they pile up fast.
 */
export const EXPORT_LIVE_SCRAPING_FOR_MOCKS = envFlag('EXPORT_MOCKS', false)

export const COOKIES_FILE_PATH = process.env.AMAZON_COOKIES_FILE || `${__dirname}/../amazonCookies.json`

/**
 * Language segment injected in every Amazon URL (`https://www.amazon.fr/-/en/...`).
 * Defaults to `en` because several scrapers match on English page text
 * ("Added to cart", "Your Amazon Cart is empty", ...). French is supported too.
 * Set to an empty string to use the marketplace default language.
 * env: AMAZON_LOCALE (e.g. `en`, `fr`, or empty)
 */
export const AMAZON_LOCALE = process.env.AMAZON_LOCALE ?? 'en'

/**
 * Go to the Amazon website and log in to your account
 * Then export cookies as JSON using a browser extension like "Cookie-Editor"
 * and paste them in [amazonCookies.json](../amazonCookies.json)
 *
 * Alternatively, run `AMAZON_DOMAIN=amazon.fr node login_and_save_cookies.cjs`.
 *
 * @see https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm?hl=fr
 */
export const AMAZON_COOKIES: {
  domain: string
  expirationDate: number
  hostOnly: boolean
  httpOnly: boolean
  name: string
  path: string
  sameSite: 'Strict' | 'Lax' | 'None' | undefined
  secure: boolean
  session: boolean
  storeId: string | null
  value: string
}[] = loadAmazonCookiesFile()

/** Resolved once - `getAmazonDomain()` used to re-log the same line on every call */
let cachedDomain: string | undefined

/**
 * Extract the Amazon domain from cookies, unless `AMAZON_DOMAIN` forces it.
 * Returns the domain without the leading dot (e.g. "amazon.com", "amazon.fr", "amazon.de")
 */
export function getAmazonDomain(): string {
  if (cachedDomain) return cachedDomain
  cachedDomain = resolveAmazonDomain()
  console.error(`[INFO] Using Amazon domain: ${cachedDomain}`)
  return cachedDomain
}

function resolveAmazonDomain(): string {
  if (process.env.AMAZON_DOMAIN) return process.env.AMAZON_DOMAIN.replace(/^\.?(www\.)?/, '')

  if (!AMAZON_COOKIES || AMAZON_COOKIES.length === 0) {
    console.error('[WARN] No cookies found, using default amazon.com domain')
    return 'amazon.com'
  }

  // Find a cookie with domain starting with ".amazon."
  const amazonCookie = AMAZON_COOKIES.find(cookie => cookie.domain && cookie.domain.startsWith('.amazon.'))
  if (amazonCookie) return amazonCookie.domain.replace(/^\./, '')

  // Fallback: any cookie with "amazon" in the domain
  const fallbackCookie = AMAZON_COOKIES.find(cookie => cookie.domain && cookie.domain.includes('amazon'))
  if (fallbackCookie) return fallbackCookie.domain.replace(/^\./, '').replace(/^www\./, '')

  console.error('[WARN] Could not detect Amazon domain from cookies, using default amazon.com')
  return 'amazon.com'
}

/**
 * Build an Amazon URL for the current marketplace and locale.
 * `amazonUrl('/gp/product/B0CYSJ9TG8')` -> `https://www.amazon.fr/-/en/gp/product/B0CYSJ9TG8`
 */
export function amazonUrl(path: string): string {
  const localePrefix = AMAZON_LOCALE ? `/-/${AMAZON_LOCALE}` : ''
  return `https://www.${getAmazonDomain()}${localePrefix}${path.startsWith('/') ? path : `/${path}`}`
}
