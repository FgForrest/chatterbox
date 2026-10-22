---
title: Almanach
description: Lidé a věci, které Klepna zná, jejich přezdívky a fakta.
---

Almanach obsahuje vše, co Klepna ví o lidech a věcech, o kterých Vaše nahrávky hovoří: kdo je kdo, na čem kdo pracuje, jak se jmenuje projekt a jak bývá často špatně rozuměn. Přepis, Učení, souhrny a úkoly z něj vycházejí.

Obsahuje karty **Lidé**, **Věci**, **Slovník** a **Kontrola**. Kurátoři Organizace navíc vidí kartu **Péče**.

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

<span id="care-possible-duplicates" />

## Péče: možné duplicity

Kurátoři Organizace najdou pod **Almanach → Péče → Možné duplicity** osoby a věci, které mohou být zapsané dvakrát. Fronta obsahuje pouze záznamy Organizace. U dvojice je vysoká, střední nebo nízká shoda a její důvody: podobná jména, přezdívky, české tvary příjmení, přeslechy nebo právní forma firmy. Důvody proti shodě jsou jantarové, například oba potvrzení mluvčí v jednom přepisu nebo různé e-maily na různých doménách. Chybějící e-mail je pouze informace, nikoli problém k nápravě.

**Sloučit…** otevře oba záznamy vedle sebe. Klepna navrhne ponechat záznam s hlavním e-mailem, poté ten s více doklady. Můžete vybrat jiný, zvolit jméno a u rozporných jednohodnotových faktů určit, která hodnota zůstane aktuální. E-maily, přezdívky, přeslechy a fakta obou záznamů se zachovají; druhé jméno se uloží jako přezdívka. Nahrazené hodnoty faktů zůstanou v historii s doklady. Mluvčí, úkoly a odkazy přejdou na ponechaný záznam, druhý na něj bude přesměrovávat. U věcí různých typů zůstane typ ponechaného záznamu; fakta, která by mu neodpovídala, je třeba nejprve opravit.

**Nejsou stejní** uloží rozhodnutí pro danou dvojici v Organizaci, takže se už nenabídne ani jinému kurátorovi. **Později** ji skryje jen pro relaci této karty prohlížeče. Výběr cíle sloučení na stránce osoby nebo věci také řadí pravděpodobné shody na začátek.

Hledání kontroluje 2 000 nejnovějších živých záznamů každého druhu a jejich nejbližší shody. Duplicity se starším záznamem mimo tento limit se nenabízejí, ani když je druhý záznam nový. Procházení ani odmítání dvojic neposune hledání za tento limit. Omezené hledání označuje upozornění. Porovnání ukazuje sdílené položky a otevřené úkoly, soukromé položky kolegů zůstávají soukromé.

Dále: [Učení](learn.md)
