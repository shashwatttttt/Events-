import type { Metadata } from "next";
import { ContactForm } from "@/components/ContactForm";
import { PageHero } from "@/components/PageHero";
import { readPublicSiteData } from "@/lib/store";
import { getPagesContent } from "@/lib/site-content";
import { safeUrl } from "@/lib/format";

export const metadata: Metadata = { title: "Contact" };
export const dynamic = "force-dynamic";

export default async function ContactPage() {
  const site = await readPublicSiteData();
  const pages = getPagesContent(site.pages);
  const instagramUrl = safeUrl(site.brand.instagramUrl);

  return (
    <>
      <PageHero
        eyebrow={pages.contact.eyebrow}
        title={pages.contact.title}
        body={pages.contact.body}
        cover={pages.contact}
      />
      <section className="section">
        <div className="shell contact-grid">
          <aside>
            <div>
              <small>{pages.contact.emailLabel}</small>
              <a href={`mailto:${site.brand.contactEmail}`}>{site.brand.contactEmail}</a>
            </div>
            <div>
              <small>{pages.contact.instagramLabel}</small>
              <a
                href={instagramUrl || "#"}
                target={instagramUrl ? "_blank" : undefined}
                rel={instagramUrl ? "noreferrer" : undefined}
              >
                {pages.contact.instagramLinkLabel} <span>↗</span>
              </a>
            </div>
            <div>
              <small>{pages.contact.basedLabel}</small>
              <span>{pages.contact.basedValue}</span>
            </div>
          </aside>
          <div className="form-panel">
            <ContactForm />
          </div>
        </div>
      </section>
    </>
  );
}
