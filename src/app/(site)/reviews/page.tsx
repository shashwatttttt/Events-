import type { Metadata } from "next";
import { PageHero } from "@/components/PageHero";
import { ReviewCard } from "@/components/ReviewCard";
import { ReviewForm } from "@/components/ReviewForm";
import { readPublicSiteData } from "@/lib/store";
import { getPagesContent } from "@/lib/site-content";

export const metadata: Metadata = { title: "Reviews" };
export const dynamic = "force-dynamic";

export default async function ReviewsPage() {
  const site = await readPublicSiteData();
  const pages = getPagesContent(site.pages);

  return (
    <>
      <PageHero
        eyebrow={pages.reviews.eyebrow}
        title={pages.reviews.title}
        body={pages.reviews.body}
        cover={pages.reviews}
      />
      <section className="section">
        <div className="shell reviews-page-grid">
          <div className="review-grid review-grid-page">
            {site.reviews.map((review) => (
              <ReviewCard key={review.id} review={review} />
            ))}
          </div>
          <aside className="form-panel">
            <p className="eyebrow">
              <span />
              {pages.reviews.formEyebrow}
            </p>
            <h2>{pages.reviews.formTitle}</h2>
            <ReviewForm />
          </aside>
        </div>
      </section>
    </>
  );
}
