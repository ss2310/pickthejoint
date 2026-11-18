import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // sharp is a native module: load it from node_modules at run time instead of bundling it.
  serverExternalPackages: ["sharp"],
  experimental: {
    // "Snap a poster" posts one photo of up to 8 MB through a server action and the middleware.
    // The admin poster inbox (several photos) posts to a route handler the middleware does not cover.
    serverActions: { bodySizeLimit: "10mb" },
    middlewareClientMaxBodySize: "10mb",
  },
  async headers() {
    return [
      // The admin area and the webhook endpoints are never indexed, whatever a crawler finds.
      { source: "/admin/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }, { key: "Cache-Control", value: "no-store" }] },
      { source: "/admin", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }, { key: "Cache-Control", value: "no-store" }] },
      { source: "/api/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] },
    ];
  },
};

export default nextConfig;
