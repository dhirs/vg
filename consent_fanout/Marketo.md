# Marketo — review of the US office's OneTrust → Marketo integration

The US office has built OneTrust → Marketo integrations and offers them to us under a
chargeback. These questions assess what has already been built: whether it's soundly designed,
and how long it would take to close any gaps. If that takes long, the case for the chargeback
falls away: a cheaper consent platform with integrations built and run locally may be the better
deal.

## The benchmark

A sound OneTrust → Marketo integration has to handle: Marketo token expiry, Marketo's shared rate
limits and daily quota, several leads per email, out-of-order changes, and failures that must not
be silent. Each question below checks
one of these, with what a good answer and a red flag look like.

## What we know so far

- OneTrust's own Marketo integration mainly sends consent **Marketo → OneTrust** (a OneTrust
  collection point with Marketo smart campaigns and webhooks, matched by email). OneTrust →
  Marketo is done with OneTrust integration workflows calling Marketo's REST API.
- Marketo practitioners report (2024–25) that OneTrust's direct calls to Marketo handle token
  expiry badly (retrying 15–30 minutes later) and ignore Marketo's concurrency limits.
- Marketo limits: 100 calls per 20 seconds and 10 concurrent — fixed, shared by everything using
  the instance; a daily quota of typically 50,000 calls; up to 300 leads per update call.
- Marketo can hold several leads with the same email; OneTrust holds one record per email.

## Questions

### Design: does it work under real conditions?

1. **How does the integration handle Marketo access tokens expiring?**
   *Why:* an opt-out that fails on an expired token and waits 15–30 minutes to retry can miss a
   campaign send.
   *Good:* the token is reused and renewed before it expires; a failed call is retried at once
   with a new token. *Red flag:* "OneTrust handles it" or retries on OneTrust's schedule.

2. **How does it stay within Marketo's rate limits, and what happens on a large change** (e.g.
   5,000 people at once)?
   *Why:* the limits are shared with the CRM sync and other tools; one call per record can lock
   them out.
   *Good:* calls are batched and throttled below the limit. *Red flag:* one call per change, no
   throttling, or "it's never been an issue".

3. **How many Marketo API calls does one consent change cost, and what stops a big re-push from
   using up the daily quota?**
   *Why:* once the quota is gone, every update stops until the next day — opt-outs included.
   *Good:* batched updates, opt-outs prioritised, quota monitored, bulk import for re-syncs.
   *Red flag:* no figure, or no plan for bulk changes.

4. **When an email matches several Marketo leads, which are updated?**
   *Why:* leads left untouched keep the old consent and can still be emailed.
   *Good:* every lead with that email. *Red flag:* "Marketo dedupes on email" or only the first
   match.

5. **What stops an older change overwriting a newer one?**
   *Why:* a retried or delayed opt-in landing after an opt-out re-subscribes the person.
   *Good:* per-person ordering and a timestamp check before writing. *Red flag:* none, or
   "OneTrust sends them in order".

6. **What happens when an update fails — who finds out, and how is it replayed?**
   *Why:* a silently lost opt-out is a compliance breach nobody notices until a complaint.
   *Good:* failures are kept (dead-letter queue or equivalent), alarmed and replayable, with a
   named owner. *Red flag:* failures only visible in OneTrust's workflow log.

### One-click unsubscribe (Gmail's Unsubscribe button)

CPMS plans to receive the one-click unsubscribe itself (`send_to_cpms/design.md` → One-click
unsubscribe), so these are about whether Marketo and the integration allow that.

7. **Can every marketing email carry *our* `List-Unsubscribe` URL instead of Marketo's own?**
   *Why:* Gmail and Yahoo require one-click unsubscribe from bulk senders; if Marketo always
   adds its own header, the opt-out lands in Marketo and OneTrust never hears of it.
   *Good:* the header is configurable per email or instance (pointing at
   `/marketo/unsubscribe?ref={{lead.cpmsPrefRef}}`), and DKIM-signed. *Red flag:* Marketo's
   header can't be changed, and its unsubscribes aren't synced back to OneTrust.

8. **How long from a OneTrust withdrawal to Marketo no longer sending?**
   *Why:* a one-click unsubscribe must be honoured within 2 days, and it reaches Marketo only
   through this integration.
   *Good:* minutes, measured, with opt-outs prioritised. *Red flag:* a daily batch, or no
   figure.

## Sources

- [OneTrust: Marketo integration](https://www.onetrust.com/integrations/marketo/)
- [OneTrust: Integrating Universal Consent & Preference Management with Marketo](https://my.onetrust.com/s/article/UUID-2cd85c1f-ab4f-bb5e-eb09-08d6f9bdd63d?language=en_US)
- [OneTrust: Consent Integration Events](https://docs.onetrust.com/en/integrations/integrating-for-consent--preference-management/consent-integration-events)
- [Adobe community: Marketo OneTrust integration (2024–25)](https://experienceleaguecommunities.adobe.com/marketo-27/marketo-onetrust-integration-184111)
- [Adobe: Marketo REST API (limits)](https://experienceleague.adobe.com/en/docs/marketo-developer/marketo/rest/rest-api)
- [Adobe: Marketo Lead Database — Leads](https://experienceleague.adobe.com/en/docs/marketo-developer/marketo/rest/lead-database/leads)
