import type { Metadata } from "next";
import { MediaGrid } from "@/components/MediaGrid";
import { PageHero } from "@/components/PageHero";
import { readPublicSiteData } from "@/lib/store";
import { getPagesContent } from "@/lib/site-content";

export const metadata: Metadata = { title: "Media" };
export const dynamic = "force-dynamic";

export default async function MediaPage() {
  const site = await readPublicSiteData();
  const pages = getPagesContent(site.pages);

  return (
    <>
      <PageHero eyebrow={pages.media.eyebrow} title={pages.media.title} body={pages.media.body} cover={pages.media} />
      <section className="section">
        <div className="shell">
          <MediaGrid items={site.media} />
        </div>
      </section>
    </>
  );
}
