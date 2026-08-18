import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { getOrdersHistory } from './orders.js'
import { getCartContent, addToCart, clearCart, removeFromCart } from './cart.js'
import { getProductDetails, searchProducts } from './products.js'
import { getProductReviews } from './reviews.js'
import { mapWithConcurrency } from './utils.js'
import { BATCH_CONCURRENCY } from './config.js'

/**
 * Every lookup tool takes either one value or a list of them, so an agent comparing five
 * products spends one tool call instead of five, and the work runs concurrently.
 *
 * Passing a single value keeps the single-result response it always had; passing a list
 * returns one entry per input, in order. A failed entry carries its error instead of
 * sinking the batch - losing four good results because the fifth ASIN is dead would make
 * batching worse than looping.
 */
function oneOrMany<T extends z.ZodTypeAny>(schema: T) {
  return z.union([schema, z.array(schema).min(1).max(BATCH_MAX_ITEMS)])
}

/**
 * Deliberately only checks the length. The real shape is enforced further down by
 * assertValidAsin(), so that in a batch one bad id fails on its own line instead of the
 * schema rejecting the whole call and throwing away the results that were fine.
 */
const ASIN_SCHEMA = z
  .string()
  .length(10, { message: 'ASIN must be a 10-character string.' })
  .describe('An ASIN: "B" followed by 9 letters or digits (e.g. B0CSYRPPPM), or a 10-digit ISBN for books.')

/** Enough to compare a page of search results; beyond that an agent should narrow down first */
const BATCH_MAX_ITEMS = 20

type BatchEntry<I, R> = { input: I; ok: true; result: R } | { input: I; ok: false; error: string }

async function runBatch<I, R>(input: I | I[], logTag: string, fn: (item: I) => Promise<R>): Promise<string> {
  if (!Array.isArray(input)) {
    // Single input keeps the exact shape callers already parse
    return JSON.stringify(await fn(input), null, 2)
  }

  const entries = await mapWithConcurrency<I, BatchEntry<I, R>>(input, BATCH_CONCURRENCY, async item => {
    try {
      return { input: item, ok: true, result: await fn(item) }
    } catch (error: any) {
      console.error(`[ERROR][${logTag}] Batch entry failed for ${JSON.stringify(item)}:`, error)
      return { input: item, ok: false, error: error.message }
    }
  })

  const failed = entries.filter(entry => !entry.ok).length
  console.error(`[INFO][${logTag}] Batch of ${entries.length} finished, ${failed} failed`)
  return JSON.stringify(entries, null, 2)
}

/**
 * Sent to the client at initialisation and surfaced to the model alongside the tool list.
 *
 * The tool descriptions say what each tool does; this says how they fit together. Without
 * it a model asked for "the best X under 50 €" tends to answer from the search page alone -
 * ranking on the star average, which is what the seller optimises, rather than on what
 * buyers actually wrote.
 */
const INSTRUCTIONS = `This server reads a real Amazon account by scraping the site. Prices, ratings and reviews are live.

# Recommending a product

When asked to find the best product matching criteria, do not answer from the search results alone.
A star average hides why people were unhappy, and the first results are partly sponsored ads.

1. Search with the criteria as filters (minPrice/maxPrice, brand, category, minRating, sortBy),
   not as free text, and not by filtering the results yourself afterwards. Amazon applies the
   filters to its whole catalogue; you would only be narrowing the page it already chose.
2. Shortlist 3 to 5 candidates. Ignore \`isSponsored: true\` entries unless nothing else fits -
   they are ads, not recommendations. Treat a high rating with very few reviews with caution.
3. Fetch their details in ONE call by passing the list of ASINs to get-product-details.
4. Read their reviews in TWO calls, both taking the same list of ASINs:
   - starFilter "critical" - this is the important one: it is where recurring defects,
     durability problems and misleading descriptions show up;
   - starFilter "positive" - to confirm what the product is actually good at.
   Prefer sortBy "recent" when the product may have changed batch or revision.
5. Compare on what reviewers report, not on the star average alone, and say what the trade-offs
   are. Name the recurring complaint of each candidate, even for the one you recommend.
6. Recommend, with the product link, the price, and the reasons - quoting reviews where useful.
   If the reviews contradict the rating, say so.

Batch whenever you have more than one item: every lookup tool takes a list as well as a single
value and fetches them concurrently. Five separate calls are five times slower for the same data.

# Care

- Ask the user before add-to-cart, remove-from-cart and clear-cart. They change a real cart.
- perform-purchase is a mock: it confirms nothing and buys nothing. Never present its output
  as a completed order.
- get-orders-history usually fails: Amazon demands a fresh authentication that exported cookies
  cannot satisfy. Report it and move on rather than retrying.
- get-product-reviews returns at most 100 reviews per filter - an Amazon limit, not an error.
  To go deeper, ask for each star level separately.
- Always give the product link when you mention a product.`

