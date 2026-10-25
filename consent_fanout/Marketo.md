# Marketo — integration questions

How consent and preferences get from OneTrust into Marketo, and the open questions — with why
each answer matters — that must be settled before building it.

## Approach (proposed)

Two candidate routes; the second is recommended.

**A. OneTrust workflow → Marketo REST API directly** — the same shape as SFMC: a OneTrust
integration workflow, triggered by *Data Subject Consent Updated*, calls Marketo's
*Sync Leads* API (`POST /rest/v1/leads.json`) to update the lead.

**B. OneTrust workflow → a small CPMS fanout service → Marketo (recommended).** OneTrust posts
each consent change to a secured CPMS endpoint; CPMS queues it (opt-outs first), batches updates,
and updates **every** Marketo lead with that email within Marketo's API limits and daily quota.
Full design: `consent_fanout/design.md` → **CPMS_Marketo_Bridge**.

**Why B over A:** Marketo community experts report that OneTrust's built-in calls to Marketo
handle token expiry badly (jobs fail and retry 15–30 minutes later) and don't respect Marketo's
concurrency limits (one call per record can swamp the limit), and their advice is to put a
service between the two. Marketo also allows several leads with the same email, which OneTrust
doesn't — so one OneTrust update may need to reach several leads. CPMS already runs this pattern
(FIFO queues, Lambdas, DLQs, alarms), so B adds little new.

## What we know so far

- **OneTrust built a Marketo integration**, listed on Marketo LaunchPoint. OneTrust's guide
  describes a OneTrust collection point used with **Marketo smart campaigns and a Marketo
  webhook** — mainly Marketo *sending* consent to OneTrust — with people matched by **email**.
  Pushing OneTrust → Marketo is done with OneTrust integration workflows calling Marketo's API.
- **Duplicates:** OneTrust allows one data subject per email; Marketo allows several leads with
  the same email. An update must reach all of them.
- **Marketo API limits:** 100 calls per 20 seconds and 10 concurrent calls per instance —
  **fixed, can't be raised**; a daily quota of typically 50,000 calls (can be raised by
  purchase); Sync Leads takes up to 300 leads per call; error 606 = rate limit exceeded.
- **Marketo API access** uses a LaunchPoint *Custom* service tied to an API-only user, giving a
  client ID and secret; access tokens are short-lived (to confirm: about an hour).
- **Marketo fields:** the standard `unsubscribed` flag blocks all marketing email to that lead;
  anything finer (per purpose / topic / channel) needs custom fields. The CPMS Router's
  `cpmsPrefRef` field also lives on the lead.

## Questions

### Identity

1. **How many Marketo leads share an email?** Is Marketo synced to Dynamics, are there lead
   partitions, and how long is the *Possible Duplicates* list? Marketo doesn't merge automatically — duplicates come from CRM sync (each CRM record is its
   own person), partitions (dedupe is per partition), API calls (`createDuplicate`, closely
   timed upserts) or a custom dedupe field.
   *Why:* OneTrust has one record per email. If only one lead is updated, the others keep the old
   consent and can still be emailed — so the fanout service updates every lead with that email.

### OneTrust side

2. **How does the CPMS endpoint know a call really comes from OneTrust?** Which credential can
   OneTrust's workflow send — an API key header, basic auth — and can we get OneTrust's outbound
   IP ranges?
   *Why:* the endpoint changes consent in Marketo. Without a check, **anyone who finds the URL can
   change anyone's consent**.
   *Example:* Jane opts out. Someone posts `{ "email": "jane@…", "unsubscribed": false }` to the
   endpoint; CPMS queues it, the fanout Lambda writes it, and Marketo emails Jane again — a
   compliance breach with no trace of who did it. Or a script posts thousands of emails with
   `unsubscribed: true` and wipes out the marketing list. (Solution: `design.md` → Endpoint
   security.)

### Marketo API access

3. **How long do Marketo access tokens last in our instance, and what is our daily API quota?**
    *Why:* the fanout service must reuse a token until just before it expires (fetching one per
    call wastes quota) and stay under the daily quota — a big change, like a taxonomy update
    touching everyone, could otherwise use it up and stop all updates until the next day.
   (Design: `design.md` → Updating Marketo, API quota.)

## Sources

- [OneTrust: Marketo integration](https://www.onetrust.com/integrations/marketo/)
- [OneTrust: Integrating Universal Consent & Preference Management with Marketo](https://my.onetrust.com/s/article/UUID-2cd85c1f-ab4f-bb5e-eb09-08d6f9bdd63d?language=en_US)
- [OneTrust: Consent Integration Events](https://docs.onetrust.com/en/integrations/integrating-for-consent--preference-management/consent-integration-events)
- [Adobe community: Marketo OneTrust integration (2024–25)](https://experienceleaguecommunities.adobe.com/marketo-27/marketo-onetrust-integration-184111)
- [Adobe: Marketo REST API (limits)](https://experienceleague.adobe.com/en/docs/marketo-developer/marketo/rest/rest-api)
- [Adobe: Marketo Lead Database — Leads (Sync Leads, Push Lead)](https://experienceleague.adobe.com/en/docs/marketo-developer/marketo/rest/lead-database/leads)
