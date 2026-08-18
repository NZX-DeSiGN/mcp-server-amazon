import * as cheerio from 'cheerio'
import fs from 'fs'
import puppeteer from 'puppeteer'
import { USE_MOCKS, EXPORT_LIVE_SCRAPING_FOR_MOCKS, amazonUrl } from './config.js'
import { cleanText, createBrowserAndPage, getTimestamp, isLoginPage } from './utils.js'

const __dirname = new URL('.', import.meta.url).pathname

// ##################################
// Product Reviews Types
// ##################################

export type ReviewsSortBy = 'recent' | 'helpful'
export type ReviewsStarFilter = 'all_stars' | 'five_star' | 'four_star' | 'three_star' | 'two_star' | 'one_star' | 'positive' | 'critical'

export interface GetProductReviewsOptions {
  /** Only keep reviews with this star rating (ignored when not logged in) */
  starFilter?: ReviewsStarFilter
  /** `helpful` is Amazon's default ordering, `recent` sorts by date (ignored when not logged in) */
  sortBy?: ReviewsSortBy
  /** Only keep "Verified Purchase" reviews (ignored when not logged in) */
  verifiedPurchaseOnly?: boolean
  /** Stop once this many reviews have been collected (default 20, max 100) */
  maxReviews?: number
}

export interface ProductReview {
  id?: string
  author?: string
  /** Numeric rating out of 5, parsed from the localised "4,2 sur 5 étoiles" / "5 out of 5 stars" label */
  rating?: number
  ratingLabel?: string
  title?: string
  date?: string
  country?: string
  isVerifiedPurchase: boolean
  helpfulVotes?: string
  variation?: string
  body?: string
  imagesCount: number
}

export interface ProductReviewsResult {
  asin: string
  productUrl: string
  /**
   * `reviews-page` is the full, filterable list and needs a logged-in session.
   * `product-page` is the public fallback: the handful of reviews Amazon shows to
   * anonymous visitors, with no filtering, sorting or pagination.
   */
  source: 'reviews-page' | 'product-page' | 'mock'
  summary: {
    averageRating?: string
    totalRatings?: string
    totalReviews?: string
    /** e.g. { "5": "74%", "4": "6%", ... } */
    ratingBreakdown: Record<string, string>
  }
  appliedFilters: {
    starFilter: ReviewsStarFilter
    sortBy: ReviewsSortBy
    verifiedPurchaseOnly: boolean
    /** false when the anonymous fallback was used - Amazon ignores filters there */
    filtersApplied: boolean
  }
  reviews: ProductReview[]
  note?: string
}

// ##################################
// Get Product Reviews
// ##################################

export async function getProductReviews(asin: string, options: GetProductReviewsOptions = {}): Promise<ProductReviewsResult> {
  if (!asin || asin.length !== 10) {
    throw new Error('Invalid ASIN provided. ASIN should be a 10-character string.')
  }

  const starFilter = options.starFilter ?? 'all_stars'
  const sortBy = options.sortBy ?? 'helpful'
  const verifiedPurchaseOnly = options.verifiedPurchaseOnly ?? false
  const maxReviews = Math.min(Math.max(options.maxReviews ?? 20, 1), 100)

  if (USE_MOCKS) {
    console.error('[INFO][get-product-reviews] Fetching reviews from mocks')
    const html = fs.readFileSync(`${__dirname}/../mocks/getProductReviews.html`, 'utf-8')
    const $ = cheerio.load(html)
    return {
      asin,
      productUrl: amazonUrl(`/gp/product/${asin}`),
      source: 'mock',
      summary: extractSummary($),
      appliedFilters: { starFilter, sortBy, verifiedPurchaseOnly, filtersApplied: true },
      reviews: extractReviews($).slice(0, maxReviews),
    }
  }

  const reviewsUrl = buildReviewsUrl(asin, starFilter, sortBy, verifiedPurchaseOnly)
  console.error(`[INFO][get-product-reviews] Fetching reviews for ${asin} from ${reviewsUrl}`)

  const { browser, page } = await createBrowserAndPage()
  try {
    await page.goto(reviewsUrl, { waitUntil: 'networkidle2', timeout: 30000 })

    // The full reviews list is session-gated: without valid cookies Amazon bounces to
    // /ap/signin. Rather than failing, fall back to the reviews shown on the public
    // product page - fewer reviews, no filtering, but still useful.
    if (await isLoginPage(page)) {
      console.error('[WARN][get-product-reviews] Not logged in, falling back to the public product page reviews')
      return await scrapeProductPageReviews(page, asin, { starFilter, sortBy, verifiedPurchaseOnly, maxReviews })
    }

    const reviews = await collectReviews(page, maxReviews, 'get-product-reviews')
    const $ = cheerio.load(await page.content())

    if (EXPORT_LIVE_SCRAPING_FOR_MOCKS) {
      const mockPath = `${__dirname}/../mocks/getProductReviews_${getTimestamp()}.html`
      fs.writeFileSync(mockPath, await page.content())
      console.error(`[INFO][get-product-reviews] Exported reviews page HTML to ${mockPath}`)
    }

    console.error(`[INFO][get-product-reviews] Extracted ${reviews.length} reviews for ${asin}`)
    return {
      asin,
      productUrl: amazonUrl(`/gp/product/${asin}`),
      source: 'reviews-page',
      summary: extractSummary($),
      appliedFilters: { starFilter, sortBy, verifiedPurchaseOnly, filtersApplied: true },
      reviews: reviews.slice(0, maxReviews),
    }
  } finally {
    await browser.close()
  }
}

