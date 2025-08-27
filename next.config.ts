import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  devIndicators: {
    position: "bottom-right",
  },
  experimental: {
    ppr: true,
  },
  serverExternalPackages: ['shiki', 'vscode-oniguruma'],
  images: {
    remotePatterns: [
      {
        hostname: 'avatar.vercel.sh',
      },
    ],
  },
};

export default nextConfig;
