import type { Metadata, Viewport } from "next";
import { assertLiveConfiguration, config } from "@/lib/config";
import { AnalyticsPageTracker } from "@/components/AnalyticsPageTracker";
import { MetaTracking } from "@/components/MetaTracking";
import "./globals.css";
import "./post-checkout.css";
import "./meta-tracking.css";
import "./checkout-ticket-types.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#050505",
  viewportFit: "cover",
};

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
  title: { default: "SKIE EVENTS", template: "%s - SKIE EVENTS" },
  description: "Skie Events - Melbourne event applications, tickets, extras and event-night access.",
  robots: { index: true, follow: true },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    shortcut: "/favicon.svg",
    apple: [{ url: "/apple-touch-icon.svg", type: "image/svg+xml" }],
  },
  manifest: "/site.webmanifest",
  openGraph: {
    title: "SKIE EVENTS",
    description: "The night starts before the door.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  assertLiveConfiguration();
  return (
    <html lang="en">
      <body>
        <AnalyticsPageTracker />
        <MetaTracking pixelId={config.metaPixelId} consentVersion={config.metaAdsConsentVersion} />
        {children}
      </body>
    </html>
  );
}
