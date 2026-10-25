# AEP (Adobe Experience Platform) — integration questions

How consent and preferences get from OneTrust into AEP, and the open questions — with why
each answer matters — that must be settled before relying on it. Scope: **OneTrust → AEP**
only. Whether AEP then feeds other systems (its Dynamics / Marketo destinations) is decided
in those systems' own files.

## Approach

Use the **OneTrust Integration source** that AEP already offers. It is configured in AEP
(Sources → Consent & Preferences → OneTrust Integration) and pulls from OneTrust on a
schedule. Nothing in between: no CPMS code.

1. **Connect:** AEP is given the OneTrust hostname (e.g. `app.onetrust.com`) and a OneTrust
   access token.
2. **Schedule:** a dataflow runs every 15 minutes or less often (`minute` with interval
   ≥ 15, `hour`, `day`, `week`, or `once`).
3. **Each run:** reads the data subjects that changed since the previous run, as JSON, and
   writes them to an AEP dataset through a field mapping.
4. **Profiles:** if the dataset is enabled for Profile, each person's consent lands on
   their AEP profile, where audiences and consent policies can use it.

## What we know so far

As documented by Adobe (pages last updated 14 Oct 2026):

- **OneTrust owns the connector.** Adobe's docs say questions and update requests go to
  OneTrust, and OneTrust shares the API specification with Adobe. Adobe doesn't name the
  OneTrust API it calls.
- **Only consent and preferences, not cookies.**
- **Authentication:** an OAuth access token created in OneTrust (Global Settings → Access
  Management → Client Credentials) with the `CONSENT` and `CONSENT_READ` scopes. It **does
  not refresh itself** — OneTrust doesn't support system-to-system refresh tokens — and
  lasts **at most one year**. It must be replaced in AEP before it expires.
- **Schedule:** fastest is every 15 minutes. The connector also loads "historic" data, but
  the docs don't say how far back or how.
- **Failed runs are not recovered.** Each run picks up after the previous one even if that
  one failed, and the failed run's time window is not re-read.
- **Data shape:** one record per **data subject** — their current state, not individual
  receipts:
  - `Identifier` (the email, for us), `Id`, `Language`, `CreatedDate`, `LastUpdatedDate`,
    `TestDataSubject`, `DataElements`
  - `Purposes[]`, each with `Id`, `Name`, `Version`, `Status` (`ACTIVE`, `WITHDRAWN`,
    `NO_CONSENT`, `EXPIRED`), `ConsentDate`, `WithdrawalDate`, `ExpiryDate`,
    `LastTransactionDate`, `LastTransactionCollectionPointId`, `Topics[]` (with
    `IsConsented`) and `CustomPreferences[]`
- **Lands in the data lake as batch data.** AEP's docs say audiences that use batch data
  are evaluated by the **batch job, every 24 hours**; streaming evaluation only applies to
  streamed data.
- **How CPMS sends channels:** each topic's email / SMS / push choice goes to OneTrust as a
  **custom preference** with one option per channel (`oneTrustChannelPreferenceId` /
  `oneTrustChannelOptions` in `send_to_cpms/taxonomy/`). So in AEP's data, channel detail
  is in `CustomPreferences`, separate from the topic's `IsConsented`.

## Questions

### Connection and access token

1. **Who creates the OneTrust access token, and who replaces it before it expires?** How
   will we be warned before the expiry date?
   - **What it is:** a password that lets AEP read consent data out of OneTrust — an OAuth
     2.0 access token (a long random string) issued by OneTrust, with the `CONSENT` and
     `CONSENT_READ` scopes and an expiry date at most one year out.
   - **Where it's generated:** in Vanguard's OneTrust tenant, by a OneTrust admin with
     Access Management rights: *Global Settings → Access Management → Client Credentials*.
     They create a client credential for AEP with those scopes, choose the token lifetime
     (up to a year), and generate the token.
   - **Where it goes:** an AEP admin pastes it into AEP — *Sources → Consent & Preferences →
     OneTrust Integration* — together with the OneTrust hostname (e.g. `app.onetrust.com`).
     AEP stores it in the connection.
   - **What it's used for:** on every scheduled run, AEP calls OneTrust's API with
     `Authorization: Bearer <token>`; OneTrust checks it and returns the consent records.
     Nothing else uses it — it isn't the SFMC credential, and CPMS never holds it.
   - **Replacing it:** AEP only has the token, not the client ID and secret behind it, so it
     can't get a new one itself. Before expiry, the OneTrust admin generates a new token and
     the AEP admin updates the connection; the old one works until its own expiry, so the
     two overlap with no gap.

   More detail: OneTrust Connectors → AEP Connector (`consent_fanout/connectors/AEP.md`).
   *Why:* the token lasts at most a year and doesn't refresh itself. When it expires, runs
   start failing — and failed windows aren't recovered (Q4), so consent changes made in that
   gap never reach AEP. This needs a named owner and a calendar reminder or alert, not
   memory.

