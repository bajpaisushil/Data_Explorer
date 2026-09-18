import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The whole app is client-side; a static export keeps the "no backend" promise literal.
  output: 'export',
  images: { unoptimized: true },
  turbopack: { root: __dirname },
}

export default nextConfig
