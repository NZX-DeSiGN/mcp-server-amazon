import * as cheerio from 'cheerio'
import fs from 'fs'
import puppeteer from 'puppeteer'
import { USE_MOCKS, EXPORT_LIVE_SCRAPING_FOR_MOCKS, HTTP_FIRST, amazonUrl } from './config.js'
import { tryFetchOverHttp } from './http.js'
import { cleanText, navigate, withPage, getTimestamp, throwIfNotLoggedIn } from './utils.js'

const __dirname = new URL('.', import.meta.url).pathname

/** Amazon returns far more results than anyone reads; the scrapers keep this many */
const SEARCH_RESULTS_LIMIT = 20

// ##################################
// Product Details
// ##################################

interface ProductDetails {
  data: {
    asin: string
    title: string
    price: string
    canUseSubscribeAndSave: boolean
    description: {
      overview?: string
      features?: string
      facts?: string
      brandSnapshot?: string
    }
    reviews: {
      averageRating?: string
      reviewsCount?: string
    }
    mainImageUrl?: string
  }
  mainImageBase64?: string
}

export async function getProductDetails(asin: string): Promise<ProductDetails> {
  if (!asin || asin.length !== 10) {
    throw new Error('Invalid ASIN provided. ASIN should be a 10-character string.')
  }

  let html: string
  if (USE_MOCKS) {
    console.error('[INFO][get-product-details] Fetching product details from mocks')
    const mockPath = `${__dirname}/../mocks/getProductDetails.html`
    html = fs.readFileSync(mockPath, 'utf-8')
  } else {
    const url = amazonUrl(`/gp/product/${asin}`)
    console.error(`[INFO][get-product-details] Fetching product details from ${url}`)

    const overHttp = await tryFetchOverHttp(url, 'get-product-details', html => !!cheerio.load(html)('span#productTitle').text().trim())
    if (overHttp) return extractProductDetailsPageData(cheerio.load(overHttp), asin)

    html = await withPage(async page => {
      // Navigate to the product page
      await navigate(page, url)

      // Handle login if needed
      await throwIfNotLoggedIn(page)

      // Wait for the product page to load
      try {
        await page.waitForSelector('#productTitle', { timeout: 10000 })
      } catch (e) {
        throw new Error('[INFO][get-product-details] Could not find product title. The product may not exist or be accessible.')
      }

      if (EXPORT_LIVE_SCRAPING_FOR_MOCKS) {
        // Export the main product content to a mock file
        const timestamp = getTimestamp()
        const mockPath = `${__dirname}/../mocks/getProductDetails_${timestamp}.html`
        const productHtml = await page.content()
        fs.writeFileSync(mockPath, productHtml)
        console.error(`[INFO][get-product-details] Exported product page HTML to ${mockPath}`)
      }

      // Get the HTML content after JavaScript execution
      return await page.content()
    })
  }

  const $ = cheerio.load(html)
  return extractProductDetailsPageData($, asin)
}

