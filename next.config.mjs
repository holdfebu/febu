/** @type {import('next').NextConfig} */

// Content-Security-Policy for the Runner page. It renders untrusted token
// metadata from the public DexScreener feed, so this is defense-in-depth behind
// the per-field escaping. All data fetches are same-origin (the server proxies
// DexScreener / GeckoTerminal), so connect-src can be locked to 'self' — that
// blocks any injected script from exfiltrating to an external host. Wallet
// extensions inject via window.solana / window.ethereum, which CSP doesn't gate.
const runnerCSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
];

const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [{ source: "/runner", destination: "/runner.html" }];
  },
  async headers() {
    const runnerHeaders = [
      ...securityHeaders,
      { key: "Content-Security-Policy", value: runnerCSP },
    ];
    return [
      // Headers match the REQUEST path, so cover both the /runner alias and the
      // /runner.html file it rewrites to.
      { source: "/runner", headers: runnerHeaders },
      { source: "/runner.html", headers: runnerHeaders },
      { source: "/:path*", headers: securityHeaders },
    ];
  },
};

export default nextConfig;
