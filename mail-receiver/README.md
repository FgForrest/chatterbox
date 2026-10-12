# mail-receiver

Inbound mail for Klepna: every user with a single sign-on account gets
`<name>@MAIL_DOMAIN`, every folder `<name>+<alias>@`, every Organization
folder `<nick>-<alias>@`, and anything sent there lands, encrypted, in the
Chatter pile. This container is the SMTP server in front of it. It accepts
mail for one domain, from Google's sending servers only, never relays,
never authenticates clients and never sends mail.

## How a message gets in

1. Google's MTA connects to port 25, directly or through a TCP proxy (see
   [Behind a TCP proxy](#behind-a-tcp-proxy)). Connections from anywhere
   else are refused (`MAIL_ALLOWED_SOURCES`, default `google`: the ranges of
   `_spf.google.com`, refreshed every six hours).
2. `RCPT TO` for another domain gets `550 5.7.1`. Up to 100 recipients.
3. After `DATA` the receiver verifies DKIM (at most three signatures, those
   of the From domain first) and asks the app which recipients would pass
   (`/api/internal/mail/precheck`, metadata only).
4. Only if some would, it sends the raw message to
   `/api/internal/mail/ingest`, with its length and SHA-256. The app
   verifies DKIM again itself, parses, applies the policy per recipient and
   stores.
5. Every recipient of the domain gets `250` whatever the app decided:
   nothing tells a sender which addresses exist. Refusals are listed in the
   address owner's delivery log (Settings, Mail). `452` when an owner is over
   their daily limit, `451` when the app cannot be reached (Google retries
   for days, then bounces), `552` past `MAIL_MAX_MESSAGE_MB`.

Who may send where:

| Address | Files into | Accepted from |
| --- | --- | --- |
| `jan@` | Jan's pile, unfiled | Jan's own mail, DKIM-signed by his domain |
| `jan+weekly@` | Jan's folder | the same |
| `acme-weekly@` | waits in the sender's pile to be shared into the Organization folder | any active user, when the address is in a signed To or Cc |
| `jan.<token>@` | what the address it extends files into | anyone (marked "sender not verified" without a matching signature) |

SPF never authorizes: DMARC passes on an SPF alignment alone, which would
let anyone sending through Google spoof a user.

## Configuration

App (`.env`): `MAIL_DOMAIN`, `MAIL_ADDRESS_HASH_SECRET`, `MAIL_INGEST_SECRET`
(both `openssl rand -hex 32`), optionally `MAIL_ORG_NICKNAME` (default `org`),
`MAIL_FORMER_ORG_NICKNAMES`, `MAIL_MAX_SIGNATURE_AGE_HOURS` (72),
`MAIL_DAILY_LIMIT` (500), `MAIL_MAX_MESSAGE_MB` (36), `MAIL_INACTIVE_DAYS`
(180). Mail needs single sign-on: an address belongs to an email the identity
provider vouched for.

Receiver: `MAIL_HOSTNAME` (the MX name, also the TLS certificate's name),
`MAIL_TLS_DIR` (holding `fullchain.pem` and `privkey.pem`), optionally
`MAIL_ALLOWED_SOURCES` and `MAIL_PROXY_PROTOCOL_FROM`. Start with
`docker compose --profile mail up -d`.

The image: the `Mail receiver image` workflow publishes it next to the app
image as `ghcr.io/<owner>/<repository>-mail-receiver`, with the app's tags
(`dev` from `main`, `latest` and `X.Y.Z` from releases). Without an override
compose builds it from the checkout as `chatterbox-mail-receiver:local`.

The base compose file binds the receiver to `127.0.0.1:2525`. Publish port
25, and on a host without the source pull the published image, in the
deployment's override:

```yaml
services:
  mail-receiver:
    image: ghcr.io/<owner>/<repository>-mail-receiver:dev
    ports: !override
      - "25:2525"
```

## Behind a TCP proxy

The source check needs the client's address. When port 25 lives on another
host that forwards TCP to the receiver, the receiver sees only the proxy,
unless the proxy prepends a PROXY protocol header naming the client. Set
`MAIL_PROXY_PROTOCOL_FROM` to the addresses the proxies connect from, as the
receiver sees them: comma-separated plain IP addresses, no ranges, hostnames
or `*`. The receiver then reads the header before its greeting and checks,
counts and limits the client it names. The override publishes the receiver's
port for the proxy (`"2525:2525"`) instead of port 25; the proxy's side, in
HAProxy:

```
backend mail-receiver
    mode tcp
    server receiver 198.51.100.20:2525 send-proxy check
```

- Version 1 only: HAProxy `send-proxy`, not `send-proxy-v2`; nginx `stream`
  with `proxy_protocol on;`.
- Only a listed peer's header is read. Any other peer is a direct client,
  and a listed peer that does not start with a valid header is disconnected.
  Still open the receiver's port to the proxy alone at the firewall.
- STARTTLS stays end to end: the proxy forwards TCP, the receiver keeps the
  certificate for `MAIL_HOSTNAME`, whose `A` record now points at the proxy.
- Health checks: a plain TCP check (HAProxy `check`) works, whether or not
  it sends the header (`check-send-proxy`). One that waits for the greeting
  (`option smtpchk`) does not: with the header the connection counts as the
  proxy's own, which is no allowed source, and gets `554`; without it,
  nothing. Do not add the proxy to `MAIL_ALLOWED_SOURCES` to make it pass.

## The app's internal endpoints

`/api/internal/mail/precheck` and `/api/internal/mail/ingest` answer only a
request carrying `MAIL_INGEST_SECRET` as a bearer token (failures are rate
limited per client), and 404 on the admin host or while mail is off. The
app cannot tell the receiver's requests from public ones by their route, so
keep them off the internet as well:

- the receiver reaches the app over the compose network (`http://app:3000`);
- the public reverse proxy routes nothing under `/api/internal/` to the app;
- the app's port is not published to the internet when a proxy fronts it.

## DNS and mail-system settings (company admins)

- `MX` record of the mail domain pointing at `MAIL_HOSTNAME`, and its `A`
  record; a certificate for that name (STARTTLS).
- `TXT` `v=spf1 -all` on the mail domain and `_dmarc.<mail domain>` with
  `p=reject`: the domain never sends, and a parent domain's `sp=none` would
  leave it spoofable.
- Google Workspace: allow automatic forwarding only for the organizational
  unit of Klepna users (it is an exfiltration switch); a TLS-compliance rule
  for the mail domain; rotate the company's DKIM key to 2048 bits.
- Firewall: TCP 25 to this host only; behind a TCP proxy, TCP 25 to the
  proxy and the receiver's port from the proxy alone.
- Before rollout: a data-protection assessment for storing and mining mail
  of third parties.

## Checks after the first deployment

- Send a mail to `<you>@MAIL_DOMAIN` from your own account: it appears in
  your pile.
- Forward one, CC one, BCC one: all appear. CC an Organization address: it
  waits in your pile to be shared. BCC an Organization address: refused,
  listed in your delivery log.
- A Gmail filter forwarding to a secret address: Gmail first sends a
  confirmation code, which lands in your pile; enter it in Gmail.
- A mail with a forged From from an outside server: refused at connect (not
  Google), or, through Google, listed as refused in the owner's log.
- That Google's signatures cover `to` and `cc` (`h=` in the DKIM-Signature):
  Organization addresses depend on it.
