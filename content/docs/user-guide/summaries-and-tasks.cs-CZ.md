---
title: Shrnutí a úkoly
description: Shrnutí, profily zpracování a úkoly sledované napříč nahrávkami a poštou.
---

## Shrnutí

Jakmile má nahrávka přepis a pracovní postup dospěje ke kroku **Shrnout**, objeví se pod přepisem prvek **Shrnutí**. Stejný prvek má i pošta. Během pracovního postupu je vložený v položce a hotové předchozí prvky se skládají do jednoho řádku. Po dokončení vypadá položka jako dříve.

![Shrnutí s úkoly čekajícími na kontrolu](images/summary.png)

1. Vyberte profil zpracování v rozbalovacím seznamu vedle tlačítka. Začíná na profilu položky. Pokud zvolíte jiný, Klepna si v tomto prohlížeči zapamatuje volbu pro další položky se stejným přiřazeným profilem.
2. Klikněte na **Shrnout** nebo na **Znovu shrnout** pro nahrazení existujícího shrnutí nahrávky. U pošty se tlačítko jmenuje **Shrnout znovu**.

Ruční výběr může použít libovolný dostupný profil pro daný druh položky. Když shrnutí spustíte sami, otevře se v okně; pruh pracovního postupu toto okno znovu otevře, pokud vyžaduje pozornost. Profil dodává instrukce shrnutí, jazyk a formát výstupu, poskytovatele, hledání úkolů a nastavení funkce **Vícenásobné shrnování**. Viz [Zpracování a profily](processing-and-profiles.md).

![Výběr profilu zpracování pro ruční shrnutí](images/summary-profile-picker.png)

Během zpracování karta ukazuje, jak dlouho už operace trvá a u funkce **Vícenásobné shrnování** také postup: `Probíhá shrnutí — 1/3 průchodů`, poté `Slučování 3 průchodů…`. Můžete stránku opustit; shrnutí se nezastaví a po návratu bude připravené.

Shrnutí jsou psána ve formátu Markdown, takže nadpisy, seznamy a tabulky se tak i zobrazují. Za textem následují **Klíčové body**. Dvě ikony umožňují shrnutí zkopírovat nebo stáhnout jako Markdown soubor.

Pokud opravíte jména v přepisu po vytvoření shrnutí, u shrnutí se objeví upozornění **Mohou obsahovat neaktuální jména nebo pojmy** s odkazem na **Znovu vygenerovat**. Pruh pracovního postupu označí práci vytvořenou ze starších vstupů jako **Zastaralé**.

### Instrukce shrnutí a Vícenásobné shrnování

Klepna obsahuje instrukce shrnutí, například **Obecné shrnutí**, **Zápis z jednání**, **Klíčové body** a **Akční body**. Nyní jsou součástí profilů zpracování, nikoli výběru u shrnutí. V profilu můžete změnit zaměření, instrukce, jazyk nebo formát výstupu.

![Shrnutí vytvořené dvěma ze tří kroků](images/summary-multi-pass.png)

Profil může shrnout přepis 2krát až 5krát a výsledky sloučit, takže i bod zachycený jen jedním během se objeví ve shrnutí. Cena procesu je přibližně tolikrát vyšší, kolik běhů nastavíte. Zápatí uvádí **Vícenásobné shrnování · 3**. Pokud některý běh selže a shrnutí vznikne z menšího počtu, odznak zežloutne, například **Vícenásobné shrnování · 2/3**; najeďte na něj kurzorem a zobrazí se důvod.

<span id="tasks-from-a-summary" />
<span id="tasks-across-items" />

## Úkoly napříč položkami

### Úkoly ze shrnutí

Shrnutí hledá věci, které někdo slíbil udělat. Úkol již nepatří jednomu shrnutí: shromažďuje zmínky z nahrávek a pošty zařazených do jeho rozsahu složek. **Kde to zaznělo** otevře zvukovou pasáž nebo zvýrazní odpovídající text pošty. **Dřívější zmínka** ukazuje starší důkaz bez změny úkolu.

Jakmile jsou změny úkolů připravené, otevře se za shrnutím vložený prvek **Kontrola úkolů**. Pruh pracovního postupu uvádí **Ke kontrole** a akce **Zkontrolovat úkoly** k němu přeskočí. Pokud úkoly vznikly ze shrnutí, které jste po pracovním postupu spustili sami, stejná kontrola se otevře v okně.

![Kontrola navržených úkolů](images/task-review.png)