### Schedule, freshness and gaps

2. **What schedule will the AEP dataflow run on (set in AEP, not OneTrust)?** The schedule
   is part of the OneTrust Integration dataflow configured in AEP: AEP decides when to call
   OneTrust and pull changes. OneTrust doesn't push anything. Options are every 15 minutes
   or more (the fastest), hourly, daily, weekly, or once.
   *Why:* sets the best-case delay between a change in OneTrust and AEP knowing about it.
   Running more often shortens the delay and makes each failed run's lost window (Q4)
   smaller.

3. **What exactly does each run pick up?** Every data subject whose `LastUpdatedDate`
   is after the previous run? Only certain purposes or collection points? Ask OneTrust —
   Adobe's docs don't say.
   *Why:* if a change doesn't update what the connector checks, it's never picked up, and
   AEP keeps the old consent with no error to show it.

4. **How do we spot a failed run, and how do we re-read its time window?** AEP dataflow
   monitoring and alerts; a one-off (`once`) dataflow over the missed window, or a full
   reload?
   *Why:* a failed run's window is never re-read automatically. A withdrawal made during it
   is lost: AEP keeps showing consent as given. We need alerts plus a tested way to fill
   the gap.

   *Example:* runs every 15 minutes. The 10:00 run succeeds. At 10:07 Jane withdraws
   marketing consent and OneTrust records it. The 10:15 run fails (e.g. expired token). The
   10:30 run succeeds but only reads 10:15–10:30, so Jane's withdrawal never reaches AEP:
   she stays in marketing audiences with no error shown. If the token expired, every run
   fails until it's replaced, and the gap is everything since expiry.

   *Proposed solution:* (1) **prevent** the main cause — a named token owner and a reminder
   before expiry (Q1); (2) **detect** — subscribe that owner to AEP's alerts for failed
   OneTrust dataflow runs; (3) **recover** with a **full reload**, not by re-reading the
   missed window — the connector reads each person's current state, so reloading everyone
   simply overwrites AEP with the correct values. Run it after any failure, and on a
   schedule (e.g. weekly) as a safety net.

### Data and mapping

5. **Which of the connector's fields do we need, and where do they go in XDM?** In
   particular: Adobe's standard **Consents & Preferences** field group
   (`consents.marketing.email.val` etc.) or our own custom fields?
   AEP can't store OneTrust's data as it arrives: every value has to be copied into a
   field on one of AEP's schemas (XDM) — think of pre-printed forms with fixed boxes.
   Adobe provides a ready-made consent form with simple boxes: *Email OK? yes / no*,
   *SMS OK? yes / no*, *Push OK? yes / no*. AEP itself reads these: if *Email OK?* is
   *no*, AEP automatically stops that person getting marketing email.
   *Why:* our preference centre is more detailed than Adobe's form, so we must choose:
   - **Adobe's form only:** simple, and AEP blocks opt-outs by itself — but topic choices
     are lost.
   - **Our own extra fields as well** (e.g. *Email OK for events?*, *Email OK for market
     updates?*): the detail is kept, but AEP doesn't check them by itself — every audience
     has to be built to use them.

   Most companies do both: Adobe's fields for the overall yes / no, plus their own for the
   detail. This mapping is the core of the setup.

   *Example:* Jane says *"email me about events, but not about market updates."* Adobe's
   form has one *Email OK?* box, so it can't hold that — it becomes a single *yes*, and AEP
   no longer knows she refused market updates. With our own fields as well, *Email OK for
   events = yes* and *Email OK for market updates = no* are kept, and market-update
   audiences can exclude her — as long as they're built to check that field.

6. **Which identity does the record attach to, and does it join up with existing AEP
    profiles?** The connector's `Identifier` is the email. Do AEP profiles carry email as an
    identity, or are they keyed on the Dynamics contact ID / ECID?
    *Why:* if the email doesn't link to the person's existing profile, consent sits on a
    separate profile and audiences built on the main one never see it. (Ties to SFMC.md Q1:
    the same email-vs-CRM-ID question.)

