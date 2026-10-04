import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/products/search": [
      "./data/watson/data/products.db",
      "./data/watson/data/products.demo-multiplatform.db",
    ],
  },
};

export default nextConfig;
