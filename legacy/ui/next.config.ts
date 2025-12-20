import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  images: {
    remotePatterns: [new URL('https://m.astrophotography.tv/i/**')],
  },
  assetPrefix: '/ph',
  serverExternalPackages: ['sequelize'],
  experimental: {
    serverActions: {
      allowedOrigins: ['astroroot.vercel.app', 'photohosting.vercel.app', 'astrophotography.tv', 'www.astrophotography.tv'],
      bodySizeLimit: '10mb',
    },
  },
  async rewrites() {
    return [
      {
        source: '/uploads/:path*',
        destination: '/api/uploads/:path*',
      },
    ];
  },
};

export default nextConfig;
