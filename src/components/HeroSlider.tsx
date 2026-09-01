"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { HeroSlide } from "@/types/site";
import { safeUrl } from "@/lib/format";

export function HeroSlider({ slides }: { slides: HeroSlide[] }) {
  const visible = useMemo(() => slides.filter((slide) => slide.active), [slides]);
  const [index, setIndex] = useState(0);
  const [failedImage, setFailedImage] = useState("");
  const [paused, setPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(preference.matches);
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (visible.length < 2 || paused || reducedMotion) return;
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % visible.length), 6500);
    return () => window.clearInterval(timer);
  }, [paused, reducedMotion, visible.length]);
  if (!visible.length) return null;
  const slide = visible[index % visible.length];
  const image = safeUrl(slide.imageUrl);
  const showImage = Boolean(image && failedImage !== image);
  const ctaHref = safeUrl(slide.ctaHref) || "/events";
  const overlayOpacity = slide.overlayOpacity ?? 0.5;
  const focalPosition = slide.focalPosition ?? "center";
  const textAlignment = slide.textAlignment ?? "left";
  return (
    <section className="hero-stage" aria-label="Featured Skie content">
      <div
        className={`hero-backdrop${showImage ? " has-image" : ""}`}
        style={showImage ? {
          ["--hero-overlay" as string]: overlayOpacity,
        } : undefined}
      >
        {showImage && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="hero-cover-image"
            src={image}
            alt={`${slide.title} cover`}
            style={{ objectPosition: focalPosition }}
            onError={() => setFailedImage(image)}
          />
        )}
      </div>
      <div className="hero-grid-overlay" /><div className="hero-orbit hero-orbit-one" /><div className="hero-orbit hero-orbit-two" />
      <div className={`shell hero-content is-${textAlignment}`}>
        <div className={`hero-copy is-${textAlignment}`} key={slide.id}>
          <p className="eyebrow"><span />{slide.kicker}</p>
          <h1>{slide.title}</h1>
          <p className="hero-subtitle">{slide.subtitle}</p>
          <div className="hero-actions"><Link href={ctaHref} className="button button-primary">{slide.ctaLabel}<span>↗</span></Link><Link href="/media" className="button button-ghost">Enter the archive</Link></div>
        </div>
        <div className="hero-index"><span>{String(index + 1).padStart(2,"0")}</span><div className="hero-progress"><i style={{ width: `${((index + 1) / visible.length) * 100}%` }} /></div><span>{String(visible.length).padStart(2,"0")}</span></div>
      </div>
      {visible.length > 1 && <div className="hero-controls" aria-label="Featured content controls"><button type="button" onClick={() => setIndex((index - 1 + visible.length) % visible.length)} aria-label="Previous slide">←</button><button type="button" onClick={() => setPaused((value) => !value)} aria-pressed={paused || reducedMotion} aria-label={paused || reducedMotion ? "Play featured slides" : "Pause featured slides"}>{paused || reducedMotion ? "▶" : "Ⅱ"}</button><button type="button" onClick={() => setIndex((index + 1) % visible.length)} aria-label="Next slide">→</button></div>}
      <p className="sr-only" aria-live="polite">Featured slide {index + 1} of {visible.length}: {slide.title}</p>
      <div className="scroll-cue" aria-hidden="true"><span>Scroll to enter</span><i /></div>
    </section>
  );
}
