import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panel = readFileSync("src/components/admin/MediaPanel.tsx", "utf8");
const studio = readFileSync("src/components/admin/AdminStudio.tsx", "utf8");

describe("media administration controls", () => {
  it("provides upload progress, cancel and retry", () => {
    expect(panel).toContain("xhr.upload.onprogress"); expect(panel).toContain("Cancel upload"); expect(panel).toContain("Retry upload");
  });
  it("provides metadata, poster, order, replace, publish and safe reference removal controls", () => {
    for (const label of ["Alt text", "Caption", "Poster image", "Move up", "Replace", "Published", "Remove reference", "Clean old orphans"]) expect(panel).toContain(label);
  });
  it("uses the shared versioned CMS save boundary for stale-write protection", () => {
    expect(studio).toContain("expectedVersion: siteVersion"); expect(studio).toContain("CMS_STALE_VERSION"); expect(studio).toContain("Reload latest");
  });
});
