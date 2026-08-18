# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is an Amazon MCP (Model Context Protocol) Server that enables AI assistants to interact with Amazon services through web scraping. The server uses Puppeteer for browser automation and exposes Amazon functionality through MCP tools.

## Development Commands

```bash
# Install dependencies (use -D flag for Puppeteer)
npm install -D

# Build TypeScript to JavaScript
npm run build

# Clean mock HTML files
npm run clean
```

## Architecture

### Core Components

- **MCP Server** (`src/index.ts`): Defines and exposes tools via the MCP protocol
- **Products** (`src/products.ts`): Product search and product details scraping
- **Reviews** (`src/reviews.ts`): Customer reviews, rating summary and star breakdown
- **Cart** (`src/cart.ts`): Cart content, add, remove one item, clear
- **Orders** (`src/orders.ts`): Orders history
- **Configuration** (`src/config.ts`): Env-driven settings, marketplace/locale, `amazonUrl()`
- **Browser Utils** (`src/utils.ts`): Puppeteer helpers, login detection, text normalisation

### Key Dependencies

- `@modelcontextprotocol/sdk`: MCP framework
- `puppeteer`: Browser automation
- `cheerio`: HTML parsing
- `zod`: Schema validation

### Authentication

Most tools need Amazon cookies:
1. Export cookies from browser using a cookie export extension, or run
   `AMAZON_DOMAIN=amazon.fr AMAZON_EMAIL=... AMAZON_PASSWORD=... node login_and_save_cookies.cjs`
2. Save to `amazonCookies.json` in project root (gitignored)
3. Format: Array of cookie objects with standard properties

A missing cookie file is not fatal: the server starts and scrapes anonymously.
Session-gated pages throw through `throwIfNotLoggedIn()`, which detects Amazon's
`/ap/signin` redirect - not just the classic `#ap_email` form.

### Configuration

Everything is env-driven (`src/config.ts`): `AMAZON_DOMAIN`, `AMAZON_LOCALE`,
`AMAZON_COOKIES_FILE`, `USE_MOCK_RESPONSES`, `EXPORT_MOCKS`, `BROWSER_VISIBLE`,
`BROWSER_REUSE`, `BROWSER_IDLE_TIMEOUT_MS`, `BLOCK_ASSETS`.
Build URLs with `amazonUrl('/gp/product/<asin>')` rather than hardcoding a domain
or the `/-/en/` language segment.

## Important Implementation Details

### Browser Automation
- Uses headless Chrome with specific flags to avoid detection
- Implements user agent spoofing
- Handles Amazon's anti-bot measures
- One Chrome is shared by all calls via `withPage()` in `src/utils.ts`, and closes
  itself after `BROWSER_IDLE_TIMEOUT_MS` idle. Never call `puppeteer.launch()`
  directly - the page accounting is what decides when the browser may close.
- Navigate with `navigate()`, which waits for `domcontentloaded` and leaves the
  "is the data there" question to each scraper's `waitForSelector`. `networkidle2`
  waits out Amazon's ad traffic and cost 90% of every request.
- Flows that click Amazon's widgets pass `{ interactive: true }` to `withPage()`
  and `{ waitUntil: 'load' }` to `navigate()`: they need a booted, fully rendered
  page, so nothing is blocked for them.

### Error Handling
- Detects login page redirects and throws authentication errors
- Implements retry logic for network failures
- Provides detailed error messages for debugging

### Scraping notes
- Amazon serves two markups for reviews: the product page uses `reviewTitle` /
  `reviewRichContentContainer`, the reviews page the classic `review-title` /
  `review-body`. Match `[data-hook="review"]` without a tag prefix - the container
  is not always a `<div>`.
- Many nodes hold both the desktop and the mobile copy of a string, yielding
  "4.2  4.2". Normalise with `cleanText()` from `src/utils.ts`.
- Text-based branching (empty cart, add-to-cart confirmation, return eligibility)
  must accept the French wording as well as the English one.

### Mock Mode
- Set `USE_MOCK_RESPONSES=true` in environment to use mock HTML files
- Mock files stored in `mocks/` directory
- Useful for development and testing without hitting Amazon

### Logging
- Server logs to `~/Library/Logs/Claude/mcp-server-amazon.log`
- Check logs for debugging authentication or scraping issues

## MCP Tools Exposed

1. `search-products`: Search Amazon catalog
2. `get-product-details`: Get detailed product information
3. `get-orders-history`: View past orders
4. `get-cart-content`: View current cart
5. `add-to-cart`: Add items to cart
6. `remove-from-cart`: Remove a single item from the cart by ASIN (leaves other items untouched)
7. `clear-cart`: Remove all items from cart
8. `get-product-reviews`: Read customer reviews, rating summary and star breakdown
   (star filter, sort, verified-only; falls back to the public product-page reviews
   when not logged in)
9. `perform-purchase`: Complete purchase (mock mode only)

## Testing Approach

No formal test suite exists. Testing is done through:
- `src/amazon.*.test.ts` scripts, run directly after `npm run build`
  (e.g. `node build/amazon.getProductReviews.test.js`)
- Manual testing with Claude Desktop
- Mock mode for development
- Log analysis for debugging

## Common Issues

1. **Authentication failures**: Update cookies from browser
2. **Scraping failures**: Amazon HTML structure may have changed
3. **Rate limiting**: Add delays between requests if needed