function buildReviewsUrl(asin: string, starFilter: ReviewsStarFilter, sortBy: ReviewsSortBy, verifiedPurchaseOnly: boolean): string {
  const params = new URLSearchParams({
    reviewerType: verifiedPurchaseOnly ? 'avp_only_reviews' : 'all_reviews',
    sortBy: sortBy === 'recent' ? 'recent' : 'helpful',
    filterByStar: starFilter,
    pageNumber: '1',
  })
  return amazonUrl(`/product-reviews/${asin}/?${params.toString()}`)
}

/** Public fallback: the reviews Amazon renders on the product page itself */
async function scrapeProductPageReviews(
  page: puppeteer.Page,
  asin: string,
  opts: { starFilter: ReviewsStarFilter; sortBy: ReviewsSortBy; verifiedPurchaseOnly: boolean; maxReviews: number }
): Promise<ProductReviewsResult> {
  const productUrl = amazonUrl(`/gp/product/${asin}`)
  await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 30000 })

  // The review block sits far down the page and is rendered lazily
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await new Promise(resolve => setTimeout(resolve, 2500))

  const $ = cheerio.load(await page.content())
  let reviews = extractReviews($)
  if (opts.verifiedPurchaseOnly) reviews = reviews.filter(r => r.isVerifiedPurchase)

  console.error(`[INFO][get-product-reviews] Extracted ${reviews.length} public reviews for ${asin} from the product page`)
  return {
    asin,
    productUrl,
    source: 'product-page',
    summary: extractSummary($),
    appliedFilters: { ...opts, filtersApplied: false },
    reviews: reviews.slice(0, opts.maxReviews),
    note:
      'Not logged in: returned only the reviews Amazon shows publicly on the product page. ' +
      'Star filtering and sorting were not applied. Provide valid Amazon cookies to read the full, filterable reviews list.',
  }
}

/**
 * Amazon replaced the numbered pager on the reviews page with a "show more" button that
 * appends the next batch in place, so paginate by clicking it until we have enough.
 */
async function collectReviews(page: puppeteer.Page, maxReviews: number, logTag: string): Promise<ProductReview[]> {
  try {
    await page.waitForSelector('[data-hook="review"]', { timeout: 15000 })
  } catch {
    console.error(`[WARN][${logTag}] No review element appeared - the product may have no reviews yet`)
    return []
  }

  const MAX_CLICKS = 10
  for (let i = 0; i < MAX_CLICKS; i++) {
    const count = await page.$$eval('[data-hook="review"]', els => els.length)
    if (count >= maxReviews) break

    const showMore = await page.$('[data-hook="show-more-button"] a, [data-hook="show-more-button"] button, [data-hook="show-more-button"]')
    if (!showMore) break

    try {
      await showMore.click()
    } catch {
      break // button went stale or is not clickable anymore
    }
    await new Promise(resolve => setTimeout(resolve, 2000))

    const newCount = await page.$$eval('[data-hook="review"]', els => els.length)
    if (newCount === count) break // nothing more to load
    console.error(`[INFO][${logTag}] Loaded more reviews: ${newCount}`)
  }

  return extractReviews(cheerio.load(await page.content()))
}

// ##################################
// Extraction
// ##################################

/**
 * Amazon serves two different markups for a review depending on the page:
 * the product page uses `reviewTitle` / `reviewRichContentContainer`, while the
 * dedicated reviews page still uses the classic `review-title` / `review-body`.
 * The container is also not always a <div>, so never scope the selector by tag.
 */
