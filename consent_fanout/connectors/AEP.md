# AEP Connector — OneTrust → Adobe Experience Platform

How AEP's **OneTrust Integration source** authenticates to OneTrust: the access token, who
creates it, where, how it's used, and why it needs looking after. Open questions about the
connector are under Open questions → AEP (`consent_fanout/AEP.md`).

## What the token is

A **password that lets AEP read consent data out of OneTrust**. AEP's connector calls
OneTrust's API on a schedule (every 15 minutes at the fastest), and every call carries this
token to prove AEP is allowed to read.

- An **OAuth 2.0 access token** issued by OneTrust: a long random string.
- It carries **scopes**, which limit what it can do. Adobe's docs require `CONSENT` and
  `CONSENT_READ`.
- It has an **expiry date** set when it's created, at most **one year** out.

## Who creates it, and where

1. A **OneTrust admin** with Access Management rights, in Vanguard's OneTrust tenant, goes to
   *Global Settings → Access Management → Client Credentials*:
   - creates a client credential for AEP, with the `CONSENT` and `CONSENT_READ` scopes
   - chooses how long its tokens last, up to a year
   - generates the access token and copies it
2. An **AEP admin** pastes it into AEP: *Sources → Consent & Preferences → OneTrust
   Integration*, together with the OneTrust **hostname** (e.g. `app.onetrust.com`). AEP
   stores it in the connection.

## How it's used

- On each scheduled run, AEP calls OneTrust's API at that hostname with
  `Authorization: Bearer <token>`.
- OneTrust checks the token is valid, not expired, and has the right scopes, then returns
  the consent records.
- Nothing else uses it. It isn't the SFMC credential, and it isn't anything CPMS holds.

## Why it causes trouble

- **AEP is only given the token, not the client ID and secret behind it.** It can't request
  a new token when the old one runs out. Adobe's docs say OneTrust doesn't support refresh
  tokens for system-to-system calls, so the token doesn't renew itself.
- **When it expires, every run fails.** Failed runs' windows are never re-read, so consent
  changes made from that point on don't reach AEP until someone installs a new token and
  fills the gap.

## Replacing it (at least yearly)

1. The OneTrust admin generates a new token for the same client credential.
2. The AEP admin updates the OneTrust Integration connection with it.
3. The old token keeps working until its own expiry, so do this well before that date and
   the two overlap with no gap.

## Things to settle

- **Owners:** a named OneTrust admin who creates the token and an AEP admin who installs
  it, plus a reminder well before the expiry date (AEP.md Q1).
- **Treat it as a secret:** it reads every person's consent. Keep it only in AEP's
  connection — not in email, chat or a ticket.
- **Scopes:** ask OneTrust why the connector needs `CONSENT` as well as `CONSENT_READ`. If
  `CONSENT` allows more than reading, the token can do more than AEP needs.

## Sources

- [AEP: Create a OneTrust Integration source connection in the UI](https://experienceleague.adobe.com/en/docs/experience-platform/sources/ui-tutorials/create/consent/onetrust)
- [AEP: Create a dataflow for a OneTrust Integration source using the Flow Service API](https://experienceleague.adobe.com/en/docs/experience-platform/sources/api-tutorials/create/consent/onetrust)
- [OneTrust: Integrating with Adobe Experience Platform](https://my.onetrust.com/s/article/UUID-39fef01a-5599-85ef-8648-d4d559dbfe73?language=en_US)
