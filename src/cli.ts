#!/usr/bin/env node
/**
 * Command line entry point, so the same scrapers can be driven from a Skill rather than
 * over MCP. Everything is printed as JSON on stdout; progress and warnings stay on stderr,
 * exactly as the MCP server does, so callers can pipe the output straight into a parser.
 */
import { addToCart, clearCart, getCartContent, removeFromCart } from './cart.js'
import { getOrdersHistory } from './orders.js'
import { getProductDetails, searchProducts, type SearchFilters, type SearchSort } from './products.js'
import { getProductReviews, type ReviewsSortBy, type ReviewsStarFilter } from './reviews.js'
import { BATCH_CONCURRENCY } from './config.js'
import { mapWithConcurrency } from './utils.js'

const USAGE = `Amazon CLI - same scrapers as the MCP server.

  search <term...>      [--min-price N] [--max-price N] [--brand B] [--category C]
                        [--min-rating N] [--sort relevance|price-asc|price-desc|rating|newest] [--max N]
  details <asin...>
  reviews <asin...>     [--star all_stars|five_star|...|positive|critical]
                        [--sort helpful|recent] [--verified] [--max N]
  cart                  Show the cart
  orders                Show the orders history
  add <asin>            Add to cart      (changes a real cart - confirm with the user first)
  remove <asin>         Remove from cart (changes a real cart - confirm with the user first)
  clear                 Empty the cart   (changes a real cart - confirm with the user first)

Several terms or ASINs may be given: they are fetched concurrently.`

interface ParsedArgs {
  positionals: string[]
  flags: Record<string, string | boolean>
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const name = arg.slice(2)
    const next = argv[i + 1]
    // A flag followed by a non-flag takes it as its value; otherwise it is a boolean
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next
      i++
    } else {
      flags[name] = true
    }
  }

  return { positionals, flags }
}

function num(value: string | boolean | undefined): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`Expected a number, got "${value}"`)
  return parsed
}

function str(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/** Run one item, or several concurrently, mirroring the MCP tools' batch behaviour */
async function runMany<T>(items: string[], fn: (item: string) => Promise<T>): Promise<unknown> {
  if (items.length === 1) return await fn(items[0])

  return await mapWithConcurrency(items, BATCH_CONCURRENCY, async item => {
    try {
      return { input: item, ok: true, result: await fn(item) }
    } catch (error: any) {
      return { input: item, ok: false, error: error.message }
    }
  })
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  const { positionals, flags } = parseArgs(rest)

  switch (command) {
    case 'search': {
      if (positionals.length === 0) throw new Error('search needs at least one search term')
      const filters: SearchFilters = {
        minPrice: num(flags['min-price']),
        maxPrice: num(flags['max-price']),
        brand: str(flags.brand),
        category: str(flags.category),
        minRating: num(flags['min-rating']),
        sortBy: str(flags.sort) as SearchSort | undefined,
        maxResults: num(flags.max),
      }
      return print(await runMany(positionals, term => searchProducts(term, filters)))
    }

    case 'details': {
      if (positionals.length === 0) throw new Error('details needs at least one ASIN')
      return print(await runMany(positionals, async asin => (await getProductDetails(asin)).data))
    }

    case 'reviews': {
      if (positionals.length === 0) throw new Error('reviews needs at least one ASIN')
      const options = {
        starFilter: str(flags.star) as ReviewsStarFilter | undefined,
        sortBy: str(flags.sort) as ReviewsSortBy | undefined,
        verifiedPurchaseOnly: flags.verified === true,
        maxReviews: num(flags.max),
      }
      return print(await runMany(positionals, asin => getProductReviews(asin, options)))
    }

    case 'cart':
      return print(await getCartContent())

    case 'orders':
      return print(await getOrdersHistory())

    case 'add': {
      if (positionals.length !== 1) throw new Error('add needs exactly one ASIN')
      return print(await addToCart(positionals[0]))
    }

    case 'remove': {
      if (positionals.length !== 1) throw new Error('remove needs exactly one ASIN')
      return print(await removeFromCart(positionals[0]))
    }

    case 'clear':
      return print(await clearCart())

    case undefined:
    case 'help':
    case '--help':
      process.stdout.write(`${USAGE}\n`)
      return

    default:
      throw new Error(`Unknown command "${command}".\n\n${USAGE}`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: any) => {
    // Errors go to stderr as JSON too, so a caller never has to guess whether stdout is data
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`)
    process.exit(1)
  })