async function extractProductDetailsPageData($: cheerio.CheerioAPI, asin: string): Promise<ProductDetails> {
  // Extract product title
  const title = $('span#productTitle').text().trim()

  // Extract price information
  let price = ''
  let canUseSubscribeAndSave: ProductDetails['data']['canUseSubscribeAndSave'] = false

  // Check if it's a subscribe and save product
  const subscriptionPrice = $('#subscriptionPrice .a-price .a-offscreen').prop('innerText')?.trim()
  if (subscriptionPrice) {
    price = subscriptionPrice
    canUseSubscribeAndSave = true
  } else {
    // Use regular price
    price = $('.priceToPay').text().trim()
  }

  // Extract description sections
  const description: ProductDetails['data']['description'] = {}

  const overview = $('#productOverview_feature_div').prop('innerText')?.trim()
  if (overview) description.overview = overview

  const features = $('#featurebullets_feature_div').prop('innerText')?.trim()
  if (features) description.features = features

  const facts = $('#productFactsDesktop_feature_div').prop('innerText')?.trim()
  if (facts) description.facts = facts

  const brandSnapshot = $('#brandSnapshot_feature_div').prop('innerText')?.trim()
  if (brandSnapshot) description.brandSnapshot = brandSnapshot

  // Extract reviews information
  const reviews: ProductDetails['data']['reviews'] = {}

  // The rating lives in a container that holds both the desktop and mobile copy,
  // so the raw text reads "4.2  4.2" - cleanText() drops the duplicate.
  const averageRating = cleanText($('#averageCustomerReviews span.a-size-small.a-color-base').text())
  if (averageRating) reviews.averageRating = averageRating

  // Amazon dropped the aria-label this used to read; take the visible count
  // ("1,234 ratings" / "1 234 évaluations") and keep the digits.
  const reviewsCountText =
    cleanText($('#acrCustomerReviewText').text()) || $('#acrCustomerReviewLink span').attr('aria-label') || ''
  const reviewsCountMatch = reviewsCountText.match(/([\d.,\u202f\u00a0\s]*\d)/)
  if (reviewsCountMatch) reviews.reviewsCount = reviewsCountMatch[1].replace(/[.,\u202f\u00a0\s]/g, '')

  // Extract main product image
  const mainImageUrl = $('#main-image-container img.a-dynamic-image').attr('src')
  // Download the image and convert to base64
  let mainImageBase64: ProductDetails['mainImageBase64'] = undefined
  if (mainImageUrl) {
    if (USE_MOCKS) {
      console.error('[INFO][get-product-details] Downloading product main image from mocks')
      const mockPath = `${__dirname}/../mocks/getProductDetails_image_base64.txt`
      mainImageBase64 = fs.readFileSync(mockPath, 'utf-8')
    } else {
      // FIXME: This is not supported yet by Claude Desktop client!! Uncomment when they implement it
      // console.error(`[INFO][get-product-details] Downloading main image from ${mainImageUrl}`)
      // mainImageBase64 = await downloadImageAsBase64(mainImageUrl)
      // if (EXPORT_LIVE_SCRAPING_FOR_MOCKS) {
      //   const timestamp = getTimestamp()
      //   const mockPath = `${__dirname}/../mocks/getProductDetails_image_base64_${timestamp}.txt`
      //   fs.writeFileSync(mockPath, mainImageBase64)
      //   console.error(`[INFO][get-product-details] Exported main image base64 to ${mockPath}`)
      // }
    }
  }

  console.error(
    `[INFO][get-product-details] Extracted product: ASIN: ${asin}, ${title}, Price: ${price}, Can use subscribe and save: ${canUseSubscribeAndSave}, Reviews: ${reviews.averageRating} (${reviews.reviewsCount} reviews), Main image URL: ${mainImageUrl}`
  )

  return {
    data: {
      asin,
      title,
      price,
      canUseSubscribeAndSave,
      description,
      reviews,
      mainImageUrl,
    },
    mainImageBase64,
  }
}

// ##################################
// Product Search
// ##################################

interface ProductSearchResult {
  asin: string
  title: string
  isSponsored: boolean
  brand?: string
  price?: string
  pricePerUnit?: string
  description?: {
    overview?: string
    features?: string
    facts?: string
    brandSnapshot?: string
  }
  reviews?: {
    averageRating?: string
    reviewCount?: string
  }
  imageUrl?: string
  isPrimeEligible: boolean
  deliveryInfo?: string
  productUrl?: string
}

export async function searchProducts(searchTerm: string): Promise<ProductSearchResult[]> {
  if (!searchTerm || searchTerm.trim().length === 0) {
    throw new Error('Search term is required and cannot be empty.')
  }

  let html: string
  if (USE_MOCKS) {
    console.error('[INFO][search-products] Fetching search results from mocks')
    const mockPath = `${__dirname}/../mocks/searchProducts.html`
    html = fs.readFileSync(mockPath, 'utf-8')
  } else {
    const url = amazonUrl(`/s?k=${encodeURIComponent(searchTerm)}`)
    console.error(`[INFO][search-products] Searching for products with term "${searchTerm}" from ${url}`)

    // Only the first SEARCH_RESULTS_LIMIT results are kept, and they arrive well before the
    // end of the stream - stop as soon as the next one starts, so the last kept result is complete.
    const overHttp = await tryFetchOverHttp(url, 'search-products', html => cheerio.load(html)('[role="listitem"]').length > 0, {
      stopWhen: partial => (partial.match(/role="listitem"/g) || []).length > SEARCH_RESULTS_LIMIT,
      checkEveryBytes: 64 * 1024,
    })
    if (overHttp) return extractSearchResultsPageData(cheerio.load(overHttp), searchTerm)

    html = await withPage(async page => {
      // Navigate to the search page
      await navigate(page, url)

      // Handle login if needed
      await throwIfNotLoggedIn(page)

      // Wait for search results to load
      try {
        await page.waitForSelector('.s-search-results', { timeout: 10000 })
      } catch (e) {
        throw new Error(
          '[INFO][search-products] Could not find search results container. The search may have failed or returned no results.'
        )
      }

      if (EXPORT_LIVE_SCRAPING_FOR_MOCKS) {
        // Export the search results content to a mock file
        const timestamp = getTimestamp()
        const searchResultsHtml = await page.$eval('.s-search-results', el => el.outerHTML)
        const mockFileName = `searchProducts_${timestamp}.html`
        const mockPath = `${__dirname}/../mocks/${mockFileName}`
        fs.writeFileSync(mockPath, searchResultsHtml)
        console.error(`[INFO][search-products] Exported search results HTML to ${mockPath}`)
      }

      // Get the HTML content after JavaScript execution
      return await page.content()
    })
  }

  const $ = cheerio.load(html)
  return extractSearchResultsPageData($, searchTerm)
}