// Create server instance
const server = new McpServer(
  {
    name: 'amazon',
    version: '1.0.0',
  },
  { instructions: INSTRUCTIONS }
)

server.tool('get-orders-history', 'Get orders history for a user', {}, async ({}) => {
  let ordersHistory: Awaited<ReturnType<typeof getOrdersHistory>>
  try {
    ordersHistory = await getOrdersHistory()
  } catch (error: any) {
    console.error('[ERROR][get-orders-history] Error in get-orders-history tool:', error)
    return {
      content: [
        {
          type: 'text',
          text: `An error occurred while retrieving orders history. Error: ${error.message}`,
        },
      ],
    }
  }

  if (!ordersHistory || ordersHistory.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: 'No orders found.',
        },
      ],
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(ordersHistory, null, 2),
      },
    ],
  }
})

server.tool(
  'get-cart-content',
  'Get the current cart content for a user - Always provide the product link when you mention a product in the response',
  {},
  async ({}) => {
    let cartContent: Awaited<ReturnType<typeof getCartContent>>
    try {
      cartContent = await getCartContent()
    } catch (error: any) {
      console.error('[ERROR][get-cart-content] Error in get-cart-content tool:', error)
      return {
        content: [
          {
            type: 'text',
            text: `An error occurred while retrieving cart content. Error: ${error.message}`,
          },
        ],
      }
    }

    if (cartContent.isEmpty) {
      return {
        content: [
          {
            type: 'text',
            text: 'Your Amazon cart is empty.',
          },
        ],
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(cartContent, null, 2),
        },
      ],
    }
  }
)

server.tool(
  'add-to-cart',
  'Add a product to the Amazon cart using ASIN - You should always ask for confirmation to the user before running this tool',
  {
    asin: z
      .string()
      .describe('An ASIN: "B" followed by 9 letters or digits, or a 10-digit ISBN for books.')
      .describe('The ASIN (Amazon Standard Identification Number) of the product to add to cart. Must be a 10-character string.'),
  },
  async ({ asin }) => {
    let result: Awaited<ReturnType<typeof addToCart>>
    try {
      result = await addToCart(asin)
    } catch (error: any) {
      console.error('[ERROR][add-to-cart] Error in add-to-cart tool:', error)
      return {
        content: [
          {
            type: 'text',
            text: `An error occurred while adding product to cart. Error: ${error.message}`,
          },
        ],
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: result.success ? `✅ ${result.message}` : `❌ Failed to add product to cart: ${result.message}`,
        },
      ],
    }
  }
)

server.tool(
  'remove-from-cart',
  'Remove a single item from the Amazon cart by its ASIN, leaving all other items untouched - ' +
    'Use this instead of clear-cart when you only want to drop or swap specific products. ' +
    'You should always ask for confirmation to the user before running this tool',
  {
    asin: z
      .string()
      .describe('An ASIN: "B" followed by 9 letters or digits, or a 10-digit ISBN for books.')
      .describe('The ASIN (Amazon Standard Identification Number) of the product to remove from the cart. Must be a 10-character string.'),
  },
  async ({ asin }) => {
    let result: Awaited<ReturnType<typeof removeFromCart>>
    try {
      result = await removeFromCart(asin)
    } catch (error: any) {
      console.error('[ERROR][remove-from-cart] Error in remove-from-cart tool:', error)
      return {
        content: [
          {
            type: 'text',
            text: `An error occurred while removing the item from cart. Error: ${error.message}`,
          },
        ],
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: result.success ? `✅ ${result.message}` : `❌ ${result.message}`,
        },
      ],
    }
  }
)

