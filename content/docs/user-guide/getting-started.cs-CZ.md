---
title: Začínáme
description: Přihlášení, průvodce prvním spuštěním a orientace v prostředí.
---

<span id="signing-in" />

## Přihlášení

Otevřete svou adresu Klepna v prohlížeči a přihlaste se pomocí svého e-mailu a hesla. Na nové instanci s vlastním hostingem se první zaregistrovaný účet stává administrátorem.

Pokud vaše organizace používá jednotné přihlašování, na přihlašovací obrazovce se místo toho zobrazí jedno tlačítko, například **Přihlásit se přes Keycloak**. Váš účet se vytvoří při prvním přihlášení. Registrace může být na vaší instanci uzavřená; v tom případě požádejte svého administrátora o přístup.

<span id="the-first-run-wizard" />

## Průvodce prvním spuštěním

Při prvním otevření Klepny Vám krátký průvodce pomůže připojit služby, které používáte. Všechny integrace jsou nepovinné. Google, pošta a Claude se zobrazí jen tehdy, když jsou na Vaší instanci povolené.

Na instanci s vlastním hostingem a Organizací už máte k dispozici sdílené nahrávky a služby. Připojte jen své osobní zdroje. Pokud zvolení poskytovatelé Organizace pokrývají přepis a shrnutí, krok s AI se vynechá a závěrečný přehled uvede jejich názvy. Poskytovatel Claude Code nebo Codex z Organizace může vytvářet shrnutí, ale neumí přepisovat nahrávky. Pokud některá role chybí, průvodce ji pojmenuje a otevře nastavení poskytovatelů. Zavřením Nastavení nebo volbou **Zpět do průvodce** se vrátíte ke stejnému kroku a stav se znovu ověří.

Účet Organizace při volbě **Spustit nastavení znovu** vidí jen sdílené poskytovatele AI, výchozí volby a profily zpracování. Členové připojují osobní integrace ze svých účtů.

