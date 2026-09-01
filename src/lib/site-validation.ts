import type { PageCoverSettings, SiteData } from "@/types/site";
import { assertCanonicalEventConfiguration, MELBOURNE_TIMEZONE } from "@/lib/event-state";

function nonNegativeInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative whole number.`);
}

function validOptionalUrl(value: string | undefined, label: string) {
  if (!value) return;
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) return;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol)) throw new Error();
  } catch {
    throw new Error(`${label} must be an HTTP(S) URL or a local /path.`);
  }
}

function validTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: value }).format();
  } catch {
    throw new Error("Timezone must be a valid IANA timezone, for example Australia/Melbourne.");
  }
  if (value !== MELBOURNE_TIMEZONE) {
    throw new Error(`Event operations must use ${MELBOURNE_TIMEZONE}.`);
  }
}

function validCalendarDate(value: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must use YYYY-MM-DD.`);
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw new Error(`${label} is not a valid calendar date.`);
  }
}

function validSalesWindow(start: string | undefined, end: string | undefined, label: string) {
  const startTime = start ? new Date(start).getTime() : null;
  const endTime = end ? new Date(end).getTime() : null;
  if (start && !Number.isFinite(startTime)) throw new Error(`${label} sales start is invalid.`);
  if (end && !Number.isFinite(endTime)) throw new Error(`${label} sales end is invalid.`);
  if (startTime !== null && endTime !== null && startTime >= endTime) {
    throw new Error(`${label} sales start must be before sales end.`);
  }
}

function validCoverSettings(value: PageCoverSettings | undefined, label: string) {
  if (!value) throw new Error(`${label} cover settings are required.`);
  validOptionalUrl(value.coverImageUrl, `${label} cover image`);
  if (
    typeof value.coverOverlayOpacity !== "number"
    || !Number.isFinite(value.coverOverlayOpacity)
    || value.coverOverlayOpacity < 0
    || value.coverOverlayOpacity > 0.9
  ) {
    throw new Error(`${label} cover overlay must be between 0 and 0.9.`);
  }
  if (!["center", "top", "bottom", "left", "right"].includes(value.coverFocalPosition)) {
    throw new Error(`${label} cover focal position is invalid.`);
  }
  if (!["left", "center"].includes(value.coverTextAlignment)) {
    throw new Error(`${label} cover text alignment is invalid.`);
  }
}

