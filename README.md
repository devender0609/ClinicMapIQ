# ClinicMap IQ v9.4 — Phased Growth Intelligence

ClinicMap IQ is a referral-growth workspace for clinics and hospital outreach teams. It helps search a market, map possible referral offices, review similar/competing clinics, save outreach targets, track follow-up, and compare existing referral relationships against public opportunities.

## What is included

- Public market search using OpenStreetMap/Overpass, NPI Registry, and optional Google Places.
- Map layers for possible referral offices, similar clinics/competitors, and existing referral sources.
- Saved searches with basic “what changed” tracking after reruns.
- Market Opportunity Brief with mission, expansion score, competitor pressure, data quality, network gap, and next move.
- Saved outreach list and selected-office profile.
- Office Intelligence Profile with office-type playbook and referral partner readiness checklist.
- Referral pipeline board: Not contacted, Contacted, Follow-up, Active, and Do-not-contact.
- Focused outreach campaigns created from next-best targets.
- Visit-day builder with route and visit sheet.
- Manual entry and CSV upload for existing referral sources.
- Manager dashboard with barriers, opportunity gaps, campaign counts, and growth command report.
- Activity history, reminders, CSV/text/PDF exports, workspace import/export, and optional Firebase cloud sync.

## Data integrity

The app does not invent clinics, demand, revenue, referral volume, or referral relationships. Results depend on public data sources and optional uploaded/manual data. Public listings should be verified before outreach.

## Optional environment variables

For broader search coverage:

```text
GOOGLE_PLACES_API_KEY=
```

For optional Firebase cloud sync:

```text
FIREBASE_API_KEY=
FIREBASE_AUTH_DOMAIN=
FIREBASE_PROJECT_ID=
FIREBASE_STORAGE_BUCKET=
FIREBASE_MESSAGING_SENDER_ID=
FIREBASE_APP_ID=
```

For optional email sending:

```text
RESEND_API_KEY=
EMAIL_FROM=
```

## Vercel deployment settings

```text
Framework Preset: Other
Install Command: echo "No install needed"
Build Command: echo "No build needed"
Output Directory: .
```

## Notes

This build focuses on value-added intelligence without duplicating existing sections: market brief, office readiness, campaigns, visit-day workflow, and command reporting are added into the existing workflow rather than as extra tabs.

## v9.5 Readability and voice search update
- Improved contrast in the Market Opportunity Brief so the recommended next move is easier to read.
- Added a compact “How scores work” explainer inside the Market Opportunity Brief.
- Added browser-based voice search for the clinic address/market field using the Web Speech API when supported by the browser.
- Voice search is optional and does not send audio to ClinicMap IQ; browser speech recognition behavior depends on the user’s browser and permissions.


## v9.8 cleanup notes
- Public data source names are still used internally for deduplication and exports, but no longer shown as repeated badges in result cards, pin popups, or selected office profile.
- More Filters now closes with an X button, outside click, Escape key, or after choosing a filter inside the menu.
