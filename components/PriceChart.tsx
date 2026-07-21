"use client";

import { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const RANGES = ["1H", "6H", "24H", "7D", "30D", "ALL"] as const;
type Range = (typeof RANGES)[number];

// How often to re-pull candles, matched to how fast each range's bars move.
const REFRESH_MS: Record<Range, number> = {
  "1H": 15_000,
  "6H": 20_000,
  "24H": 30_000,
  "7D": 60_000,
  "30D": 120_000,
  ALL: 300_000,
};

export default function PriceChart({ price }: { price?: number | null }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const lastCandleRef = useRef<Candle | null>(null);
  const firstOpenRef = useRef<number | null>(null);

  const [range, setRange] = useState<Range>("24H");
  const [meta, setMeta] = useState<{ dex: string; quote: string } | null>(null);
  const [stats, setStats] = useState<{ last: number; changePct: number } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Create the chart once.
  useEffect(() => {
    if (!boxRef.current) return;

    const chart = createChart(boxRef.current, {
      layout: {
        background: { color: "transparent" },
        textColor: "#a2a2ad",
        fontFamily:
          "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      rightPriceScale: {
        borderColor: "#2a2a30",
        scaleMargins: { top: 0.12, bottom: 0.28 },
      },
      timeScale: { borderColor: "#2a2a30", timeVisible: true, secondsVisible: false },
      crosshair: {
        vertLine: { color: "#6e6e7a", width: 1, style: 3, labelBackgroundColor: "#26262c" },
        horzLine: { color: "#6e6e7a", width: 1, style: 3, labelBackgroundColor: "#26262c" },
      },
      handleScale: { axisPressedMouseMove: false },
      autoSize: true,
    });

    priceRef.current = chart.addSeries(CandlestickSeries, {
      upColor: "#4ade80",
      downColor: "#fb7185",
      wickUpColor: "#4ade80",
      wickDownColor: "#fb7185",
      borderVisible: false,
      priceFormat: { type: "price", precision: 8, minMove: 0.00000001 },
    });

    volRef.current = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
    });
    chart
      .priceScale("vol")
      .applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  // Load candles on range change, then keep polling so the chart stays live.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const load = async (silent: boolean) => {
      try {
        const res = await fetch(`/api/chart?range=${range}`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(json.error || "Failed to load");

        const candles: Candle[] = json.candles ?? [];
        if (!candles.length) throw new Error("No candles for this range");
        lastCandleRef.current = candles[candles.length - 1];
        firstOpenRef.current = candles[0].open;

        priceRef.current?.setData(
          candles.map((c) => ({
            time: c.time as UTCTimestamp,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          }))
        );
        volRef.current?.setData(
          candles.map((c) => ({
            time: c.time as UTCTimestamp,
            value: c.volume,
            color:
              c.close >= c.open
                ? "rgba(74,222,128,0.28)"
                : "rgba(251,113,133,0.28)",
          }))
        );
        if (!silent) chartRef.current?.timeScale().fitContent();

        const first = candles[0].open;
        const last = candles[candles.length - 1].close;
        setStats({
          last,
          changePct: first > 0 ? ((last - first) / first) * 100 : 0,
        });
        setMeta({ dex: json.dex, quote: json.quote });
      } catch (e) {
        // A failed background refresh shouldn't blank a working chart.
        if (!cancelled && !silent) {
          setError(e instanceof Error ? e.message : "Failed");
        }
      } finally {
        if (!cancelled && !silent) setLoading(false);
      }
    };

    load(false);
    const id = setInterval(() => load(true), REFRESH_MS[range]);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [range]);

  // Between polls, ride the live price so the chart tracks the header exactly.
  useEffect(() => {
    if (price == null || !priceRef.current) return;
    const c = lastCandleRef.current;
    if (!c) return;

    const updated: Candle = {
      ...c,
      close: price,
      high: Math.max(c.high, price),
      low: Math.min(c.low, price),
    };
    lastCandleRef.current = updated;
    priceRef.current.update({
      time: updated.time as UTCTimestamp,
      open: updated.open,
      high: updated.high,
      low: updated.low,
      close: updated.close,
    });

    const first = firstOpenRef.current;
    setStats({
      last: price,
      changePct: first && first > 0 ? ((price - first) / first) * 100 : 0,
    });
  }, [price]);

  const up = (stats?.changePct ?? 0) >= 0;

  return (
    <div className="section">
      <div className="section-head">
        <h2>Price</h2>
        <div className="head-tools">
          {stats && (
            <span className="chart-stats">
              <span className="chart-last">
                ${stats.last.toFixed(stats.last < 0.01 ? 6 : 4)}
              </span>
              <span className={`chg ${up ? "up" : "down"}`}>
                {up ? "+" : ""}
                {stats.changePct.toFixed(2)}%
              </span>
            </span>
          )}
          <div className="range-tabs">
            {RANGES.map((r) => (
              <button
                key={r}
                className={`range-tab${range === r ? " on" : ""}`}
                onClick={() => setRange(r)}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="chart-wrap">
        <div ref={boxRef} className="chart-box" />
        {loading && <div className="chart-overlay">loading…</div>}
        {error && <div className="chart-overlay err">{error}</div>}
        {meta && !loading && !error && (
          <div className="chart-source">
            {meta.dex} · FEBU/{meta.quote}
          </div>
        )}
      </div>
    </div>
  );
}
