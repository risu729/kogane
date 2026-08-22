# Existing Tools and Reuse

Kogane does not start from zero. Several existing tools — some our own,
some third-party — already solve parts of the collection and parsing
problem. This document catalogs them, maps each onto Kogane's four layers
(see `docs/design.md`), and records which are adopted, which are reused as
references, and which are rejected as a store of record.

The guiding rule from the design still applies: **evidence is preserved
byte-exact and re-processable; everything above it is disposable.** A tool
is only adopted wholesale if it respects that boundary, and adapted (not
adopted) if it collapses raw evidence into finished records.

## Summary

```text
tool                  owner       role in Kogane
--------------------  ----------  ----------------------------------------
kuebiko               risu729     raw capture (A). Already the raw layer.
smcc-meisai-scraper   risu729     card CSV parser (A→B). Adapt the parser.
pnsk-lab/mnie         3rd (MIT)   fetch-based provider clients + auth.
                                  Reuse providers + auth-bitwarden.
hirano00o/acctf       3rd (MIT)   scraper reference only (Go/Playwright).
```

## kuebiko — raw capture (owned)

[kuebiko](https://github.com/risu729/kuebiko) is already treated as the raw
layer in `docs/collection.md`: a Kuebiko run directory maps 1:1 onto
`fetch_run` / `fetch_artifact` / `raw_object`, and `metadata.ndjson` records
the internal JSON APIs each site's frontend calls. Nothing changes here; it
remains the phase-0 collector and the source of endpoint intelligence for
later automation.

## smcc-meisai-scraper — card statement parser (owned)

[smcc-meisai-scraper](https://github.com/risu729/smcc-meisai-scraper)
downloads Vpass (Sumitomo Mitsui Card) monthly statement CSVs and parses
them. It is small (~600 lines, TypeScript) and splits cleanly into three
parts:

```text
downloader.ts  Vpass internal CSV endpoint
               (web_meisai_csv_exec/v1?seikyuym=YYYYMM), Downloads polling
date.ts        statement availability window (11th 21:00 JST, prev 15 mo)
parser.ts      Vpass CSV -> typed transactions
```

`parser.ts` is the valuable part and already agrees with Kogane's design:

- usage amount and payment amount kept as separate fields (observed values
  not conflated),
- foreign use decomposed into amount / currency / rate / exchange date and
  never flattened into a JPY figure (provider FX rate kept distinct),
- the CSV total row is reconciled against the parsed sum and mismatches are
  warned (differences are signal, not bugs).

Its only dependencies are `fast-csv` / `valibot` / `luxon`, so the parser is
portable to Workers as-is.

**Plan:**

- **Adopt `parser.ts`** as the SMCC-card observation parser (A→B, phase 3).
  Two additions are required to satisfy the design: record
  `parser_name` / `parser_version` and the `raw_object` locator on every
  observation, and stop discarding unrecognized note lines (`log.warn`) —
  carry them into the observation instead.
- **Adapt `downloader.ts`.** As written it deletes the source file
  (`unlink`) and decodes Shift-JIS + `normalize("NFKC")` *before* saving.
  Kogane needs the opposite order: save the raw bytes first
  (`exports/<date>/smcc-card/`, content-addressed), then decode in the
  parser. This is exactly the "browser downloads are not reliably captured
  via CDP" gap that `docs/collection.md` calls out, so this scraper
  complements kuebiko rather than competing with it.
- **Drop `index.ts` / `config.ts`.** The `aggregated_meisai.csv` output is a
  finished-ledger shape the design rejects, the interactive card-switching
  loop cannot be scheduled, and `config.ts` hardcodes WSL paths.

`smcc-direct` (bank) in mnie and this card scraper do not overlap: one is
SMBC bank, the other is the Vpass card. Both are needed.

## pnsk-lab/mnie — fetch-based provider clients (third-party, MIT)

[pnsk-lab/mnie](https://github.com/pnsk-lab/mnie) is a self-hosted personal
finance system (a MoneyForward-style app: server, UI, CLI, MCP, OAuth). It
is not adopted as a whole — it is a "finished ledger" app, which is exactly
the shape `docs/design.md` argues against as a store of record. But two
parts are directly reusable, and its type model is strong prior art.

### Provider clients are pure `fetch`

Every provider in mnie is implemented with the platform `fetch` — no
Playwright, Puppeteer, or CDP anywhere in the tree. Shift-JIS is handled by
`iconv-lite`; SMBC's QR by `uqr`; sessions by a small per-origin cookie jar.
This is the "replay the site's internal API" approach that
`docs/collection.md` ranks second (below official exports, above browser
automation) — already implemented for several Japanese institutions:

```text
package                  target                     capabilities
-----------------------  -------------------------  -----------------------
provider-sbi-sec         SBI Securities             accounts/balances/
                                                    transactions/investments
                                                    (+ trade)
provider-smbc-direct     SMBC (bank direct)         accounts/balances/
                                                    transactions/transfers
provider-mobile-suica    Mobile Suica (SF history)  accounts/transactions/
                                                    transit-cards
provider-paypay          PayPay wallet balance      accounts/balances
provider-paypay-bank     PayPay Bank                accounts/balances/txns
provider-paypay-sec      PayPay Securities          + investments
client-nissay-401k       Nissay DC pension          pension read
starbucks-jp             Starbucks JP               points/prepaid balance
```

For Kogane these packages short-circuit phase 1 (capture analysis) for the
sources they cover: the endpoints, request shapes, and encodings are already
worked out, so the "characterize each site from captures" step is done for
SBI Securities, SMBC, Mobile Suica, and PayPay balances.

**Gap: no raw-evidence layer.** mnie's providers `fetch` and parse straight
to typed objects; the response bytes are not retained (its only SHA-256 use
is hashing an account id). That violates Kogane's first principle. Because
the transport is plain `fetch`, the fix is small: wrap `fetch` so the raw
response is written to `raw_objects` (keyed by SHA-256) *before* the
provider parses it. A Playwright-based tool could not be adapted this way;
mnie can.

**Plan:** depend on the provider packages, inject a raw-capturing `fetch`,
and treat their parse output as observations (recording the parser
version). The cleanest upstream contribution is a transport-injection hook.
Constrain adopted capabilities to read-only — `provider-sbi-sec` and
`provider-paypay-sec` expose `investments:trade`, which Kogane must never
enable.

### auth-bitwarden — credential source

`packages/auth-bitwarden` opens a local Bitwarden `data.json` (the desktop
app's synced state, not an export), derives the user key from the master
password (PBKDF2 or Argon2id), and can mint WebAuthn assertions from
vault-stored passkeys (`node:crypto` only) — used to log into SBI
Securities headlessly.

This fits our environment (Bitwarden + SBI Securities) and removes the need
for a second secret store. Its API is already scoped for least privilege:
`credentials(userKey, origin?)` and `passkeys(userKey, rpId?)` filter by
site, and the cookie jar has `export()` / `import()`, so a single
authenticated session can be handed out without exposing the whole vault.

The auth architecture that follows from this is important enough to have its
own section below.

## hirano00o/acctf — scraper reference only (third-party, MIT)

[hirano00o/acctf](https://github.com/hirano00o/acctf) scrapes banks and
brokers (Sumishin SBI Net Bank, WealthNavi; exact list to verify) for
transaction history, holdings, **cost basis**, and current price. It is
Go + Playwright.

- **Useful as a reference**: it captures acquisition cost, which most
  aggregators drop, and it covers Sumishin SBI Net Bank — the institution
  with the most easily-missed separate balances (purpose accounts, SBI
  hybrid deposit).
- **Not adopted**: Go does not run on Workers, and Playwright is browser
  automation (the lowest-preference collection method, and hard to run on
  Cron). Read it for *which DOM nodes / endpoints hold which data*, then
  implement via replayed internal APIs where possible.

## Type model as prior art

mnie's `packages/mnie-types` arrives independently at nearly the same
conclusions as `docs/design.md`, and is worth reading as a design review of
phases 3, 6, and 7:

```text
mnie                                     kogane design
---------------------------------------  ------------------------------------
TransactionObservation ("one account's   observation: "source X says Y"
  view, not a claim another account
  observed the same event")
source.fingerprint / revision /          pending -> posted is a link,
  firstSeenAt / lastSeenAt                 not an update
EconomicEvent + Posting (debit/credit,   economic_events + event_legs
  role source/dest/fee/tax)
MatchEvidence (same-amount /             observation_links
  time-distance / account-link /           (method / confidence)
  reference-id)
Amount = money | points(programId,unit)  reward units are not currencies
Money.value as decimal string            never REAL for money
completeness: partial | complete         events not forced to balance
```

These are interface definitions only (no storage, no raw layer), so they
inform the schema without constraining it.

## Auth and execution: local auth, cloud ingestion

Reusing `auth-bitwarden` raises the question of where credentials and
scraping live. The decision: **authenticated fetching runs locally;
Cloudflare only ingests, stores, parses, and computes.** Credentials never
leave the local machine.

```text
Local (always-on machine / scheduled task)
  - open Bitwarden vault, extract only the needed site credential
    or cookie jar (never the whole vault)
  - run authenticated providers (mnie clients, smcc downloader)
  - POST raw bytes + SHA-256 to the ingestion API

Cloudflare (holds no credentials, only a bearer token)
  - ingestion API / R2 / D1 / parsers (A->B) / derived calc
```

This matches `docs/collection.md` ("the importer is a local CLI",
"ingestion must stay dumb") and keeps the blast radius small: a compromised
Worker exposes ingested financial evidence, not the Bitwarden vault (which
holds far more than finance — identity, government, university accounts).

Reasons not to run authenticated scraping on Workers/Containers, even though
it is *technically* close to possible:

- **Egress IP and geolocation.** Worker fetches originate from Cloudflare
  data-center IPs. Japanese financial sites treat unfamiliar IPs and
  overseas locations as anomalies (extra auth, temporary lock). Running
  from a stable local IP avoids this; it is a functional blocker, not only
  a security one. Containers give a real runtime (custom TLS/HTTP client)
  but share the same Cloudflare egress.
- **TLS/HTTP fingerprint.** Workers normalize header order and HTTP/2
  behavior, so requests cannot be shaped to resemble a browser; WAFs that
  fingerprint clients may reject them.
- **Argon2id.** `auth-bitwarden` uses a native Rust addon
  (`@node-rs/argon2`) for Argon2id KDF, which does not run on Workers.
  PBKDF2 vaults derive fine with `node:crypto`; an Argon2id vault would
  have to derive the user key locally and pass 32/64 raw bytes instead.
  Moot once auth is local-only.

If no always-on local machine is available, a Container is an acceptable
compromise for the *fetch* step — but it must receive a per-site credential
or cookie jar, never the whole vault, and the geolocation limitation still
applies.

`kuebiko` capture and any APK/endpoint reverse-engineering also stay local
by nature; only the dumb ingestion API and the re-derivable layers above it
belong on Cloudflare.

## Preference order, revised

The source-onboarding order in `docs/collection.md` is unchanged, but the
existing tools change what "cheapest" means per source:

1. Official CSV / OFX export — still first where it exists.
2. Replayed internal API — **already implemented** by mnie for SBI Sec,
   SMBC, Mobile Suica, PayPay; by smcc-meisai-scraper for the Vpass card.
3. Email statements.
4. Browser automation — acctf as a *reference* for what to extract.
5. Manual entry / kuebiko-only capture for long-tail sources.
