"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { HoldersPayload, Holder, BucketStat } from "@/lib/holders";
import { TOKEN_MINT, AGE_COHORTS, cohortForDays } from "@/lib/config";
import PriceChart from "@/components/PriceChart";
import {
  shortAddr,
  fmtNumber,
  fmtPct,
  fmtDuration,
  fmtDate,
  fmtUsd,
  fmtPrice,
} from "@/lib/format";

interface PriceInfo {
  usdPrice: number;
  priceChange24h: number | null;
  liquidity: number | null;
  at: number;
}

const PRICE_POLL_MS = 3_000;

interface PoolDetail {
  owner: string;
  entries: Array<{
    mint: string;
    symbol: string;
    amount: number;
    usd: number | null;
  }>;
  tvl: number;
  at: number;
}

type AgeState =
  | { status: "loading" }
  | { status: "done"; ageSeconds: number | null; firstBlockTime: number | null };

const TABLE_LIMIT = 100; // how many holders the table shows
const AUTO_LOAD = 100; // auto-fetch hold times for the top N holders
const BATCH = 20;

export default function Page() {
  const [data, setData] = useState<HoldersPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ages, setAges] = useState<Record<string, AgeState>>({});
  const [loadingMore, setLoadingMore] = useState(false);
  const [price, setPrice] = useState<PriceInfo | null>(null);
  const [priceStale, setPriceStale] = useState(false);
  const [retryRound, setRetryRound] = useState(0);
  const [refreshingCohorts, setRefreshingCohorts] = useState(false);
  const [refreshingTable, setRefreshingTable] = useState(false);

  const fetchHolders = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/holders?limit=${TABLE_LIMIT}${force ? "&fresh=1" : ""}`
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setData(json as HoldersPayload);
      setAges({});
      setRetryRound(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHolders();
  }, [fetchHolders]);

  // Poll the Jupiter price every 10 seconds.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/price");
        const json = await res.json();
        if (cancelled) return;
        if (res.ok && typeof json.usdPrice === "number") {
          setPrice(json as PriceInfo);
          setPriceStale(false);
        } else {
          setPriceStale(true);
        }
      } catch {
        if (!cancelled) setPriceStale(true);
      }
    };
    tick();
    const id = setInterval(tick, PRICE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Fetch hold times for a given list of holders in bounded batches.
  // Stable identity (no deps) to avoid stale-closure bugs; callers pick the slice.
  const loadAges = useCallback(async (holders: Holder[]) => {
    if (!holders.length) return;

    setAges((prev) => {
      const next = { ...prev };
      for (const h of holders) next[h.tokenAccount] = { status: "loading" };
      return next;
    });

    for (let i = 0; i < holders.length; i += BATCH) {
      const chunk = holders.slice(i, i + BATCH);
      const accounts = chunk.map((h) => h.tokenAccount).join(",");

      // Retry the batch a few times before giving up on it.
      let results: Record<string, { ageSeconds: number | null; firstBlockTime: number | null }> | null =
        null;
      for (let attempt = 0; attempt < 3 && !results; attempt++) {
        try {
          const res = await fetch(`/api/holdtime?accounts=${accounts}`);
          const json = await res.json();
          if (res.ok && json.results) results = json.results;
          else await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        } catch {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }

      setAges((prev) => {
        const next = { ...prev };
        for (const h of chunk) {
          const r = results ? results[h.tokenAccount] : null;
          next[h.tokenAccount] = {
            status: "done",
            ageSeconds: r ? r.ageSeconds : null,
            firstBlockTime: r ? r.firstBlockTime : null,
          };
        }
        return next;
      });
    }
  }, []);

  // Auto-load hold times for the top holders once data arrives.
  useEffect(() => {
    if (data) loadAges(data.holders.slice(0, AUTO_LOAD));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const loadMoreAges = useCallback(async () => {
    if (!data) return;
    setLoadingMore(true);
    const start = Object.keys(ages).length;
    await loadAges(data.holders.slice(start, start + AUTO_LOAD));
    setLoadingMore(false);
  }, [data, ages, loadAges]);

  // Build hold-time cohort distribution over the TOP 100 wallets by balance.
  const cohortStats = useMemo(() => {
    const counts: Record<string, number> = {};
    let loaded = 0;
    let pending = 0;
    let unknown = 0;
    const top = data ? data.holders.slice(0, 100) : [];
    for (const h of top) {
      const a = ages[h.tokenAccount];
      if (!a || a.status === "loading") {
        pending++;
        continue;
      }
      if (a.ageSeconds == null) {
        unknown++;
        continue;
      }
      loaded++;
      const days = a.ageSeconds / 86400;
      counts[cohortForDays(days).key] = (counts[cohortForDays(days).key] || 0) + 1;
    }
    return { counts, loaded, pending, unknown, total: top.length };
  }, [ages, data]);

  // Baselines come from the server's rolling history (~1h old), so a
  // first-time visitor sees real movement without touching Refresh.
  const prevBuckets = data?.baseline?.buckets ?? null;
  const prevCounts = data?.baseline?.cohorts ?? null;
  const baselineAge = data?.baseline?.ageSeconds ?? null;

  // Auto-retry any top-100 wallets that came back unknown (transient RPC limits),
  // up to a few bounded rounds so the cohort chart converges to 100.
  useEffect(() => {
    if (!data || cohortStats.pending > 0 || cohortStats.unknown === 0) return;
    if (retryRound >= 3) return;
    const toRetry = data.holders.slice(0, 100).filter((h) => {
      const a = ages[h.tokenAccount];
      return a && a.status === "done" && a.ageSeconds == null;
    });
    if (!toRetry.length) return;
    setRetryRound((r) => r + 1);
    const t = setTimeout(() => loadAges(toRetry), 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cohortStats.pending, cohortStats.unknown, retryRound, data]);

  // Re-resolve hold times for the current top 100, keeping the old counts
  // so each cohort can show its gain/loss.
  const refreshCohorts = useCallback(async () => {
    if (!data || refreshingCohorts) return;
    setRefreshingCohorts(true);
    setRetryRound(0);
    await loadAges(data.holders.slice(0, AUTO_LOAD));
    setRefreshingCohorts(false);
  }, [data, loadAges, refreshingCohorts]);

  // Re-pull the holder list itself (bypasses the 60s server cache).
  // Baselines are NOT reset here — deltas always read "since page load".
  const refreshTable = useCallback(async () => {
    if (refreshingTable) return;
    setRefreshingTable(true);
    await fetchHolders(true);
    setRefreshingTable(false);
  }, [fetchHolders, refreshingTable]);


  const copyMint = () => navigator.clipboard?.writeText(TOKEN_MINT);

  return (
    <div className="wrap">
      <header className="header">
        <div className="brand">
          <pre className="logo" aria-label="febu">{String.raw`\   |   /
