const DEFAULT_ACCENT = "#5170FF";

function relativeLuminance(hex: string) {
  const channels = hex.slice(1).match(/.{2}/g)?.map((part) => Number.parseInt(part, 16) / 255) || [];
  const [red, green, blue] = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(foreground: string, background: string) {
  if (!/^#[0-9a-f]{6}$/i.test(foreground) || !/^#[0-9a-f]{6}$/i.test(background)) return 0;
  const values = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

export function accessibleAccent(preferred: string, fallback = DEFAULT_ACCENT) {
  return /^#[0-9a-f]{6}$/i.test(preferred) && contrastRatio(preferred, "#050505") >= 4.5
    ? preferred
    : fallback;
}
