import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { readSiteData } from "@/lib/data/documents";
import { getCurrentUser } from "@/lib/security/session";
import type { CSSProperties } from "react";
import { accessibleAccent } from "@/lib/accessibility";

export const dynamic = "force-dynamic";

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const [site, user] = await Promise.all([readSiteData(), getCurrentUser()]);
  const accent = accessibleAccent(site.brand.accent);
  const style = { "--blue": accent } as CSSProperties;

  return (
    <div className="public-site-root" style={style}>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <SiteHeader user={user} brandName={site.brand.name} />
      <main id="main-content" tabIndex={-1}>{children}</main>
      <SiteFooter
        brand={site.brand}
        footer={site.footer}
        newsletterEnabled={site.settings.newsletterEnabled}
      />
    </div>
  );
}