- Nová akce může nabídnout **Navržené shody** s dřívějšími otevřenými úkoly ze stejného rozsahu složek. Každá karta porovnává **Dřívější úkol** s tím, co **Zaznělo teď**, včetně obou citací a časů, kdy zazněly. Volba **Tentýž úkol: připojit tuto zmínku** propojí novou zmínku, ale jinak dřívější úkol nezmění. Každá navržená shoda je zpočátku nezaškrtnutá bez ohledu na počet kandidátů nebo původ důkazu. Nezaškrtnuté jsou zpočátku také změny termínu a dokončení.
- Pokud je možných kandidátů více, vyberte správný, nebo zvolte **Ponechat jako nový**. **Sloučit do dřívějšího úkolu** prohledá všechny otevřené úkoly v rozsahu složek, nejen navržené kandidáty.
- Změna termínu zobrazuje **Současný termín** i **Navržený termín**. Dokončení je označeno **Vyžaduje potvrzení**. Výrok starší než poslední úprava úkolu se zobrazí jako **Dřívější zmínka** a nevyžaduje rozhodnutí.
- Shrnutí může také navrhnout **Už není potřeba** nebo **Předáno někomu jinému**. Tyto možnosti nejsou nikdy předem vybrané. Neznámý řešitel se zobrazí ke kontrole a nevytvoří se potají.
- Odškrtněte nový úkol, který není skutečný. Před přijetím opravte jeho text, řešitele nebo termín. V zápatí **Přidat úkol** doplní a zaměří úkol, který shrnutí opomenulo, a **Použít vybrané změny** použije vše, co zůstalo zaškrtnuté; **Uložit a pokračovat později** zachová kontrolu bez použití změn.

Kontrola zobrazuje jednu kartu pro každý úkol. Shoda je hlavní rozhodnutí; změny termínu, dokončení, **Už není potřeba** a **Předáno někomu jinému** pro tento úkol jsou uvedeny pod ní. Tlačítko **Kde to zaznělo** ukazuje čas a během přehrávání pasáže se změní na pozastavení. Pokud citaci nelze v přepisu najít, kontrola to napíše místo nefunkčního odkazu.

![Změny úkolu a dřívější zmínka v kontrole](images/task-review-changes.png)

![Výběr dřívějšího úkolu ke sloučení](images/task-merge-earlier.png)

Po přijetí shody ji může vlastník položky v jejím seznamu úkolů zrušit; u sdílené položky to mohou provést také kurátoři. Zrušením se tato zmínka oddělí do vlastního úkolu. Změny polí již použité na dřívější úkol zůstanou použité.

Přijaté úkoly jsou uvedené u položky. Zaškrtněte je po dokončení, nebo použijte **Přidat úkol** pro ruční doplnění. Úkol žije, dokud existuje alespoň jedna zmínka, i když nahradíte shrnutí, které jej původně našlo.

<span id="routed-proposals" />

## Směrované návrhy

Pokud zkontrolujete navrženou změnu, ale nemáte právo ji použít, Klepna ji předá někomu, kdo toto právo má. **Návrhy pro vás** na stránce Úkoly jsou schránkou těchto rozhodnutí a odznak v navigaci uvádí jejich počet. Při použití návrhu se oprávnění zkontroluje znovu.

![Směrovaný návrh úkolu ve schránce na stránce Úkoly](images/tasks-routed.png)

U sdíleného úkolu mohou vlastník jeho domovské položky a kurátoři Organizace upravovat text, termín a řešitele, úkol zrušit, sloučit a uzavřít. Řešitel jej může také uzavřít nebo znovu otevřít. U soukromého úkolu může tyto úkony provádět pouze jeho vlastník. Tato práva úkolů jsou výjimkou z ostatních pravidel úprav sdílených položek.

Po smazání domovské položky se domovem stane nejnovější přeživší zmínka ve stejném rozsahu. Pokud žádná nezůstane, úkol zmizí. Po odebrání sdílené domovské položky z Organizace se domovem stane nejnovější zbývající sdílená zmínka. Pokud žádná nezůstane, úkol se stane soukromým spolu s odebranou položkou. Odebraná zmínka již není v Organizaci viditelná. Retence, která odstraní zvuk nebo vytvořený obsah, domov nepřesouvá.

<span id="the-tasks-page" />

## Stránka Úkoly

**Úkoly** v horní liště zobrazují úkoly z nahrávek i pošty.

![Úkoly přiřazené Vám](images/tasks-mine.png)

- **Moje**: úkoly přiřazené Vám. Klepna určí Váš záznam v Almanachu podle e-mailové adresy; otevřete svůj záznam v Almanachu a zvolte **Toto jsem já**, pokud se Vám zde úkoly nezobrazují.
- **Sledované**: ostatní úkoly z Vašich položek, přiřazené jiným osobám nebo zatím nikomu.

![Úkoly, které sledujete](images/tasks-tracked.png)

Filtry zobrazí otevřené, hotové nebo zrušené úkoly, úkoly z jedné složky i úkoly po termínu, splatné tento týden nebo zatím bez termínu. Seznam lze třídit podle novosti nebo termínu splnění. U každého úkolu najdete akce, ke kterým máte oprávnění, a **Kde bylo řečeno** pro každou zmínku.

Akci **Sloučit do dřívějšího úkolu** zde použijte, pokud dva řádky představují stejnou práci. Cílovému úkolu zůstanou jeho pole. Rozdíly vyžadující oprávnění jiné osoby se předají jako návrhy a nepoužijí se potají. Soukromý úkol a úkol Organizace nelze sloučit způsobem, který by úkol Organizace před členy skryl.

Dále: [Almanach](almanac.md)