--- ( ) ---
/   |   \
|  o   o  |
\__  _  __/
/  f e b u  \
/|\       /|\
(_/         \_)`}</pre>
          <div>
            <h1>$febu holders</h1>
            <div className="mint-row">
              <span className="mint-pill">{shortAddr(TOKEN_MINT, 6, 6)}</span>
              <button className="copy-btn" onClick={copyMint}>
                copy
              </button>
              <a
                className="copy-btn"
                href={`https://solscan.io/token/${TOKEN_MINT}`}
                target="_blank"
                rel="noreferrer"
              >
                solscan ↗
              </a>
            </div>
          </div>
        </div>
        <div className="header-right">
          <a className="runner-btn" href="/runner">
            ✦ Runner
          </a>
          <PricePill price={price} stale={priceStale} />
          <button
            className="refresh"
            onClick={refreshTable}
            disabled={loading || refreshingTable}
          >
            {loading ? "Loading…" : "↻ Refresh"}
          </button>
        </div>
      </header>

      {loading && !data && (
        <div className="state">
          <div className="spinner" />
          Scanning the chain for holders…
        </div>
      )}

      {error && (
        <div className="state error">
          <strong>Couldn&apos;t load data.</strong>
          <div style={{ marginTop: 8, fontFamily: "var(--mono)", fontSize: 12 }}>
            {error}
          </div>
          <div style={{ marginTop: 12, fontSize: 12.5 }}>
            Make sure <code>HELIUS_API_KEY</code> is set in <code>.env.local</code>.
          </div>
        </div>
      )}

      {data && (
        <>
          <StatCards data={data} price={price} />
          <BucketSection
            buckets={data.buckets}
            bucketsExPools={data.bucketsExPools}
            burned={data.burned}
            liquidity={data.liquidity}
            totalHolders={data.totalHolders}
            price={price}
            prevBuckets={prevBuckets}
            baselineAge={baselineAge}
            supplyUi={data.supply.uiAmount}
          />
          <CohortSection
            cohortStats={cohortStats}
            prevCounts={prevCounts}
            onRefresh={refreshCohorts}
            refreshing={refreshingCohorts}
          />
          <PriceChart price={price?.usdPrice ?? null} />
          <PoolsSection pools={data.pools ?? []} price={price} />
          <HoldersTable
            data={data}
            ages={ages}
            onLoadMore={loadMoreAges}
            loadingMore={loadingMore}
            onRefresh={refreshTable}
            refreshing={refreshingTable}
          />

          <div className="footer">
            Data via Helius · fetched {fmtDate(Math.floor(data.fetchedAt / 1000))} · Hold
            time = age since the wallet&apos;s token account first received this token.
          </div>
        </>
      )}
    </div>
  );
}

