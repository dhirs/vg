# OneTrust magic links — how they work, and why we can't just seed them

## How a OneTrust magic link works

OneTrust hosts the **preference centre**: the page where a person sees what they've agreed to
and changes it. A **magic link** opens that page already signed in as one particular person.

- **The link is the preference centre URL plus that person's link token.** The token is unique to
  the person (the OneTrust "data subject", identified by their email) and has an expiry date.
- **Getting a token:** OneTrust's *Get Data Subject Token* API —
  `GET https://<hostname>/rest/api/consent/v4/datasubjects/linktokens` with header
  `identifier: <email>` — returns the token and its `expiryDate`. Tokens can also be generated
  when consent receipts are recorded; OneTrust's docs mention a lifetime of up to a year.
- **Opening it:** whoever opens the link sees **that person's latest settings** — whatever
  OneTrust holds right now, from any system — and can change them. OneTrust records the change
  itself.
- **Without a link:** the preference centre can also be shown on a website on its own. The person
  enters their email, OneTrust identifies them (depending on the tenant's setup, typically by
  emailing a link to that address) and then shows their latest settings.

So a magic link is simple to use: put the right link in front of the right person and OneTrust
does the rest.

## The obvious approach: put each person's magic link everywhere

To give people a "manage your preferences" link that just works, the obvious approach is to fetch
every person's magic link from OneTrust and **seed it into every system that talks to them**:
a Marketo field for emails, a field in AEP for journeys, a field on the Dynamics CRM contact,
the website's user record, and so on. Each system then prints the person's link.

## Why that doesn't work for us

### 1. Every copy has to be kept in sync

The link belongs to a person's **current** identity in OneTrust. Whenever that changes, every
seeded copy in every system is wrong until it's updated:

- **Email change** — OneTrust identifies people by email, so a new email means a new data subject
  and a new token. The old link in Marketo, AEP and the CRM now opens the old identity, or nothing.
- **Person removed** (an erasure request, or a lead deleted) — their link must stop working
  everywhere, and must be removed from every system that holds it.
- **Token reissued** — any new token has to be pushed to every system again.

That's a sync job per system, for every person, forever — and a missed update means someone gets a
link that opens the wrong record, or a removed person's link keeps working.

### 2. Expiry: either links that never die, or links that keep dying

Tokens expire. That leaves two bad options:

- **Seed long-lived or never-expiring links.** Every marketing email ever sent then carries a
  permanent key to that person's consent. A forwarded email, a shared screenshot or a leaked
  mailbox lets anyone change that person's preferences, indefinitely — and the link can't be
  revoked without re-seeding every system. That's a **security concern**.
- **Seed short-lived links.** Links in emails already sent go dead, so people click "manage your
  preferences" and get an error. To avoid that, every system needs a fresh link before every send —
  a constant refresh job across all systems, on top of the sync job above.

### In short

Seeding OneTrust magic links means **N systems × every person × every change**, plus a choice
between insecure permanent links and constantly expiring ones. The fix is to never store a magic
link at all — see **What is CPMS Router**.

## Sources

- [OneTrust: Get Data Subject Token](https://developer.onetrust.com/onetrust/reference/getemaillinktokenbydatasubjectv4)
- [OneTrust: Implementing the Collection Point with REST API](https://developer.onetrust.com/onetrust/reference/implementing-the-collection-point-with-rest-api)
