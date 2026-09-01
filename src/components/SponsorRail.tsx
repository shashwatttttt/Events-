"use client";

import { useState } from "react";
import type { Sponsor } from "@/types/site";
import { safeUrl } from "@/lib/format";

export function SponsorRail({ sponsors }: { sponsors: Sponsor[] }) {
  const active = sponsors.filter((sponsor) => sponsor.active);
  const [failedBanners, setFailedBanners] = useState<Set<string>>(() => new Set());
  const [failedLogos, setFailedLogos] = useState<Set<string>>(() => new Set());
  if (!active.length) return null;

  return (
    <div className="sponsor-showcase" aria-label="Skie partners">
      {active.map((sponsor, index) => {
        const banner = failedBanners.has(sponsor.id) ? "" : safeUrl(sponsor.bannerUrl);
        const logo = failedLogos.has(sponsor.id) ? "" : safeUrl(sponsor.logoUrl);
        const website = safeUrl(sponsor.websiteUrl);
        const instagram = safeUrl(sponsor.instagramUrl || "");

        return (
          <article
            className={`sponsor-slide${banner ? " has-banner" : ""}`}
            key={sponsor.id}
          >
            {banner && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="sponsor-banner-image"
                src={banner}
                alt={`${sponsor.name} banner`}
                onError={() => setFailedBanners((current) => new Set(current).add(sponsor.id))}
              />
            )}
            <div className="sponsor-slide-index">{String(index + 1).padStart(2, "0")}</div>
            <div className="sponsor-slide-content">
              {logo
                // eslint-disable-next-line @next/next/no-img-element
                ? <img className="sponsor-logo" src={logo} alt={`${sponsor.name} logo`} onError={() => setFailedLogos((current) => new Set(current).add(sponsor.id))} />
                : <strong className="sponsor-name">{sponsor.name}</strong>}
              <p className="eyebrow"><span />{sponsor.tagline}</p>
              <p>{sponsor.description}</p>
              {(website || instagram) && (
                <div className="sponsor-links">
                  {website && (
                    <a className="text-link" href={website} target="_blank" rel="noreferrer">
                      Visit partner <span>↗</span>
                    </a>
                  )}
                  {instagram && (
                    <a className="text-link" href={instagram} target="_blank" rel="noreferrer">
                      Instagram <span>↗</span>
                    </a>
                  )}
                </div>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
