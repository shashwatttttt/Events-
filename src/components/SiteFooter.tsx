import Link from "next/link";
import type { FooterContent, SiteData } from "@/types/site";
import { BrandMark } from "@/components/BrandMark";
import { NewsletterForm } from "@/components/NewsletterForm";
import { getFooterContent } from "@/lib/site-content";
import { safeUrl } from "@/lib/format";

export function SiteFooter({
  brand,
  footer,
  newsletterEnabled = true,
}: {
  brand: SiteData["brand"];
  footer?: Partial<FooterContent>;
  newsletterEnabled?: boolean;
}) {
  const content = getFooterContent(footer);
  const instagramUrl = safeUrl(brand.instagramUrl);

  return (
    <footer className="site-footer">
      <div className="shell footer-grid">
        <div>
          <BrandMark name={brand.name} />
          <p className="footer-statement">{brand.statement}</p>
          {newsletterEnabled && <NewsletterForm />}
        </div>
        <div>
          <span className="footer-label">{content.exploreLabel}</span>
          <Link href="/events">{content.eventsLabel}</Link>
          <Link href="/media">{content.mediaLabel}</Link>
          <Link href="/reviews">{content.reviewsLabel}</Link>
          <Link href="/account">{content.accountLabel}</Link>
        </div>
        <div>
          <span className="footer-label">{content.connectLabel}</span>
          <a href={`mailto:${brand.contactEmail}`}>{brand.contactEmail}</a>
          <a
            href={instagramUrl || "#"}
            target={instagramUrl ? "_blank" : undefined}
            rel={instagramUrl ? "noreferrer" : undefined}
          >
            {content.instagramLabel} <span>↗</span>
          </a>
          <Link href="/contact">{content.contactLabel}</Link>
          <span className="footer-label footer-legal-label">{content.policiesLabel}</span>
          <Link href="/terms">{content.termsLabel}</Link>
          <Link href="/privacy">{content.privacyLabel}</Link>
          <Link href="/refund-policy">{content.refundsLabel}</Link>
          <Link href="/entry-policy">{content.entryLabel}</Link>
        </div>
      </div>
      <div className="shell footer-bottom">
        <span>© {new Date().getFullYear()} {brand.name}</span>
        <span>{content.locationLabel}</span>
      </div>
    </footer>
  );
}
