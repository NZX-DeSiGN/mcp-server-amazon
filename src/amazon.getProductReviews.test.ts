import { USE_MOCKS } from './config.js'
import { searchProducts } from './products.js'
import { getProductReviews } from './reviews.js'

/** Pick a real ASIN from a search so the test does not rot when a hardcoded product disappears */
async function getTestASIN(): Promise<string> {
  if (USE_MOCKS) return 'B0CYSJ9TG8'
  const results = await searchProducts('mechanical keyboard')
  const withReviews = results.find(p => p.reviews?.reviewCount)
  return withReviews?.asin || results[0].asin
}

async function testGetProductReviews_basic(asin: string) {
  console.log('\n--------------------------------------')
  console.log(`Run testGetProductReviews_basic on ${asin}...`)

  const result = await getProductReviews(asin, { maxReviews: 5 })
  console.log(`✅ source: ${result.source} (filters applied: ${result.appliedFilters.filtersApplied})`)
  if (result.note) console.log(`ℹ️  ${result.note}`)
  console.log(`   Average: ${result.summary.averageRating ?? 'N/A'} | ${result.summary.totalRatings ?? 'N/A'}`)
  console.log(`   Breakdown: ${JSON.stringify(result.summary.ratingBreakdown)}`)
  console.log(`   Got ${result.reviews.length} reviews`)

  if (result.reviews.length === 0) {
    console.log('❌ No review extracted - Amazon may have changed its markup again')
    return
  }

  const withBody = result.reviews.filter(r => r.body).length
  const withTitle = result.reviews.filter(r => r.title).length
  const withRating = result.reviews.filter(r => typeof r.rating === 'number').length
  console.log(`   📊 with body: ${withBody}/${result.reviews.length}, title: ${withTitle}/${result.reviews.length}, rating: ${withRating}/${result.reviews.length}`)

  // A title that still starts with the rating means the star span leaked into it
  const leaked = result.reviews.filter(r => /^\d+([.,]\d+)?\s*(out of|sur)\s*5/i.test(r.title || ''))
  if (leaked.length > 0) console.log(`❌ ${leaked.length} title(s) still carry the star label`)

  console.log('   First review:', JSON.stringify(result.reviews[0], null, 2))
}

async function testGetProductReviews_criticalOnly(asin: string) {
  console.log('\n--------------------------------------')
  console.log(`Run testGetProductReviews_criticalOnly on ${asin}...`)

  const result = await getProductReviews(asin, { starFilter: 'critical', sortBy: 'recent', maxReviews: 5 })
  if (!result.appliedFilters.filtersApplied) {
    console.log('⚠️  Skipped: not logged in, Amazon does not filter the public product page reviews')
    return
  }

  const ratings = result.reviews.map(r => r.rating)
  console.log(`✅ Got ${result.reviews.length} critical reviews, ratings: ${JSON.stringify(ratings)}`)
  const tooHigh = ratings.filter(r => r !== undefined && r > 3)
  if (tooHigh.length > 0) console.log(`❌ Filter leaked ${tooHigh.length} review(s) rated above 3 stars`)
}

async function testGetProductReviews_invalidAsin() {
  console.log('\n--------------------------------------')
  console.log('Run testGetProductReviews_invalidAsin...')
  try {
    await getProductReviews('TOO_SHORT')
    console.log('❌ Should have rejected an invalid ASIN')
  } catch (error: any) {
    console.log(`✅ Correctly rejected: ${error.message}`)
  }
}

async function main() {
  console.log('🧪 Testing Amazon Get Product Reviews functionality...')
  console.log('='.repeat(50))

  await testGetProductReviews_invalidAsin()
  const asin = await getTestASIN()
  await testGetProductReviews_basic(asin)
  await testGetProductReviews_criticalOnly(asin)

  console.log('\n✨ Get Product Reviews tests completed!')
}

main().catch(console.error)
