import { AMAZON_COOKIES } from './config.js'

/**
 * Direct HTTP access to Amazon, used instead of driving Chrome when a page is only read.
 *
 * Measured on amazon.fr, a plain request returns byte-identical markup to the one Chrome
 * renders - the pages we scrape are server-rendered - while skipping the browser entirely.
 * The catch is that we lose Chrome's fingerprint, so every caller must be able to fall back
 * to Puppeteer when Amazon answers with a sign-in wall or a captcha.
 */

const BROWSER_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  'upgrade-insecure-requests': '1',
  'sec-ch-ua': '"Chromium";v="137", "Not/A)Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
}

/** Amazon refused to serve the page to a plain HTTP client - the caller should retry with Chrome */
export class AmazonHttpBlockedError extends Error {
  constructor(reason: string) {
    super(`Amazon did not serve this page over plain HTTP (${reason})`)
    this.name = 'AmazonHttpBlockedError'
  }
}

function cookieHeader(): string {
  return AMAZON_COOKIES.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const cookies = cookieHeader()
  return { ...BROWSER_HEADERS, ...(cookies ? { cookie: cookies } : {}), ...extra }
}

function assertServed(html: string, finalUrl: string): void {
  if (/\/ap\/signin|\/ap\/cvf\//.test(finalUrl)) throw new AmazonHttpBlockedError('redirected to sign-in')
  if (/\/errors\/validateCaptcha/.test(finalUrl) || /validateCaptcha|Saisissez les caractères/i.test(html.slice(0, 20000))) {
    throw new AmazonHttpBlockedError('captcha wall')
  }
}

export interface FetchHtmlOptions {
  /**
   * Called on the markup received so far; return true once the page holds everything the
   * caller needs. Amazon streams these pages progressively and the tail is recommendations
   * and carousels, so stopping early skips megabytes we would only throw away.
   */
  stopWhen?: (html: string) => boolean
  /** Only run `stopWhen` every N bytes, so a costly predicate does not run per chunk */
  checkEveryBytes?: number
  timeoutMs?: number
}

/** GET an Amazon page, optionally abandoning the response as soon as the caller has enough */
export async function fetchAmazonHtml(url: string, options: FetchHtmlOptions = {}): Promise<string> {
  const { stopWhen, checkEveryBytes = 256 * 1024, timeoutMs = 30000 } = options

  const response = await fetch(url, { headers: headers(), redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new AmazonHttpBlockedError(`HTTP ${response.status}`)

  if (!stopWhen || !response.body) {
    const html = await response.text()
    assertServed(html, response.url)
    return html
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let html = ''
  let lastCheckedAt = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      html += decoder.decode(value, { stream: true })

      if (html.length - lastCheckedAt >= checkEveryBytes) {
        lastCheckedAt = html.length
        if (stopWhen(html)) break
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }

  assertServed(html, response.url)
  return html
}

/** POST a form-encoded body (Amazon's internal AJAX endpoints) and return the raw response */
export async function postAmazonForm(
  url: string,
  body: URLSearchParams,
  extraHeaders: Record<string, string> = {}
): Promise<{ ok: boolean; status: number; text: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: headers({
      accept: 'text/html,*/*',
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      ...extraHeaders,
    }),
    body: body.toString(),
    signal: AbortSignal.timeout(30000),
  })
  return { ok: response.ok, status: response.status, text: await response.text() }
}