7. **Does anything else write consent into the same AEP fields?** E.g. Web SDK / cookie
    consent, CRM imports, SFMC data. Which wins when they disagree?
    *Why:* two writers to the same field means the newest record wins under the merge
    policy — which could be an older CRM value overwriting a fresh OneTrust withdrawal.

8. **Should OneTrust test data subjects be filtered out?** (`TestDataSubject` flag.)
    *Why:* test records shouldn't become real AEP profiles or end up in audiences.

### Using consent in AEP

9. **What will AEP use consent for?** Once consent is in AEP, it can be used in three
    ways — which ones does Vanguard need?
    - **Filtering audiences.** Marketers build audiences such as "UK advisers who allow
      email about events", with consent as one of the audience rules. Each audience that
      should respect consent has to include the rule.
    - **Automatic consent enforcement.** AEP itself stops people who haven't consented from
      being sent to a destination, whatever audience they're in. This only works when
      consent is in Adobe's standard consent fields, and needs the right AEP licence.
    - **Journey Optimizer sends.** If Vanguard sends email from AEP itself, consent decides
      who gets each message at the moment it's sent.

    *Why:* the answer decides two other questions:
    - **The mapping (Q5).** Enforcement needs Adobe's standard consent fields. Detailed
      per-topic, per-channel audiences need custom fields as well.
    - **How fresh consent must be (Q10).** Audiences are re-evaluated daily, so when consent
      is only used to filter audiences, an opt-out can take up to a day to take effect.
      When it's checked at send time, a day's delay could mean emailing someone who has
      opted out.

    If AEP doesn't use consent for anything yet, most of the mapping work can wait until it
    does.

10. **Is a delay of up to ~24 hours acceptable for audiences?** There are two separate
    delays after someone changes their consent:
    - **OneTrust → the person's AEP profile: ~15 minutes at best.** Set by the dataflow's
      schedule (Q2). Each run updates the profile.
    - **Profile → audience membership: up to ~24 hours.** Data loaded by a scheduled pull is
      batch data, and audiences using batch data are only re-evaluated by AEP's nightly job.
      Running the dataflow more often doesn't make audiences update any faster.

    So after an opt-out, the profile says *no* within ~15 minutes, but the person stays in
    the audience until the nightly run.
    *Why:* this decides whether the standard OneTrust dataflow is enough on its own, or
    whether we need more:
    - **Consent only used as a rule inside audiences:** the full ~24-hour delay applies.
      The person stays in the audience — and in any destination it feeds — until the
      nightly run. Fine if a day's delay is acceptable; if not, the standard dataflow isn't
      enough.
    - **Consent checked at send or export time:** the profile value is what counts, so
      ~15 minutes applies. Journey Optimizer checks the profile's consent when it sends;
      AEP's consent enforcement on destinations (with the right licence) applies consent
      policies on export. Both need Adobe's standard consent fields (Q5). To confirm with
      Adobe: does enforcement re-read the profile on every export, or only when audience
      membership changes?
    - **Neither good enough:** consent changes must be **streamed** into AEP — e.g. CPMS
      also sends each change to AEP's streaming ingestion — with the OneTrust dataflow kept
      as the full, reconciling picture. That's extra build, and a second writer to the same
      fields (Q7).

    *Example:* Jane opts out of marketing email at 10:07. By ~10:15 her AEP profile says
    *email = no*. If the "Weekly market update" audience only filters on consent, she stays
    in it until the nightly run and can still get tomorrow morning's send. If the send
    itself checks her profile, she's excluded from ~10:15.

11. **What happens in AEP when a data subject is deleted in OneTrust** (an erasure request)?
    *Why:* the docs don't say the connector propagates deletions. If it doesn't, the person's
    consent and profile data stay in AEP after they asked for erasure, and need a separate
    privacy-request process.

## Sources

- [AEP: OneTrust Integration source overview](https://experienceleague.adobe.com/en/docs/experience-platform/sources/connectors/consent/onetrust)
- [AEP: Create a OneTrust Integration source connection in the UI](https://experienceleague.adobe.com/en/docs/experience-platform/sources/ui-tutorials/create/consent/onetrust)
- [AEP: Create a dataflow for a OneTrust Integration source using the Flow Service API](https://experienceleague.adobe.com/en/docs/experience-platform/sources/api-tutorials/create/consent/onetrust)
- [AEP: Streaming segmentation guide](https://experienceleague.adobe.com/en/docs/experience-platform/segmentation/ui/streaming-segmentation)
- [OneTrust: Integrating with Adobe Experience Platform](https://my.onetrust.com/s/article/UUID-39fef01a-5599-85ef-8648-d4d559dbfe73?language=en_US)
