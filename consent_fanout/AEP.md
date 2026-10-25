# AEP (Adobe Experience Platform) as the outbound hub — integration questions

Open questions for route D: OneTrust → AEP → AEP destinations → SFMC, Dynamics CRM and
Marketo. AEP would be the single place consent fans out from. Answer these before
choosing it over per-system routes (see [`SFMC.md`](SFMC.md) for SFMC's routes A–C).

## What we know so far

- **Inbound:** AEP has a OneTrust Integration source, provided by Adobe. It pulls consent
  and preference data (not cookies) **on a schedule**. A run picks up after the previous
  one even if that run failed, so **a failed run's time window is not re-collected
  automatically**.
- **Outbound:** Adobe's catalogue has streaming, API-based destinations for all three
  targets:

  | Target | What it writes | Constraints |
  |---|---|---|
  | Dynamics 365 | Audience status into a custom text field on the **Contact** | Updates only — nothing says it creates contacts. Matches on `contactid` only. People audiences from the Segmentation Service only. |
  | Marketo Engage | Static lists, person fields, or both. Can create new persons. | Marketo instance must have its users managed in Adobe Admin Console and sit in the same Adobe org. |
  | SFMC | Creates/updates contacts. Audience status into text attributes on SFMC's contact attributes. | Matches on SFMC contact key. Nothing about subscriber status, All Subscribers or publication lists. |

- Destinations export **audience membership**, not consent values. Consent would be modelled
  as audiences (e.g. "email opt-in for topic X"), and each target system filters on the
  resulting status fields or lists.
- Destinations are part of **Real-Time CDP**, not plain AEP.
- AEP does not send changes made inside the target systems back to OneTrust.

## Questions

### Licence and current use

1. **Does Vanguard have Real-Time CDP (and which tier), not just AEP?**
   *Why:* without Real-Time CDP there are no destinations, and route D isn't available.

2. **Are any of the three destinations (Dynamics 365, Marketo, SFMC) already connected and
   in use today?** For what?
   *Why:* an existing, trusted connection makes route D mostly configuration. A new one
   needs credentials, approval and an owner on both sides.

3. **Who owns AEP at Vanguard, and can we create schemas, audiences and dataflows?**
   *Why:* decides who builds and supports the consent audiences and destinations, and how
   changes are approved.

### Getting consent into AEP

4. **How often can the OneTrust source run, and what does a run actually pick up?** All
   changes since the last run, or only certain purposes or collection points?
   *Why:* the schedule sets the best-case delay for every downstream system. Any gap in
   what's picked up is consent that never reaches anyone.

5. **How do we detect and recover a failed OneTrust source run?** Alerts, and a way to
   replay the missed window?
   *Why:* a failed run's window isn't re-collected automatically. A lost opt-out means
   someone keeps getting marketing. We'd need monitoring plus a reconciliation job.

6. **Should CPMS also stream each change straight into AEP** (AEP streaming ingestion),
   with the OneTrust source kept as a safety net?
   *Why:* streamed data is evaluated within minutes, not daily, so destinations update
   much faster. CPMS already produces a clean event per change. The trade-off is a second
   writer into AEP, so the two inputs must agree on how consent is modelled.

### Audiences

7. **Are consent audiences evaluated by streaming or by batch segmentation?**
   *Why:* data arriving by batch (the OneTrust source) is typically evaluated by the
   batch job, roughly daily. That, plus the source schedule, is the end-to-end delay
   for an opt-out — to be compared with the SLA (SFMC.md Q17).

8. **How should consent be modelled as audiences?** One audience per purpose, per
   topic × channel, or only a few ("marketable by email")?
   *Why:* each audience becomes a field or list in every target system. Too few loses
   the preference detail people set in our preference centre. Too many hits field limits
   (e.g. SFMC's custom field count per edition) and makes sends hard to configure.

### Opt-outs and exits

9. **When someone leaves an audience, does each destination reliably write `exited`,
   or remove them from the Marketo list?**
   *Why:* for consent, leaving the opt-in audience **is** the opt-out. The destination
   docs don't describe exit handling, so this has to be tested for each of the three.

10. **Is AEP's consent / data-usage enforcement switched on for these destinations?**
    *Why:* enforcement can stop non-consented profiles being exported at all. The
    "you've opted out" update might then never reach the target system. We need to know
    whether exits still flow, and test it.

### Identity

11. **Does AEP's identity graph hold each target system's ID for every person?** Dynamics
    `contactid`, SFMC contact key, Marketo email.
    *Why:* OneTrust and CPMS key on email. A person with no Dynamics `contactid` in AEP
    can't be updated in Dynamics at all, because that destination matches on
    `contactid` only and doesn't create contacts.

### Target systems

12. **Can each target system enforce consent from audience fields or lists?** SFMC
    sends filtering on status attributes, Dynamics using the Contact status field, Marketo
    smart lists using the static list or field.
    *Why:* route D delivers consent only as audience status. If sends today rely on
    native unsubscribe flags, every send, journey and program has to change to read the
    new fields instead.

13. **Can the Marketo destination write Marketo's native unsubscribe field?** Is the
    Marketo instance managed in Adobe Admin Console in the same org?
    *Why:* writing the native flag would mean Marketo enforces opt-outs everywhere
    automatically, instead of every program checking a list. The Admin Console
    requirement decides whether the destination can be used at all.

### Changes coming back

14. **How do unsubscribes made in SFMC, Marketo or Dynamics get back to OneTrust?**
    *Why:* AEP destinations push outward only. Without a route back, the next AEP export
    can overwrite a newer unsubscribe made in the target system. That would be a
    compliance breach. This is likely a new CPMS source either way.

## Sources

- [AEP: OneTrust Integration source](https://experienceleague.adobe.com/en/docs/experience-platform/sources/connectors/consent/onetrust)
- [AEP: Microsoft Dynamics 365 destination](https://experienceleague.adobe.com/en/docs/experience-platform/destinations/catalog/crm/microsoft-dynamics-365)
- [AEP: Marketo Engage connection](https://experienceleague.adobe.com/en/docs/experience-platform/destinations/catalog/adobe/marketo-engage-connection)
- [AEP: (API) Salesforce Marketing Cloud connection](https://experienceleague.adobe.com/en/docs/experience-platform/destinations/catalog/email-marketing/salesforce-marketing-cloud-exact-target)
