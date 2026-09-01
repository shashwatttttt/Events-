import type { Review } from "@/types/site";

export function ReviewCard({ review }: { review: Review }) {
  return <article className="review-card"><div className="review-rating" aria-label={`${review.rating} out of 5 stars`}>{Array.from({length:5},(_,index)=><span key={index} className={index<review.rating?"is-lit":""}>✦</span>)}</div><blockquote>“{review.body}”</blockquote><footer><span>{review.name}</span><small>Verified community review</small></footer></article>;
}
