import { getEarliestBlockTime } from "./helius";
import { loadJSON, saveJSON } from "./persist";

// Earliest-blocktime per token account. A first acquisition never moves, so
// successful lookups are cached for the life of the process. Failures are not
// cached, so transient RPC errors can be retried later.
const cache = new Map<string, number>(
  Object.entries(loadJSON<Record<string, number>>("holdtime", {}))
);

function persist() {
  saveJSON("holdtime", () => Object.fromEntries(cache));
}
// Dedupe concurrent lookups of the same account across simultaneous visitors.
const inflight = new Map<string, Promise<number | null>>();

export async function resolveEarliest(account: string): Promise<number | null> {
  const cached = cache.get(account);
  if (cached !== undefined) return cached;

  const running = inflight.get(account);
  if (running) return running;

  const task = getEarliestBlockTime(account)
    .then((t) => {
      if (t != null) {
        cache.set(account, t);
        persist();
      }
      return t;
    })
    // Isolate failures: one bad account must not fail a whole batch.
    .catch(() => null)
    .finally(() => inflight.delete(account));

  inflight.set(account, task);
  return task;
}

// Run promises with bounded concurrency.
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const workers = new Array(Math.min(limit, items.length))
    .fill(0)
    .map(async () => {
      while (idx < items.length) {
        const cur = idx++;
        results[cur] = await fn(items[cur]);
      }
    });
  await Promise.all(workers);
  return results;
}
