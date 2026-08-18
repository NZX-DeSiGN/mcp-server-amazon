---
name: amazon
description: Search Amazon, read product details and customer reviews, and manage the cart, using the user's logged-in session. Use when asked to find, compare, judge or buy a product on Amazon, to check what reviewers say about a product, or to look at the Amazon cart.
allowed-tools: Bash
---

# Amazon

Drives a real, logged-in Amazon account by scraping the site. Prices, ratings and reviews are live.

Run everything through:

```sh
node ~/Documents/DEV/perso/amazon/build/cli.js <command> [...]
```

Output is JSON on stdout. Errors are JSON on stderr with a non-zero exit code.

## Commands

```sh
search <term...>   [--min-price N] [--max-price N] [--brand B] [--category C]
                   [--min-rating N] [--sort relevance|price-asc|price-desc|rating|newest] [--max N]
details <asin...>
reviews <asin...>  [--star all_stars|five_star|four_star|three_star|two_star|one_star|positive|critical]
                   [--sort helpful|recent] [--verified] [--max N]
cart
orders
add <asin>  |  remove <asin>  |  clear
```

Several terms or ASINs in one command are fetched **concurrently**. Passing three ASINs to
`reviews` costs about as much as passing one, so never loop where you can pass a list.

## Recommending a product

Do not answer from the search results alone. A star average hides *why* people were unhappy,
and the first results are partly sponsored ads.

1. **Search with the criteria as filters**, not as free text, and not by filtering the output
   yourself. Amazon applies the filters to its whole catalogue; you would only narrow the page
   it already chose.
   ```sh
   node ~/Documents/DEV/perso/amazon/build/cli.js search "clavier mécanique azerty" \
     --min-price 60 --max-price 150 --min-rating 4 --sort rating
   ```
2. **Shortlist 3 to 5 candidates.** Skip `"isSponsored": true` entries unless nothing else
   fits - they are ads, not recommendations. Be wary of a high rating carried by very few
   reviews.
3. **Fetch the details in one call**, passing every shortlisted ASIN.
4. **Read the reviews in two calls**, both taking the whole list:
   ```sh
   node ~/…/build/cli.js reviews ASIN1 ASIN2 ASIN3 --star critical --sort recent --max 20
   node ~/…/build/cli.js reviews ASIN1 ASIN2 ASIN3 --star positive --max 20
   ```
   `critical` is the important one: recurring defects, durability problems and misleading
   descriptions surface there. Prefer `--sort recent` when a product may have changed revision.
5. **Compare on what reviewers report**, not on the average. Name the recurring complaint of
   every candidate, including the one you recommend.
6. **Recommend** with the product link, the price and the reasons, quoting reviews where useful.
   If the reviews contradict the rating, say so - for instance when the positive reviews are
   unverified while the critical ones come from verified buyers.

## Care

- **Ask the user before `add`, `remove` and `clear`.** They change a real cart.
- `orders` usually fails: Amazon demands a fresh authentication that exported cookies cannot
  satisfy. Report it and move on rather than retrying.
- `reviews` returns at most 100 reviews per filter. That is an Amazon ceiling, not an error;
  to go deeper, ask for each star level separately.
- Always give the product link when mentioning a product.

## When it stops working

`You need to be logged in` means the session expired. The user re-exports their cookies with:

```sh
cd ~/Documents/DEV/perso/amazon
AMAZON_DOMAIN=amazon.fr AMAZON_EMAIL=… AMAZON_PASSWORD=… node login_and_save_cookies.cjs
```

Settings are environment variables - `AMAZON_DOMAIN`, `AMAZON_LOCALE`, `HTTP_FIRST`,
`BATCH_CONCURRENCY` and others are listed in the project README.
