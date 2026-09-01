import Link from "next/link";

export function BrandMark({ name = "SKIE EVENTS" }: { name?: string }) {
  const [main, ...rest] = name.trim().split(/\s+/);
  const sub = rest.join(" ");

  return (
    <Link href="/" className="brand-mark wordmark" aria-label={`${name} home`}>
      <span className="wordmark-main">{main || "SKIE"}</span>
      {sub && <span className="wordmark-sub">{sub}</span>}
    </Link>
  );
}
