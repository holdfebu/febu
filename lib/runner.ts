import { loadJSON, saveJSON } from "./persist";

/**
 * Runner: watches DexScreener's new-token-profile feed (WebSocket with a REST
 * safety net) and streams alerts to browsers over SSE. Ported from the
 * standalone meme_snipe server so it rides inside the Next.js process.
 */

export interface Alert {
  tokenAddress: string;
  chainId: string;
  name: string | null;
  symbol: string | null;
  marketCap: number | null;
  priceUsd: number | string | null;
  liquidity: number | null;
  icon: string | null;
  description: string;
  url?: string;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  creator?: string | null;
  ts: number;
}

const CHAINS = new Set(["solana", "robinhood"]);
const FALLBACK_MS = 20_000;
const BURST = 12; // >this many "new" at once = a resync snapshot, not real alerts
const DISPLAY = 10; // cards per column that get live re-pricing
const LIVE_MS = 2_000;
const MAX_FEED = 500;

const WS_URL = "wss://api.dexscreener.com/token-profiles/latest/v1";
const REST_URL = "https://api.dexscreener.com/token-profiles/latest/v1";

// ---- state (restored from disk so restarts keep history) ----
interface RunnerFile {
  feed: Alert[];
  seen: string[];
}

type Send = (line: string) => void;

interface RunnerState {
  feed: Alert[];
  seen: Set<string>;
  clients: Set<Send>;
  primed: boolean;
  started: boolean;
  working: boolean;
}

// instrumentation.ts and route handlers are bundled into separate module
// graphs in production, so plain module-level state would exist twice: the
// watcher would fill one copy while the SSE route reads another, empty one.
// Anchoring the state on globalThis makes every copy share it.
const g = globalThis as unknown as { __febuRunner?: RunnerState };
if (!g.__febuRunner) {
  const savedState = loadJSON<RunnerFile>("runner", { feed: [], seen: [] });
  g.__febuRunner = {
    feed: [...savedState.feed],
    seen: new Set(savedState.seen),
    clients: new Set(),
    primed: savedState.seen.length > 0,
    started: false,
    working: false,
  };
}
const state = g.__febuRunner;
const feed = state.feed;
const seen = state.seen;
const clients = state.clients;

function save() {
  saveJSON("runner", () => ({ feed, seen: [...seen] }));
}

export function addClient(send: Send): () => void {
  // replay history oldest-first so the page fills instantly
  for (const a of [...feed].reverse()) send(`data: ${JSON.stringify(a)}\n\n`);
  clients.add(send);
  return () => clients.delete(send);
}

export function clientCount(): number {
  return clients.size;
}

function broadcastObj(obj: unknown) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const send of clients) {
    try {
      send(line);
    } catch {
      clients.delete(send);
    }
  }
}

