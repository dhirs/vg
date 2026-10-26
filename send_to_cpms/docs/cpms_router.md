# What is CPMS Router

## In one line

CPMS Router is a small component that turns a "manage your preferences" click from **any**
system into that person's OneTrust magic link **at the moment they click** — so no system ever has
to store a OneTrust link.

## How it works

Each system that talks to people gets **its own route** on the router, and prints a link to it
carrying **its own ID for the person** — encrypted, never a OneTrust link:

| System | Link it prints | ID inside the `ref` |
|---|---|---|
| Marketo emails | `/marketo/preferences?ref={{lead.cpmsPrefRef}}` | Marketo lead ID, pre-encrypted once per lead |
| Vanguard 365 website | `/website/preferences?ref=…` | CRM local ID + issue time, encrypted when the page renders (short-lived) |

When someone clicks, the route's own Lambda:

1. **Decrypts** the `ref` with that route's key. A forged or edited `ref` fails here.
2. **Looks up the person's email now**, in the system that owns the ID (Marketo for a lead ID, the
   CRM for a local ID).
3. **Asks OneTrust for the magic link now** (*Get Data Subject Token* for that email).
4. **Redirects** the browser to it. The person lands in OneTrust's preference centre and sees
   their latest settings; OneTrust records any change.

The magic link is fetched for that one click and never stored anywhere. The route a link points
at tells the router which system the ID came from — there's no "source" parameter.

**One route doesn't redirect: `POST /marketo/unsubscribe`.** It's the URL in the email's
`List-Unsubscribe` header, called by Gmail's servers when someone clicks Gmail's own Unsubscribe
button — there's no browser to redirect. It takes the same `{{lead.cpmsPrefRef}}`, decrypts it and
looks the email up the same way, then sends a `withdrawn` event into CPMS and answers `200`
(`cpms-lambda-oneclick-unsub`; flow: the **Email_OneClick_Unsubscribe** schematic).

## The problems it solves

The two problems with seeding OneTrust magic links into every system (see **OneTrust magic
links**) go away:

| | Seeding magic links in every system | CPMS Router |
|---|---|---|
| What each system stores | A OneTrust magic link per person, kept up to date | Only its own encrypted ID for the person — no OneTrust link |
| Email change | Every copy must be updated, in every system | Nothing to do: the email is looked up at click time, so the new one is used |
| Person removed | Their link must be found and removed everywhere | The lookup finds no one → generic "invalid or expired link" page |
| Expiry | Permanent links (security risk) or links that keep dying | The magic link is fetched fresh per click, so it can be short-lived; the link in the email keeps working |
| A link leaks | Permanent access to that person's preferences | Revocable per person (issue a new `ref`) or for everyone (rotate the key) |
| Sync and refresh jobs | One per system, forever | None |

## Adding another system

A new system — AEP / Journey Optimizer, Dynamics CRM emails, SFMC, an app — needs:

1. **A route and its own Lambda** on the router, e.g. `/aep/preferences`.
2. **A way to turn its ID into an email** — the system's own API, or the CRM.
3. **Its own key**, so its `ref` can't be used on another route.
4. **Its links to print `ref`** — encrypted once per person and stored in that system (like
   Marketo), or encrypted when the link is created (like the website).

Nothing changes in OneTrust or in any other system, and there's still nothing to seed or keep in
sync — however many systems are added.

## What it's made of

- **API Gateway** `cpms-apigw-router`, one route per system, each throttled on its own.
- **One Lambda per route** — `cpms-lambda-router-marketo`, `cpms-lambda-router-website`,
  `cpms-lambda-oneclick-unsub` — with its
  own secrets, so one route's compromise doesn't expose another's.
- **A shared module** for what every route does the same way: decrypting, calling OneTrust,
  the generic error page, failure counting and logging rules.
- **One key per route** in Secrets Manager (`cpms-secret-pref-ref-key`, `cpms-secret-web-ref-key`).

Full parts list: `send_to_cpms/building_blocks.md` → CPMS_Router. Flows: the
**Email_Consent_Update**, **Email_OneClick_Unsubscribe** and **Website_Consent_Update** schematics.
