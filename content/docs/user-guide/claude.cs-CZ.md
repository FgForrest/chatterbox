---
title: Riffado v Claude
description: Ptejte se Claude nebo Claude Code na své nahrávky, lidi a úkoly.
---

Pokud to Váš administrátor nastavil, Claude za Vás umí vyhledávat v Riffadu. Prohledá Vaše přepisy, přečte shrnutí, řekne Vám, kdo je někdo v Almanachu, nebo vypíše Vaše otevřené úkoly. Ptáte se vlastními slovy a Claude si vybere, co vyhledat.

Funguje v Claude na webu (claude.ai), v desktopové a mobilní aplikaci Claude, v Cowork a v Claude Code.

<span id="what-claude-can-see" />

## Co Claude vidí

Claude vidí to, co vidíte Vy v Riffadu, a nikdy víc:

- **Nahrávky**: Vaše vlastní a ty sdílené s Organizací, tak jak je ukazuje Váš seznam nahrávek.
- **Almanach**: Vaše osoby a věci a ty z Organizace.
- **Úkoly**: úkoly u Vašich nahrávek a u sdílených nahrávek ty, které jsou přiřazené Vám.

Které oblasti máte otevřené, určuje Váš administrátor: Almanach, přepisy, shrnutí, úkoly a změny úkolů. Claude dostane nabídnuté jen vyhledávání pro Vaše oblasti, takže může říct, že se k něčemu nedostane, i když to v aplikaci vidíte.

Claude může změnit jedinou věc: s právem měnit úkoly umí úkol označit jako hotový, znovu otevřít, zrušit nebo přiřadit někomu jinému, tam kde by Vám to dovolila stránka Úkoly. Vše ostatní je jen pro čtení. Riffado zaznamenává každé vyhledávání (co se hledalo a kterých nahrávek či záznamů se týkalo), nikdy ne to, na co jste se ptali ani co Claude odpověděl.

<span id="before-you-connect" />

## Než se připojíte

Jednou se přihlaste přímo do Riffada v prohlížeči. Claude se nemůže připojit za někoho, koho Riffado nikdy neviděl.

<span id="connecting-claude" />

## Připojení Claude

**Pokud Vaše organizace používá Claude Team nebo Enterprise**, administrátor Riffado přidal pro všechny:

1. V Claude otevřete **Customize → Connectors**.
2. Najděte **Riffado** se štítkem **Custom** a klikněte na **Connect**.
3. Otevře se přihlašovací stránka Vaší organizace. Přihlaste se stejně jako do Riffada.

**Pokud používáte osobní tarif Claude** (Free, Pro nebo Max), administrátor Vám dá vlastní client ID a tajemství:

1. V Claude otevřete **Customize → Connectors → Add custom connector**.
2. Zadejte název **Riffado** a adresu od administrátora, která končí na `/api/mcp`.
3. V **Advanced settings** zadejte své client ID a tajemství. Pokud jste dostali i klíč, přidejte ho v **Request headers** jako `x-api-key`.
4. Klikněte na **Add**, pak na **Connect** a přihlaste se.

Tajemství si nechte pro sebe, stejně jako heslo.

Riffado v konverzaci zapnete přes **+** v poli zprávy, volbu **Connectors** a přepínač u Riffada.

<span id="connecting-claude-code" />

## Připojení Claude Code

Claude Code se připojuje z Vašeho počítače, takže funguje ve firemní síti nebo přes VPN. V terminálu, s adresou od administrátora:

```bash
claude mcp add --transport http --client-id claude-code riffado https://riffado.example.com/api/mcp
```

Pak v Claude Code napište `/mcp`, vyberte **riffado** a přihlaste se v okně prohlížeče, které se otevře.

<span id="what-to-ask" />

## Na co se ptát

Ptejte se tak, jako byste se ptali kolegy, který všechno četl:

- „Na čem jsme se s Bluefin Logistics dohodli ohledně harmonogramu Harboru?“
- „Shrň, co Priya Raman řekla na úvodní schůzce k Harboru.“
- „Kdo je Marek Dvořák a co o něm víme?“
- „Které moje úkoly jsou po termínu?“
- „Označ úkol o přístupu k Dispatch API jako hotový.“

Jména fungují všude, kde by Claude jinak potřeboval ID: osoby, věci a nahrávky se najdou podle jmen, přezdívek a názvů. Když jméno může znamenat víc lidí, Claude dostane kandidáty a měl by se Vás zeptat, kterého myslíte.

Hledání prochází nahrávky od nejnovější a po několika stovkách skončí, protože vše je uložené šifrovaně a pro hledání se musí dešifrovat. Claude se dozví, když hledání nedošlo k nejstarším nahrávkám, a může hledat dál do minulosti. Když uvedete měsíc, projekt nebo nahrávku, odpověď bude rychlejší a přesnější.

Přepisy jsou to, co lidé v nahrávkách řekli. Claude má pokyn brát je jako informace, ne jako instrukce k provedení. Přesto kontrolujte, co za Vás Claude mění, zvlášť v Cowork, který pracuje sám.

<span id="staying-connected" />

## Trvání připojení

Claude zůstane přihlášený, dokud přes něj Riffado použijete aspoň jednou za 30 dní. Po delší přestávce Vás požádá o nové přihlášení.

Když administrátor změní, co smíte vidět, odebraná oblast přestane fungovat do 15 minut. Nová oblast se objeví, jakmile konektor obnovíte v **Customize → Connectors**, nebo se odpojíte a připojíte znovu.

Pro ukončení zvolte **Disconnect** (nebo **Remove**) v **Customize → Connectors**. V Claude Code spusťte `claude mcp remove riffado`. Tam také můžete vypnout jednotlivá vyhledávání, například to, které mění úkoly, nastavením na **Blocked**.

<span id="when-it-does-not-work" />

## Když to nefunguje

| Co se stane | Co dělat |
| --- | --- |
| Přihlašovací stránka ukáže chybu | Řekněte administrátorovi, co hlásí; je potřeba upravit klienta nebo nastavení přihlášení. |
| Claude hned po přihlášení říká, že konektor nemůže použít | Jednou se přihlaste do Riffada v prohlížeči a připojte se znovu. Pokud to stále nejde, zeptejte se administrátora: log Riffada uvádí, proč přístup odmítl. |
| Claude se nedostane k přepisům, shrnutím nebo úkolům | Tuto oblast nemáte otevřenou. Zeptejte se administrátora. |
| Vyhledávání odpoví „Unknown tool“ | Změnilo se, co smíte vidět. Obnovte konektor nebo se připojte znovu. |
| Claude Code se nepřipojí | Připojte se z firemní sítě nebo přes VPN. |

Dále: [Pro administrátory](administrators.md)
