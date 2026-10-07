---
title: Začínáme
description: Přihlášení, průvodce prvním spuštěním a orientace v prostředí.
---

<span id="signing-in" />

## Přihlášení

Otevřete svou adresu Riffado v prohlížeči a přihlaste se pomocí svého e-mailu a hesla. Na nové instanci s vlastním hostingem se první zaregistrovaný účet stává administrátorem.

Pokud vaše organizace používá jednotné přihlašování, na přihlašovací obrazovce se místo toho zobrazí jedno tlačítko, například **Přihlásit se přes Keycloak**. Váš účet se vytvoří při prvním přihlášení. Registrace může být na vaší instanci uzavřená; v tom případě požádejte svého administrátora o přístup.

<span id="the-first-run-wizard" />

## Průvodce prvním spuštěním

Při prvním otevření Riffado vám krátký průvodce pomůže nastavit základní věci. Jakýkoliv krok můžete přeskočit a vrátit se k němu později v Nastavení.

| Krok | Co dělá |
| --- | --- |
| ![Welcome](images/onboarding-welcome.png) | **Vítejte.** Co Riffado umí: synchronizuje nahrávky, přepisuje je a pomocí AI je shrnuje. |
| ![Connect Plaud](images/onboarding-plaud.png) | **Připojte účet nahrávače.** Přihlaste se rozšířením prohlížeče Riffado Connector, pomocí kódu zaslaného e-mailem nebo vložením tokenu. Poté Riffado začíná pravidelně stahovat vaše nahrávky. |
| ![AI provider](images/onboarding-ai-provider.png) | **Nastavte poskytovatele AI.** Otevře Nastavení, kde přidáte službu pro přepisy a shrnutí. Viz [Poskytovatelé AI](settings.md#ai-providers). |
| ![Done](images/onboarding-done.png) | **Vše je připraveno.** Klikněte na **Začít**. |

Pro zobrazení průvodce znovu přejděte do **Nastavení → Export/Záloha** a klikněte na **Znovu spustit úvodní nastavení**.

<span id="finding-your-way-around" />

## Orientace v prostředí

![Obrazovka Nahrávky](images/dashboard.png)

Horní lišta obsahuje tři sekce:

- **Nahrávky**: vaše knihovna. Vlevo je seznam nahrávek, vpravo detail vybrané nahrávky.
- **Almanach**: osoby a objekty, o kterých Riffado ví. Odznak ukazuje počet recenzí čekajících na vás. Viz [Almanach](almanac.md).
- **Úkoly**: akční položky nalezené ve vašich nahrávkách. Odznak ukazuje nové úkoly přiřazené vám. Viz [Shrnutí a úkoly](summaries-and-tasks.md#the-tasks-page).

Vpravo v liště:

- **Hledat** (nebo `Ctrl`/`⌘` + `K`) otevře příkazovou paletu.
- **Synchronizovat zařízení** okamžitě stáhne nové nahrávky z cloudu vašeho nahrávače, místo čekání na další automatickou synchronizaci.
- **Nahrát** přidá zvukový nebo video soubor z vašeho počítače.
- Kulaté tlačítko s vaším iniciálou otevře nabídku účtu: **Nastavení**, **Klávesové zkratky**, režim světlý/tmavý a **Odhlásit se**.

<span id="getting-help" />

## Získání pomoci

Klikněte na **Nápověda** v horní liště nebo stiskněte `h` pro otevření této příručky vedle vaší práce, v kapitole týkající se aktuální obrazovky. Na stránce nahrávky se otevře [Přepisy](transcripts.md), na stránce Úkoly [Stránka Úkoly](summaries-and-tasks.md#the-tasks-page), v Nastavení se otevře právě zvolená sekce.

![Panel nápovědy vedle nahrávky](images/help-drawer.png)

- **Kapitola** nahoře v panelu umožňuje přepnout na jinou kapitolu.
- **Otevřít celou příručku** otevře stejnou stránku v nové záložce s navigací a vyhledáváním.
- Malé **?** u některých funkcí, například na kartách Přepis a Shrnutí, v recenzi Učit se nebo u nastavení exportu složek, otevře panel přímo u této funkce.

Celá příručka je také dostupná na `/docs` na vaší adrese Riffado v sekci **Uživatelská příručka**.

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

Riffado komunikuje anglicky i česky. Řídí se jazykem vašeho prohlížeče, dokud si v **Nastavení → Zobrazení → Jazyk** nezvolíte jiný. E-maily, které vám Riffado zasílá, se také posílají ve stejném jazyce.

Pokračujte: [Nahrávky](recordings.md)
