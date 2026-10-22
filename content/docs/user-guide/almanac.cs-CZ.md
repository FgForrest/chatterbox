---
title: Almanach
description: Lidé a věci, které Klepna zná, jejich přezdívky a fakta.
---

Almanach obsahuje vše, co Klepna ví o lidech a věcech, o kterých Vaše nahrávky hovoří: kdo je kdo, na čem kdo pracuje, jak se jmenuje projekt a jak bývá často špatně rozuměn. Přepis, Učení, souhrny a úkoly z něj vycházejí.

Obsahuje čtyři karty: **Lidé**, **Věci**, **Slovník** a **Kontrola**.

<span id="people" />

## Lidé

![Lidé](images/almanac-people.png)

Každý, koho jste pojmenovali jako řečníka, je zde, včetně počtu nahrávek, ve kterých je slyšet. **Přidat osobu** umožní přidat někoho ještě před tím, než promluví. Lidé označení jako **Organizace** pocházejí z nahrávek sdílených s Organizací (viz [Organizace](organization.md)).

Kliknutím na osobu otevřete její stránku:

![Osoba](images/almanac-person.png)

- **Také známý jako**: přezdívky a jiné varianty jmen. Vyhledávání podle nich osobu najde a Učení je rozpoznává v přepisech.
- **Poznámky**: cokoli si chcete zapamatovat. U organizačních osob jsou poznámky Vaše vlastní.
- **Co je známo**: fakta jako *pracuje pro Bluefin Logistics* nebo *má roli provozního ředitele*. **Přidat faktum** umožní zvolit vztah a druhou stranu z Almanachu, nebo použít prostý text. Klepna odmítá fakta o zdraví, rodině, osobnosti, výkonnosti nebo demografii.
- **Nahrávky**: kde tato osoba mluví.
- **To jsem já** určuje aplikaci Klepna, která osoba jste Vy. Učení pak ví, kdo nahrávku vytvořil, a Vaše úkoly se zobrazují pod záložkou **Moje**.
- **Přejmenovat**, **Sloučit do…** (pokud dvě položky představují tutéž osobu) a **Smazat**.

<span id="things" />

## Věci

![Věci](images/almanac-things.png)

Almanach používá základní typy **Osoba**, **Organizace**, **Tým**, **Projekt**, **Produkt nebo systém**, **Pojem**, **Místo** a **Dokument**. Věci můžete vyhledat, filtrovat podle typu, nebo kliknout na **Přidat věc**.

![Věc](images/almanac-thing.png)

Stránka věci má stejné části jako stránka osoby: přezdívky, popis, fakta a nahrávky, s možnostmi **Upravit**, **Změnit typ**, **Sloučit do…** a **Smazat**.

<span id="importing-a-list" />

### Import seznamu

Volba **Importovat seznam** na kartě Věci umožňuje přidat více názvů najednou. Napište každý typ na samostatný řádek: typ, dvojtečka a názvy oddělené čárkou, přičemž přezdívky uveďte v závorkách:

```
project: Harbor phase 2
product: Pathfinder Lite (PF Lite)
location: Rotterdam depot, Antwerp depot
```

V seznamu pro import zůstávají anglické klíče `project`, `product` a `location`. V náhledu se jejich typy zobrazí jako **Projekt**, **Produkt nebo systém** a **Místo**.

Kliknutím na **Náhled** se zobrazí, co bude přidáno, než cokoliv uložíte:

![Náhled importu](images/almanac-import.png)

<span id="vocabulary" />

## Slovník

**Slovník** zobrazuje druhy věcí a vztahů, které jste vytvořili nad rámec základních. Zde je můžete spravovat—ponechat, přejmenovat, sloučit nebo smazat. V Organizaci zde účet organizace rozhoduje o vztazích, které navrhli členové.

<span id="review" />

## Kontrola

![Co čeká na kontrolu](images/almanac-review.png)

**Kontrola** shromažďuje kontroly položek čekající na Vaše posouzení: běhy [Učení](learn.md) a navržené úkoly z nahrávky nebo pošty. Odznak na **Almanachu** tyto kontroly položek počítá. Změny úkolů předané Vám proto, že je můžete použít pouze Vy, čekají pod **Úkoly → Návrhy pro vás** a mají vlastní odznak v navigaci. Viz [Směrované návrhy](summaries-and-tasks.md#routed-proposals).

<span id="folder-knowledge" />

## Znalosti složky

Na hlavní stránce otevřete složku a vedle jejího názvu zvolte **Znalosti**. Pohled může číst každý, kdo složku vidí. Zahrnuje položky složky a všech jejích podsložek, bez nadřazených složek. Lidé pocházejí z potvrzených mluvčích, oprav a dokladů faktů; věci z oprav a dokladů. Opravy ukazují přeslechnuté podoby použité v těchto položkách a počty použití. Fakta ukazují podpořené doklady s položkou a datem včetně pošty.

Karta **Co dostanou modely** používá stejné funkce jako zpracování položek:

- **Přepis:** nejvýše 500 jmen, přezdívek a pojmů. První je nahrávající, pak použití ve složce, vlastní použití, přeslechy a pořadí jmen. Náhled vysvětluje pořadí, ukazuje první výrazy, počet vynechaných, hranici 500 a několik výrazů pod ní. Složky mění pořadí, nikdy nefiltrují dostupné záznamy Almanachu.
- **Oprava přepisu:** nejvýše 500 záznamů se jmény, přezdívkami a přeslechy, bez faktů. První jsou záznamy už zmíněné v přepisu, pak rozhoduje použití ve složce. Náhled ukazuje počet záznamů a přesnou podobu `ALMANAC (JSON)` prvních pěti záznamů.
- **Učení:** znalosti si dohledává samo, nejvýše 10 výsledků na dotaz; při shodě rozhoduje použití ve složce.
- **Shrnutí:** dostává opravený přepis bez Almanachu. Jména mluvčích se doplní až potom.
- **MCP:** čte oprávněný Almanach Organizace a soukromý Almanach bez filtru složky.

Náhled předpokládá novou položku vlastněnou čtenářem, zařazenou jen do této složky, zatím bez zmínek v přepisu. Používá jazyk přepisu z výchozího zvukového profilu složky, včetně zděděného profilu. Při automatickém rozpoznávání jazyka zahrnuje přeslechy ze všech jazyků. Jiný vlastník, jazyk, existující přepis nebo další umístění mohou pořadí změnit. Kořenové složky se z řazení vynechávají: položka zařazená přímo do kořene nedostává kontext z tohoto kořene; podsložky mohou nadále přispívat použitím. Karty znalostí přesto počítají celý strom kořene.

Dále: [Učení](learn.md)
