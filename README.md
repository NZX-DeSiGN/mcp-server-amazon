# Amazon MCP Server

This server allows you to interact with Amazon's services using the MCP (Model Context Protocol) framework. This lets you use your Amazon account through ChatGPT or Claude AI interfaces.

## Features

- **Product search**: Search for products on Amazon
- **Product details**: Retrieve detailed information about a specific product on Amazon
- **Customer reviews**: Read a product's reviews, rating summary and star breakdown, with star/sort/verified filters
- **Cart management**: Add items, remove a single item, or clear your Amazon cart
- **Ordering**: Place orders (fake for demonstration purposes)
- **Orders history**: Retrieve your recent Amazon orders details

Works with any Amazon marketplace - `amazon.com`, `amazon.fr`, `amazon.de`, ... - see [Configuration](#configuration).

## Demo

Simple demo, showcasing a quick product search and purchase.

![Demo GIF video](./demo.gif)

## Full Demo

Another more complex demo with products search, leveraging Claude AI recommendations to compare and make a decision, then purchase.

It showcases how natural and powerful the Amazon MCP integration could be inside a conversation

Video: https://www.youtube.com/watch?v=xas2CLkJDYg

## Install

Install dependencies

```sh
npm install -D
```

Build the project

```sh
npm run build
```

## Authentication

Most tools need your Amazon session. Either export your cookies with a browser
extension like [Cookie-Editor](https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm)
into `amazonCookies.json` (see [amazonCookies.example.json](./amazonCookies.example.json)),
or let the helper script log in for you:

```sh
AMAZON_DOMAIN=amazon.fr AMAZON_EMAIL=you@example.com AMAZON_PASSWORD=... node login_and_save_cookies.cjs
```

A visible browser window opens so you can complete any CAPTCHA, OTP or device
approval; the cookies are saved when the login lands.

Without cookies the server still starts and `search-products`, `get-product-details`
and `get-product-reviews` keep working anonymously - reviews then fall back to the
handful Amazon shows publicly on the product page.

## Configuration

All settings are environment variables, so nothing has to be edited and rebuilt:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AMAZON_DOMAIN` | detected from cookies | Marketplace to use, e.g. `amazon.fr`, `amazon.de` |
| `AMAZON_LOCALE` | `en` | Language segment in every URL (`/-/en/`). Use `fr`, or an empty string for the marketplace default |
| `AMAZON_COOKIES_FILE` | `./amazonCookies.json` | Where to read the cookies from |
| `USE_MOCK_RESPONSES` | `false` | Serve the HTML in `mocks/` instead of scraping |
| `EXPORT_MOCKS` | `false` | Dump the scraped HTML into `mocks/` (several MB per call) |
| `BROWSER_VISIBLE` | `false` | Run Chrome with a window, to watch the scraping |
| `BROWSER_REUSE` | `true` | Share one Chrome across tool calls instead of launching one per call |
| `BROWSER_IDLE_TIMEOUT_MS` | `180000` | Close the shared Chrome after this long without activity (`0` keeps it open) |
| `BLOCK_ASSETS` | `true` | Skip images, stylesheets, fonts, ads and telemetry while scraping |
| `HTTP_FIRST` | `true` | Read pages over plain HTTP and only start Chrome if Amazon refuses |

`AMAZON_LOCALE` defaults to `en` because a few scrapers match on page text; both
English and French wordings are recognised, so `fr` works too.

`HTTP_FIRST` is where most of the speed comes from: the pages being scraped are
server-rendered, so a plain request returns the same markup Chrome would render,
without the browser. Chrome still takes over automatically on a captcha or an
unrecognised page, and the tools that click Amazon's widgets always use it.

The three browser settings only trade speed for isolation: with the defaults a
search takes ~2s instead of ~4.2s, and an idle server holds no browser at all.
`add-to-cart`, `remove-from-cart` and `clear-cart` always get a fully rendered
page regardless of `BLOCK_ASSETS`, since they click Amazon's own widgets.

## Claude Desktop Integration

Create or update `~/Library/Application Support/Claude/claude_desktop_config.json` with the path to the MCP server.

```json
{
  "mcpServers": {
    "amazon": {
      "command": "node",
      "args": ["/Users/admin/dev/mcp-server-amazon/build/index.js"],
      "env": {
        "AMAZON_DOMAIN": "amazon.fr"
      }
    }
  }
}
```

Restart the Claude Desktop app to apply the changes. You should now see the Amazon MCP server listed in the Claude Desktop app.

|                                  |                                    |
| :------------------------------: | :--------------------------------: |
| ![screenshot](./screenshot.webp) | ![screenshot2](./screenshot2.webp) |

## Troubleshooting

The MCP server logs its output to a file. If you encounter any issues, you can check the log file for more information.

See `~/Library/Logs/Claude/mcp-server-amazon.log`

## License

[The MIT license](./LICENSE)
