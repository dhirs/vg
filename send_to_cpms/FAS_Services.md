# FAS services — EMO and CL6

EMO and CL6 are the two source systems that create **new consent records** in CPMS. Both
are Java web services built with Spring Boot, owned by their own Vanguard teams — not by
us. This file says what each one is, what it must publish, and what we still have to agree
with its team. The pipeline those events go into is in `design.md`.

## Status

Both changes **can** be implemented, but neither team will build anything until we tell
them **exactly** which event to publish. The spec below is what we hand them. Until then,
the EMO and CL6 pages in the test app (`web/`) publish these events in their place.

## EMO — event management service

- **What it does:** handles registration for Vanguard events, online and offline.
- **When it triggers CPMS:** someone registers for a new event. EMO already captures the
  registration, so it can publish the event below at that point.
- **Technical lead:** James Morrison (Vanguard) — the person to ask for more detail on EMO.
- **Consent on the page:** no granular choices. Registering *is* the marketing agreement,
  plus a privacy/cookie policy tick. The profile fields (name, job role, firm, firm size)
  are for EMO's own processes and are **not** sent to CPMS.

## CL6 — new user registration (Vanguard 365)

- **What it does:** handles new user registration through Vanguard 365.
- **When it triggers CPMS:** a new user registers. The registration carries consent, so CL6
  can publish an event of the same shape as EMO's.
- **Technical lead:** *(not yet known)*
- **Consent on the page:** creating the account *is* the marketing agreement, plus a
  required tick for the privacy policy, IP agreement and T&Cs. The T&Cs and IP agreement
  are not CPMS purposes, and profile fields (name, company, company type, FCA number) are
  **not** sent to CPMS.

## The event each team must publish

Both publish to the EventBridge bus **`cpms-eventbus-consent`**. The event body
(`Detail`) must be a valid `schemas/source_event.schema.json` — that file is the contract
to hand over, and the first pipeline step rejects anything that doesn't match it.

| Field | EMO | CL6 |
|---|---|---|
| EventBridge `Source` | `cpms.emo` | `cpms.cl6` |
| EventBridge `DetailType` | `event_registration` | `account_registration` |
| `eventType` | `event_registration` | `account_registration` |
| `sourceSystem` | `emo` | `cl6` |
| `consent[].purpose` | `marketing_communications`, `event_communications` *(assumed — see `design.md` → Open items)* | `marketing_communications` |
| `consent[].status` | `granted` | `granted` |
| `consent[].captureMethod` | `implied_by_registration` | `implied_by_account_creation` |

The bus rule only picks up events whose `Source` starts with `cpms.` — anything else is
silently ignored.

Example (EMO):

```json
{
  "schemaVersion": "1.0",
  "eventId": "6f1c2a9e-0b7d-4e7a-9a51-3c2f8d0e4b11",
  "eventType": "event_registration",
  "sourceSystem": "emo",
  "occurredAt": "2026-10-25T09:14:03Z",
  "subject": { "identifierType": "email", "identifierValue": "jane.doe@example.com" },
  "consent": [
    { "purpose": "marketing_communications", "status": "granted",
      "capturedAt": "2026-10-25T09:14:03Z", "captureMethod": "implied_by_registration" },
    { "purpose": "event_communications", "status": "granted",
      "capturedAt": "2026-10-25T09:14:03Z", "captureMethod": "implied_by_registration" }
  ],
  "provenance": {
    "sourceEventId": "<EMO's registration ID>",
    "captureChannel": "web",
    "policyVersion": "<privacy policy version the user agreed to>"
  }
}
```

CL6 sends the same shape with its own values from the table, and only the
`marketing_communications` consent item.

### Rules both teams must follow

- **Email lowercased and trimmed** before sending (`Jane@X.com` is rejected). It's used
  as-is to keep each person's events in order, and EventBridge can't fix it on the way in.
  Max 100 characters.
- **`eventId`** is unique per event (a UUID is fine). **`provenance.sourceEventId`** is the
  record's ID in EMO/CL6 itself, so a CPMS record can be traced back.
- **`policyVersion`** is the version of the privacy policy the user agreed to.
- **No extra fields** — the schema rejects unknown properties.
- Send only consent for **new** registrations. Existing people change their settings in
  OneTrust's preference centre, not through EMO or CL6.

## Still to agree with the teams

- CL6 technical lead / contact.
- Whether EMO's `event_communications` purpose is right (see `design.md` → Open items).
- How each service authenticates to our AWS account to publish (IAM role/user and the
  `events:PutEvents` permission on `cpms-eventbus-consent`).
- What each service does if publishing fails (retry, log, alert).
