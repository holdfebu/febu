// Server-only Helius data access. Never import this from client components.

const HELIUS_KEY = process.env.HELIUS_API_KEY;

function rpcUrl(): string {
  if (!HELIUS_KEY) {
    throw new Error(
      "HELIUS_API_KEY is not set. Copy .env.local.example to .env.local and add your key."
    );
  }
  return `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
}

let idCounter = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// JSON-RPC call with retry + exponential backoff on rate limits (429) and 5xx.
async function heliusRpc<T>(
  method: string,
  params: unknown,
  maxAttempts = 5
): Promise<T> {
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(rpcUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `febu-${++idCounter}`,
          method,
          params,
        }),
        cache: "no-store",
      });

      // Rate limited or transient server error -> back off and retry.
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = retryAfter
          ? retryAfter * 1000
          : Math.min(4000, 250 * 2 ** attempt) + Math.random() * 150;
        lastErr = new Error(`Helius ${method} HTTP ${res.status}`);
        await sleep(wait);
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Helius ${method} HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      const json = (await res.json()) as {
        result?: T;
        error?: { code: number; message: string };
      };
      if (json.error) {
        // -32429 style rate-limit inside a 200 body -> retry too.
        if (json.error.code === -32429 || /rate|limit/i.test(json.error.message)) {
          lastErr = new Error(`Helius ${method} rpc-limit: ${json.error.message}`);
          await sleep(Math.min(4000, 250 * 2 ** attempt) + Math.random() * 150);
          continue;
        }
        throw new Error(`Helius ${method} error ${json.error.code}: ${json.error.message}`);
      }
      return json.result as T;
    } catch (err) {
      // Network error: retry a couple of times, then give up.
      lastErr = err;
      if (attempt < maxAttempts - 1) {
        await sleep(Math.min(4000, 250 * 2 ** attempt));
        continue;
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(`Helius ${method} failed`);
}

export interface TokenSupply {
  amount: string; // raw integer as string
  decimals: number;
  uiAmount: number;
}

export async function getTokenSupply(mint: string): Promise<TokenSupply> {
  const result = await heliusRpc<{
    value: { amount: string; decimals: number; uiAmount: number };
  }>("getTokenSupply", [mint]);
  return {
    amount: result.value.amount,
    decimals: result.value.decimals,
    uiAmount: result.value.uiAmount,
  };
}

export interface RawTokenAccount {
  address: string; // token account (ATA)
  owner: string;
  amount: number; // raw integer amount
}

// Paginate the DAS getTokenAccounts endpoint to collect every non-zero
// token account for the mint. Capped to avoid runaway pagination.
export async function getAllTokenAccounts(
  mint: string,
  maxPages = 60,
  limit = 1000
): Promise<RawTokenAccount[]> {
  const out: RawTokenAccount[] = [];
  let page = 1;

  while (page <= maxPages) {
    const result = await heliusRpc<{
      token_accounts?: Array<{ address: string; owner: string; amount: number }>;
    }>("getTokenAccounts", {
      mint,
      page,
      limit,
      options: { showZeroBalance: false },
    });

    const accounts = result.token_accounts ?? [];
    for (const a of accounts) {
      out.push({ address: a.address, owner: a.owner, amount: Number(a.amount) });
    }
    if (accounts.length < limit) break; // last page reached
    page++;
  }

  return out;
}

// Find the earliest known block time for an account by paging its signature
// history to the oldest entry. Returns unix seconds, or null if unknown.
export async function getEarliestBlockTime(
  account: string,
  maxPages = 12,
  limit = 1000
): Promise<number | null> {
  let before: string | undefined;
  let earliest: number | null = null;

  for (let i = 0; i < maxPages; i++) {
    const sigs = await heliusRpc<
      Array<{ signature: string; blockTime: number | null }>
    >("getSignaturesForAddress", [account, before ? { limit, before } : { limit }]);

    if (!sigs.length) break;

    const last = sigs[sigs.length - 1];
    if (last.blockTime != null) earliest = last.blockTime;
    before = last.signature;

    if (sigs.length < limit) break; // reached the oldest page
  }

  return earliest;
}
