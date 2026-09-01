# SKIE EVENTS Accessibility Evaluation Report

Date: 22 July 2026

Target: WCAG 2.2 Level AA

Evaluation type: Internal engineering remediation and conformance-oriented evidence

## Important qualification

This report is not an independent accessibility certification and is not a third-party certification. No external accessibility certification was performed. It records the remediation implemented in this repository, the automated checks run locally, the source and rendered-semantic checks completed, and the remaining manual evaluation work.

## Scope reviewed

- Public layout, header, navigation, footer and page-title behavior.
- Homepage carousel and motion behavior.
- Events listing and event details.
- Login, signup and application forms.
- Checkout, test checkout and payment-status flows.
- Customer account and ticket detail, including QR alternatives.
- Media grid, adaptive video controls, caption metadata and unavailable-media fallbacks.
- Door scanner, manual attendee search, scan results and entitlement controls.
- Hidden admin login, dashboard navigation, operational status messages and sensitive confirmation flows.
- Responsive and focus styles in the shared design system.

The review did not include authenticated end-to-end interaction with real provider accounts, production data, real payment instruments, live camera permission, or external assistive-technology certification.

## Remediation implemented

### Structure and navigation

- Added public, admin-login, admin-dashboard and door-flow skip links with focusable main targets.
- Added an explicit accessible name to the primary navigation and `aria-current="page"` to active public navigation links.
- Added meaningful metadata titles to events, previous events, authentication, account, checkout, payment, ticket, admin-login and door routes; event detail titles are generated from event data.
- Added admin section announcements and focus movement to the newly selected admin heading.

### Keyboard and focus

- Added a consistent high-contrast `:focus-visible` treatment.
- Added Escape handling and focus restoration for the mobile navigation.
- Replaced admin browser confirm/prompt calls with a labelled modal dialog that traps Tab/Shift+Tab, closes with Escape, starts focus on a safe control and restores focus to the invoking control.
- Added 44 CSS-pixel minimum heights to primary controls and 24 CSS-pixel checkbox/radio targets.

### Forms and status

- Added `aria-busy` and explicit error/status associations to authentication, application and checkout flows.
- Added required-field guidance to application forms.
- Added alert semantics to checkout, authentication, application and scanner failures.
- Added polite or assertive live regions to totals, payment state, scan results and administrative operation status.

### Ticketing, scanner and media

- Added an explicit text equivalent for every ticket QR code while retaining the visible ticket code and full ticket details.
- Added non-colour scan-result text and assertive announcements for valid, duplicate, wrong-event and invalid outcomes.
- Added manual scan instructions and preserved labelled, keyboard-operable controls with large touch targets.
- Expanded video-player accessible names to identify controls and caption availability.
- Added descriptive unavailable-video fallback text and polite status announcements.
- Preserved native video controls and caption/subtitle `<track>` metadata.
- Added a user-controlled pause/play action to the featured carousel and disabled automatic rotation when reduced motion is requested.

### Visual access

- Changed normal text on `#5170FF` surfaces to `#050505`; the measured contrast is approximately 4.96:1.
- Preserved `#5170FF` on `#050505`, also approximately 4.96:1.
- Confirmed the shared muted colour `#9B9BA4` on `#050505` is approximately 7.39:1.
- Raised low-contrast secondary labels on dark cards to `#85858F`.
- Added an accessible-accent guard: administrator-supplied accents that do not reach 4.5:1 against the core dark background fall back to `#5170FF`.
- Preserved narrow-viewport reflow rules, overflow containment, responsive tables/cards, stable media ratios and reduced-motion overrides.

## Automated PASS

- `npm run test:accessibility`: 1 test file, 8 tests passed.
- Automated contracts cover skip targets, labelled navigation, Escape/focus restoration source contracts, carousel pause/reduced motion, checkout totals, scanner announcements, video controls/captions/fallbacks, modal focus trap/restoration, core contrast ratios, accent fallback and meaningful titles.
- `npm run test:browser`: local headless Edge checks passed for rendered skip links, main landmark target, labelled navigation, meaningful page titles, reduced-motion-safe carousel control, protected-route behavior and payment live-region markup.
- `npm run verify`: lint, TypeScript and the Next.js production build passed.
- `npm test`: full Vitest regression passed after accessibility updates.
- `npm run test:database`: full local database migration/security suite passed; no schema change was introduced by Phase 6.
- `git diff --check`: passed; Git emitted only existing line-ending conversion notices.

