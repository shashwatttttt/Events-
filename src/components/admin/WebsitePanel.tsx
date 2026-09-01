"use client";

import { AdminAssetUploadField } from "@/components/admin/AdminAssetUploadField";
import { defaultHomepageContent, getFooterContent, getHomepageContent, getPagesContent } from "@/lib/site-content";
import type { FooterContent, HomepageContent, PageCoverSettings, SiteData, WebsitePagesContent } from "@/types/site";

function PageCoverEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: PageCoverSettings;
  onChange: (updates: Partial<PageCoverSettings>) => void;
}) {
  return (
    <div className="nested-admin-card admin-page-cover-editor">
      <h4>{label}</h4>
      <AdminAssetUploadField
        label={`${label} cover image`}
        value={value.coverImageUrl}
        onChange={(coverImageUrl) => onChange({ coverImageUrl })}
        accept="image/*"
        helperText="Recommended landscape cover: 1920x1080 or wider."
        previewType="image"
      />
      <div className="admin-grid-three">
        <label className="admin-field">
          <span>Overlay opacity</span>
          <input
            type="number"
            min="0"
            max="0.9"
            step="0.05"
            value={value.coverOverlayOpacity}
            onChange={(event) => onChange({ coverOverlayOpacity: Number(event.target.value) })}
          />
        </label>
        <label className="admin-field">
          <span>Focal position</span>
          <select
            value={value.coverFocalPosition}
            onChange={(event) => onChange({ coverFocalPosition: event.target.value as PageCoverSettings["coverFocalPosition"] })}
          >
            <option value="center">Center</option>
            <option value="top">Top</option>
            <option value="bottom">Bottom</option>
            <option value="left">Left</option>
            <option value="right">Right</option>
          </select>
        </label>
        <label className="admin-field">
          <span>Text alignment</span>
          <select
            value={value.coverTextAlignment}
            onChange={(event) => onChange({ coverTextAlignment: event.target.value as PageCoverSettings["coverTextAlignment"] })}
          >
            <option value="left">Left</option>
            <option value="center">Center</option>
          </select>
        </label>
      </div>
    </div>
  );
}