// ---- helpers ----
async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    cache: "no-store",
    headers: { accept: "application/json", "user-agent": "febu-runner/1.0" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

interface DsPair {
  baseToken?: { name?: string; symbol?: string; address?: string };
  marketCap?: number;
  fdv?: number;
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: unknown;
  priceChange?: unknown;
  txns?: unknown;
  pairCreatedAt?: number;
  dexId?: string;
  url?: string;
  pairAddress?: string;
}

async function marketData(addr: string) {
  try {
    const d = await getJSON<{ pairs?: DsPair[] }>(
      `https://api.dexscreener.com/latest/dex/tokens/${addr}`
    );
    const pairs = d.pairs || [];
    if (!pairs.length) return {};
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const p = pairs[0];
    return {
      name: p.baseToken?.name,
      symbol: p.baseToken?.symbol,
      marketCap: p.marketCap ?? p.fdv ?? null,
      priceUsd: p.priceUsd ?? null,
      liquidity: p.liquidity?.usd ?? null,
    };
  } catch {
    return {};
  }
}

async function enrichCreator(alert: Alert) {
  if (alert.chainId !== "solana" || !alert.tokenAddress.endsWith("pump")) return;
  if (alert.creator) return;
  try {
    const coin = await getJSON<{ creator?: string }>(
      `https://frontend-api-v3.pump.fun/coins/${alert.tokenAddress}`
    );
    if (!coin.creator) return;
    alert.creator = coin.creator;
    save();
    broadcastObj({
      type: "creator",
      tokenAddress: alert.tokenAddress,
      creator: coin.creator,
    });
  } catch {
    /* optional enrichment */
  }
}

interface Profile {
  tokenAddress: string;
  chainId: string;
  icon?: string;
  description?: string;
  url?: string;
  links?: Array<{ type?: string; label?: string; url?: string }>;
}

function pickLink(
  links: Profile["links"],
  type: string,
  rx: RegExp
): string | null {
  const l = links || [];
  return (
    (l.find((x) => x.type === type) || l.find((x) => rx.test(x.url || "")))
      ?.url || null
  );
}

async function processProfiles(profiles: Profile[]) {
  const wanted = profiles.filter((p) => CHAINS.has(p.chainId));
  const fresh = [...wanted].reverse().filter((p) => !seen.has(p.tokenAddress));
  if (!fresh.length || state.working) return;
  state.working = true;

  const silent = !state.primed || fresh.length > BURST;
  try {
    for (const p of fresh) {
      if (seen.has(p.tokenAddress)) continue;
      seen.add(p.tokenAddress);
      const md = await marketData(p.tokenAddress);
      const alert: Alert = {
        tokenAddress: p.tokenAddress,
        chainId: p.chainId,
        name: md.name || null,
        symbol: md.symbol || null,
        marketCap: md.marketCap ?? null,
        priceUsd: md.priceUsd ?? null,
        liquidity: md.liquidity ?? null,
        icon: p.icon || null,
        description: p.description || "",
        url: p.url,
        twitter: pickLink(p.links, "twitter", /(?:twitter\.com|x\.com)/i),
        telegram: pickLink(p.links, "telegram", /t\.me/i),
        website:
          (p.links || []).find(
            (l) => (l.label || "").toLowerCase() === "website"
          )?.url ||
          (p.links || []).find((l) => l.type === "website")?.url ||
          null,
        ts: Date.now(),
      };
      feed.unshift(alert);
      if (feed.length > MAX_FEED) feed.pop();
      save();
      broadcastObj(alert);
      void enrichCreator(alert);
      console.log(
        `runner ${silent ? "seed" : "NEW "} [${alert.chainId}] ${alert.symbol || "?"} ${alert.tokenAddress}`
      );
    }
    state.primed = true;
  } finally {
    state.working = false;
  }
}

// ---- primary feed: WebSocket ----
function connectWS() {
  let ws: WebSocket;
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    setTimeout(connectWS, 5000);
    return;
  }
  ws.addEventListener("open", () => console.log("runner ws connected"));
  ws.addEventListener("message", (ev: MessageEvent) => {
    let txt: string;
    if (typeof ev.data === "string") txt = ev.data;
    else {
      try {
        txt = Buffer.from(ev.data as ArrayBuffer).toString("utf8");
      } catch {
        return;
      }
    }
    let msg: unknown;
    try {
      msg = JSON.parse(txt);
    } catch {
      return;
    }
    const data = Array.isArray(msg)
      ? msg
      : (msg as { data?: unknown }).data;
    if (Array.isArray(data)) void processProfiles(data as Profile[]);
  });
  ws.addEventListener("close", () => setTimeout(connectWS, 3000));
  ws.addEventListener("error", () => {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  });
}

async function fallbackPoll() {
  try {
    const profiles = await getJSON<Profile[]>(REST_URL);
    await processProfiles(profiles);
  } catch {
    /* transient */
  } finally {
    setTimeout(fallbackPoll, FALLBACK_MS);
  }
}

// Re-price the visible cards, one batched call per chain per tick.
async function refreshLive() {
  try {
    for (const chain of CHAINS) {
      const shown = feed
        .filter((a) => (a.chainId || "solana") === chain)
        .slice(0, DISPLAY);
      if (!shown.length) continue;
      const addrs = shown.map((a) => a.tokenAddress).join(",");
      let pairs: DsPair[];
      try {
        pairs = await getJSON<DsPair[]>(
          `https://api.dexscreener.com/tokens/v1/${chain}/${addrs}`
        );
      } catch {
        continue;
      }
      if (!Array.isArray(pairs)) continue;

      const best: Record<
        string,
        { marketCap: number | null; liquidity: number | null; price: number | null; _score: number }
      > = {};
      for (const p of pairs) {
        const key = (p.baseToken?.address || "").toLowerCase();
        if (!key) continue;
        const liq = p.liquidity?.usd ?? null;
        const score = liq ?? -1;
        if (!best[key] || score > best[key]._score) {
          best[key] = {
            marketCap: p.marketCap ?? p.fdv ?? null,
            liquidity: liq,
            price: p.priceUsd != null ? +p.priceUsd : null,
            _score: score,
          };
        }
      }
      for (const a of shown) {
        void enrichCreator(a);
        const b = best[a.tokenAddress.toLowerCase()];
        if (!b) continue;
        if (
          a.marketCap !== b.marketCap ||
          a.liquidity !== b.liquidity ||
          a.priceUsd !== b.price
        ) {
          a.marketCap = b.marketCap;
          a.liquidity = b.liquidity;
          a.priceUsd = b.price;
          broadcastObj({
            type: "update",
            tokenAddress: a.tokenAddress,
            marketCap: b.marketCap,
            liquidity: b.liquidity,
            price: b.price,
          });
        }
      }
    }
  } catch {
    /* keep the loop alive */
  } finally {
    setTimeout(refreshLive, LIVE_MS);
  }
}

/** Start the watcher exactly once per process. */
export function startRunner() {
  if (state.started) return;
  state.started = true;
  console.log("runner starting: watching", [...CHAINS].join(", "));
  connectWS();
  void fallbackPoll();
  void refreshLive();
  // keep SSE connections warm
  setInterval(() => broadcastObjPing(), 15_000);
}

function broadcastObjPing() {
  for (const send of clients) {
    try {
      send(`: ping ${Date.now()}\n\n`);
    } catch {
      clients.delete(send);
    }
  }
}
