export function safeRedirectPath(value: string | null | undefined, fallback = "/account") {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  if (/[%\u0000-\u001f\u007f]/.test(value)) return fallback;
  try {
    const parsed = new URL(value, "http://skie.local");
    if (parsed.origin !== "http://skie.local" || parsed.pathname.startsWith("/api/")) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export function loginRedirectPath(next: string) {
  return `/login?next=${encodeURIComponent(safeRedirectPath(next))}`;
}
