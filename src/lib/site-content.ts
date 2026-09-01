import type {
  FooterContent,
  HeroSlide,
  HomepageContent,
  PageCoverSettings,
  SiteData,
  SiteSettings,
  WebsitePagesContent,
} from "@/types/site";

export const defaultPageCoverSettings: PageCoverSettings = {
  coverImageUrl: "",
  coverOverlayOpacity: 0.55,
  coverFocalPosition: "center",
  coverTextAlignment: "left",
};

export const defaultHomepageContent: HomepageContent = {
  showUpcomingEvents: true,
  showMedia: true,
  showReviews: true,

  upcomingEyebrow: "Next transmissions",
  upcomingTitle: "Upcoming events",
  upcomingLinkLabel: "View all events",
  emptyEventsTitle: "The next signal is being built.",
  emptyEventsBody: "Join the mailing list for the first release.",

  manifestoMarquee: "NOT ANOTHER NIGHT OUT - BUILT TO BE REMEMBERED -",
  manifestoEyebrow: "What is Skie?",
  manifestoTitle: "We build the kind of night you talk about the next morning.",
  manifestoBody:
    "High-energy nights with house-party intimacy, sharp curation and no dead space.",
  manifestoLinkLabel: "Read the manifesto",
  manifestoLinkHref: "/about",

  mediaEyebrow: "Proof of life",
  mediaTitle: "Inside previous nights",
  mediaLinkLabel: "Open media",

  reviewsEyebrow: "People said it",
  reviewsTitle: "No paid hype. Real reactions.",
  reviewsLinkLabel: "Leave a review",

  partnersEyebrow: "Partners in the room",
  partnersTitle: "Visible. Useful. Never louder than Skie.",

  finalCtaEyebrow: "THE NEXT ONE IS ALREADY MOVING.",
  finalCtaTitle: "Meet us before the lights come on.",
  finalCtaButtonLabel: "Find your event",
  finalCtaButtonHref: "/events",
};

export const defaultPagesContent: WebsitePagesContent = {
  events: {
    ...defaultPageCoverSettings,
    eyebrow: "SKIE calendar",
    title: "Choose your next room.",
    body: "Public releases, invite-only applications and everything currently open.",
    emptyState: "No public events are live yet.",
  },
  previousEvents: {
    ...defaultPageCoverSettings,
    eyebrow: "The archive",
    title: "Previous events.",
    body: "Rooms that happened once and still influence what comes next.",
    emptyState: "The archive opens after the first completed event.",
  },
  media: {
    ...defaultPageCoverSettings,
    eyebrow: "Media archive",
    title: "The flash after midnight.",
    body: "Photos, motion and fragments from inside the Skie world.",
  },
  reviews: {
    ...defaultPageCoverSettings,
    eyebrow: "Community",
    title: "Say it how it felt.",
    body: "Approved reviews from people who were actually in the room.",
    formEyebrow: "Your turn",
    formTitle: "Leave a review.",
  },
  about: {
    ...defaultPageCoverSettings,
  },
  contact: {
    ...defaultPageCoverSettings,
    eyebrow: "Contact Skie",
    title: "Bring us the right idea.",
    body: "Partnerships, artists, venues, media or something we have not thought of yet.",
    emailLabel: "Email",
    instagramLabel: "Instagram",
    instagramLinkLabel: "Open Instagram",
    basedLabel: "Based",
    basedValue: "Melbourne, VIC",
  },
};

export const defaultFooterContent: FooterContent = {
  exploreLabel: "Explore",
  eventsLabel: "Upcoming events",
  mediaLabel: "Previous nights",
  reviewsLabel: "Community reviews",
  accountLabel: "My account",
  connectLabel: "Connect",
  instagramLabel: "Instagram",
  contactLabel: "Contact the team",
  policiesLabel: "Policies",
  termsLabel: "Terms",
  privacyLabel: "Privacy",
  refundsLabel: "Refunds",
  entryLabel: "Entry",
  locationLabel: "Melbourne, Australia",
};

export const defaultSiteSettings: SiteSettings = {
  appMode: "test",
  currency: "AUD",
  timezone: "Australia/Melbourne",
  defaultTicketLimit: 2,
  defaultAllocationExpiryHours: 48,
  newsletterEnabled: true,
  featuredSponsorCarousel: false,
};

export function getHomepageContent(homepage?: Partial<HomepageContent> | null): HomepageContent {
  return {
    ...defaultHomepageContent,
    ...(homepage || {}),
  };
}

