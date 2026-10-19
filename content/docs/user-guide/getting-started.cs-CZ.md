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

Při prvním otevření Klepna vám krátký průvodce pomůže nastavit základní věci. Kroky s integracemi jsou nepovinné a zobrazí se jen tehdy, když je správce nastavil.

| Krok | Co dělá |
| --- | --- |
| ![Vítejte](images/onboarding-welcome.png) | **Vítejte.** Co Klepna umí: synchronizuje nahrávky, přepisuje je a pomocí AI je shrnuje. |
| ![Připojení účtu Plaud](images/onboarding-plaud.png) | **Připojte účet nahrávače.** Přihlaste se rozšířením prohlížeče, pomocí kódu zaslaného e-mailem nebo vložením tokenu. Poté Klepna začíná pravidelně stahovat vaše nahrávky. |
| ![Poskytovatel AI](images/onboarding-ai-provider.png) | **Nastavte poskytovatele AI.** Otevře Nastavení, kde přidáte službu pro přepisy a shrnutí. Viz [Poskytovatelé AI](settings.md#ai-providers). |
| Kalendář Google a Meet (pokud jsou nastavené) | **Připojte Kalendář Google a Meet.** Přístup jen pro čtení pomůže rozpoznat schůzky a navrhnout mluvčí podle pozvaných hostů a účastníků Meet. |
| Nahrávání schůzek | **Nastavte nahrávání schůzek.** Nainstalujte rozšíření pro Chrome a připojte je k této instanci Klepny. |
| E-mail (pokud je nastavený) | **Posílejte e-maily do Klepny.** Zkopírujte svou osobní adresu a posílejte nebo přeposílejte zprávy do Klepny. |
| Claude (pokud je nastavený) | **Připojte Claude.** Přidejte Klepna jako vlastní konektor do Claude nebo Claude Code. |
| ![Hotovo](images/onboarding-done.png) | **Vše je připraveno.** Klikněte na **Začít**. |

Průvodce můžete znovu otevřít z uživatelské nabídky přes **Spustit nastavení znovu**. Dokončené nastavení se tím nevynuluje.

<span id="finding-your-way-around" />

## Orientace v prostředí

![Obrazovka Nahrávky](images/dashboard.png)

Horní lišta obsahuje tři sekce:

- **Klepy**: vaše knihovna. Vlevo zůstává seznam a panel složek, vpravo je detail vybrané nahrávky. Ještě před první nahrávkou můžete pomocí **Nová složka** knihovnu uspořádat, nebo rovnou synchronizovat či nahrát soubor.
- **Almanach**: osoby a objekty, o kterých Klepna ví. Odznak ukazuje počet kontrol čekajících na vás. Viz [Almanach](almanac.md).
- **Úkoly**: akční položky sledované napříč Vašimi nahrávkami a poštou. Odznak ukazuje nové úkoly a návrhy pro Vás. Viz [Shrnutí a úkoly](summaries-and-tasks.md#the-tasks-page).

Vpravo v liště:

- **Hledat v Klepech**, **Hledat v Almanachu** nebo **Hledat v úkolech** (nebo `Ctrl`/`⌘` + `K`) otevře vyhledávání v aktuální sekci.
- **Nahrát** přidá zvukový nebo video soubor z vašeho počítače. Tlačítko je dostupné také v Úkolech, Almanachu a Nastavení. Po nahrání se otevřou Nahrávky, nová položka bude vybraná a její pracovní postup bude na začátku.
- Nabídka účtu **≡** je dostupná ve všech třech sekcích: **Nastavení**, **Klávesové zkratky**, **Nápověda**, **Spustit nastavení znovu**, **Synchronizovat zařízení**, světlý či tmavý režim a **Odhlásit se**. Nastavení organizace se zobrazí, pokud k němu máte přístup. **Synchronizovat zařízení** stáhne nové nahrávky hned, bez čekání na automatickou synchronizaci.

Na úzké obrazovce se vyhledávání, Nahrát a ≡ zobrazí jako tlačítka s ikonami. Ikony všech tří sekcí zůstávají viditelné, název má jen aktuální sekce.

<span id="getting-help" />

## Získání pomoci

Vyberte **≡ → Nápověda** nebo stiskněte `h` pro otevření této příručky vedle vaší práce, v kapitole týkající se aktuální obrazovky. Na stránce nahrávky se otevře [Přepisy](transcripts.md), na stránce Úkoly [Stránka Úkoly](summaries-and-tasks.md#the-tasks-page), v Nastavení se otevře právě zvolená sekce.

![Panel nápovědy vedle nahrávky](images/help-drawer.png)

- **Kapitola** nahoře v panelu umožňuje přepnout na jinou kapitolu.
- **Otevřít celou příručku** otevře stejnou stránku v nové záložce s navigací a vyhledáváním.
- Malé **?** u některých funkcí, například na kartách Přepis a Shrnutí, v kontrole poznatků z Učení nebo u nastavení exportu složek, otevře panel přímo u této funkce.

Celá příručka je také dostupná na `/docs` na vaší adrese Klepna v sekci **Uživatelská příručka**.

![Uživatelská příručka na /docs](images/docs-user-guide.png)

<span id="the-command-palette" />

## Příkazová paleta

![Příkazová paleta](images/command-palette.png)

Vyhledávání začíná v sekci, kterou máte otevřenou. Dvě tlačítka pod vyhledávacím polem ukazují aktuální sekci a **Všude**. Klávesou `Tab` mezi nimi přepnete bez zavření palety.

- **Klepy** hledají v nahrávkách a přepisech a nabízejí akce jako **Synchronizovat zařízení**, **Nahrát** a **Otevřít nastavení**. Klávesami `⌘`/`Ctrl` + `Enter` spustíte přepis vybrané nahrávky, která přepis ještě nemá.
- **Almanach** hledá osoby, věci všech typů a naučené přeslechy se správnými názvy. Výsledek ukazuje typ záznamu ve vašem jazyce a otevře jeho stránku v Almanachu.
- **Úkoly** prohledávají vaše i sledované úkoly. Otevřené jsou před hotovými, u každého je termín a zdrojová nahrávka. Vybraný úkol se otevře přímo, bez ohledu na filtry seznamu.
- **Všude** spojí výsledky ze všech sekcí a rozdělí je do skupin.

Výsledek vyberete šipkami `↑` a `↓`, otevřete klávesou `Enter` a paletu zavřete klávesou `Esc`. Vyhledávání v jednotlivých seznamech i filtry úkolů fungují dál nezávisle. Pokud vyhledávání hlásí, že mohou existovat další výsledky, upřesněte dotaz.

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