server.tool('clear-cart', 'Clear all items from the Amazon cart', {}, async ({}) => {
  let result: Awaited<ReturnType<typeof clearCart>>
  try {
    result = await clearCart()
  } catch (error: any) {
    console.error('[ERROR][clear-cart] Error in clear-cart tool:', error)
    return {
      content: [
        {
          type: 'text',
          text: `An error occurred while clearing the cart. Error: ${error.message}`,
        },
      ],
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: result.message,
      },
    ],
  }
})

server.tool(
  'get-product-details',
  'Get detailed information about one or several products using their ASIN - ' +
    'Pass a list of ASINs to look up several products in one call instead of calling this tool repeatedly - ' +
    'Always provide the product link when you mention a product in the response',
  {
    asin: oneOrMany(
      ASIN_SCHEMA
    ).describe(
      'The ASIN (Amazon Standard Identification Number) of the product to get details for, ' +
        `or a list of up to ${BATCH_MAX_ITEMS} ASINs to fetch them all at once. Each ASIN is a 10-character string.`
    ),
  },
  async ({ asin }) => {
    // The image is only returned for a single lookup: a batch of base64 images would blow
    // past what a tool response can usefully carry.
    if (!Array.isArray(asin)) {
      let result: Awaited<ReturnType<typeof getProductDetails>>
      try {
        result = await getProductDetails(asin)
      } catch (error: any) {
        console.error('[ERROR][get-product-details] Error in get-product-details tool:', error)
        return {
          content: [
            {
              type: 'text',
              text: `An error occurred while retrieving product details. Error: ${error.message}`,
            },
          ],
        }
      }

      return {
        content: result.mainImageBase64
          ? [
              { type: 'text', text: JSON.stringify(result.data, null, 2) },
              { type: 'image', data: result.mainImageBase64, mimeType: 'image/jpeg' },
            ]
          : [{ type: 'text', text: JSON.stringify(result.data, null, 2) }],
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: await runBatch(asin, 'get-product-details', async item => (await getProductDetails(item)).data),
        },
      ],
    }
  }
)

