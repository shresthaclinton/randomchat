# Online Galli — beta launch checklist (30 Oct 2026)

## Already implemented in this package
- Online Galli branding and green entry button
- Age self-attestation checkbox before camera/microphone request (not age verification)
- Public routes /privacy, /terms, /guidelines and footer links
- Existing matching, WebRTC, moderation and admin code preserved except the added public page routes

## REQUIRED BEFORE PUBLIC INVITES
- [ ] Confirm legal operator name, address, and reachable support/safety/privacy emails. Replace ALL bracketed placeholders.
- [ ] Verify privacy notice against actual server logs, Neon data, Metered relay, Render and retention settings.
- [ ] Obtain legal review for Nepal and other intended jurisdictions; check requirements for adult stranger video chat, child protection, data protection and reporting.
- [ ] Establish a realistic moderation staffing, escalation, incident response and evidence retention/deletion process.
- [ ] Consider stronger age assurance where legally required; checkbox alone is not age verification.
- [ ] Check domain, trademarks and availability for Online Galli.
- [ ] Test /privacy, /terms, /guidelines, checkbox gating, and core video features on phone and desktop after deploying to a STAGING URL.
- [ ] Ensure admin secrets, database URLs and Metered API credentials stay only in environment variables.
- [ ] Start with small invitation-only Nepal beta; monitor reports, safety and reliability.

## Deploy (when ready)
Upload extracted files to existing GitHub repo, commit, let Render deploy. Do not upload this ZIP as one file to the repo. Do not announce public launch until required items are complete.
