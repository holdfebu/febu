"use client";

import { useEffect, useRef, useState } from "react";
import { shortAddr } from "@/lib/format";

interface FeeClaim {
  signature: string;
  timestamp: number;
  sol: number;
  venue: "pump" | "pumpswap";
}

interface OutflowCat {
  sol: number;
  count: number;
}

interface Outflows {
  fireblocks: OutflowCat;
  pump: OutflowCat;
  humans: OutflowCat;
}

interface IncomePayload {
  wallet: string;
  balanceSol: number;
  claims: FeeClaim[];
  totalSol: number;
  count: number;
  last: FeeClaim | null;
  sol24h: number;
  count24h: number;
  outflows: Outflows;
  solPrice: number | null;
  at: number;
}

const POLL_MS = 10 * 60 * 1000; // every 10 minutes
const NUM_DOTS = 5;

// The three spend buckets, top to bottom.
const OUT_NODES: Array<{
  key: keyof Outflows;
  icon: string;
  label: string;
  sub: (o: OutflowCat) => string;
}> = [
  {
    key: "fireblocks",
    icon: "🏦",
    label: "Fireblocks",
    sub: (o) => `Treasury · ${o.count} tx`,
  },
  { key: "pump", icon: "💊", label: "pump.fun", sub: () => "2 tokens" },
  {
    key: "humans",
    icon: "🧑‍💻",
    label: "Rent Humans",
    sub: (o) => `${o.count} task payouts`,
  },
];

function fmtSol(sol: number): string {
  if (sol >= 100) return sol.toFixed(0);
  if (sol >= 1) return sol.toFixed(2);
  return sol.toFixed(3);
}

function relTime(tsSeconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - tsSeconds);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function IncomeFlow() {
  const [data, setData] = useState<IncomePayload | null>(null);
  const [burst, setBurst] = useState<{ claim: FeeClaim; key: number } | null>(null);
  const lastSeenSig = useRef<string | null>(null);
  const burstKey = useRef(0);

  // Measure the curve area so the SVG connectors can be drawn in real pixels —
  // that keeps the strokes and flowing dots undistorted at any width.
  const curvesRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useEffect(() => {
    const el = curvesRef.current;
    if (!el) return;
    const update = () => setDims({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let burstTimer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const res = await fetch("/api/income");
        if (!res.ok) return;
        const json = (await res.json()) as IncomePayload;
        if (cancelled) return;
        setData(json);

        const top = json.last;
        if (top) {
          if (lastSeenSig.current === null) {
            lastSeenSig.current = top.signature;
          } else if (top.signature !== lastSeenSig.current) {
            lastSeenSig.current = top.signature;
            setBurst({ claim: top, key: ++burstKey.current });
            clearTimeout(burstTimer);
            burstTimer = setTimeout(() => !cancelled && setBurst(null), 3200);
          }
        }
      } catch {
        /* keep the last good state */
      }
    };

    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
      clearTimeout(burstTimer);
    };
  }, []);

  const usd = data?.solPrice != null ? data.balanceSol * data.solPrice : null;
  const last = data?.last ?? null;

  // One smooth cubic bezier from the wallet edge out to each node's centre.
  const OUT_GAP = 10; // must match the .mf-out-nodes gap
  const START_X = -14; // reach back into the gap toward the wallet
  const curvePaths: string[] = (() => {
    const { w, h } = dims;
    if (w <= 0 || h <= 0) return [];
    const nodeH = (h - OUT_GAP * 2) / 3;
    return [0, 1, 2].map((i) => {
      const cy = i * (nodeH + OUT_GAP) + nodeH / 2;
      const c1x = START_X + (w - START_X) * 0.55;
      const c2x = START_X + (w - START_X) * 0.45;
      return `M ${START_X} ${h / 2} C ${c1x} ${h / 2}, ${c2x} ${cy}, ${w} ${cy}`;
    });
  })();

  return (
    <section className={`income${burst ? " claiming" : ""}`}>
      <div className="income-head">
        <div>
          <span className="income-title">Febu&apos;s Income &amp; Expense</span>
        </div>
        <div className="income-total">
          <span className="it-label">SOL</span>
          <span className="it-num">◎ {data ? fmtSol(data.balanceSol) : "—"}</span>
          {usd != null && (
            <span className="it-usd">
              ≈ ${usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
          )}
        </div>
      </div>

      <div className="moneyflow">
        {/* Income: pump fees flow into the wallet. */}
        <div className="mf-in">
          <div className="node source">
            <span className="node-icon" aria-hidden="true">✦</span>
            <span className="node-label">Pump fees</span>
            <span className="node-sub">pump.fun · pumpswap</span>
          </div>
          <div className="pipe in">
            <span className="pipe-line" aria-hidden="true" />
            {Array.from({ length: NUM_DOTS }).map((_, i) => (
              <span
                key={i}
                className="fee-dot"
                style={{ animationDelay: `${(i * 3) / NUM_DOTS}s` }}
                aria-hidden="true"
              />
            ))}
            {burst && (
              <span key={burst.key} className="fee-packet" aria-hidden="true">
                +{fmtSol(burst.claim.sol)} ◎
              </span>
            )}
          </div>
        </div>

        {/* The wallet sits at the centre of the flow. */}
        <div className="node wallet hub">
          <span className="node-icon wallet-icon" aria-hidden="true">◎</span>
          <span className="node-label">febu</span>
          {data && (
            <a
              className="node-sub"
              href={`https://solscan.io/account/${data.wallet}`}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddr(data.wallet, 4, 4)} ↗
            </a>
          )}
        </div>

        {/* Spend: SOL flows out along curved connectors to three categories. */}
        <div className="mf-out">
          <div className="mf-curves" ref={curvesRef} aria-hidden="true">
            <svg
              width="100%"
              height="100%"
              viewBox={`0 0 ${dims.w || 1} ${dims.h || 1}`}
              preserveAspectRatio="none"
            >
              {curvePaths.map((d, i) => (
                <path key={`base-${i}`} className="curve-base" d={d} />
              ))}
              {curvePaths.map((d, i) => (
                <path
                  key={`flow-${i}`}
                  className="curve-flow"
                  d={d}
                  style={{ animationDelay: `${i * 0.55}s` }}
                />
              ))}
            </svg>
          </div>
          <div className="mf-out-nodes">
            {OUT_NODES.map((n) => {
              const o = data?.outflows[n.key];
              return (
                <div className="node out" key={n.key}>
                  <span className="out-top">
                    <span className="out-icon" aria-hidden="true">{n.icon}</span>
                    <span className="node-label">{n.label}</span>
                  </span>
                  <span className="out-amt">◎ {o ? fmtSol(o.sol) : "—"}</span>
                  <span className="node-sub">{o ? n.sub(o) : ""}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="income-foot">
        {last ? (
          <>
            <span className={burst ? "flash" : ""}>
              last fee claim <strong>◎ {fmtSol(last.sol)}</strong>{" "}
              <span className={`venue ${last.venue}`}>
                {last.venue === "pumpswap" ? "PumpSwap" : "pump.fun"}
              </span>{" "}
              · {relTime(last.timestamp)}
            </span>
            <span className="income-foot-r">
              {data?.count ?? 0} claim{data?.count === 1 ? "" : "s"} total
            </span>
          </>
        ) : (
          <span>watching wallet activity…</span>
        )}
      </div>
    </section>
  );
}