function extractSearchResultsPageData($: cheerio.CheerioAPI, searchTerm: string): ProductSearchResult[] {
  const searchResults: ProductSearchResult[] = []

  // Find the search results using the actual Amazon structure
  const $productItems = $('[role="listitem"]')

  if ($productItems.length === 0) {
    console.error('[INFO][search-products] No search results found')
    return []
  }

  const limitedItems = $productItems.slice(0, SEARCH_RESULTS_LIMIT)

  console.error(`[INFO][search-products] Found ${$productItems.length} products, processing first ${limitedItems.length}`)

  limitedItems.each((index, element) => {
    const $item = $(element)

    try {
      const productData = extractSearchResultSingleProductData($, $item)
      if (productData && productData.asin) {
        searchResults.push(productData)
        console.error(`[INFO][search-products] Extracted product ${index + 1}: ${productData.asin} - ${productData.title}`)
      }
    } catch (error) {
      console.error(`[INFO][search-products] Error extracting product ${index + 1}:`, error)
    }
  })

  console.error(`[INFO][search-products] Successfully extracted ${searchResults.length} products for search term "${searchTerm}"`)
  return searchResults
}

function extractSearchResultSingleProductData($: cheerio.CheerioAPI, $item: cheerio.Cheerio<any>): ProductSearchResult | null {
  // Extract ASIN
  const asin = $item.attr('data-asin')
  if (!asin) {
    return null
  }

  // Extract title and check if sponsored
  const titleElement = $item.find('h2[aria-label]')
  const fullTitle = titleElement.attr('aria-label') || ''
  // The separator alternates between an en dash and a hyphen depending on the page
  // variant, and the label is localised - matching one exact string missed most ads.
  const sponsoredPrefix = fullTitle.match(/^(Sponsored Ad|Publicité sponsorisée|Sponsorisé|Gesponsert|Patrocinado)\s*[-\u2013\u2014:]\s*/i)
  const isSponsored = sponsoredPrefix !== null
  const title = isSponsored ? fullTitle.slice(sponsoredPrefix![0].length) : fullTitle

  // Extract brand
  const brand = $item.find('h2.a-size-mini span.a-size-base-plus.a-color-base').text().trim() || undefined

  // Extract price information
  const price = $item.find('span.a-price[data-a-size="xl"] > span.a-offscreen').text().trim() || undefined

  // Extract price per unit (more complex selector)
  let pricePerUnit: string | undefined
  const pricePerUnitElement = $item.find('span.a-price[data-a-size="b"][data-a-color="secondary"] > span.a-offscreen')
  if (pricePerUnitElement.length > 0) {
    const parentText = pricePerUnitElement.parent().parent().text().trim()
    pricePerUnit = parentText || undefined
  }

  // Extract reviews
  const reviews: ProductSearchResult['reviews'] = {}

  const ratingText = cleanText($item.find('i.a-icon-star-mini span.a-icon-alt, i.a-icon-star span.a-icon-alt').first().text())
  if (ratingText) {
    reviews.averageRating = ratingText
  }

  // The count used to sit in `a[aria-label*="ratings"] span.a-size-small`; Amazon
  // reskinned that span to `a-size-mini`, so the old selector matched nothing. Read the
  // link's aria-label ("30 ratings") and fall back to its visible "(30)" / "(9.4K)" text.
  // Skip the star popover trigger, whose aria-label ("4.2 out of 5 stars, rating details")
  // also contains "rating"; the count link is labelled "30 ratings" / "30 évaluations".
  const countLabel = $item
    .find('a[aria-label]')
    .map((_i, el) => $(el).attr('aria-label') || '')
    .get()
    .find(label => /^[\d.,\u202f\u00a0\s]*\d\s*(ratings?|évaluations?|avis)\b/i.test(label))
  // Drop the thousands separators (", " / "." / narrow no-break space) so the count is a plain number
  const reviewCount = cleanText(countLabel?.replace(/\s*(ratings?|évaluations?|avis).*$/i, ''))
    .replace(/[()]/g, '')
    .replace(/[.,\u202f\u00a0\s](?=\d{3}\b)/g, '')
    .trim()
  if (reviewCount) {
    reviews.reviewCount = reviewCount
  }

  // Extract image URL
  const imageUrl = $item.find('img.s-image').attr('src') || undefined

  // Check Prime eligibility
  const isPrimeEligible = $item.find('i.a-icon-prime').length > 0

  // Extract delivery information
  const deliveryInfo = $item.find('div.udm-primary-delivery-message').text().trim() || undefined

  // Extract product URL
  const productUrl = amazonUrl(`/gp/product/${asin}`)

  return {
    asin,
    title,
    isSponsored,
    brand,
    price,
    pricePerUnit,
    reviews: Object.keys(reviews).length > 0 ? reviews : undefined,
    imageUrl,
    isPrimeEligible,
    deliveryInfo,
    productUrl,
  }
}