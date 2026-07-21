"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { HoldersPayload, Holder, BucketStat } from "@/lib/holders";
import { TOKEN_MINT, AGE_COHORTS, cohortForDays } from "@/lib/config";
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

const PRICE_POLL_MS = 10_000;

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
            <div className="bucket" key={b.key}>
              <div className="top">
                <div className="name">
                  <span className="tier-dot" style={{ background: b.color }} />
                  {usdRangeLabel(b.min, b.max, marketCap)}
                </div>
                <span className="range">{b.rangeLabel}</span>
              </div>
              <div className="count">
                {b.count.toLocaleString()}
                <ChangeTag
                  current={b.count}
                  prev={prevBuckets ? prevBuckets[b.key] ?? 0 : null}
                />
                <small>{fmtPct(b.holdersPct)} of holders</small>
              </div>
              <div className="bucket-usd">
                {usd != null ? fmtUsd(usd) : "—"}
                <span className="bucket-usd-sub">held ({fmtPct(b.supplyPct)} of supply)</span>
              </div>
              <div className="bar">
                <span
                  style={{
                    width: `${(b.count / maxCount) * 100}%`,
                    background: b.color,
                  }}
                />
              </div>
              <div className="legend">
                <span>{fmtNumber(b.supplyUi)} tokens</span>
                <span>
                  {price ? `${fmtPrice(price.usdPrice)}/tkn` : ""}
                </span>
              </div>
            </div>
          );
        })}

        {/* Burned — supply permanently removed */}
        <div className="bucket special">
          <div className="top">
            <div className="name">
              <span className="tier-dot" style={{ background: "#fb7185" }} />
              Burned
            </div>
            <span className="range">supply</span>
          </div>
          <div className="count">
            {fmtPct(burned.pct)}
            <small>of launch supply</small>
          </div>
          <div className="bucket-usd">
            {burnedUsd != null ? fmtUsd(burnedUsd) : "—"}
            <span className="bucket-usd-sub">destroyed at current price</span>
          </div>
          <div className="bar">
            <span
              style={{
                width: `${Math.min(100, burned.pct)}%`,
                background: "#fb7185",
              }}
            />
          </div>
          <div className="legend">
            <span>{fmtNumber(burned.amount)} tokens</span>
            <span>1B at launch</span>
          </div>
        </div>

        {/* Liquidity — supply sitting in AMM pools */}
        <div className="bucket special">
          <div className="top">
            <div className="name">
              <span className="tier-dot" style={{ background: "#38bdf8" }} />
              Liquidity
            </div>
            <span className="range">
              {liquidity.count} pool{liquidity.count === 1 ? "" : "s"}
            </span>
          </div>
          <div className="count">
            {fmtPct(liquidity.pct)}
            <small>of supply in pools</small>
          </div>
          <div className="bucket-usd">
            {liqUsd != null ? fmtUsd(liqUsd) : "—"}
            <span className="bucket-usd-sub">
              {liquidity.venues.length ? liquidity.venues.join(" · ") : "none found"}
            </span>
          </div>
          <div className="bar">
            <span
              style={{
                width: `${Math.min(100, liquidity.pct)}%`,
                background: "#38bdf8",
              }}
            />
          </div>
          <div className="legend">
            <span>{fmtNumber(liquidity.amount)} tokens</span>
            <span>not real holders</span>
          </div>
        </div>
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

  return (
    <div className="section">
      <div className="section-head">
        <h2>Top {data.holders.length} holders</h2>
        <div className="head-tools">
          <span className="hint">
            of {data.totalHolders.toLocaleString()} total ·{" "}
            {loadedCount.toLocaleString()} hold times loaded
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
                  <tr key={h.owner}>
                    <td className="rank">{h.rank}</td>
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
                      {h.pool && <span className="lp-badge">LP · {h.pool}</span>}
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
