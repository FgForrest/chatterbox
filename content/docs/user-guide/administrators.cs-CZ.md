---
title: Pro administrátory
description: Co je potřeba zapnout pro jednotlivé funkce na instanci s vlastním hostingem.
---

Většina funkcí Klepna funguje ihned po spuštění. Některé funkce však vyžadují nejprve určité nastavení instance. Zapínají se pomocí proměnných v `.env` (viz `.env.example`) a u některých z nich také pomocí dodatečných služeb v `docker-compose.yml`. Po změně libovolného z těchto nastavení vždy restartujte sadu služeb.

| Funkce | Co nastavit | Více informací |
| --- | --- | --- |
| [Organizace](organization.md) | `ORG_ACCOUNT_EMAIL`, `ORG_ACCOUNT_PASSWORD` (min. 12 znaků), volitelně `ORG_ACCOUNT_NAME` | [Organizace](../self-hosting/organization.mdx) |
| Jednotné přihlašování (Single sign-on) | `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, volitelně `OIDC_PROVIDER_NAME`, `OIDC_SCOPES`, `OIDC_SESSION_MAX_AGE` | [Jednotné přihlašování](../self-hosting/sso.mdx) |
| [Přístup od poskytovatele identity](#access-from-the-identity-provider) | `AUTHZ_MODE=idp`, `IDENTITY_PROVIDER=keycloak`, tři `KEYCLOAK_GROUP_*_ID`, `KEYCLOAK_VERIFIER_CLIENT_*` | [Jednotné přihlašování](../self-hosting/sso.mdx#authorization-from-the-identity-provider) |
| Uzavřená registrace | `DISABLE_REGISTRATION=true` | |
| [Export složek na disk](exports-backups-retention.md#to-a-disk) | `FILESYSTEM_EXPORT_HOST_PATH` (Docker) nebo `FILESYSTEM_EXPORT_ROOT` | |
| [Exporty na Google Drive](exports-backups-retention.md#to-google-drive) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_PICKER_API_KEY`, `GOOGLE_CLOUD_PROJECT_NUMBER`, volitelně `GOOGLE_WORKSPACE_DOMAINS` | [Google Drive](../self-hosting/google-drive.mdx) |
| Návrhy mluvčích z [Kalendáře a Meet](learn.md#calendar-meet-and-speaker-guesses) | tytéž proměnné Google a navíc API a rozsahy Kalendáře a Meet v Google Cloud | [Kalendář a Meet](../self-hosting/google-drive.mdx#calendar-and-meet) |
| [Pošta](mail.md) | jednotné přihlašování, `MAIL_DOMAIN`, `MAIL_ADDRESS_HASH_SECRET`, `MAIL_INGEST_SECRET`, profil `mail` s `MAIL_HOSTNAME` a `MAIL_TLS_DIR` a DNS | [níže](#inbound-mail) |
| Výchozí hodnoty pro [Nahrávání schůzek](../guides/meeting-recorder.mdx) | nic; volitelně `RECORDER_AUTO_RECORD_PLATFORMS`, `RECORDER_AUTO_STOP_QUIET_SECONDS`, `RECORDER_NOTICE_TEXT`, `RECORDER_LOCK_DEFAULTS` | [níže](#meeting-recorder-for-chrome) |
| Kam se zapisují zálohy | `BACKUP_STORAGE_PATH` | [Záloha a obnovení](../guides/backup-and-restore.mdx) |
| Větší nahrávání videí | `VIDEO_UPLOAD_MAX_BYTES` (výchozí 4 GiB) | |
| Poskytovatelé Claude Code a Codex | profil `agent-bridge` a `BRIDGE_TOKEN` | [níže](#claude-code-and-codex-subscriptions) |
| MCP server pro AI klienty a služby | `MCP_AUDIENCE` s jednotným přihlašováním, volitelně `MCP_ALLOWED_CLIENTS` | [Externí MCP server](../self-hosting/mcp.mdx) |
| [Klepna v Claude](claude.md) a Claude Code | klienti v Keycloaku, `MCP_PUBLIC_INGRESS_HEADER`, `MCP_PUBLIC_CLIENTS`, `MCP_CONNECTOR_KEYS`, veřejný vstup pro `/api/mcp` | [níže](#claude-and-claude-code) |
| [Hledání podle významu v Učení](learn.md) | profil `learn` a `EMBEDDING_BASE_URL` | [níže](#learn) |
| Limit pro automatické souhrny, témata a Učení | `AUTO_SUMMARY_RATE_LIMIT_PER_HOUR` | |

<span id="the-organization" />

## Organizace

Nastavení `ORG_ACCOUNT_EMAIL` a `ORG_ACCOUNT_PASSWORD` vytvoří při spuštění jeden účet organizace a poskytne všem uživatelům strom složek Organizace. Zadaný e-mail nesmí patřit existujícímu uživateli. Heslo sdělte osobě, která spravuje uživatele a exporty Organizace. Pokud využíváte jednotné přihlašování, heslo je volitelné.

Odebráním těchto dvou proměnných se Organizace nastaví jako pouze pro čtení: sdílený obsah zůstane viditelný a nic nebude smazáno.

<span id="single-sign-on" />

## Jednotné přihlašování

Při zadání třech proměnných `OIDC_` nabídne přihlašovací stránka tlačítko **Přihlásit se pomocí …**; zároveň je vypnuto heslové přihlašování, registrace i reset hesla. Jako redirect URI u svého poskytovatele identity zaregistrujte `<APP_URL>/api/auth/oauth2/callback/oidc`. Stávající účty se propojí při prvním přihlášení, pokud poskytovatel ověří e-mailovou adresu.

Pokud přidáte i `DISABLE_REGISTRATION=true`, mohou se přihlásit pouze osoby, které již mají účet. Chcete-li povolit přístup nové osobě, tuto volbu dočasně vypněte, restartujte, nechte ji jednou přihlásit a poté znovu zapněte.

<span id="access-from-the-identity-provider" />

## Přístup od poskytovatele identity

S `AUTHZ_MODE=idp` rozhoduje váš poskytovatel identity o každé osobě tři
věci:

- **Přístup do Klepna** (`use`): bez něj se nikdo nepřihlásí a jeho API
  klíče, záznamník schůzek i AI klienti přestanou fungovat.
- **Spravuje Organizaci** (`org.curate`): mění sdílené nahrávky ve
  zobrazení Organizace (jména mluvčích, Učení, opravy, názvy, shrnutí,
  témata, přepisy) pod svým vlastním jménem.
- **Spravuje přístup** (`access.manage`): vidí **Nastavení → Přístupy** a
  přepíná tam ostatním tato tři práva.

Práva jsou nezávislá: administrátor není kurátorem Organizace, pokud
nedostane obě práva, a ani jedno nefunguje bez přístupu. Klepna si
nevede žádný vlastní seznam: co přepnete v **Nastavení → Přístupy**, se
zapíše do skupin poskytovatele identity, s vlastním přihlášením
administrátora, a odtud se také čte zpět. Nikdo si nemůže odebrat vlastní
přístup ani správu přístupu.

Odebrání přístupu osobu okamžitě odhlásí, zde i u poskytovatele, a
zablokuje její API klíče a záznamník schůzek, dokud přístup znovu
nedostane; nahrávky čekající v jejím prohlížeči zůstanou zachovány. Pokud
ji poskytovatel odhlásit nedokáže, **Nastavení → Přístupy** osobu uvede
nahoře, dokud jí administrátor relace neukončí tlačítkem **Ukončit
relace**. Osoba deaktivovaná nebo smazaná u poskytovatele ztratí přístup do
`AUTHZ_VERIFICATION_MAX_AGE` (výchozí 30 minut) poté, co se to Klepna
dozví; jak rychle se to dozví váš poskytovatel, záleží na vašem IT.

[Jednotné přihlašování](../self-hosting/sso.mdx#authorization-from-the-identity-provider)
popisuje nastavení včetně příkazu, který připraví realm v Keycloaku a
prvního administrátora.

<span id="inbound-mail" />

## Příjem pošty

Se zapnutým příjmem pošty dostane každý, kdo se přihlásí přes jednotné přihlašování, adresu ve Vaší poštovní doméně, každá složka adresu, která do ní zařazuje, a každá složka Organizace adresu, na kterou mohou psát kolegové. Malý SMTP server, služba `mail-receiver` (profil compose `mail`), přijímá poštu pro tuto doménu pouze z odesílacích serverů Googlu a každou zprávu předá Klepně, která před zařazením ověří podpis odesílatele.

Potřebuje proměnné z tabulky, port 25 dostupný z internetu, záznam `MX` a certifikát pro `MAIL_HOSTNAME`. Stránka [Příjem pošty](../self-hosting/mail.mdx) popisuje všechny kroky, záznamy DNS a kontroly po prvním nasazení. Lidi odkažte na kapitolu [Pošta](mail.md).

<span id="meeting-recorder-for-chrome" />

## Nahrávání schůzek v Chromu

Rozšíření Nahrávání schůzek nepotřebuje na serveru žádné nastavení: lidé si ho nainstalují z Internetového obchodu Chrome přes **Nastavení → Nahrávání schůzek** a propojí ho ve třech krocích. Viz [Nahrávání schůzek](../guides/meeting-recorder.mdx).

Server může volitelně nastavit výchozí hodnoty pro všechny: které platformy schůzek se nahrávají jedním kliknutím (`RECORDER_AUTO_RECORD_PLATFORMS`), po kolika sekundách ticha se nahrávání zastaví (`RECORDER_AUTO_STOP_QUIET_SECONDS`), pravidla nahrávání zobrazená před zapnutím nahrávání jedním kliknutím (`RECORDER_NOTICE_TEXT`) a zda je lidé smějí vypnout (`RECORDER_LOCK_DEFAULTS`). Předejte je službě aplikace v `environment:` souboru `docker-compose.yml`; viz [Proměnné prostředí](../self-hosting/environment-variables.mdx#meeting-recorder).

<span id="claude-code-and-codex-subscriptions" />

## Claude Code a Codex předplatná

Můstek pro agenty umožňuje, aby souhrny, témata, názvy i Učení běžely na předplatném Claude nebo ChatGPT namísto API klíče:

```bash
echo "BRIDGE_TOKEN=$(openssl rand -hex 32)" >> .env
docker compose --profile agent-bridge up -d --build agent-bridge
```

Přihlaste můstek jednou ke službě Claude nebo Codex (viz `agent-bridge/README.md` v repozitáři). Poté v Klepna přidejte poskytovatele **Claude Code** nebo **Codex** a jako API klíč vložte token z můstku. Můstek nemá připravený obraz a neotevírá žádný port. Ve výchozím stavu zpracovává vždy jen jeden požadavek; pokud využíváte vícenásobné shrnování, zvyšte `BRIDGE_MAX_CONCURRENCY` na potřebný počet kol. Doporučujeme ponechat poskytovatele s API klíčem jako zálohu.

<span id="claude-and-claude-code" />

## Claude a Claude Code

Se zapnutým [externím MCP serverem](../self-hosting/mcp.mdx) se lidé mohou na své nahrávky ptát Claude (claude.ai, desktopová a mobilní aplikace, Cowork) a Claude Code, s přihlášením přes Váš realm v Keycloaku a v mezích svých rolí v něm. Claude přistupuje k aplikaci Klepna z cloudu Anthropicu, takže je potřeba:

1. V Keycloaku důvěrný klient `claude` pro konektor organizace, veřejný klient `claude-code` a jeden důvěrný klient pro každého, kdo se připojuje z osobního tarifu Claude.
2. Veřejný DNS název a reverzní proxy, která adresám Anthropicu (`160.79.104.0/21`) zpřístupní `/api/mcp` a jeho metadata, nic jiného, a tyto požadavky označí hlavičkou.
3. V `.env`: `MCP_ALLOWED_CLIENTS`, `MCP_PUBLIC_INGRESS_HEADER`, `MCP_PUBLIC_CLIENTS` a pro `X-API-Key` konektoru `MCP_CONNECTOR_KEYS`.
4. V Claude Owner jednou přidá konektor s ID a tajemstvím klienta `claude`; členové se pak připojí.

Stránka [Claude a Claude Code](../self-hosting/claude.mdx) obsahuje všechny kroky, kontroly i postup, když je připojení odmítnuto. Lidi odkažte na kapitolu [Klepna v Claude](claude.md).

<span id="learn" />

## Učení

Učení nepotřebuje žádné další nastavení kromě poskytovatele, který zapisuje souhrny. Dvě volitelné možnosti zvyšují jeho efektivitu:

- **Hledání podle významu.** `docker compose --profile learn up -d` spouští službu `embeddings` (cca 1,3 GB paměti; při prvním spuštění se stáhne 1,2 GB). Nastavte `EMBEDDING_BASE_URL=http://embeddings:11434/v1`.
- **Vyhledávání informací v reálném čase.** Pokud je za můstkem poskytovatel Claude Code nebo Codex, nastavte `LEARN_MCP_URL=http://app:3000/api/mcp/learn` a `LEARN_BRIDGE_URL=http://agent-bridge:8787/v1` (přesně kořenovou URL poskytovatele) a zvyšte `BRIDGE_TIMEOUT_MS` na `900000`. Model pak může dotazovat Almanach přímo během čtení místo toho, aby dostal vše v pokynu.

<span id="meeting-recorder-meetrec" />

## Záznamník schůzek (meetrec)

`meetrec` je malý linuxový nástroj pro záznam schůzek pořádaných v prohlížeči. Nahraje Váš mikrofon i ostatní účastníky do jednoho souboru Ogg/Opus, během nahrávání ukazuje hlasitost a končí po stisknutí `Ctrl`+`C`. Po dokončení nahrávku nahrajte do Klepna ručně. Vyžaduje PipeWire, `pactl`, FFmpeg s Opusem a Go pro sestavení:

```bash
go build -o meetrec ./cmd/meetrec && ./meetrec
```

Podrobnosti najdete v `cmd/meetrec/README.md` v repozitáři. Záznam ostatních osob vyžaduje jejich souhlas.

<span id="ai-providers-in-general" />

## Poskytovatelé AI obecně

Poskytovatele přepisu a souhrnů si každý uživatel přidává sám v nastavení. Pro tyto účely zde není potřeba nic dalšího. Instance provozované na vlastním hostingu mohou směřovat na lokální servery jako Ollama nebo LM Studio přes Docker síť, takže nahrávky nikdy neopustí vaše zařízení.
