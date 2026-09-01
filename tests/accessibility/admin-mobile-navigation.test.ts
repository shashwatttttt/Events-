import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("mobile admin navigation", () => {
  it("uses an accessible off-canvas sections drawer", () => {
    const studio = source("src/components/admin/AdminStudio.tsx");
    const css = source("src/components/admin/AdminStudio.module.css");

    expect(studio).toContain('aria-controls="admin-mobile-navigation"');
    expect(studio).toContain("aria-expanded={navigationOpen}");
    expect(studio).toContain("Close admin navigation");
    expect(studio).toContain('event.key === "Escape"');
    expect(studio).toContain("setNavigationOpen(false)");
    expect(css).toContain("position: fixed !important");
    expect(css).toContain("transform: translateX(-105%)");
    expect(css).toContain("visibility: hidden");
    expect(css).toContain("pointer-events: none");
    expect(css).toContain("visibility: visible");
    expect(css).toContain("pointer-events: auto");
    expect(css).toContain(".sidebarOpen");
    expect(css).toContain("overflow-x: hidden !important");
  });

  it("turns dense admin controls into touch-friendly phone layouts", () => {
    const css = source("src/components/admin/AdminStudio.module.css");

    expect(css).toContain("min-height: 46px");
    expect(css).toContain(":global(.admin-filter-bar)");
    expect(css).toContain(":global(.inline-admin-actions)");
    expect(css).toContain(":global(.audit-row)");
    expect(css).toContain("grid-template-columns: 1fr !important");
    expect(css).toContain("prefers-reduced-motion: reduce");
  });
});
