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

// Create server instance
const server = new McpServer({
  name: 'amazon',
  version: '1.0.0',
})

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
      .length(10, { message: 'ASIN must be a 10-character string.' })
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
      .length(10, { message: 'ASIN must be a 10-character string.' })
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
      z.string().length(10, { message: 'ASIN must be a 10-character string.' })
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
  'Search for products on Amazon using one or several search terms - Returns the products matching each term - ' +
    'Pass a list of terms to run several searches in one call instead of calling this tool repeatedly - ' +
    'Always provide the product link when you mention a product in the response',
  {
    searchTerm: oneOrMany(z.string().min(1, { message: 'Search term cannot be empty.' })).describe(
      'The search term to look for products on Amazon (for example: "collagen", "laptop", "books"), ' +
        `or a list of up to ${BATCH_MAX_ITEMS} terms to run all those searches at once.`
    ),
  },
  async ({ searchTerm }) => {
    if (!Array.isArray(searchTerm)) {
      let result: Awaited<ReturnType<typeof searchProducts>>
      try {
        result = await searchProducts(searchTerm)
      } catch (error: any) {
        console.error('[ERROR][search-products] Error in search-products tool:', error)
        return {
          content: [{ type: 'text', text: `An error occurred while searching for products. Error: ${error.message}` }],
        }
      }

      if (!result || result.length === 0) {
        return { content: [{ type: 'text', text: `No products found for search term "${searchTerm}".` }] }
      }

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }

    return {
      content: [{ type: 'text', text: await runBatch(searchTerm, 'search-products', term => searchProducts(term)) }],
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
    asin: oneOrMany(z.string().length(10, { message: 'ASIN must be a 10-character string.' })).describe(
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
