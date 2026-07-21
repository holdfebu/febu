import fs from "fs";
import path from "path";

/**
 * Tiny disk-backed store so in-memory state survives redeploys.
 *
 * Railway sets RAILWAY_VOLUME_MOUNT_PATH when a volume is attached; without
 * one this falls back to a local directory, which works in development but is
 * wiped on each deploy in production.
 */

const DIR =
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  process.env.DATA_DIR ||
  path.join(process.cwd(), ".data");

let ready = false;

function ensureDir(): boolean {
  if (ready) return true;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    ready = true;
    return true;
  } catch {
    return false;
  }
}

export function isPersistent(): boolean {
  return Boolean(
    process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR
  );
}

export function loadJSON<T>(name: string, fallback: T): T {
  try {
    const file = path.join(DIR, `${name}.json`);
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    // A corrupt or partial file must never stop the server booting.
    return fallback;
  }
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Debounced atomic write: state changes often, disk shouldn't. Writes to a
 * temp file then renames, so a crash mid-write can't leave a truncated file.
 */
export function saveJSON(name: string, getData: () => unknown, delayMs = 20_000) {
  if (timers.has(name)) return;
  const t = setTimeout(() => {
    timers.delete(name);
    if (!ensureDir()) return;
    try {
      const file = path.join(DIR, `${name}.json`);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(getData()));
      fs.renameSync(tmp, file);
    } catch {
      // Persistence is best-effort; never break a request over it.
    }
  }, delayMs);
  // Don't hold the process open for a pending write.
  if (typeof t.unref === "function") t.unref();
  timers.set(name, t);
}