export function getPagesContent(pages?: Partial<WebsitePagesContent> | null): WebsitePagesContent {
  return {
    events: { ...defaultPagesContent.events, ...(pages?.events || {}) },
    previousEvents: { ...defaultPagesContent.previousEvents, ...(pages?.previousEvents || {}) },
    media: { ...defaultPagesContent.media, ...(pages?.media || {}) },
    reviews: { ...defaultPagesContent.reviews, ...(pages?.reviews || {}) },
    about: { ...defaultPagesContent.about, ...(pages?.about || {}) },
    contact: { ...defaultPagesContent.contact, ...(pages?.contact || {}) },
  };
}

export function getFooterContent(footer?: Partial<FooterContent> | null): FooterContent {
  return {
    ...defaultFooterContent,
    ...(footer || {}),
  };
}

export function getSiteSettings(settings?: Partial<SiteSettings> | null): SiteSettings {
  return {
    ...defaultSiteSettings,
    ...(settings || {}),
  };
}

function normalizeHeroSlides(slides: HeroSlide[], brandName: string): HeroSlide[] {
  const reservedIds = new Set(
    slides
      .map((slide) => (typeof slide?.id === "string" ? slide.id.trim() : ""))
      .filter(Boolean),
  );
  const usedIds = new Set<string>();

  return slides.map((slide, index) => {
    const value = slide as Partial<HeroSlide> | null | undefined;
    let id = typeof value?.id === "string" ? value.id.trim() : "";

    if (!id || usedIds.has(id)) {
      const baseId = `hero_slide_${index + 1}`;
      id = baseId;
      let suffix = 2;
      while (reservedIds.has(id) || usedIds.has(id)) {
        id = `${baseId}_${suffix}`;
        suffix += 1;
      }
    }
    usedIds.add(id);

    return {
      ...value,
      id,
      active: typeof value?.active === "boolean" ? value.active : false,
      kicker: typeof value?.kicker === "string" ? value.kicker : "",
      title: typeof value?.title === "string" && value.title.trim()
        ? value.title
        : brandName,
      subtitle: typeof value?.subtitle === "string" ? value.subtitle : "",
      imageUrl: typeof value?.imageUrl === "string" ? value.imageUrl : "",
      videoUrl: typeof value?.videoUrl === "string" ? value.videoUrl : undefined,
      ctaLabel: typeof value?.ctaLabel === "string" ? value.ctaLabel : "",
      ctaHref: typeof value?.ctaHref === "string" ? value.ctaHref : "",
      overlayOpacity: value?.overlayOpacity === undefined ? 0.5 : value.overlayOpacity,
      focalPosition: value?.focalPosition === undefined ? "center" : value.focalPosition,
      textAlignment: value?.textAlignment === undefined ? "left" : value.textAlignment,
    };
  });
}

export function normalizeSiteData(site: SiteData): SiteData {
  const brandName = site.brand?.name?.trim() || "SKIE EVENTS";
  const normalizedMedia = Array.isArray(site.media) ? site.media.map((item, index) => ({
    ...item,
    eventName: typeof item.eventName === "string" ? item.eventName : "Unassigned",
    caption: typeof item.caption === "string" ? item.caption : "",
    altText: typeof item.altText === "string" && item.altText.trim() ? item.altText : item.type === "image" ? item.title : "",
    posterUrl: typeof item.posterUrl === "string" ? item.posterUrl : item.thumbnailUrl,
    manualPosterUrl: typeof item.manualPosterUrl === "string" ? item.manualPosterUrl : typeof item.posterUrl === "string" ? item.posterUrl : undefined,
    generatedPosterUrl: typeof item.generatedPosterUrl === "string" ? item.generatedPosterUrl : undefined,
    fallbackPosterUrl: typeof item.fallbackPosterUrl === "string" ? item.fallbackPosterUrl : undefined,
    posterTimeSeconds: typeof item.posterTimeSeconds === "number" && item.posterTimeSeconds >= 0 ? item.posterTimeSeconds : 1,
    provider: item.provider === "mux" ? "mux" as const : "local" as const,
    processingStatus: item.type === "video" ? item.processingStatus || "ready" as const : undefined,
    captions: Array.isArray(item.captions) ? item.captions : [],
    order: Number.isInteger(item.order) ? item.order : index,
    visibility: item.published ? "published" as const : "draft" as const,
    aspectRatio: typeof item.aspectRatio === "number" && item.aspectRatio > 0
      ? item.aspectRatio
      : item.width && item.height ? item.width / item.height : 4 / 3,
  })).sort((left, right) => (left.order || 0) - (right.order || 0)) : [];
  return {
    ...site,
    homepage: getHomepageContent(site.homepage),
    pages: getPagesContent(site.pages),
    footer: getFooterContent(site.footer),
    settings: getSiteSettings(site.settings),
    heroSlides: Array.isArray(site.heroSlides)
      ? normalizeHeroSlides(site.heroSlides, brandName)
      : site.heroSlides,
    media: normalizedMedia,
  };
}