server.tool(
  'search-products',
  'Search for products on Amazon using one or several search terms, with optional filters - ' +
    'Pass a list of terms to run several searches in one call instead of calling this tool repeatedly - ' +
    'Put the user criteria (budget, brand, minimum rating, category) into the filters rather than searching broadly ' +
    'and sorting it out afterwards: the filters are applied by Amazon over its whole catalogue, ' +
    'while filtering the returned page only ever narrows the first results - ' +
    'Always provide the product link when you mention a product in the response',
  {
    searchTerm: oneOrMany(z.string().min(1, { message: 'Search term cannot be empty.' })).describe(
      'The search term to look for products on Amazon (for example: "collagen", "laptop", "books"), ' +
        `or a list of up to ${BATCH_MAX_ITEMS} terms to run all those searches at once.`
    ),
    minPrice: z.number().nonnegative().optional().describe('Minimum price, in the marketplace currency (e.g. 50 for 50 €).'),
    maxPrice: z.number().positive().optional().describe('Maximum price, in the marketplace currency. Use it whenever the user gives a budget.'),
    brand: z.string().optional().describe('Only return products of this brand, e.g. "Keychron".'),
    category: z
      .string()
      .optional()
      .describe('Restrict to an Amazon department, e.g. "computers", "electronics", "beauty", "pets". Omit to search everything.'),
    minRating: z
      .number()
      .min(1)
      .max(5)
      .optional()
      .describe('Only return products rated at least this many stars (e.g. 4 for "4 stars and up"). Products with no rating are excluded.'),
    sortBy: z
      .enum(['relevance', 'price-asc', 'price-desc', 'rating', 'newest'])
      .optional()
      .describe('Result ordering. "relevance" is Amazon default; "rating" surfaces the best reviewed first.'),
    maxResults: z.number().int().min(1).max(60).optional().describe('How many products to return per search term (default 20).'),
  },
  async ({ searchTerm, ...filters }) => {
    if (!Array.isArray(searchTerm)) {
      let result: Awaited<ReturnType<typeof searchProducts>>
      try {
        result = await searchProducts(searchTerm, filters)
      } catch (error: any) {
        console.error('[ERROR][search-products] Error in search-products tool:', error)
        return {
          content: [{ type: 'text', text: `An error occurred while searching for products. Error: ${error.message}` }],
        }
      }

      if (!result || result.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No products found for search term "${searchTerm}"${
                Object.keys(filters).length > 0 ? ' with the given filters. Consider relaxing them.' : '.'
              }`,
            },
          ],
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }

    return {
      content: [{ type: 'text', text: await runBatch(searchTerm, 'search-products', term => searchProducts(term, filters)) }],
    }
  }
)

server.tool(
  'get-product-reviews',
  'Read the customer reviews of one or several products using their ASIN - ' +
    'Returns the rating summary, the star breakdown and the individual reviews (title, rating, date, verified-purchase badge, text) - ' +
    'Pass a list of ASINs to read the reviews of several products in one call instead of calling this tool repeatedly, ' +
    'which is the fast way to compare candidates - ' +
    'Use it to judge whether a product is actually good before recommending or buying it, and quote what reviewers said - ' +
    'Always provide the product link when you mention a product in the response',
  {
    asin: oneOrMany(ASIN_SCHEMA).describe(
      'The ASIN (Amazon Standard Identification Number) of the product to read reviews for, ' +
        `or a list of up to ${BATCH_MAX_ITEMS} ASINs to read them all at once. Each ASIN is a 10-character string.`
    ),
    starFilter: z
      .enum(['all_stars', 'five_star', 'four_star', 'three_star', 'two_star', 'one_star', 'positive', 'critical'])
      .optional()
      .describe('Only return reviews with this rating. Use "critical" to look for recurring complaints. Requires a logged-in session.'),
    sortBy: z
      .enum(['helpful', 'recent'])
      .optional()
      .describe('Order of the reviews: "helpful" (Amazon default) or "recent". Requires a logged-in session.'),
    verifiedPurchaseOnly: z.boolean().optional().describe('Only return reviews from verified purchases. Requires a logged-in session.'),
    maxReviews: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('How many reviews to return per product, between 1 and 100 (default 20).'),
  },
  async ({ asin, starFilter, sortBy, verifiedPurchaseOnly, maxReviews }) => {
    const options = { starFilter, sortBy, verifiedPurchaseOnly, maxReviews }

    if (!Array.isArray(asin)) {
      let result: Awaited<ReturnType<typeof getProductReviews>>
      try {
        result = await getProductReviews(asin, options)
      } catch (error: any) {
        console.error('[ERROR][get-product-reviews] Error in get-product-reviews tool:', error)
        return {
          content: [{ type: 'text', text: `An error occurred while retrieving product reviews. Error: ${error.message}` }],
        }
      }

      if (result.reviews.length === 0) {
        return {
          content: [{ type: 'text', text: `No reviews found for product ${asin}.${result.note ? ` ${result.note}` : ''}` }],
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }

    return {
      content: [
        { type: 'text', text: await runBatch(asin, 'get-product-reviews', item => getProductReviews(item, options)) },
      ],
    }
  }
)

server.tool(
  'perform-purchase',
  'Checkout with the current cart and complete the purchase - ' +
    'Before purchasing, you should verify in the cart content that your are not buying another product that was already there. ' +
    'If there are other products, clear the cart then add the items that the user want to buy again to the cart. ' +
    'Eventually you can purchase. ' +
    'You should always ask for confirmation to the user before running this tool',
  {},
  async ({}) => {
    // Mock the purchase confirmation for demonstration purposes
    return {
      content: [
        {
          type: 'text',
          text: '✅ Purchase confirmed! You can now consult your orders history to see the details of your latest purchase.',
        },
      ],
    }
  }
)

// Start the server
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[INFO] Amazon MCP Server running on stdio')
}

main().catch(error => {
  console.error('[ERROR] Fatal error in main():', error)
  process.exit(1)
})
