import type { Metadata } from "next";
import Link from "next/link";
import { readPublicSiteData } from "@/lib/store";
import { safeUrl } from "@/lib/format";
import { getPagesContent } from "@/lib/site-content";

export const metadata: Metadata = { title: "About" };
export const dynamic = "force-dynamic";

export default async function AboutPage() {
  const site = await readPublicSiteData();
  const pages = getPagesContent(site.pages);
  const cover = safeUrl(pages.about.coverImageUrl);

  return (
    <>
      <section
        className={`about-hero${cover ? " has-cover" : ""} is-${pages.about.coverTextAlignment}`}
        style={{ ["--page-cover-overlay" as string]: pages.about.coverOverlayOpacity }}
      >
        {cover && (
          <div
            className="page-hero-cover"
            style={{
              backgroundImage: `url(${JSON.stringify(cover).slice(1, -1)})`,
              backgroundPosition: pages.about.coverFocalPosition,
            }}
          />
        )}
        <div className="page-hero-cover-overlay" />
        {!cover && <div className="about-word" aria-hidden="true">SKIE</div>}
        <div className="shell">
          <p className="eyebrow"><span />{site.about.eyebrow}</p>
          <h1>{site.about.title}</h1>
        </div>
      </section>
      <section className="section about-copy">
        <div className="shell about-grid">
          <div><span>01</span><p>Melbourne<br />Australia</p></div>
          <article>
            {site.about.body.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            <Link className="button button-primary" href="/events">Enter the next event <span>↗</span></Link>
          </article>
        </div>
      </section>
    </>
  );
}