export function WebsitePanel({
  site,
  setSite,
}: {
  site: SiteData;
  setSite: (site: SiteData) => void;
}) {
  const homepage = getHomepageContent(site.homepage);
  const pages = getPagesContent(site.pages);
  const footer = getFooterContent(site.footer);

  function updateHomepage<K extends keyof HomepageContent>(key: K, value: HomepageContent[K]) {
    setSite({
      ...site,
      homepage: {
        ...defaultHomepageContent,
        ...homepage,
        [key]: value,
      },
    });
  }

  function updatePage<Page extends keyof WebsitePagesContent>(
    page: Page,
    updates: Partial<WebsitePagesContent[Page]>,
  ) {
    const nextPages = getPagesContent(site.pages);

    setSite({
      ...site,
      pages: {
        ...nextPages,
        [page]: {
          ...nextPages[page],
          ...updates,
        },
      },
    });
  }

  function updateFooter<K extends keyof FooterContent>(key: K, value: FooterContent[K]) {
    setSite({
      ...site,
      footer: {
        ...footer,
        [key]: value,
      },
    });
  }

  return (
    <section className="admin-section admin-stack">
      <div className="admin-section-title">
        <div>
          <h2>Website content</h2>
          <p>Edit homepage wording, hero slides, About copy and legal pages from one place.</p>
        </div>
      </div>

      <div className="admin-card">
        <h3>Homepage sections</h3>
        <p className="admin-field-note">
          Empty-event wording is shown only when there are no public upcoming events.
        </p>

        <div className="toggle-row admin-section-visibility">
          <label><input type="checkbox" checked={homepage.showUpcomingEvents} onChange={(event) => updateHomepage("showUpcomingEvents", event.target.checked)} /> Show upcoming events</label>
          <label><input type="checkbox" checked={homepage.showMedia} onChange={(event) => updateHomepage("showMedia", event.target.checked)} /> Show media</label>
          <label><input type="checkbox" checked={homepage.showReviews} onChange={(event) => updateHomepage("showReviews", event.target.checked)} /> Show reviews</label>
          <label>
            <input
              type="checkbox"
              checked={site.settings.featuredSponsorCarousel}
              onChange={(event) => setSite({
                ...site,
                settings: { ...site.settings, featuredSponsorCarousel: event.target.checked },
              })}
            />{" "}
            Show sponsors
          </label>
        </div>

        <div className="admin-grid-two">
          <label className="admin-field">
            <span>Upcoming events eyebrow</span>
            <input
              value={homepage.upcomingEyebrow}
              onChange={(event) => updateHomepage("upcomingEyebrow", event.target.value)}
            />
          </label>

          <label className="admin-field">
            <span>Upcoming events title</span>
            <input
              value={homepage.upcomingTitle}
              onChange={(event) => updateHomepage("upcomingTitle", event.target.value)}
            />
          </label>

          <label className="admin-field">
            <span>Upcoming events link label</span>
            <input
              value={homepage.upcomingLinkLabel}
              onChange={(event) => updateHomepage("upcomingLinkLabel", event.target.value)}
            />
          </label>

          <label className="admin-field">
            <span>Empty events title</span>
            <input
              value={homepage.emptyEventsTitle}
              onChange={(event) => updateHomepage("emptyEventsTitle", event.target.value)}
            />
          </label>
        </div>

        <label className="admin-field">
          <span>Empty events body</span>
          <textarea
            rows={3}
            value={homepage.emptyEventsBody}
            onChange={(event) => updateHomepage("emptyEventsBody", event.target.value)}
          />
        </label>
      </div>

      <div className="admin-card">
        <h3>Homepage manifesto / What is Skie section</h3>

        <label className="admin-field">
          <span>Moving marquee text</span>
          <input
            value={homepage.manifestoMarquee}
            onChange={(event) => updateHomepage("manifestoMarquee", event.target.value)}
          />
        </label>

        <label className="admin-field">
          <span>Eyebrow</span>
          <input
            value={homepage.manifestoEyebrow}
            onChange={(event) => updateHomepage("manifestoEyebrow", event.target.value)}
          />
        </label>

        <label className="admin-field">
          <span>Title</span>
          <textarea
            rows={3}
            value={homepage.manifestoTitle}
            onChange={(event) => updateHomepage("manifestoTitle", event.target.value)}
          />
        </label>

        <label className="admin-field">
          <span>Body</span>
          <textarea
            rows={5}
            value={homepage.manifestoBody}
            onChange={(event) => updateHomepage("manifestoBody", event.target.value)}
          />
        </label>

        <div className="admin-grid-two">
          <label className="admin-field">
            <span>Button label</span>
            <input
              value={homepage.manifestoLinkLabel}
              onChange={(event) => updateHomepage("manifestoLinkLabel", event.target.value)}
            />
          </label>

          <label className="admin-field">
            <span>Button link</span>
            <input
              value={homepage.manifestoLinkHref}
              onChange={(event) => updateHomepage("manifestoLinkHref", event.target.value)}
            />
          </label>
        </div>
      </div>

      <div className="admin-card">
        <h3>Homepage media, reviews and partners</h3>
        <p className="admin-field-note">
          Partner wording is shown when the homepage sponsor feature is enabled in Settings.
        </p>

        <div className="admin-grid-two">
          <label className="admin-field">
            <span>Media eyebrow</span>
            <input
              value={homepage.mediaEyebrow}
              onChange={(event) => updateHomepage("mediaEyebrow", event.target.value)}
            />
          </label>

          <label className="admin-field">
            <span>Media title</span>
            <input
              value={homepage.mediaTitle}
              onChange={(event) => updateHomepage("mediaTitle", event.target.value)}
            />
          </label>

          <label className="admin-field">
            <span>Media link label</span>
            <input
              value={homepage.mediaLinkLabel}
              onChange={(event) => updateHomepage("mediaLinkLabel", event.target.value)}
            />
          </label>

          <label className="admin-field">
            <span>Reviews eyebrow</span>
            <input
              value={homepage.reviewsEyebrow}
              onChange={(event) => updateHomepage("reviewsEyebrow", event.target.value)}
            />
          </label>

          <label className="admin-field">
            <span>Reviews title</span>
            <input
              value={homepage.reviewsTitle}
              onChange={(event) => updateHomepage("reviewsTitle", event.target.value)}
            />
          </label>

          <label className="admin-field">
            <span>Reviews link label</span>
            <input
              value={homepage.reviewsLinkLabel}
              onChange={(event) => updateHomepage("reviewsLinkLabel", event.target.value)}
            />
          </label>

          <label className="admin-field">
            <span>Partners eyebrow</span>
            <input
              value={homepage.partnersEyebrow}
              onChange={(event) => updateHomepage("partnersEyebrow", event.target.value)}
            />
          </label>

          <label className="admin-field">
            <span>Partners title</span>
            <input
              value={homepage.partnersTitle}
              onChange={(event) => updateHomepage("partnersTitle", event.target.value)}
            />
          </label>
        </div>
      </div>

      <div className="admin-card">
        <h3>Homepage final call to action</h3>

        <label className="admin-field">
          <span>Eyebrow</span>
          <input
            value={homepage.finalCtaEyebrow}
            onChange={(event) => updateHomepage("finalCtaEyebrow", event.target.value)}
          />
        </label>

        <label className="admin-field">
          <span>Title</span>
          <textarea
            rows={3}
            value={homepage.finalCtaTitle}
            onChange={(event) => updateHomepage("finalCtaTitle", event.target.value)}
          />
        </label>

        <div className="admin-grid-two">
          <label className="admin-field">
            <span>Button label</span>
            <input
              value={homepage.finalCtaButtonLabel}
              onChange={(event) => updateHomepage("finalCtaButtonLabel", event.target.value)}
            />
          </label>

          <label className="admin-field">
            <span>Button link</span>
            <input
              value={homepage.finalCtaButtonHref}
              onChange={(event) => updateHomepage("finalCtaButtonHref", event.target.value)}
            />
          </label>
        </div>
      </div>

      <div className="admin-card">
        <h3>Public page hero copy</h3>

        <div className="admin-grid-two">
          <label className="admin-field">
            <span>Events eyebrow</span>
            <input
              value={pages.events.eyebrow}
              onChange={(event) => updatePage("events", { eyebrow: event.target.value })}
            />
          </label>

          <label className="admin-field">
            <span>Events title</span>
            <input
              value={pages.events.title}
              onChange={(event) => updatePage("events", { title: event.target.value })}
            />
          </label>
        </div>

        <label className="admin-field">
          <span>Events body</span>
          <textarea
            rows={3}
            value={pages.events.body}
            onChange={(event) => updatePage("events", { body: event.target.value })}
          />
        </label>

        <label className="admin-field">
          <span>Events empty state</span>
          <input
            value={pages.events.emptyState}
            onChange={(event) => updatePage("events", { emptyState: event.target.value })}
          />
        </label>

        <div className="admin-grid-two">
          <label className="admin-field">
            <span>Previous Events eyebrow</span>
            <input
              value={pages.previousEvents.eyebrow}
              onChange={(event) => updatePage("previousEvents", { eyebrow: event.target.value })}
            />
          </label>

          <label className="admin-field">
            <span>Previous Events title</span>
            <input
              value={pages.previousEvents.title}
              onChange={(event) => updatePage("previousEvents", { title: event.target.value })}
            />
          </label>
        </div>

        <label className="admin-field">
          <span>Previous Events body</span>
          <textarea
            rows={3}
            value={pages.previousEvents.body}
            onChange={(event) => updatePage("previousEvents", { body: event.target.value })}
          />
        </label>

        <label className="admin-field">
          <span>Previous Events empty state</span>
          <input
            value={pages.previousEvents.emptyState}
            onChange={(event) => updatePage("previousEvents", { emptyState: event.target.value })}
          />
        </label>

        <div className="admin-grid-two">
          <label className="admin-field">
            <span>Media eyebrow</span>
            <input
              value={pages.media.eyebrow}
              onChange={(event) => updatePage("media", { eyebrow: event.target.value })}
            />
          </label>

          <label className="admin-field">
            <span>Media title</span>
            <input
              value={pages.media.title}
              onChange={(event) => updatePage("media", { title: event.target.value })}
            />
          </label>
        </div>

        <label className="admin-field">
          <span>Media body</span>
          <textarea
            rows={3}
            value={pages.media.body}
            onChange={(event) => updatePage("media", { body: event.target.value })}
          />
        </label>

        <div className="admin-grid-two">
          <label className="admin-field">
            <span>Reviews eyebrow</span>
            <input
              value={pages.reviews.eyebrow}
              onChange={(event) => updatePage("reviews", { eyebrow: event.target.value })}
            />
          </label>

          <label className="admin-field">
            <span>Reviews title</span>
            <input
              value={pages.reviews.title}
              onChange={(event) => updatePage("reviews", { title: event.target.value })}
            />
          </label>
        </div>

        <label className="admin-field">
          <span>Reviews body</span>
          <textarea
            rows={3}
            value={pages.reviews.body}
            onChange={(event) => updatePage("reviews", { body: event.target.value })}
          />
        </label>

        <div className="admin-grid-two">
          <label className="admin-field">
            <span>Reviews form eyebrow</span>
            <input
              value={pages.reviews.formEyebrow}
              onChange={(event) => updatePage("reviews", { formEyebrow: event.target.value })}
            />
          </label>

          <label className="admin-field">
            <span>Reviews form title</span>
            <input
              value={pages.reviews.formTitle}
              onChange={(event) => updatePage("reviews", { formTitle: event.target.value })}
            />
          </label>
        </div>

        <div className="admin-grid-two">
          <label className="admin-field">
            <span>Contact eyebrow</span>
            <input
              value={pages.contact.eyebrow}
              onChange={(event) => updatePage("contact", { eyebrow: event.target.value })}
            />
          </label>

          <label className="admin-field">
            <span>Contact title</span>
            <input
              value={pages.contact.title}
              onChange={(event) => updatePage("contact", { title: event.target.value })}
            />
          </label>
        </div>

        <label className="admin-field">
          <span>Contact body</span>
          <textarea
            rows={3}
            value={pages.contact.body}
            onChange={(event) => updatePage("contact", { body: event.target.value })}
          />
        </label>
      </div>

      <div className="admin-card">
        <h3>Public page cover images</h3>
        <p className="admin-field-note">
          Uploaded covers replace the generated page-header artwork. Clearing a cover restores the SKIE fallback.
        </p>
        <div className="admin-page-cover-grid">
          <PageCoverEditor label="Events" value={pages.events} onChange={(updates) => updatePage("events", updates)} />
          <PageCoverEditor label="Previous Events" value={pages.previousEvents} onChange={(updates) => updatePage("previousEvents", updates)} />
          <PageCoverEditor label="Media" value={pages.media} onChange={(updates) => updatePage("media", updates)} />
          <PageCoverEditor label="Reviews" value={pages.reviews} onChange={(updates) => updatePage("reviews", updates)} />
          <PageCoverEditor label="About" value={pages.about} onChange={(updates) => updatePage("about", updates)} />
          <PageCoverEditor label="Contact" value={pages.contact} onChange={(updates) => updatePage("contact", updates)} />
        </div>
      </div>

      <div className="admin-card">
        <h3>Contact page details</h3>

        <div className="admin-grid-two">
          <label className="admin-field">
            <span>Email label</span>
            <input
              value={pages.contact.emailLabel}
              onChange={(event) => updatePage("contact", { emailLabel: event.target.value })}
            />
          </label>

          <label className="admin-field">
            <span>Instagram label</span>
            <input
              value={pages.contact.instagramLabel}
              onChange={(event) => updatePage("contact", { instagramLabel: event.target.value })}
            />
          </label>

          <label className="admin-field">
            <span>Instagram link label</span>
            <input
              value={pages.contact.instagramLinkLabel}
              onChange={(event) => updatePage("contact", { instagramLinkLabel: event.target.value })}
            />
          </label>

          <label className="admin-field">
            <span>Based label</span>
            <input
              value={pages.contact.basedLabel}
              onChange={(event) => updatePage("contact", { basedLabel: event.target.value })}
            />
          </label>
        </div>

        <label className="admin-field">
          <span>Based value</span>
          <input
            value={pages.contact.basedValue}
            onChange={(event) => updatePage("contact", { basedValue: event.target.value })}
          />
        </label>
      </div>

      <div className="admin-card">
        <h3>Footer labels</h3>

        <div className="admin-grid-two">
          <label className="admin-field">
            <span>Explore heading</span>
            <input
              value={footer.exploreLabel}
              onChange={(event) => updateFooter("exploreLabel", event.target.value)}
            />
          </label>

          <label className="admin-field">
            <span>Events link</span>
            <input
              value={footer.eventsLabel}
              onChange={(event) => updateFooter("eventsLabel", event.target.value)}
            />
          </label>

          <label className="admin-field">
            <span>Media link</span>
            <input
              value={footer.mediaLabel}
              onChange={(event) => updateFooter("mediaLabel", event.target.value)}
            />
          </label>

          <label className="admin-field">
            <span>Reviews link</span>
            <input
              value={footer.reviewsLabel}
              onChange={(event) => updateFooter("reviewsLabel", event.target.value)}
            />
          </label>

          <label className="admin-field">
            <span>Account link</span>
            <input
              value={footer.accountLabel}
              onChange={(event) => updateFooter("accountLabel", event.target.value)}
            />
          </label>

          <label className="admin-field">
            <span>Connect heading</span>
            <input
              value={footer.connectLabel}
              onChange={(event) => updateFooter("connectLabel", event.target.value)}
            />
          </label>

          <label className="admin-field">
            <span>Instagram link</span>
            <input
              value={footer.instagramLabel}
              onChange={(event) => updateFooter("instagramLabel", event.target.value)}
            />
          </label>

          <label className="admin-field">
            <span>Contact link</span>
            <input
              value={footer.contactLabel}
              onChange={(event) => updateFooter("contactLabel", event.target.value)}
            />
          </label>

          <label className="admin-field">
            <span>Policies heading</span>
            <input
              value={footer.policiesLabel}
              onChange={(event) => updateFooter("policiesLabel", event.target.value)}
            />
          </label>

          <label className="admin-field">
            <span>Terms link</span>
            <input
              value={footer.termsLabel}
              onChange={(event) => updateFooter("termsLabel", event.target.value)}
            />
          </label>

          <label className="admin-field">
            <span>Privacy link</span>
            <input
              value={footer.privacyLabel}
              onChange={(event) => updateFooter("privacyLabel", event.target.value)}
            />
          </label>

          <label className="admin-field">
            <span>Refunds link</span>
            <input
              value={footer.refundsLabel}
              onChange={(event) => updateFooter("refundsLabel", event.target.value)}
            />
          </label>

          <label className="admin-field">
            <span>Entry link</span>
            <input
              value={footer.entryLabel}
              onChange={(event) => updateFooter("entryLabel", event.target.value)}
            />
          </label>

          <label className="admin-field">
            <span>Footer location</span>
            <input
              value={footer.locationLabel}
              onChange={(event) => updateFooter("locationLabel", event.target.value)}
            />
          </label>
        </div>
      </div>
      <div className="admin-grid-two">
        {site.heroSlides.map((slide) => (
          <article className="admin-card" key={slide.id}>
            <div className="admin-card-head">
              <strong>Hero slide</strong>
              <label>
                <input
                  type="checkbox"
                  checked={slide.active}
                  onChange={(event) =>
                    setSite({
                      ...site,
                      heroSlides: site.heroSlides.map((item) =>
                        item.id === slide.id ? { ...item, active: event.target.checked } : item,
                      ),
                    })
                  }
                />{" "}
                Active
              </label>
            </div>

            <label className="admin-field">
              <span>Kicker</span>
              <input
                value={slide.kicker}
                onChange={(event) =>
                  setSite({
                    ...site,
                    heroSlides: site.heroSlides.map((item) =>
                      item.id === slide.id ? { ...item, kicker: event.target.value } : item,
                    ),
                  })
                }
              />
            </label>

            <label className="admin-field">
              <span>Title</span>
              <textarea
                value={slide.title}
                onChange={(event) =>
                  setSite({
                    ...site,
                    heroSlides: site.heroSlides.map((item) =>
                      item.id === slide.id ? { ...item, title: event.target.value } : item,
                    ),
                  })
                }
              />
            </label>

            <label className="admin-field">
              <span>Subtitle</span>
              <textarea
                value={slide.subtitle}
                onChange={(event) =>
                  setSite({
                    ...site,
                    heroSlides: site.heroSlides.map((item) =>
                      item.id === slide.id ? { ...item, subtitle: event.target.value } : item,
                    ),
                  })
                }
              />
            </label>

            <AdminAssetUploadField
              label="Hero cover image"
              value={slide.imageUrl}
              onChange={(value) =>
                setSite({
                  ...site,
                  heroSlides: site.heroSlides.map((item) =>
                    item.id === slide.id ? { ...item, imageUrl: value } : item,
                  ),
                })
              }
              accept="image/*"
              helperText="Recommended hero cover: 1920x1080 or 2400x1350."
              previewType="image"
            />
            <div className="admin-grid-three">
              <label className="admin-field">
                <span>Overlay opacity</span>
                <input
                  type="number"
                  min="0"
                  max="0.9"
                  step="0.05"
                  value={slide.overlayOpacity ?? 0.5}
                  onChange={(event) =>
                    setSite({
                      ...site,
                      heroSlides: site.heroSlides.map((item) =>
                        item.id === slide.id ? { ...item, overlayOpacity: Number(event.target.value) } : item,
                      ),
                    })
                  }
                />
              </label>
              <label className="admin-field">
                <span>Focal position</span>
                <select
                  value={slide.focalPosition ?? "center"}
                  onChange={(event) =>
                    setSite({
                      ...site,
                      heroSlides: site.heroSlides.map((item) =>
                        item.id === slide.id ? { ...item, focalPosition: event.target.value as NonNullable<typeof item.focalPosition> } : item,
                      ),
                    })
                  }
                >
                  <option value="center">Center</option>
                  <option value="top">Top</option>
                  <option value="bottom">Bottom</option>
                  <option value="left">Left</option>
                  <option value="right">Right</option>
                </select>
              </label>
              <label className="admin-field">
                <span>Text alignment</span>
                <select
                  value={slide.textAlignment ?? "left"}
                  onChange={(event) =>
                    setSite({
                      ...site,
                      heroSlides: site.heroSlides.map((item) =>
                        item.id === slide.id ? { ...item, textAlignment: event.target.value as NonNullable<typeof item.textAlignment> } : item,
                      ),
                    })
                  }
                >
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                </select>
              </label>
            </div>
          </article>
        ))}
      </div>

      <div className="admin-card">
        <h3>About page</h3>

        <label className="admin-field">
          <span>Title</span>
          <input
            value={site.about.title}
            onChange={(event) =>
              setSite({
                ...site,
                about: { ...site.about, title: event.target.value },
              })
            }
          />
        </label>

        <label className="admin-field">
          <span>Paragraphs - one per line</span>
          <textarea
            rows={8}
            value={site.about.body.join("\n")}
            onChange={(event) =>
              setSite({
                ...site,
                about: {
                  ...site.about,
                  body: event.target.value.split("\n").filter(Boolean),
                },
              })
            }
          />
        </label>
      </div>

      <div className="admin-grid-two">
        {site.legalPages.map((page) => (
          <article className="admin-card" key={page.id}>
            <div className="admin-card-head">
              <strong>{page.title}</strong>
              <span>v{page.version}</span>
            </div>

            <label className="admin-field">
              <span>Version</span>
              <input
                value={page.version}
                onChange={(event) =>
                  setSite({
                    ...site,
                    legalPages: site.legalPages.map((item) =>
                      item.id === page.id ? { ...item, version: event.target.value } : item,
                    ),
                  })
                }
              />
            </label>

            <label className="admin-field">
              <span>Content</span>
              <textarea
                rows={8}
                value={page.content}
                onChange={(event) =>
                  setSite({
                    ...site,
                    legalPages: site.legalPages.map((item) =>
                      item.id === page.id
                        ? {
                            ...item,
                            content: event.target.value,
                            publishedAt: new Date().toISOString(),
                          }
                        : item,
                    ),
                  })
                }
              />
            </label>
          </article>
        ))}
      </div>
    </section>
  );
}
