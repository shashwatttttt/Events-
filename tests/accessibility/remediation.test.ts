import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdaptiveVideoPlayer } from "@/components/AdaptiveVideoPlayer";
import { CheckoutBuilder } from "@/components/CheckoutBuilder";
import { HeroSlider } from "@/components/HeroSlider";
import { QRScanner } from "@/components/QRScanner";
import { accessibleAccent, contrastRatio } from "@/lib/accessibility";
import { eventFixture, productFixture } from "../fixtures";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function filesBelow(path: string): string[] {
  return readdirSync(path).flatMap((name) => {
    const child = join(path, name);
    return statSync(child).isDirectory() ? filesBelow(child) : [child];
  });
}

function luminance(hex: string) {
  const channels = hex.match(/[a-f\d]{2}/gi)?.map((part) => Number.parseInt(part, 16) / 255) || [];
  const [red, green, blue] = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground: string, background: string) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe("WCAG 2.2 AA remediation contracts", () => {
  it("provides a focusable public skip target and labelled primary navigation", () => {
    const layout = source("src/app/(site)/layout.tsx");
    const header = source("src/components/SiteHeader.tsx");
    expect(layout).toContain('className="skip-link" href="#main-content"');
    expect(layout).toContain('id="main-content" tabIndex={-1}');
    expect(header).toContain('aria-label="Main navigation"');
    expect(header).toContain('aria-current={pathname===href?"page":undefined}');
    expect(header).toContain('event.key==="Escape"');
    expect(header).toContain("menuButton.current?.focus()");
  });

  it("renders carousel controls that expose pause, position and reduced-motion behavior", () => {
    const markup = renderToStaticMarkup(createElement(HeroSlider, { slides: [
      { id: "one", active: true, kicker: "One", title: "First", subtitle: "First slide", imageUrl: "", ctaLabel: "Events", ctaHref: "/events" },
      { id: "two", active: true, kicker: "Two", title: "Second", subtitle: "Second slide", imageUrl: "", ctaLabel: "Media", ctaHref: "/media" },
    ] }));
    expect(markup).toContain('aria-label="Featured content controls"');
    expect(markup).toContain('aria-label="Play featured slides"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-live="polite"');
    expect(source("src/components/HeroSlider.tsx")).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
  });

  it("renders accessible checkout totals, quantity guidance and decorative extras", () => {
    const markup = renderToStaticMarkup(createElement(CheckoutBuilder, { event: eventFixture(), products: [productFixture()] }));
    expect(markup).toContain('aria-describedby="ticket-quantity-help"');
    expect(markup).toContain('aria-label="Fixture Extra quantity"');
    expect(markup).toContain('aria-label="Total $45"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-hidden="true"');
  });

  it("exposes scanner instructions and non-colour scan announcements", () => {
    const markup = renderToStaticMarkup(createElement(QRScanner, { events: [eventFixture()] }));
    expect(markup).toContain('aria-describedby="manual-scan-help"');
    expect(markup).toContain("Paste the full QR URL");
    expect(markup).toContain("Start camera");
    const scanner = source("src/components/QRScanner.tsx");
    expect(scanner).toContain('aria-live="assertive"');
    expect(scanner).toContain("Scan result:");
  });

  it("keeps video controls, captions and unavailable fallback text exposed", () => {
    const ready = renderToStaticMarkup(createElement(AdaptiveVideoPlayer, { label: "Event recap", src: "/video.m3u8", captions: [{ id: "en", kind: "captions", label: "English", language: "en-AU", src: "/captions.vtt", default: true }] }));
    const unavailable = renderToStaticMarkup(createElement(AdaptiveVideoPlayer, { label: "Event recap", status: "failed" }));
    expect(ready).toContain("Video player with playback controls and captions");
    expect(ready).toContain("controls");
    expect(ready).toContain('kind="captions"');
    expect(unavailable).toContain('aria-live="polite"');
    expect(unavailable).toContain("text description or caption track");
  });

  it("uses an accessible modal contract with focus trapping and restoration", () => {
    const dialog = source("src/components/AccessibleDialog.tsx");
    expect(dialog).toContain('role="dialog"');
    expect(dialog).toContain('aria-modal="true"');
    expect(dialog).toContain("event.key === \"Escape\"");
    expect(dialog).toContain("event.key !== \"Tab\"");
    expect(dialog).toContain("returnFocus.current?.focus()");
    const adminSource = filesBelow(join(process.cwd(), "src", "components", "admin"))
      .filter((path) => /\.tsx$/.test(path))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(adminSource).not.toMatch(/window\.(confirm|prompt)\s*\(/);
  });

  it("meets AA contrast for the core brand combinations used for normal text", () => {
    expect(contrast("5170FF", "050505")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("050505", "5170FF")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("9B9BA4", "050505")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("FFFFFF", "050505")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#5170FF", "#050505")).toBeGreaterThanOrEqual(4.5);
    expect(accessibleAccent("#101010")).toBe("#5170FF");
    expect(accessibleAccent("#7890FF")).toBe("#7890FF");
    const css = source("src/app/globals.css");
    expect(css).toMatch(/\.button-primary\s*\{\s*color:\s*#050505/);
    expect(css).toContain("min-height: 44px");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("provides meaningful titles for key public and operational flows", () => {
    expect(source("src/app/(site)/login/page.tsx")).toContain('title: "Log in"');
    expect(source("src/app/(site)/signup/page.tsx")).toContain('title: "Create account"');
    expect(source("src/app/(site)/payment/success/page.tsx")).toContain('title:"Payment status"');
    expect(source("src/app/skie-control/check-in/page.tsx")).toContain('title:"Door check-in"');
    expect(source("src/app/(site)/events/[slug]/page.tsx")).toContain("generateMetadata");
  });
});
