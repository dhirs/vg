# SFMC (Salesforce Marketing Cloud / ExactTarget) — integration questions

How consent and preferences get from OneTrust into SFMC, and the open questions — with why
each answer matters — that must be settled before building it.

## Approach (decided)

A **custom OneTrust integration workflow calls the SFMC REST API directly**. Nothing in
between: no Dynamics, no AEP, no CPMS code.

1. **Trigger:** *Data Subject Consent Updated*, filtered by purpose / collection point.
2. **Get a token:** `POST https://<subdomain>.auth.marketingcloudapis.com/v2/token` with
   an SFMC Installed Package's client ID and secret (OAuth client credentials). The token
   lasts ~18 minutes and is sent as `Authorization: Bearer <token>`. See Q16.
3. **Upsert the person's row in a consent data extension**, keyed on Subscriber Key:
   `PUT https://<subdomain>.rest.marketingcloudapis.com/hub/v1/dataevents/key:<DE external key>/rows/SubscriberKey:<value>`
   with each purpose's status, each topic × channel opt-in / opt-out, and the timestamp.
4. **On a full opt-out,** optionally also set the subscriber's status to Unsubscribed, so
   SFMC blocks every send, not only those that check the data extension.

Sends and journeys then filter on the data extension (or subscriber status; see Q5–Q6).

## What we know so far

- Vanguard already uses OneTrust.
- SFMC is used **with Dynamics CRM**; there is **no Salesforce CRM** (Sales/Service Cloud).
- OneTrust's **ready-made** "Salesforce Marketing Cloud" templates write to Salesforce CRM
  Contacts / Leads and rely on Marketing Cloud Connect to reach SFMC, which needs
  Salesforce CRM. They are no use to us — hence the custom workflow above.
- The workflow is triggered by OneTrust consent events, not on a schedule. OneTrust's docs
  don't state latency, batching or retry behaviour (see Q14).
- CPMS sends OneTrust the lowercased **email** as the data subject identifier, so that's
  the ID the workflow has by default. The outbound schema
  (`send_to_cpms/schemas/onetrust_request.schema.json`) can also carry
  `additionalIdentifiers` and `dsDataElements`.

## Questions

### Identity

1. **What is the Subscriber Key in SFMC: the email address or the Dynamics contact GUID?**
   To check: Email Studio → Subscribers → All Subscribers (or Contact Builder → All
   Contacts) and open any subscriber, or ask whoever built the Dynamics → SFMC sync.
   *Why:* step 3 needs the Subscriber Key, but OneTrust only knows the email.
   - **Email:** the workflow uses the OneTrust identifier as is. Check whether two
     subscribers can share an email.
   - **Dynamics contact GUID:** OneTrust has to be given the GUID.
     - **CPMS adds it to each receipt (preferred).** CPMS looks the GUID up in Dynamics
       and sends it as an `additionalIdentifiers` / `dsDataElements` entry. OneTrust stores
       it on the data subject, and the event payload hands it to the workflow — and to any
       later workflow for other systems. Needs CPMS read access to Dynamics, and a lookup
       for every source event, including EMO registrants who may not be in Dynamics yet.
     - **The workflow looks it up in SFMC first** (fallback), querying a data extension by
       email, then upserting. An extra call per event, and it fails when one email maps to
       several subscribers.

2. **What happens when someone changes their email, or isn't in SFMC yet?**
   *Why:* OneTrust keys people by email, so a new email is a new data subject. Their
   consent has to follow them in both OneTrust and SFMC. And an EMO registrant never
   synced from Dynamics has no Subscriber Key yet: either the workflow creates the row,
   or their consent has to wait until they arrive.

3. **One business unit or several (Enterprise 2.0)?** If several, which ones send
   marketing email, and is subscriber status shared or kept separately per unit?
   A large SFMC account can be split into **business units** (e.g. UK, Europe, US). Each
   one is like its own mini SFMC, with its own data extensions, its own sends and journeys,
   and often its own subscriber list and unsubscribe status. A small setup has just one.
   *Why:* it changes what the workflow has to do:
   - **Where to write.** With several units there may be one consent data extension per
     unit. Writing to one leaves the others unchanged — unless they all read from a
     shared data extension.
   - **Opt-outs may not carry across.** Depending on the setup, an Unsubscribed status
     can apply to one unit only, so someone who opts out could still get email from
     another unit.
   - **Credentials.** The Installed Package (Q16) is created in one unit. Writing to
     another unit means naming it by its ID (MID) in the token request, with the package
     allowed to access it — or a separate login per unit.

   One unit: nothing changes and Q3 is closed. Several: the workflow writes to every unit
   that sends marketing email, or to a shared data extension they all read from.

### How consent is stored and enforced in SFMC

4. **Is there a consent / preference data extension today, or do we create one?** Its
   external key, primary key and fields.
   *Why:* step 3 writes to it. Its primary key must match the ID from Q1, and its fields
   must hold every purpose and topic × channel value from Q7.

5. **Where else does SFMC hold consent today?** All Subscribers status, publication lists,
   fields on sendable data extensions, suppression lists?
   *Why:* sends may check these instead of our data extension. Writing to a place sends
   don't check would make the whole integration pointless.

6. **How do sends and journeys apply consent?** Entry criteria, exclusion scripts,
   publication lists, auto-suppression?
   *Why:* we need to be sure an updated value actually stops a send. Also shows whether
   per-topic preferences, not just a global opt-out, can be enforced at all today.

