import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/products/search": ["./data/watson/data/products.db"],
    "/api/products/select": ["./data/watson/data/products.db"],
  },
};

export default nextConfig;