| Krok | Co dělá |
| --- | --- |
| ![Vítejte](images/onboarding-welcome.png) | **Vítejte.** Co Klepna umí: synchronizuje nahrávky, přepisuje je a pomocí AI je shrnuje. |
| ![Připojení účtu Plaud](images/onboarding-plaud.png) | **Připojte účet nahrávače.** Přihlaste se rozšířením prohlížeče, pomocí kódu zaslaného e-mailem nebo vložením tokenu. Poté Klepna začíná pravidelně stahovat Vaše nahrávky. Na vlastní doméně přidejte tento web ve vyskakovacím okně Plaud Connectoru a stránku znovu načtěte. |
| ![Poskytovatel AI](images/onboarding-ai-provider.png) | **Nastavte poskytovatele AI.** Otevře Nastavení, kde přidáte službu pro přepisy a shrnutí. Viz [Poskytovatelé AI](settings.md#ai-providers). |
| Kalendář Google a Meet (pokud jsou nastavené) | **Připojte Kalendář Google a Meet.** Přístup jen pro čtení pomůže rozpoznat schůzky a navrhnout mluvčí podle pozvaných hostů a účastníků Meet. |
| Nahrávání schůzek | **Nastavte nahrávání schůzek.** Nainstalujte rozšíření, otevřete jeho ikonu na liště a povolte tento web. Zde klikněte na **Připojit**, potom v rozšíření na **Confirm**. Postupujte podle výzev k souhlasu a zjištěného stavu; současné rozšíření může po souhlasu vyžadovat další otevření ikony na liště. Pokud se zobrazí upozornění, povolte v rozšíření mikrofon, jinak se Váš hlas nenahraje. Ruční připojení pomocí URL a klíče zůstává k dispozici. |
| E-mail (pokud je nastavený) | **Posílejte e-maily do Klepny.** Vaše adresa nepotřebuje nastavení. Posílejte nebo přeposílejte ze své firemní adresy. Pro automatické přeposílání od jiných odesílatelů použijte tajnou adresu v Nastavení → Pošta. Adresy se generují pro každou vlastní složku a mění se v jejím záhlaví. Pošta zaslaná v poli Komu nebo Kopie do složky Organizace čeká, až ji s Organizací nasdílíte. Průvodce ukáže i pozastavený příjem nebo nesplněné podmínky. |
| Claude (pokud je nastavený) | **Připojte Claude.** V Claude na claude.ai nebo v desktopové aplikaci otevřete **Customize → Connectors**, najděte firemní konektor, klikněte na **Connect** a přihlaste se firemním účtem. V konverzaci ho zapněte přes **+ → Connectors**. Pokyny pro osobní tarify a Claude Code jsou pod **Není v seznamu?**. Volba **Už mám nastaveno** zaznamená Vaše potvrzení, nikoli ověřené připojení. Viz [Claude](claude.md). |
| ![Hotovo](images/onboarding-done.png) | **Vše je připraveno.** Klikněte na **Začít**. |

Průvodce můžete znovu otevřít z uživatelské nabídky přes **Spustit nastavení znovu**. Dokončené nastavení se tím nevynuluje. Závěrečný přehled ověří existující připojení i po návratu z přihlášení ke Googlu, aniž byste museli znovu navštívit předchozí kroky. **Další** pokračuje; přeskočení zaznamená jen **Přeskočit**. Probíhající či neúspěšné ověření a nutnost opětovného připojení se zobrazují samostatně.

<span id="finding-your-way-around" />

## Orientace v prostředí

![Obrazovka Nahrávky](images/dashboard.png)

Horní lišta obsahuje tři sekce:

- **Nahrávky**: vaše knihovna. Vlevo zůstává seznam a panel složek, vpravo je detail vybrané nahrávky. Ještě před první nahrávkou můžete pomocí **Nová složka** knihovnu uspořádat, nebo rovnou synchronizovat či nahrát soubor.
- **Almanach**: osoby a objekty, o kterých Klepna ví. Odznak ukazuje počet kontrol čekajících na vás. Viz [Almanach](almanac.md).
- **Úkoly**: akční položky sledované napříč Vašimi nahrávkami a poštou. Odznak ukazuje nové úkoly a návrhy pro Vás. Viz [Shrnutí a úkoly](summaries-and-tasks.md#the-tasks-page).

Vpravo v liště:

- **Hledat** (nebo `Ctrl`/`⌘` + `K`) otevře příkazovou paletu.
- **Synchronizovat zařízení** okamžitě stáhne nové nahrávky z cloudu vašeho nahrávače, místo čekání na další automatickou synchronizaci.
- **Nahrát** přidá zvukový nebo video soubor z vašeho počítače. Tlačítko je dostupné také v Úkolech, Almanachu a Nastavení. Po nahrání se otevřou Nahrávky, nová položka bude vybraná a její pracovní postup bude na začátku.
- Kulaté tlačítko s vaším iniciálou otevře nabídku účtu: **Nastavení**, **Klávesové zkratky**, režim světlý/tmavý a **Odhlásit se**.

<span id="getting-help" />

## Získání pomoci

Klikněte na **Nápověda** v horní liště nebo stiskněte `h` pro otevření této příručky vedle vaší práce, v kapitole týkající se aktuální obrazovky. Na stránce nahrávky se otevře [Přepisy](transcripts.md), na stránce Úkoly [Stránka Úkoly](summaries-and-tasks.md#the-tasks-page), v Nastavení se otevře právě zvolená sekce.

![Panel nápovědy vedle nahrávky](images/help-drawer.png)

- **Kapitola** nahoře v panelu umožňuje přepnout na jinou kapitolu.
- **Otevřít celou příručku** otevře stejnou stránku v nové záložce s navigací a vyhledáváním.
- Malé **?** u některých funkcí, například na kartách Přepis a Shrnutí, v kontrole poznatků z Učení nebo u nastavení exportu složek, otevře panel přímo u této funkce.

Celá příručka je také dostupná na `/docs` na vaší adrese Klepna v sekci **Uživatelská příručka**.

![Uživatelská příručka na /docs](images/docs-user-guide.png)

<span id="the-command-palette" />

## Příkazová paleta

![Příkazová paleta](images/command-palette.png)

Paleta během psaní vyhledává v názvech i přepisech. Stiskněte `Enter` pro otevření nahrávky, nebo `⌘` + `Enter` pro přepis nahrávky, která ještě nemá přepis. Umí také spustit akce jako **Synchronizovat zařízení**, **Nahrát** nebo **Otevřít nastavení**.

<span id="keyboard-shortcuts" />

## Klávesové zkratky

| Klávesy | Akce |
| --- | --- |
| `⌘`/`Ctrl` + `K` | Příkazová paleta |
| `?` | Seznam zkratek |
| `h` | Otevřít tuto příručku na aktuální obrazovce |
| `,` | Nastavení |
| `/` | Hledat v seznamu nahrávek |
| `j` / `k` | Další / předchozí nahrávka |
| `Space` | Přehrát nebo pozastavit |
| `←` / `→` | Posun zpět / vpřed o 5 vteřin |
| `↑` / `↓` | Hlasitost |

<span id="language" />

## Jazyk

Klepna komunikuje anglicky i česky. Řídí se jazykem vašeho prohlížeče, dokud si v **Nastavení → Zobrazení → Jazyk** nezvolíte jiný. E-maily, které vám Klepna zasílá, se také posílají ve stejném jazyce.

Pokračujte: [Zpracování a profily](processing-and-profiles.md)
