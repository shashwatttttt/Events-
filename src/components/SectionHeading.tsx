import Link from "next/link";

export function SectionHeading({ eyebrow, title, href, linkLabel = "View all" }: { eyebrow: string; title: string; href?: string; linkLabel?: string }) {
  return <div className="section-heading"><div><p className="eyebrow"><span />{eyebrow}</p><h2>{title}</h2></div>{href && <Link href={href} className="text-link">{linkLabel}<span>↗</span></Link>}</div>;
}