7. **How do OneTrust purposes, topics and channels map to SFMC fields?** E.g.
   `marketing_communications` / `event_communications` and their topics → which data
   extension fields.
   *Why:* this mapping is the core of the workflow's request body. Gaps mean a preference
   the person set in our preference centre has no effect in SFMC.

8. **Are SMS (MobileConnect) or push (MobilePush) used, or only email?**
   *Why:* our taxonomy has email / SMS / push channels. SMS and push opt-ins live in
   separate SFMC stores with separate APIs, so each one used adds steps to the workflow.

### The existing Dynamics → SFMC sync

9. **Does the Dynamics → SFMC sync write any consent or "do not email" fields?** Which
   ones, how often, and who runs it?
   *Why:* if it does, it can overwrite what the OneTrust workflow just wrote, putting an
   opted-out person back to opted in on the next sync run.

10. **Which system is the master for consent: OneTrust, Dynamics, or SFMC?**
    *Why:* with OneTrust as the master, every other system — including the Dynamics sync —
    must take its value and stop overwriting it. That needs agreeing with the Dynamics
    and SFMC owners.

### Changes made inside SFMC

11. **How do unsubscribes that SFMC handles itself get back to OneTrust?** The
    unsubscribe link in our emails is already covered: it goes to our landing page, which
    identifies the person by CRM ID and sends the change through CPMS to OneTrust. Not
    covered:
    - **one-click unsubscribe** from the inbox (`List-Unsubscribe` header, required by
      Gmail / Yahoo for bulk senders since 2024): the mailbox provider calls SFMC directly,
      SFMC marks the subscriber Unsubscribed, and no landing page is involved
    - **spam complaints**: SFMC unsubscribes the person from the mailbox providers'
      feedback loops

    *Why:* the workflow pushes *out* of OneTrust only. These unsubscribes never reach
    OneTrust, and the next push could re-subscribe the person — a compliance breach. Likely
    fix: a scheduled job reads SFMC's unsubscribe / complaint data and sends each one to
    CPMS as a source event.

12. **Is there an SFMC preference / subscription centre (CloudPages) in use?**
    *Why:* it would compete with our preference centre as a second place to change
    preferences. It either has to be retired or send its changes to CPMS.

### OneTrust side

13. **Does Vanguard's OneTrust licence include the Integrations module (workflows)?** Is
    there a limit on workflows or runs? Who administers the tenant, and can we build and
    change workflows there?
    *Why:* the approach depends on it. Without it, the approach has to be revisited.

14. **Can a OneTrust workflow do what the approach needs?**
    - get an OAuth token, then call the API with it
    - map purpose / topic values from the event into the request body
    - take a conditional step (only set Unsubscribed on a full opt-out)
    - retry failed calls, alert on failures, and replay missed events

    *Why:* steps 2–4 rely on each of these. If an opt-out call fails silently, the person
    keeps getting email, so we need to know whether failures are visible and recoverable
    or whether we need a reconciliation job.

15. **Are "delta-type" consent integration events enabled on our collection points or
    preference centre?**
    *Why:* with delta-type events on, *Data Subject Consent Updated* only fires when a
    person is **created**. Later updates would then never reach SFMC unless the workflow
    listens to a different event.

### SFMC API access

16. **Can we get an SFMC Installed Package for authentication?** Who approves it, and who
    owns it? What it involves:
    - **SFMC admin creates it:** Setup → Apps → Installed Packages → New → API Integration
      component, type **Server-to-Server**, with only the scopes needed: **Data
      Extensions: Read, Write** (step 3) and, if step 4 is used, **List and Subscribers:
      Read, Write**.
    - **SFMC shows:** client ID, client secret, authentication base URI
      (`https://<subdomain>.auth.marketingcloudapis.com`) and REST base URI.
    - **Business units:** the token is issued for the package's own business unit unless
      the request passes `account_id` = another unit's MID (ties to Q3).
    - **Token request:**
      ```
      POST https://<subdomain>.auth.marketingcloudapis.com/v2/token
      { "grant_type": "client_credentials", "client_id": "…", "client_secret": "…",
        "account_id": "<MID>" }
      → { "access_token": "…", "expires_in": 1079, "rest_instance_url": "…" }
      ```
      SFMC asks integrations to reuse a token until it expires; a new token per call may
      be throttled.
    - **OneTrust holds the credentials** as a credential in its Integrations module, never
      in CPMS. To confirm (with Q14): does OneTrust offer an **OAuth 2.0 client
      credentials** credential type that fetches and reuses the token itself? If yes, step
      2 is handled by the credential; if not, the workflow makes an explicit token call per
      event.
    - **IP allowlisting:** if SFMC restricts API access by IP, OneTrust's outbound IP
      ranges must be allowlisted.
    - **Secret rotation:** who rotates the client secret, how often, and how the OneTrust
      credential is updated without breaking the workflow.
    - **Owner:** a dedicated integration owner, not a person who might leave.

    *Why:* step 2 can't run without it. Approval can take a while, so it's worth starting
    early. Narrow scopes limit the damage if the secret leaks.

17. **Which SFMC edition and API limits apply?**
    *Why:* a bulk change, such as a taxonomy change re-pushing many people, must not hit
    rate limits and silently drop updates.

### Requirements

18. **How quickly must an opt-out stop marketing sends?** A legal requirement or an
    internal SLA: minutes, hours, a day?
    *Why:* sets how fast failures must be detected and retried (Q14), and whether a
    reconciliation job is needed as a safety net.
