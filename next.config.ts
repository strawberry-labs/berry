import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  devIndicators: {
    buildActivity: false, // This specifically hides the build activity indicator
    buildActivityPosition: 'bottom-right', // You can also change its position if you want to keep it
  },
  experimental: {
    ppr: true,
  },
  images: {
    remotePatterns: [
      {
        hostname: 'avatar.vercel.sh',
      },
    ],
  },
};

export default nextConfig;
