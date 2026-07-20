// Display formatting helpers.

export function shortAddr(addr: string, lead = 4, tail = 4): string {
  if (!addr) return "";
  if (addr.length <= lead + tail + 1) return addr;
  return `${addr.slice(0, lead)}…${addr.slice(-tail)}`;
}

export function fmtNumber(n: number, maxFrac = 2): string {
  if (!isFinite(n)) return "—";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B";
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (abs >= 1_000) return (n / 1_000).toFixed(2) + "K";
  return n.toLocaleString("en-US", { maximumFractionDigits: maxFrac });
}

// Large USD amounts: $1.2M, $945K, $12.34.
export function fmtUsd(n: number): string {
  if (!isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return "$" + (n / 1_000_000_000).toFixed(2) + "B";
  if (abs >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
  if (abs >= 1_000) return "$" + (n / 1_000).toFixed(2) + "K";
  if (abs >= 1) return "$" + n.toFixed(2);
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

// A single token's USD price, keeping precision for sub-cent values.
export function fmtPrice(n: number): string {
  if (!isFinite(n) || n <= 0) return "—";
  if (n >= 1) return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  // Show ~4 significant figures for tiny prices.
  const decimals = Math.min(12, Math.max(4, 3 - Math.floor(Math.log10(n))));
  return "$" + n.toFixed(decimals);
}

export function fmtPct(p: number): string {
  if (!isFinite(p)) return "—";
  if (p === 0) return "0%";
  if (p < 0.001) return "<0.001%";
  if (p < 0.01) return p.toFixed(4) + "%";
  if (p < 1) return p.toFixed(3) + "%";
  return p.toFixed(2) + "%";
}

// Turn a duration in seconds into a compact human string.
export function fmtDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d >= 365) {
    const y = Math.floor(d / 365);
    const rem = d % 365;
    return `${y}y ${rem}d`;
  }
  if (d >= 1) return `${d}d ${h}h`;
  if (h >= 1) return `${h}h ${m}m`;
  if (m >= 1) return `${m}m`;
  return `${Math.floor(seconds)}s`;
}

export function fmtDate(unixSeconds: number): string {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
