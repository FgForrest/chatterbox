---
title: Učení
description: Nechte Klepna navrhnout jména mluvčích, opravy a fakta a poté je zkontrolujte.
---

Funkce Učení porovnává přepis s vaším [Almanachem](almanac.md) a navrhuje nalezené položky:

- **jména mluvčích** pro ty, kteří zatím nebyli pojmenováni,
- **opravy** jmen, která přepis nesprávně rozpoznal („Path finder“ místo Pathfinder),
- **nové osoby a věci**, které stojí za to přidat do Almanachu,
- **fakta**, která byla řečena („Marek pracuje na Pathfinderu”).

Nic se nezmění, dokud návrhy nezkontrolujete.

Učení je dostupné u přepisů s časovými údaji na instancích s vlastním hostingem a poskytovatelem AI, který umí vytvářet souhrny (viz [Jakého poskytovatele zvolit](transcripts.md#which-provider-to-choose)).

<span id="running-learn" />

## Spuštění Učení

U ručního kroku prvek Učení uvádí, že je připravený, a nabízí tlačítko **Učení**. Po spuštění se bez otevření okna přepne na stav **Učení čte přepis**. Během zpracování můžete stránku opustit. Po dokončení prvek nabídne akci **Zkontrolovat**.

Pokud má profil zpracování položky u Učení zapnuté **Spouštět automaticky**, Učení se spustí po novém přepisu. Když najde návrhy, jeho kontrola se zobrazí vložená přímo v pracovním postupu. Pruh uvádí **Ke kontrole** a akce **Zkontrolovat poznatky** přeskočí ke kontrole. Název, shrnutí a témata čekají na Vaši kontrolu, aby používaly opravený přepis. Po 72 hodinách pokračují bez kontroly, ale kontrola zůstane otevřená a nadále blokuje zamýšlené sdílení s Organizací.

Pokud Učení nenajde nic ke kontrole a je zapnutá volba **Opravit přepis po Učení**, krok Učení zůstane ve stavu **Běží**, zatímco přepis znovu čte a opravuje špatně rozpoznaná slova. U shrnutí se zobrazí, že čeká na tuto opravu, a po jejím dokončení se samo spustí. Kliknutím na **Shrnout** jej můžete spustit ihned.

<span id="reviewing" />

## Kontrola návrhů

Obsah kontroly je stejný, ať je vložený v položce, nebo otevřený v okně. Akce **Zkontrolovat** u prvku a **Zkontrolovat poznatky** v pruhu pracovního postupu toto okno výslovně otevřou:

![Přehled návrhů Učení](images/learn-review.png)

- **Mluvčí**: koho Učení považuje za každého nepojmenovaného mluvčího a proč. **▷** přehraje důkaz. **Někdo jiný…** vybere jinou osobu, **Neznámý** označí mluvčího za neznámého.
- **Nové v Almanachu**: osoby a věci, které Učení rozpoznalo, ale Almanach je nezná. Začínají nezaškrtnuté. Opravte jméno nebo typ před zaškrtnutím, zvolte **Je to něco známého…**, pokud záznam už máte pod jiným jménem, nebo **Nikdy nenavrhovat**, pokud jej nechcete navrhovat v žádné nahrávce.
- **Opravy**: špatně rozpoznaná jména, četnost a výskyt. Tyto návrhy jsou předem zaškrtnuté.
- **Nová fakta** a **Známá fakta** zmiňovaná znovu.

Zaškrtněte, co je správně, a klikněte na **Dokončit kontrolu**. **Uložit a pokračovat později** zachová Vaše zaškrtnutí bez použití změn. Nezaškrtnuté návrhy již na této nahrávce nebudou navrženy.

Přehled nemusíte otevírat: návrhy se zobrazují i přímo v přepisu. Návrh opravy je zvýrazněn, navržený mluvčí je zobrazen jako jméno s **?**, každý s fajfkou k přijetí. **Návrhy mluvčích** nad přepisem zobrazují navržená jména s možností **Přijmout vše**.

<span id="after-the-review" />

## Po kontrole

![Co kontrola provedla](images/learn-results.png)

Po kontrole se během dalšího zpracování prvek složí na řádek **Učení dokončeno** s akcí **Zobrazit výsledky**. Ve výsledcích zjistíte, zda byl každý návrh použit, zamítnut nebo přeskočen. **Učit se znovu** spustí další běh a ukáže jeho průběh na místě; pokud jste si některý návrh rozmysleli, zaškrtněte **Učit se znovu: navrhnout znovu i to, co jsem u této nahrávky odmítl(a)**.

Přijaté opravy jsou uchovány vedle původního textu, nikdy ne místo něj, takže je lze vždy vrátit zpět. Viz [Opravená slova](transcripts.md#corrected-words).

Pokud má profil zpracování zapnuté **Opravit přepis po Učení**, Učení potom ještě jednou přečte celý přepis s údaji z Almanachu a opraví další nesprávně rozpoznaná slova. Každá oprava je podtržena jantarovou barvou a můžete ji vrátit zpět.

<span id="where-reviews-wait" />

## Kde čekají kontroly

- Filtr **Vyžaduje kontrolu** nad seznamem nahrávek.
- Odznak na **Almanach** a záložka **Ke kontrole** tamtéž.
- Nahrávku s nedokončenou kontrolou nelze sdílet s Organizací, dokud není kontrola dokončena.

<span id="good-to-know" />

## Důležité vědět

- Jména jsou rozpoznávána v jejich ohýbaných tvarech v jazyce přepisu, s diakritikou i bez: „Šimákem“ najde Šimáka.
- Mluvčí označený pouze křestním jménem je podle toho označen. Křestní jméno, které sdílí dvě osoby v Almanachu, nepřiřadí žádné z nich.
- Zařazení nového záznamu jako toho, který už máte, naučí Klepna nerozpoznané jméno jako přezdívku, takže příští běh jej rozpozná správně.
- Profil zpracování může Učení přiřadit vlastního poskytovatele a model, například výkonnější než pro shrnutí. Viz [Zpracování a profily](processing-and-profiles.md).

Pokračujte zde: [Organizace](organization.md)
