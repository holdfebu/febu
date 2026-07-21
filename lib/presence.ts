import { createHash } from "crypto";

// Live visitor tracking. Every open tab polls /api/price every 10s, so that
// doubles as a heartbeat. IPs are hashed — we only ever store a digest.
const WINDOW_MS = 60_000;
const seen = new Map<string, number>();
let requests = 0;
let requestsWindowStart = Date.now();
let lastMinRequests = 0;
const startedAt = Date.now();

export function heartbeat(ip: string): void {
  const id = createHash("sha256").update(ip).digest("hex").slice(0, 16);
  seen.set(id, Date.now());
  requests++;

  if (Date.now() - requestsWindowStart >= WINDOW_MS) {
    lastMinRequests = requests;
    requests = 0;
    requestsWindowStart = Date.now();
  }
}

export function stats() {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [id, at] of seen) if (at < cutoff) seen.delete(id);

  const mem = process.memoryUsage();
  return {
    activeUsers: seen.size,
    requestsPerMin: lastMinRequests || requests,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    memoryMB: Math.round(mem.rss / 1024 / 1024),
  };
}