Axe and Lighthouse were not run because neither axe nor Lighthouse is installed in this project, and the available environment did not expose an interactive browser automation connection. Heavy browser dependencies were not added solely to manufacture a score. This limitation is explicit and is not represented as a pass.

## Manually checked PASS

These are source-oriented and rendered-semantic checks, not assistive-technology certification:

- Landmark and heading hierarchy inspected across representative public, customer, admin and door routes.
- Native form labels, required attributes, descriptions and error/status associations inspected.
- Confirmation-dialog accessible name, description, modal state, Escape handling, focus loop and focus-restoration logic inspected.
- Active navigation state uses text plus `aria-current`; ticket, notification and scan states include visible words and do not depend on colour alone.
- Meaningful images use supplied alt text or descriptive titles; decorative overlays/posters in fallback status blocks use empty alt text or are non-semantic CSS layers.
- Ticket pages remain understandable from holder, date, time, venue and ticket-code text without reading the QR image.
- Caption metadata and native video-control markup inspected in rendered component output.
- Core brand contrast combinations were calculated using the WCAG relative-luminance formula.
- Source-level narrow-width/reflow and 200%-zoom risk inspection found responsive wrapping, bounded widths and horizontal containment for the reviewed flows.

## Keyboard checks performed

- Source-level Tab order was checked to ensure native links, buttons, inputs, selects, summaries and video controls remain in DOM order.
- Skip targets are focusable and appear before the repeated navigation.
- Mobile navigation supports Escape and returns focus to its toggle.
- Admin dialogs define Tab and Shift+Tab containment, Escape cancellation, initial safe focus and invoker focus restoration.
- Carousel previous, pause/play and next actions are native buttons with accessible names.

Direct physical keyboard traversal in a visible browser was not available in this execution environment and remains listed below for manual verification.

## Screen-reader-oriented semantic checks

- One primary public `main` target is provided by the site layout; protected standalone admin and door routes expose their own main landmarks.
- Navigation landmarks have accessible names.
- Route titles identify the current workflow.
- Form failures use `role="alert"`; ongoing and completed state updates use appropriate live regions.
- Scanner outcomes use visible status text plus `aria-live="assertive"` and `aria-atomic="true"`.
- Ticket QR imagery has descriptive alt text and a separate text-code equivalent.
- Video exposes native controls, an accessible name, caption tracks and textual fallback status.

## Not yet manually verified

- Full keyboard-only traversal on desktop and mobile, including every authenticated admin tab and every dialog invocation.
- NVDA with Edge/Chrome, JAWS, VoiceOver on Safari, and TalkBack behavior.
- Real focus appearance under Windows High Contrast/forced-colours modes.
- Browser zoom at 200% and text-only zoom across every route using production-like content lengths.
- Reflow at 320 CSS pixels across authenticated checkout, account, admin tables and the live camera widget.
- Live camera permission, camera chooser and third-party `html5-qrcode` controls with keyboard and screen reader.
- Native HLS/video-control behavior, caption selection and transcript quality across target browsers.
- Caption accuracy, timing and completeness for each final launch video; the implementation only validates and exposes caption metadata.
- Accessibility of Stripe-hosted checkout and other provider-hosted interfaces, which remains the responsibility of those providers and launch QA.

## Remaining findings

### P0 launch blockers

- None found by the completed automated and source-oriented checks.

### P1 serious blockers

- None found by the completed automated and source-oriented checks.

### P2 limitations

- Complete the not-yet-manually-verified keyboard, screen-reader, 200% zoom, 320px reflow, camera and cross-browser video checks before ticket release.
- Validate every production caption file for accuracy and synchronization and provide transcripts where the final editorial content requires them.
- Recheck contrast when brand artwork, event imagery or administrator-managed content changes, even though the shared accent is guarded.

### P3 recommendations

- Add axe and Lighthouse CI when a maintained browser test runtime is approved for the repository.
- Add Windows forced-colours snapshots or assertions when the project adopts a browser automation dependency.
- Maintain a short, repeatable assistive-technology smoke checklist for each release candidate.

## Conformance statement

The repository now contains WCAG 2.2 AA-focused engineering remediation and local evaluation evidence. The evidence supports the automated and source-oriented results described above; it does not establish full conformance for every content state, browser, assistive technology or external provider. No independent or third-party accessibility certification was performed.
