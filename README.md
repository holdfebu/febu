# $febu holders

Deep holder analytics for the Solana token
`4ko5tSr5o3H4v1sFtjTSd9MPUW7yx5AFCpkNPoL6pump`.

- **Holders** — full holder list, aggregated across each wallet's token accounts.
- **Tiers by % of supply** — holders bucketed into six tiers, each headed by its
  live USD range (derived from market cap) alongside its percentage band.
- **Hold-time cohorts** — the top 100 wallets grouped by how long they've held
  (`<24h` → `6m+`).
- **Gain/loss** — every tier and cohort shows its change against a rolling
  server-side baseline (~1h), so a first-time visitor sees real movement without
  refreshing.
- **Live price** — Jupiter price, market cap and 24h change, polled every 10s.

## Setup

1. Get a free API key at [helius.dev](https://helius.dev) → API Keys.
2. Copy `.env.local.example` to `.env.local` and fill it in:

   ```
   HELIUS_API_KEY=your_key_here
   NEXT_PUBLIC_TOKEN_MINT=4ko5tSr5o3H4v1sFtjTSd9MPUW7yx5AFCpkNPoL6pump
   ```

3. Install and run:

   ```
   npm install
   npm run dev
   ```

## Architecture

- `lib/helius.ts` — Helius RPC with retry/backoff on rate limits.
- `lib/holders.ts` — holder aggregation, tiers, concentration. 60s cache with
  **request coalescing**: concurrent callers share one chain scan.
- `lib/holdtime.ts` — earliest-acquisition lookup, cached per account and
  deduped across concurrent requests.
- `lib/history.ts` — rolling snapshots (every 5 min, 6h retained) that provide
  the ~1h baseline for gain/loss.
- `lib/jupiter.ts` — price feed.
- `app/api/{holders,holdtime,price}` — API routes; the price route caches for 7s
  and dedupes so a crowd doesn't multiply through to Jupiter.

## Deployment

Designed to run as a **single always-on instance** (Railway, Fly, Render, a VPS).
All caching, coalescing and snapshot history live in process memory, which is
what lets one chain scan serve every concurrent viewer.

Required env vars: `HELIUS_API_KEY`, `NEXT_PUBLIC_TOKEN_MINT`.
Build `npm run build`, start `npm start` (reads `PORT` from the environment).

> **Do not run multiple replicas / autoscaling** without adding a shared cache
> (Redis). Each replica would keep its own cache and its own baseline, so
> visitors would see inconsistent numbers and Helius usage would multiply.

## Notes / limitations

- **Hold time** is the age since a wallet's largest token account first received
  the token. A wallet that sold and rebought still shows its original date.
- Cohorts cover the **top 100 wallets**, not all holders — resolving hold times
  for every holder would be prohibitively rate-intensive.