export function extractReviews($: cheerio.CheerioAPI): ProductReview[] {
  const reviews: ProductReview[] = []

  $('[data-hook="review"]').each((_index, element) => {
    const $review = $(element)

    const ratingLabel = cleanText($review.find('[data-hook="review-star-rating"], [data-hook="cmps-review-star-rating"]').first().text())
    // "4,2 sur 5 étoiles" / "5.0 out of 5 stars" -> 4.2 / 5
    const ratingMatch = ratingLabel.match(/(\d+([.,]\d+)?)/)

    const dateLabel = cleanText($review.find('[data-hook="review-date"]').first().text())
    // "Reviewed in France on 22 May 2026" / "Commenté en France le 22 mai 2026"
    const dateMatch = dateLabel.match(/(?:in|en|au|aux)\s+(.+?)\s+(?:on|le)\s+(.+)$/i)

    const body = cleanText(
      $review.find('[data-hook="reviewRichContentContainer"]').first().text() ||
        $review.find('[data-hook="review-body"]').first().text() ||
        $review.find('[data-hook="reviewText"]').first().text()
    )

    const review: ProductReview = {
      id: $review.attr('id')?.replace(/^customer_review[-_]/, '') || undefined,
      author: cleanText($review.find('.a-profile-name').first().text()) || undefined,
      rating: ratingMatch ? parseFloat(ratingMatch[1].replace(',', '.')) : undefined,
      ratingLabel: ratingLabel || undefined,
      title: extractReviewTitle($, $review) || undefined,
      date: dateMatch ? dateMatch[2] : dateLabel || undefined,
      country: dateMatch ? dateMatch[1] : undefined,
      isVerifiedPurchase: $review.find('[data-hook="avp-badge"]').length > 0,
      helpfulVotes: cleanText($review.find('[data-hook="helpful-vote-statement"]').first().text()) || undefined,
      variation: cleanText($review.find('[data-hook="format-strip"]').first().text()) || undefined,
      body: body || undefined,
      imagesCount: $review.find('[data-hook="review-image-tile"], .review-image-tile').length,
    }

    if (review.id || review.body || review.title) reviews.push(review)
  })

  return reviews
}

/**
 * On the reviews page the title link wraps two spans - the screen-reader rating
 * ("5,0 sur 5 étoiles") and the actual headline - so reading the element's text
 * returns both glued together. Prefer the last span, then strip any leading
 * "<n> out of 5 stars" / "<n> sur 5 étoiles" that survived.
 */
function extractReviewTitle($: cheerio.CheerioAPI, $review: cheerio.Cheerio<any>): string {
  const $title = $review.find('[data-hook="reviewTitle"], [data-hook="review-title"]').first()
  const $spans = $title.find('span')
  const raw = cleanText($spans.length > 0 ? $spans.last().text() : $title.text())
  return raw.replace(/^\d+([.,]\d+)?\s*(?:out of|sur|von|de|su)\s*5\s*\S*\s*/i, '').trim()
}

export function extractSummary($: cheerio.CheerioAPI): ProductReviewsResult['summary'] {
  const ratingBreakdown: Record<string, string> = {}

  // Each histogram row is a link whose aria-label carries both numbers - read that
  // rather than the layout, which is a <table> on one page and a <ul> on the other,
  // and whose visible cells repeat every star label in every row.
  $('#histogramTable a[aria-label], #cm_cr_dp_d_rating_histogram a[aria-label], [data-hook="cr-histogram"] a[aria-label]').each(
    (_index, element) => {
      const label = $(element).attr('aria-label') || ''
      // "74% des commentaires ont reçu 5 étoiles" but also "74 percent of reviews have 5 stars"
      const match = label.match(/(\d+)\s*(?:%|percent|pour ?cent|Prozent|por ciento)\D*?(\d)\s*(?:stars?|étoiles?|Sterne?|estrellas?|stelle?)/i)
      if (match && !ratingBreakdown[match[2]]) ratingBreakdown[match[2]] = `${match[1]}%`
    }
  )

  return {
    averageRating: cleanText($('[data-hook="rating-out-of-text"]').first().text()) || undefined,
    totalRatings: cleanText($('[data-hook="total-review-count"]').first().text()) || undefined,
    totalReviews: cleanText($('[data-hook="cr-filter-info-review-rating-count"]').first().text()) || undefined,
    ratingBreakdown,
  }
}