function PricePill({ price, stale }: { price: PriceInfo | null; stale: boolean }) {
  if (!price) {
    return (
      <div className="price-pill">
        <span className="live-dot loading" />
        <span className="price-main">$ —</span>
      </div>
    );
  }
  const up = (price.priceChange24h ?? 0) >= 0;
  return (
    <div className="price-pill" title={`Updated ${new Date(price.at).toLocaleTimeString()}`}>
      <span className={`live-dot${stale ? " stale" : ""}`} />
      <div className="price-body">
        <span className="price-main">{fmtPrice(price.usdPrice)}</span>
        {price.priceChange24h != null && (
          <span className={`price-chg ${up ? "up" : "down"}`}>
            {up ? "▲" : "▼"} {Math.abs(price.priceChange24h).toFixed(2)}% 24h
          </span>
        )}
      </div>
    </div>
  );
}

function StatCards({ data, price }: { data: HoldersPayload; price: PriceInfo | null }) {
  const marketCap = price ? price.usdPrice * data.supply.uiAmount : null;
  return (
    <div className="stats">
      <div className="card">
        <div className="stat-label">Holders</div>
        <div className="stat-value">{data.totalHolders.toLocaleString()}</div>
        <div className="stat-sub">{data.totalAccounts.toLocaleString()} token accounts</div>
      </div>
      <div className="card accent">
        <div className="stat-label">Price · Market Cap</div>
        <div className="stat-value">{price ? fmtPrice(price.usdPrice) : "—"}</div>
        <div className="stat-sub">
          {marketCap != null ? `${fmtUsd(marketCap)} mcap` : "loading…"}
          {price?.priceChange24h != null && (
            <span
              style={{
                marginLeft: 8,
                color: price.priceChange24h >= 0 ? "var(--green)" : "var(--red)",
              }}
            >
              {price.priceChange24h >= 0 ? "+" : ""}
              {price.priceChange24h.toFixed(2)}%
            </span>
          )}
        </div>
      </div>
      <div className="card">
        <div className="stat-label">Total Supply</div>
        <div className="stat-value">{fmtNumber(data.supply.uiAmount)}</div>
        <div className="stat-sub">{data.supply.decimals} decimals</div>
      </div>
      <div className="card">
        <div className="stat-label">Top 10 Hold</div>
        <div className="stat-value">{fmtPct(data.concentration.top10)}</div>
        <div className="stat-sub">Top 1: {fmtPct(data.concentration.top1)}</div>
      </div>
      {/* Token-level facts, not holder tiers — they belong up here. */}
      <div className="card">
        <div className="stat-label">Burned</div>
        <div className="stat-value">{fmtPct(data.burned.pct)}</div>
        <div className="stat-sub">
          {price ? fmtUsd(data.burned.amount * price.usdPrice) : "—"} ·{" "}
          {fmtNumber(data.burned.amount)}
        </div>
      </div>
      <div className="card">
        <div className="stat-label">Liquidity</div>
        <div className="stat-value">{fmtPct(data.liquidity.pct)}</div>
        <div className="stat-sub">
          {data.liquidity.count} pools · {data.liquidity.venues.join(", ") || "—"}
        </div>
      </div>
    </div>
  );
}