export function assertValidSiteData(site: SiteData) {
  if (!site?.brand?.name?.trim()) throw new Error("Brand name is required.");
  if (
    !Array.isArray(site.events)
    || !Array.isArray(site.products)
    || !Array.isArray(site.heroSlides)
    || !Array.isArray(site.forms)
  ) {
    throw new Error("Invalid site payload.");
  }
  if (site.events.length > 500 || site.products.length > 5000) throw new Error("Site payload exceeds safe limits.");
  if (!/^#[0-9a-f]{6}$/i.test(site.brand.accent)) throw new Error("Brand accent must be a six-digit hex colour.");
  validTimezone(site.settings.timezone);
  if (
    !Number.isInteger(site.settings.defaultTicketLimit)
    || site.settings.defaultTicketLimit < 1
    || site.settings.defaultTicketLimit > 20
  ) throw new Error("New-event ticket limit must be between 1 and 20.");
  if (
    !Number.isInteger(site.settings.defaultAllocationExpiryHours)
    || site.settings.defaultAllocationExpiryHours < 1
    || site.settings.defaultAllocationExpiryHours > 336
  ) throw new Error("Application allocation expiry must be between 1 and 336 hours.");
  validOptionalUrl(site.brand.instagramUrl, "Brand Instagram URL");
  validOptionalUrl(site.homepage?.manifestoLinkHref, "Manifesto link");
  validOptionalUrl(site.homepage?.finalCtaButtonHref, "Final call-to-action link");

  if (site.homepage) {
    const visibilityFields = new Set(["showUpcomingEvents", "showMedia", "showReviews"]);
    for (const [key, value] of Object.entries(site.homepage)) {
      if (visibilityFields.has(key)) {
        if (typeof value !== "boolean") throw new Error(`Homepage field '${key}' must be true or false.`);
        continue;
      }
      if (typeof value !== "string") throw new Error(`Homepage field '${key}' must be text.`);
      if (value.length > 5000) throw new Error(`Homepage field '${key}' is too long.`);
    }
  }

  const pages = site.pages;
  if (!pages) throw new Error("Public page settings are required.");
  validCoverSettings(pages.events, "Events page");
  validCoverSettings(pages.previousEvents, "Previous Events page");
  validCoverSettings(pages.media, "Media page");
  validCoverSettings(pages.reviews, "Reviews page");
  validCoverSettings(pages.about, "About page");
  validCoverSettings(pages.contact, "Contact page");

  const heroSlideIds = new Set<string>();
  for (const slide of site.heroSlides) {
    if (
      typeof slide?.id !== "string"
      || !slide.id.trim()
      || typeof slide.title !== "string"
      || !slide.title.trim()
    ) {
      throw new Error("Every hero slide needs an ID and title.");
    }
    if (heroSlideIds.has(slide.id)) throw new Error("Hero slide IDs must be unique.");
    heroSlideIds.add(slide.id);
    if (
      typeof slide.overlayOpacity !== "number"
      || !Number.isFinite(slide.overlayOpacity)
      || slide.overlayOpacity < 0
      || slide.overlayOpacity > 0.9
    ) {
      throw new Error(`${slide.title} overlay must be between 0 and 0.9.`);
    }
    if (!["center", "top", "bottom", "left", "right"].includes(slide.focalPosition || "")) {
      throw new Error(`${slide.title} focal position is invalid.`);
    }
    if (!["left", "center"].includes(slide.textAlignment || "")) {
      throw new Error(`${slide.title} text alignment is invalid.`);
    }
    validOptionalUrl(slide.imageUrl, `${slide.title} image`);
    validOptionalUrl(slide.videoUrl, `${slide.title} video`);
    validOptionalUrl(slide.ctaHref, `${slide.title} link`);
  }

  const formIds = new Set<string>();
  for (const form of site.forms) {
    if (!form.id || formIds.has(form.id)) throw new Error("Application form IDs must be unique.");
    formIds.add(form.id);
    if (!form.name.trim() || !Array.isArray(form.fields)) throw new Error("Every application form needs a name and fields.");

    const fieldIds = new Set<string>();
    const fieldKeys = new Set<string>();
    for (const field of form.fields) {
      if (!field?.id || fieldIds.has(field.id)) throw new Error(`${form.name} field IDs must be present and unique.`);
      if (!field.key || !/^[a-z0-9_]+$/.test(field.key) || fieldKeys.has(field.key)) {
        throw new Error(`${form.name} field keys must be present, unique and use lowercase letters, numbers or underscores.`);
      }
      fieldIds.add(field.id);
      fieldKeys.add(field.key);
      if (!field.label?.trim()) throw new Error(`${form.name} has a field without a label.`);
      if (!["text", "email", "phone", "textarea", "select", "radio", "checkbox"].includes(field.type)) {
        throw new Error(`${field.label} has an unsupported field type.`);
      }
      if ((field.type === "select" || field.type === "radio") && !field.options?.length) {
        throw new Error(`${field.label} needs at least one option.`);
      }
      if (field.maxLength !== undefined && (!Number.isInteger(field.maxLength) || field.maxLength < 1 || field.maxLength > 5000)) {
        throw new Error(`${field.label} has an invalid maximum length.`);
      }
    }
  }

  const eventIds = new Set<string>();
  const slugs = new Set<string>();
  const ticketTypeIds = new Set<string>();
  for (const event of site.events) {
    if (!event.id || eventIds.has(event.id)) throw new Error("Event IDs must be unique.");
    eventIds.add(event.id);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(event.slug) || slugs.has(event.slug)) throw new Error(`Event slug '${event.slug}' is invalid or duplicated.`);
    slugs.add(event.slug);
    if (!event.title.trim() || !event.date) throw new Error("Every event needs a title and date.");
    if (!["draft", "preview", "published", "archived", "cancelled"].includes(event.lifecycle)) throw new Error(`${event.title} has an invalid lifecycle.`);
    if (!["public", "hidden", "password", "private_link", "coming_soon", "archived"].includes(event.visibility)) throw new Error(`${event.title} has invalid visibility.`);
    if (!["invite_only", "direct_purchase", "post_checkout_approval", "coming_soon", "closed", "free_rsvp"].includes(event.ticketMode)) throw new Error(`${event.title} has an invalid ticket mode.`);
    validCalendarDate(event.date, `${event.title} start date`);
    if (event.endDate) {
      validCalendarDate(event.endDate, `${event.title} end date`);
      if (event.endDate < event.date) throw new Error(`${event.title} end date cannot be before its start date.`);
    }
    assertCanonicalEventConfiguration(event);
    if (event.visibility === "password" && (!event.password || event.password.length < 6)) throw new Error(`${event.title} needs an event password of at least 6 characters.`);
    if (event.formId && !formIds.has(event.formId)) throw new Error(`${event.title} references a missing application form.`);

    [
      [event.venueCapacity, `${event.title} venue capacity`],
      [event.publicCapacity, `${event.title} public capacity`],
      [event.sponsorAllocation, `${event.title} sponsor allocation`],
      [event.guestlistAllocation, `${event.title} guestlist allocation`],
      [event.teamAllocation, `${event.title} team allocation`],
      [event.safetyBuffer, `${event.title} safety buffer`],
      [event.defaultTicketLimit, `${event.title} default ticket limit`],
    ].forEach(([value, label]) => nonNegativeInteger(Number(value), String(label)));

    const allocationTotal = event.publicCapacity + event.sponsorAllocation + event.guestlistAllocation + event.teamAllocation + event.safetyBuffer;
    if (allocationTotal > event.venueCapacity) throw new Error(`${event.title} allocations exceed venue capacity.`);
    if (event.defaultTicketLimit < 1 || event.defaultTicketLimit > 20) throw new Error(`${event.title} default ticket limit must be between 1 and 20.`);
    if (!event.ticketTypes.length) throw new Error(`${event.title} needs at least one ticket type.`);

    let ticketCapacity = 0;
    for (const ticketType of event.ticketTypes) {
      if (!ticketType.id || ticketTypeIds.has(ticketType.id)) throw new Error("Ticket type IDs must be unique.");
      ticketTypeIds.add(ticketType.id);
      if (!ticketType.name.trim()) throw new Error(`${event.title} has a ticket type without a name.`);
      nonNegativeInteger(ticketType.priceCents, `${ticketType.name} price`);
      nonNegativeInteger(ticketType.capacity, `${ticketType.name} capacity`);
      nonNegativeInteger(ticketType.sold, `${ticketType.name} sold quantity`);
      if (ticketType.capacity < ticketType.sold) throw new Error(`${ticketType.name} capacity cannot be below issued quantity.`);
      if (ticketType.defaultMaxPerCustomer < 1 || ticketType.defaultMaxPerCustomer > 20) throw new Error(`${ticketType.name} max per customer must be between 1 and 20.`);
      validSalesWindow(ticketType.salesStartAt, ticketType.salesEndAt, ticketType.name);
      ticketCapacity += ticketType.capacity;
    }
    if (ticketCapacity > event.publicCapacity) throw new Error(`${event.title} ticket-type capacity exceeds public allocation.`);
    validOptionalUrl(event.posterUrl, `${event.title} poster`);
    validOptionalUrl(event.heroUrl, `${event.title} hero`);
  }

  const productIds = new Set<string>();
  for (const product of site.products) {
    if (!product.id || productIds.has(product.id)) throw new Error("Product IDs must be unique.");
    productIds.add(product.id);
    if (!eventIds.has(product.eventId)) throw new Error(`${product.name} references a missing event.`);
    if (!product.name.trim()) throw new Error("Every product needs a name.");
    nonNegativeInteger(product.priceCents, `${product.name} price`);
    nonNegativeInteger(product.stockQuantity, `${product.name} stock`);
    nonNegativeInteger(product.soldQuantity, `${product.name} sold quantity`);
    if (product.stockQuantity < product.soldQuantity) throw new Error(`${product.name} stock cannot be below purchased quantity.`);
    if (product.maxPerOrder < 1 || product.maxPerCustomer < 1) throw new Error(`${product.name} quantity limits must be at least 1.`);
    if (product.maxPerOrder > product.maxPerCustomer) throw new Error(`${product.name} max per order cannot exceed max per customer.`);
    if (product.unitsPerPurchase < 1 || product.unitsPerPurchase > 100) throw new Error(`${product.name} redeemable units must be between 1 and 100.`);
    validSalesWindow(product.salesStartAt, product.salesEndAt, product.name);
    validOptionalUrl(product.imageUrl, `${product.name} image`);
  }

  const mediaIds = new Set<string>();
  const mediaOrders = new Set<number>();
  for (const media of site.media) {
    if (!media.id || mediaIds.has(media.id)) throw new Error("Media IDs must be present and unique.");
    mediaIds.add(media.id);
    if (!media.title?.trim() || media.title.length > 200) throw new Error("Every media item needs a concise title.");
    if (!media.eventName?.trim() || media.eventName.length > 200) throw new Error(`${media.title} needs an event label.`);
    if (media.eventId && !eventIds.has(media.eventId)) throw new Error(`${media.title} references a missing event.`);
    if (!["image", "video"].includes(media.type)) throw new Error(`${media.title} has an invalid media type.`);
    validOptionalUrl(media.url, `${media.title} asset`);
    validOptionalUrl(media.posterUrl, `${media.title} poster`);
    validOptionalUrl(media.manualPosterUrl, `${media.title} manual poster`);
    validOptionalUrl(media.generatedPosterUrl, `${media.title} generated poster`);
    validOptionalUrl(media.fallbackPosterUrl, `${media.title} fallback poster`);
    if (media.provider && !["local", "mux"].includes(media.provider)) throw new Error(`${media.title} has an invalid video provider.`);
    if (media.processingStatus && !["pending_upload", "uploaded", "processing", "ready", "failed", "deleted"].includes(media.processingStatus)) throw new Error(`${media.title} has an invalid processing status.`);
    if (media.posterTimeSeconds !== undefined && (!Number.isFinite(media.posterTimeSeconds) || media.posterTimeSeconds < 0 || media.posterTimeSeconds > 86_400)) throw new Error(`${media.title} poster timestamp is invalid.`);
    if (media.durationSeconds !== undefined && (!Number.isFinite(media.durationSeconds) || media.durationSeconds < 0 || media.durationSeconds > 604_800)) throw new Error(`${media.title} duration is invalid.`);
    if (media.provider === "mux" && media.published && (media.processingStatus !== "ready" || !media.playbackId || media.playbackPolicy !== "public")) throw new Error(`${media.title} must have a ready public playback before publishing.`);
    if ((media.processingErrorCode?.length || 0) > 100 || (media.processingErrorMessage?.length || 0) > 500) throw new Error(`${media.title} processing error is too long.`);
    if ((media.captions?.length || 0) > 20 || (media.captions || []).filter((track) => track.default).length > 1) throw new Error(`${media.title} caption tracks are invalid.`);
    for (const track of media.captions || []) {
      if (!track.id?.trim() || track.id.length > 100 || !["captions", "subtitles"].includes(track.kind) || !track.label?.trim() || track.label.length > 100 || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(track.language)) throw new Error(`${media.title} has invalid caption metadata.`);
      validOptionalUrl(track.src, `${media.title} caption track`);
    }
    if (media.type === "image" && media.published && !media.altText?.trim()) throw new Error(`${media.title} needs alt text before publishing.`);
    if ((media.altText?.length || 0) > 500 || (media.caption?.length || 0) > 2000) throw new Error(`${media.title} metadata is too long.`);
    if (!Number.isInteger(media.order) || media.order! < 0 || mediaOrders.has(media.order!)) throw new Error(`${media.title} needs a unique non-negative gallery order.`);
    mediaOrders.add(media.order!);
    if (media.width !== undefined && (!Number.isInteger(media.width) || media.width < 1 || media.width > 20_000)) throw new Error(`${media.title} width is invalid.`);
    if (media.height !== undefined && (!Number.isInteger(media.height) || media.height < 1 || media.height > 20_000)) throw new Error(`${media.title} height is invalid.`);
    if (media.aspectRatio !== undefined && (!Number.isFinite(media.aspectRatio) || media.aspectRatio < 0.1 || media.aspectRatio > 10)) throw new Error(`${media.title} aspect ratio is invalid.`);
    if (media.focalX !== undefined && (media.focalX < 0 || media.focalX > 1)) throw new Error(`${media.title} focal X must be between 0 and 1.`);
    if (media.focalY !== undefined && (media.focalY < 0 || media.focalY > 1)) throw new Error(`${media.title} focal Y must be between 0 and 1.`);
  }

  const sponsorIds = new Set(site.sponsors.map((item) => item.id));
  for (const sponsor of site.sponsors) {
    validOptionalUrl(sponsor.logoUrl, `${sponsor.name} logo`);
    validOptionalUrl(sponsor.bannerUrl, `${sponsor.name} banner`);
    validOptionalUrl(sponsor.websiteUrl, `${sponsor.name} website`);
    validOptionalUrl(sponsor.instagramUrl, `${sponsor.name} Instagram`);
  }
  for (const event of site.events) {
    if (event.sponsorIds.some((id) => !sponsorIds.has(id))) throw new Error(`${event.title} references a missing sponsor.`);
    if (event.productIds.some((id) => !productIds.has(id))) throw new Error(`${event.title} references a missing product.`);
    if (event.productIds.some((id) => site.products.find((product) => product.id === id)?.eventId !== event.id)) {
      throw new Error(`${event.title} references a product assigned to another event.`);
    }
  }
  for (const product of site.products) {
    const event = site.events.find((item) => item.id === product.eventId);
    if (!event?.productIds.includes(product.id)) throw new Error(`${product.name} must be assigned to its event product list.`);
  }

  const emailKeys = new Set<string>();
  for (const template of site.emailTemplates) {
    if (!template.key || emailKeys.has(template.key)) throw new Error("Email template keys must be unique.");
    emailKeys.add(template.key);
    if (!template.subject.trim() || !template.html.trim()) throw new Error(`${template.name} requires a subject and body.`);
  }

  const legalSlugs = new Set<string>();
  for (const page of site.legalPages) {
    if (!page.slug || legalSlugs.has(page.slug)) throw new Error("Legal page slugs must be unique.");
    legalSlugs.add(page.slug);
    if (!page.version.trim() || !page.content.trim()) throw new Error(`${page.title} requires a version and content.`);
  }
}
