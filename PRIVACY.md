# OurALERT Privacy Policy

_Last updated: April 10, 2026_

OurALERT ("we", "us", "the platform") is operated by Penny Tribune, an independent digital news organization, at [ouralert.org](https://ouralert.org). This policy describes what information we collect, why, how long we keep it, and your rights.

**Plain English summary:** We do not want to know who you are. We do not use cookies. We do not track you across sessions. We do not share data with advertisers, data brokers, or any third-party analytics providers. We built our own analytics from scratch so we would never have to.

## 1. What we collect

### 1.1 When you submit a report

When you submit a report through the anonymous report form, we collect:

- **The report content you provide:** location (address or coordinates), description, category, vehicle and official counts, optional arrestee name (with your explicit consent), and any photos or videos you upload.
- **A hashed, salted fingerprint of your IP address:** used solely for rate-limiting to prevent spam and abuse. The raw IP is never written to disk. The hash is deleted after 7 days.
- **A Cloudflare Turnstile token:** a one-time, single-use bot verification token that expires within 5 minutes. We do not receive any user data from Turnstile beyond the verification result.
- **A randomly-generated session ID:** stored in your browser's `sessionStorage` and cleared when you close the tab. Used only to avoid counting the same person twice in the same visit. Not linked to any identity.

### 1.2 When you browse the site

When you visit OurALERT, we collect first-party, aggregated analytics events:

- **Page path** (e.g. `/`, `/r/abc123`, `/rights`)
- **Event name** (e.g. `page_view`, `report_viewed`, `filter_changed`)
- **Device class** (mobile / tablet / desktop), derived from your browser's user-agent string at the moment of the request. We do not store the user-agent itself.
- **Country code** (e.g. `US`, `CA`), derived from Cloudflare's network location data at the moment of the request. We do not store city or precise location. Country is only aggregated into daily rollups — never written alongside individual events.
- **Referrer domain** if you arrived from another site (e.g. `google.com`, `twitter.com`) — the domain only, never the full URL.
- **UTM campaign parameters** if present in the URL you arrived at.

We do **not** collect:
- IP addresses (except hashed, for rate limiting)
- User agents beyond the derived device class
- Operating system identifiers
- Browser fingerprints
- Cookies of any kind
- Cross-session identifiers
- Your name, email, or phone number unless you explicitly provide them when subscribing to alerts

### 1.3 When you subscribe to email alerts or the AlertIQ digest

If you voluntarily subscribe to email alerts or the daily AlertIQ digest, we collect:

- **Your email address**
- **The zip code(s) and radius** you want to monitor
- **Your preferred delivery time** for the daily digest
- **An unsubscribe token** used for one-click unsubscribe

We use a double opt-in flow: you must click a verification link before we send you anything. Unsubscribing is one click and permanently deletes your subscription.

### 1.4 When you volunteer

If you are approved as a volunteer moderator, we collect:

- **Your email address and hashed password** (PBKDF2 with 100,000 iterations)
- **Two-factor email verification codes** (6-digit, 10-minute expiry, rate-limited)
- **A server-side session token** stored in your browser's `localStorage` (not a cookie). This token is invalidated on logout.
- **An action log** of moderation decisions you make (approve, reject, flag, comment), linked to your volunteer ID. This is for accountability and cannot be disabled.

## 2. How we store and protect it

- **Database:** Cloudflare D1 (SQLite at the edge, US region)
- **Media files:** Cloudflare R2 (US region), with EXIF metadata — including GPS coordinates — stripped server-side before storage
- **Cache:** Cloudflare KV (edge-distributed, used for rate limits, zip geocoding cache, and the 5-minute analytics hot buffer)
- **Secrets:** All API keys, salts, and credentials are stored as Cloudflare Worker secrets, encrypted at rest, and never exposed to the client

## 3. How we use it

- **Report data** is shown on the public map after a volunteer moderator reviews and approves it. All reports are marked "Alleged Sighting — Not Confirmed" until independently verified. Unapproved reports are only visible to moderators.
- **Analytics events** are used to build aggregated daily rollups that power our internal dashboard. Raw events are deleted after 30 days. Rollups contain no user-identifiable information and are kept indefinitely for historical trend analysis.
- **Email addresses** (for alerts and digests) are used only to send the specific emails you subscribed to. We never send you anything else, and we never share your address.
- **Volunteer credentials** are used only to authenticate you into the moderation portal.
- **Hashed IPs** are used only to rate-limit report submissions and prevent spam. They are deleted after 7 days.

## 4. What we do not do

- We do not use Google Analytics, PostHog, Mixpanel, Amplitude, Segment, Fullstory, or any other third-party analytics provider
- We do not use Jetpack Stats, WordPress.com tracking, or any WordPress plugin telemetry
- We do not use Facebook Pixel, Google Ads Conversion, TikTok Pixel, or any advertising tracker
- We do not set cookies for any purpose, including "functional" or "essential" cookies
- We do not sell data to anyone
- We do not share data with law enforcement except in response to a valid court order, which we will publish on a transparency page as permitted by law
- We do not retain raw IP addresses
- We do not store user agent strings
- We do not fingerprint devices

## 5. Third-party services we do use

These services receive information to provide their specific function. We have selected each based on their privacy practices:

| Service | What they receive | Why |
|---|---|---|
| **Cloudflare** | All HTTP requests (they are our host and CDN) | Infrastructure |
| **Cloudflare Turnstile** | Bot verification signals from your browser | Spam prevention on the report form and volunteer login |
| **OpenStreetMap / Nominatim** | The address string you type when searching the map | Geocoding addresses to map coordinates |
| **Amazon SES or Loops.so** | Your email address, if you subscribed to alerts | Delivering email alerts and the AlertIQ digest |
| **OneSignal** | An anonymous browser push subscription ID, if you opt into push notifications | Delivering web push notifications. No email or identity is shared with OneSignal. |
| **Featherless.ai** | Aggregated report summaries (no PII) | Generating the AlertIQ daily digest |

## 6. Your rights

Because we collect almost no personally identifiable information, most traditional data-subject rights (access, deletion, portability) are automatically satisfied: there is nothing personal to access, delete, or port. However:

- **Takedown of a report:** If a report concerns you or your property and you want it removed, email `takedown@ouralert.org`. We review takedown requests within 72 hours.
- **Unsubscribe from alerts or digests:** Every email contains a one-click unsubscribe link. Clicking it permanently deletes your subscription.
- **Volunteer account deletion:** Email `hello@ouralert.org` from your registered volunteer email and we will delete your account and personally-identifiable records within 7 days. Moderation action logs are retained in anonymized form for accountability.
- **Data inquiries:** Email `hello@ouralert.org`.

## 7. Children

OurALERT is not directed at children under 13. We do not knowingly collect information from children. If you believe a child has submitted a report or subscribed to an alert, email `hello@ouralert.org` and we will remove the associated data.

## 8. Changes to this policy

If we update this policy in a material way, we will post the change at the top of this page and, for subscribers, send a single email notification with a summary of the change. We will never lower the privacy protections described here without first giving subscribers the option to unsubscribe.

## 9. Contact

- **General privacy questions:** `hello@ouralert.org`
- **Takedowns:** `takedown@ouralert.org`
- **Security disclosures:** `security@ouralert.org`
- **Press:** `press@ouralert.org`

OurALERT is published by Penny Tribune. For corporate contact information, see [thepennytribune.com](https://thepennytribune.com).