// Signed % change since the last refresh, styled like the market cap widget.
// Falls back to the absolute move when the previous value was zero (no ratio).
function ChangeTag({ current, prev }: { current: number; prev: number | null }) {
  // No baseline yet (first load) — show the neutral state rather than nothing,
  // so the tag is always present on the widget.
  if (prev == null) return <span className="chg flat">NO CHANGE</span>;
  const diff = current - prev;
  if (diff === 0) return <span className="chg flat">NO CHANGE</span>;
  const pct = prev > 0 ? (diff / prev) * 100 : null;
  const sign = diff > 0 ? "+" : "-";
  return (
    <span
      className={`chg ${diff > 0 ? "up" : "down"}`}
      title={`${sign}${Math.abs(diff)} vs the baseline snapshot`}
    >
      {pct != null
        ? `${sign}${Math.abs(pct).toFixed(2)}%`
        : `${sign}${Math.abs(diff)}`}
    </span>
  );
}

// A tier's holdings expressed in dollars, derived from live market cap.
// e.g. the 1–5% tier on a $1.77M cap reads "$17.70K – $88.52K".
function usdRangeLabel(
  min: number,
  max: number | null,
  marketCap: number | null
): string {
  if (marketCap == null) return "—";
  const lo = (min / 100) * marketCap;
  if (max == null) return `${fmtUsd(lo)}+`;
  const hi = (max / 100) * marketCap;
  if (min === 0) return `< ${fmtUsd(hi)}`;
  return `${fmtUsd(lo)} – ${fmtUsd(hi)}`;
}

function BucketSection({
  buckets,
  bucketsExPools,
  burned,
  liquidity,
  totalHolders,
  price,
  prevBuckets,
  baselineAge,
  supplyUi,
}: {
  buckets: BucketStat[];
  bucketsExPools: BucketStat[];
  burned: { amount: number; pct: number };
  liquidity: { amount: number; pct: number; count: number; venues: string[] };
  totalHolders: number;
  price: PriceInfo | null;
  prevBuckets: Record<string, number> | null;
  baselineAge: number | null;
  supplyUi: number;
}) {
  const [excludePools, setExcludePools] = useState(false);
  const shown = excludePools ? bucketsExPools : buckets;
  const maxCount = Math.max(1, ...shown.map((b) => b.count));
  const marketCap = price ? price.usdPrice * supplyUi : null;
  const burnedUsd = price ? burned.amount * price.usdPrice : null;
  const liqUsd = price ? liquidity.amount * price.usdPrice : null;
  return (
    <div className="section">
      <div className="section-head">
        <h2>Holders by Share of Supply</h2>
        <div className="head-tools">
          <span className="hint">
            {totalHolders.toLocaleString()} holders
            {baselineAge != null
              ? ` · change vs ${fmtDuration(baselineAge)} ago`
              : ""}
          </span>
          <button
            className={`toggle-btn${excludePools ? " on" : ""}`}
            onClick={() => setExcludePools((v) => !v)}
            title="Liquidity pools are not real holders — hide them to see the true distribution"
          >
            {excludePools ? "☑ Pools hidden" : "☐ Exclude pools"}
          </button>
        </div>
      </div>
      <div className="bucket-grid">
        {shown.map((b) => {
          const usd = price ? b.supplyUi * price.usdPrice : null;
          return (
            <div
              className="bucket"
              key={b.key}
              title={`${usd != null ? fmtUsd(usd) : "—"} held · ${fmtNumber(
                b.supplyUi
              )} tokens · ${fmtPct(b.holdersPct)} of holders`}
            >
              <div className="top">
                <div className="name">
                  <span className="tier-dot" style={{ background: b.color }} />
                  {b.rangeLabel}
                </div>
                <span className="range">{fmtPct(b.supplyPct)}</span>
              </div>
              <div className="count">
                {b.count.toLocaleString()}
                <ChangeTag
                  current={b.count}
                  prev={prevBuckets ? prevBuckets[b.key] ?? 0 : null}
                />
                <small>{usdRangeLabel(b.min, b.max, marketCap)}</small>
              </div>
              <div className="bar">
                <span
                  style={{
                    width: `${(b.count / maxCount) * 100}%`,
                    background: b.color,
                  }}
                />
              </div>
            </div>
          );
        })}

      </div>
    </div>
  );
}

