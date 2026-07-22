/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [{ source: "/runner", destination: "/runner.html" }];
  },
};

export default nextConfig;
