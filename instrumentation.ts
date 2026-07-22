// Runs once when the Next.js server boots — the hook that starts the Runner
// watcher (DexScreener WebSocket + fallback poll) inside this process.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startRunner } = await import("./lib/runner");
    startRunner();
  }
}