function CohortSection({
  cohortStats,
  prevCounts,
  onRefresh,
  refreshing,
}: {
  cohortStats: {
    counts: Record<string, number>;
    loaded: number;
    pending: number;
    unknown: number;
    total: number;
  };
  prevCounts: Record<string, number> | null;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const { counts, loaded, pending, unknown, total } = cohortStats;
  const busy = refreshing || pending > 0;
  return (
    <div className="section">
      <div className="section-head">
        <h2>Hold-time cohorts · top 100 wallets</h2>
        <div className="head-tools">
          <span className="hint">
            {pending > 0
              ? `resolving ${(loaded + unknown).toLocaleString()} / ${total} top wallets…`
              : `${loaded.toLocaleString()} of top ${total} wallets${
                  unknown > 0 ? ` · ${unknown} unknown` : ""
                }`}
          </span>
          <button className="mini-refresh" onClick={onRefresh} disabled={busy}>
            {busy ? "↻ …" : "↻ Refresh"}
          </button>
        </div>
      </div>
      <div className="cohorts">
        {AGE_COHORTS.map((c) => {
          const n = counts[c.key] || 0;
          const pct = loaded ? (n / loaded) * 100 : 0;
          const prev = prevCounts ? prevCounts[c.key] ?? 0 : null;
          return (
            <div className="cohort" key={c.key}>
              <div className="clabel">
                <span
                  className="dot"
                  style={{ background: c.color, display: "inline-block", marginRight: 6 }}
                />
                {c.label}
              </div>
              <div className="cval">
                {n.toLocaleString()}
                <ChangeTag current={n} prev={prev} />
              </div>
              <div className="bar">
                <span style={{ width: `${pct}%`, background: c.color }} />
              </div>
              <div className="legend">
                <span>{fmtPct(pct)} of top 100</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Leaderboard movement vs ~24h ago. Positive delta = climbed the ranks.
function RankMove({ holder }: { holder: Holder }) {
  if (holder.isNew) return <span className="rank-move new">NEW</span>;
  const d = holder.rankDelta;
  if (d == null) return null;
  if (d === 0) return <span className="rank-move flat">—</span>;
  const up = d > 0;
  return (
    <span
      className={`rank-move ${up ? "up" : "down"}`}
      title={`was #${holder.prevRank}${
        holder.balancePct != null
          ? ` · balance ${holder.balancePct >= 0 ? "+" : ""}${holder.balancePct.toFixed(1)}%`
          : ""
      }`}
    >
      {up ? "▲" : "▼"}
      {Math.abs(d)}
    </span>
  );
}

function PoolsSection({
  pools,
  price,
}: {
  pools: Holder[];
  price: PriceInfo | null;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [detail, setDetail] = useState<Record<string, PoolDetail | "loading">>({});

  // Load every pool's composition up front so the collapsed row can show the
  // pool's real total, not just the FEBU leg. Responses are cached server-side.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const p of pools) {
        try {
          const res = await fetch(`/api/pool?owner=${p.owner}`);
          const json = await res.json();
          if (cancelled || !res.ok) continue;
          setDetail((d) => ({ ...d, [p.owner]: json as PoolDetail }));
        } catch {
          /* leave it unresolved; the row falls back to the FEBU leg */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pools]);

  const toggle = useCallback((owner: string) => {
    setOpen((cur) => (cur === owner ? null : owner));
  }, []);

  if (!pools.length) return null;

  // Most pools carry negligible liquidity; lead with the ones that matter.
  const TOP = 3;
  const shown = showAll ? pools : pools.slice(0, TOP);
  const hidden = pools.length - shown.length;

  return (
    <div className="section">
      <div className="section-head">
        <h2>Liquidity Pools</h2>
        <span className="hint">
          {pools.length} pool{pools.length === 1 ? "" : "s"} · click to expand
        </span>
      </div>
      <div className="pools-list">
        {shown.map((p) => {
          const d = detail[p.owner];
          const info = d && d !== "loading" ? d : null;
          // The paired side — usually SOL, but not always.
          const pair = info?.entries.find((e) => e.symbol !== "FEBU");
          const febuLeg = info?.entries.find((e) => e.symbol === "FEBU");
          return (
          <div className="pool-card" key={p.owner}>
            <button className="pool-card-head" onClick={() => toggle(p.owner)}>
              <span className="pool-venue">{p.pool}</span>
              <a
                className="addr pool-addr"
                href={`https://solscan.io/account/${p.owner}`}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                {shortAddr(p.owner, 4, 4)}
              </a>
              <span className="pool-rank">rank #{p.rank}</span>
              <span className="pool-pct">{fmtPct(p.percentage)} of supply</span>
              <span className="pool-total">
                <span className="pool-total-usd">
                  {info
                    ? fmtUsd(info.tvl)
                    : price
                      ? fmtUsd(p.amount * price.usdPrice)
                      : "—"}
                </span>
                <span className="pool-total-legs">
                  {fmtNumber(febuLeg ? febuLeg.amount : p.amount)} FEBU
                  {pair ? ` · ${fmtNumber(pair.amount)} ${pair.symbol}` : ""}
                </span>
              </span>
              <span className="pool-caret">{open === p.owner ? "▴" : "▾"}</span>
            </button>
            {open === p.owner && (
              <div className="pool-card-body">
                <PoolBreakdown detail={detail[p.owner]} venue={p.pool || ""} />
              </div>
            )}
          </div>
          );
        })}
      </div>
      {hidden > 0 && !showAll && (
        <button className="load-btn" style={{ marginTop: 10 }} onClick={() => setShowAll(true)}>
          Show {hidden} smaller pool{hidden === 1 ? "" : "s"}
        </button>
      )}
      {showAll && pools.length > TOP && (
        <button className="load-btn" style={{ marginTop: 10 }} onClick={() => setShowAll(false)}>
          Show less
        </button>
      )}
    </div>
  );
}

function PoolBreakdown({
  detail,
  venue,
}: {
  detail: PoolDetail | "loading" | undefined;
  venue: string;
}) {
  if (!detail || detail === "loading") {
    return <div className="pool-detail loading">Reading {venue} pool…</div>;
  }
  if (!detail.entries.length) {
    return <div className="pool-detail loading">Couldn&apos;t read this pool.</div>;
  }

  return (
    <div className="pool-detail">
      <div className="pool-detail-head">
        <span>{venue} pool composition</span>
        <span className="pool-tvl">{fmtUsd(detail.tvl)} TVL</span>
      </div>
      <div className="pool-legs">
        {detail.entries.map((e) => {
          const share = detail.tvl > 0 ? ((e.usd ?? 0) / detail.tvl) * 100 : 0;
          return (
            <div className="pool-leg" key={e.mint}>
              <div className="pool-leg-top">
                <span className="pool-sym">{e.symbol}</span>
                <span className="pool-usd">
                  {e.usd != null ? fmtUsd(e.usd) : "—"}
                </span>
              </div>
              <div className="bar">
                <span style={{ width: `${share}%`, background: "#38bdf8" }} />
              </div>
              <div className="pool-leg-sub">
                {fmtNumber(e.amount)} {e.symbol} · {fmtPct(share)} of pool
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HoldersTable({
  data,
  ages,
  onLoadMore,
  loadingMore,
  onRefresh,
  refreshing,
}: {
  data: HoldersPayload;
  ages: Record<string, AgeState>;
  onLoadMore: () => void;
  loadingMore: boolean;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const bucketMap = useMemo(() => {
    const m: Record<string, BucketStat> = {};
    for (const b of data.buckets) m[b.key] = b;
    return m;
  }, [data.buckets]);

  const loadedCount = Object.keys(ages).length;
  const hasMore = loadedCount < data.holders.length;

  // Pool composition, fetched on demand when an LP badge is clicked.
  const [openPool, setOpenPool] = useState<string | null>(null);
  const [poolData, setPoolData] = useState<Record<string, PoolDetail | "loading">>(
    {}
  );

  const togglePool = useCallback(
    async (owner: string) => {
      if (openPool === owner) {
        setOpenPool(null);
        return;
      }
      setOpenPool(owner);
      if (poolData[owner]) return;

      setPoolData((p) => ({ ...p, [owner]: "loading" }));
      try {
        const res = await fetch(`/api/pool?owner=${owner}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "failed");
        setPoolData((p) => ({ ...p, [owner]: json as PoolDetail }));
      } catch {
        setPoolData((p) => ({
          ...p,
          [owner]: { owner, entries: [], tvl: 0, at: Date.now() },
        }));
      }
    },
    [openPool, poolData]
  );

  return (
    <div className="section">
      <div className="section-head">
        <h2>Top {data.holders.length} holders</h2>
        <div className="head-tools">
          <span className="hint">
            of {data.totalHolders.toLocaleString()} total ·{" "}
            {loadedCount.toLocaleString()} hold times loaded
            {data.rankWindowSeconds != null
              ? ` · movement vs ${fmtDuration(data.rankWindowSeconds)} ago`
              : ""}
            {data.flowsAgeSeconds != null
              ? ` · buy/sell top 50, updated ${fmtDuration(data.flowsAgeSeconds)} ago`
              : ""}
          </span>
          <button className="mini-refresh" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? "↻ …" : "↻ Refresh"}
          </button>
        </div>
      </div>
      <div className="table-wrap">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Wallet</th>
                <th style={{ textAlign: "right" }}>Bought</th>
                <th style={{ textAlign: "right" }}>Sold</th>
                <th style={{ textAlign: "right" }}>Amount</th>
                <th style={{ textAlign: "right" }}>Share</th>
                <th>Tier</th>
                <th>Hold time</th>
                <th>First acquired</th>
              </tr>
            </thead>
            <tbody>
              {data.holders.map((h) => {
                const b = bucketMap[h.bucketKey];
                const age = ages[h.tokenAccount];
                return (
                  <Fragment key={h.owner}>
                  <tr>
                    <td className="rank">
                      {h.rank}
                      <RankMove holder={h} />
                    </td>
                    <td>
                      <a
                        className="addr"
                        href={`https://solscan.io/account/${h.owner}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {shortAddr(h.owner, 5, 5)}
                      </a>
                      {h.accounts > 1 && (
                        <span
                          style={{
                            color: "var(--text-faint)",
                            fontSize: 11,
                            marginLeft: 6,
                          }}
                        >
                          ×{h.accounts}
                        </span>
                      )}
                      {h.pool && (
                        <button
                          className={`lp-badge${openPool === h.owner ? " open" : ""}`}
                          onClick={() => togglePool(h.owner)}
                          title="Show pool composition"
                        >
                          LP · {h.pool} {openPool === h.owner ? "▴" : "▾"}
                        </button>
                      )}
                    </td>
                    <td
                      className={`num flow-buy${h.flowReconciled === false && h.bought != null ? " partial" : ""}`}
                      title={
                        h.bought != null && h.flowReconciled === false
                          ? "Partial history — wallet has more transactions than we walk"
                          : undefined
                      }
                    >
                      {h.bought != null
                        ? `${h.flowReconciled === false ? "~" : ""}${fmtNumber(h.bought)}`
                        : "—"}
                    </td>
                    <td
                      className={`num flow-sell${h.flowReconciled === false && h.sold != null ? " partial" : ""}`}
                    >
                      {h.sold != null
                        ? `${h.flowReconciled === false ? "~" : ""}${fmtNumber(h.sold)}`
                        : "—"}
                    </td>
                    <td className="num">{fmtNumber(h.amount)}</td>
                    <td className="num">{fmtPct(h.percentage)}</td>
                    <td>
                      {b && (
                        <span className="tag">
                          <span className="dot" style={{ background: b.color }} />
                          {b.rangeLabel}
                        </span>
                      )}
                    </td>
                    <td>
                      {!age ? (
                        <span className="age loading">—</span>
                      ) : age.status === "loading" ? (
                        <span className="age loading">…</span>
                      ) : age.ageSeconds == null ? (
                        <span className="age loading">n/a</span>
                      ) : (
                        <span className="age">{fmtDuration(age.ageSeconds)}</span>
                      )}
                    </td>
                    <td>
                      {age && age.status === "done" && age.firstBlockTime ? (
                        <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
                          {fmtDate(age.firstBlockTime)}
                        </span>
                      ) : (
                        <span style={{ color: "var(--text-faint)" }}>—</span>
                      )}
                    </td>
                  </tr>
                  {h.pool && openPool === h.owner && (
                    <tr className="pool-row">
                      <td colSpan={9}>
                        <PoolBreakdown
                          detail={poolData[h.owner]}
                          venue={h.pool}
                        />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {hasMore && (
        <div style={{ marginTop: 12 }}>
          <button className="load-btn" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? "Loading hold times…" : "Load hold times for more rows"}
          </button>
        </div>
      )}
    </div>
  );
}
