import { readFile } from "node:fs/promises";

const reportPath = process.argv[2];
if (!reportPath) {
  throw new Error("Pass the npm audit JSON path.");
}

const report = JSON.parse(await readFile(reportPath, "utf8"));
const vulnerabilities = report.vulnerabilities && typeof report.vulnerabilities === "object"
  ? report.vulnerabilities
  : {};

// These advisories are accepted only when npm reports them through the exact
// ESLint/Minimatch development-tool package chain below. Production dependencies
// are audited separately and must remain clean. GHSA-rgw5-rvv9-x895 is accepted
// temporarily only for those dev-only transitive copies and must be removed on
// the next reviewed lockfile refresh that resolves them to patched versions.
const allowedAdvisoryUrls = new Set([
  "https://github.com/advisories/GHSA-mh99-v99m-4gvg",
  "https://github.com/advisories/GHSA-f886-m6hf-6m8v",
  "https://github.com/advisories/GHSA-3jxr-9vmj-r5cp",
  "https://github.com/advisories/GHSA-rgw5-rvv9-x895",
]);

const allowedAffectedPackages = new Set([
  "@eslint/config-array",
  "@eslint/eslintrc",
  "brace-expansion",
  "eslint",
  "eslint-config-next",
  "eslint-plugin-import",
  "eslint-plugin-jsx-a11y",
  "eslint-plugin-react",
  "minimatch",
]);

const unexpectedPackages = Object.keys(vulnerabilities)
  .filter((name) => !allowedAffectedPackages.has(name));

const advisories = [];
for (const [packageName, vulnerability] of Object.entries(vulnerabilities)) {
  const via = Array.isArray(vulnerability?.via) ? vulnerability.via : [];
  for (const item of via) {
    if (item && typeof item === "object") {
      advisories.push({
        packageName,
        url: String(item.url || ""),
        title: String(item.title || ""),
        severity: String(item.severity || vulnerability.severity || "unknown"),
      });
    }
  }
}

const unexpectedAdvisories = advisories.filter((item) => !allowedAdvisoryUrls.has(item.url));
if (unexpectedPackages.length || unexpectedAdvisories.length) {
  console.error(JSON.stringify({ unexpectedPackages, unexpectedAdvisories }, null, 2));
  throw new Error("The full dependency audit contains an advisory outside the reviewed development-only allowlist.");
}

if (advisories.length === 0) {
  console.log("Full dependency audit is clean.");
  process.exit(0);
}

const productionCounts = report.metadata?.dependencies || {};
console.log(JSON.stringify({
  acceptedDevelopmentOnlyAdvisories: advisories,
  affectedPackages: Object.keys(vulnerabilities).sort(),
  dependencyCounts: productionCounts,
}, null, 2));
console.log("Accepted only reviewed brace-expansion advisories in the ESLint/Minimatch development toolchain; the separate production audit must remain clean.");
