import type { NextConfig } from "next";

// Content Security Policy:
// In standalone production, frame-ancestors 'none' prevents clickjacking.
// For AI Studio cloud previews and container hosting, allow Google and Run domains:
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'self' https://*.google.com https://*.run.app https://ai.studio https://*.aistudio.google.com",
  "object-src 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com https://connect.facebook.net https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.stripe.com https://graph.facebook.com https://www.facebook.com https://*.mux.com https://*.muxed.dev https://www.google.com/recaptcha/",
  "frame-src https://js.stripe.com https://hooks.stripe.com https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/",
  "worker-src 'self' blob:",
  "upgrade-insecure-requests",
].join("; ");

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: { cpus: 2 },
  poweredByHeader: false,
  outputFileTracingIncludes: {
    "/*": ["./data/*.json"],
  },
  images: {
    dangerouslyAllowSVG: false,
    contentDispositionType: "attachment",
    remotePatterns: [
      { protocol: "https", hostname: "**" }
    ]
  },
  async headers() {
    const securityHeaders = [
      { key: "Content-Security-Policy", value: contentSecurityPolicy },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
      ...(process.env.NODE_ENV === "production"
        ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
        : []),
    ];
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      }
    ];
  }
};

export default nextConfig;
