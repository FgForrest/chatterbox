---
title: Shrnutí a úkoly
description: Shrnutí, profily zpracování a úkoly sledované napříč nahrávkami a poštou.
---

## Shrnutí

Jakmile má nahrávka přepis a pracovní postup dospěje ke kroku **Shrnout**, objeví se pod přepisem prvek **Shrnutí**. Stejný prvek má i pošta. Během pracovního postupu je vložený v položce a hotové předchozí prvky se skládají do jednoho řádku. Po dokončení zůstávají přepis a shrnutí dostupné; dokončené výsledky Učení najdete v panelu **Znalosti** otevřeném ze záhlaví.

![Karta shrnutí s profilem zpracování v zápatí](images/summary.png)

1. **Profil** s názvem v zápatí pod úkoly ukazuje profil, kterým vzniklo zobrazené shrnutí. Tužka otevře výběr. U existujícího shrnutí volba jiného profilu spustí nové shrnutí, u ručně upraveného textu až po potvrzení; před prvním shrnutím jen nastaví profil pro příští spuštění. Čtenář bez práva úprav tužku nevidí. Pokud původní profil nelze dohledat, zobrazí se profil pro příští spuštění.
2. Před prvním shrnutím použijte tlačítko **Shrnout** v těle karty nebo ikonu jisker v záhlaví. Existující shrnutí nahradí kruhová šipka **Shrnout znovu**. Šipka vlevo od nadpisu kartu sbalí nebo rozbalí. Záhlaví vlastníkovi nabízí také **Upravit shrnutí** a **Připomínky ke shrnutí**, za nimi stažení a kopírování.

Ruční výběr může použít libovolný dostupný profil pro daný druh položky. Když shrnutí spustíte sami, karta zůstane na místě a přepne se do průběhového stavu. Profil dodává instrukce shrnutí, jazyk a formát výstupu, poskytovatele, hledání úkolů a nastavení funkce **Vícenásobné shrnování**. Viz [Zpracování a profily](processing-and-profiles.md).

![Výběr profilu zpracování pro ruční shrnutí](images/summary-profile-picker.png)

Během zpracování karta ukazuje, jak dlouho už operace trvá a u funkce **Vícenásobné shrnování** také postup: `Probíhá shrnutí — 1/3 průchodů`, poté `Slučování 3 průchodů…`. Můžete stránku opustit; shrnutí se nezastaví a po návratu bude připravené.

Shrnutí jsou psána ve formátu Markdown, takže nadpisy, seznamy a tabulky se tak i zobrazují. **Klíčové body** jsou poslední částí uvnitř stejného rámečku jako text shrnutí. Stažený i zkopírovaný Markdown zachovává pořadí text, potom klíčové body. Zápatí pod úkoly ukazuje upozornění s akcemi ve žlutém pruhu a pod ním jeden řádek s profilem, poskytovatelem, modelem a označeními, například vícenásobným shrnováním nebo **Upraveno ručně**.

Pokud opravíte jména v přepisu po vytvoření shrnutí, u shrnutí se objeví upozornění **Může obsahovat zastaralá jména nebo pojmy** s odkazem **Vygenerovat znovu**. Pruh pracovního postupu označí práci vytvořenou ze starších vstupů jako **Zastaralé**.

<span id="edit-a-summary" />

### Ruční úprava shrnutí

Vlastník položky může u vygenerovaného shrnutí použít **Upravit shrnutí** (tužku v záhlaví karty), a to i u vlastní nahrávky sdílené s Organizací, z obou pohledů. U cizí položky tyto ovládací prvky oprav nemají kurátoři, ostatní členové ani příjemci. Účet Organizace ovládání oprav nemá. Importovaná shrnutí **Plaud** nelze ručně upravovat ani opravovat připomínkami.

![Úprava textu shrnutí a klíčových bodů](images/summary-edit.png)

Upravte **Text shrnutí** ve formátu Markdown a **Klíčové body**, každý na samostatném řádku začínajícím `- `, a zvolte **Uložit** nebo **Zrušit**. Odkazy na mluvčí zobrazují aktuální jména, například `[Alex Morgan](#speaker-1)`. Zachovejte odkaz `#speaker-N`, aby jméno sledovalo pozdější přejmenování mluvčího. Úprava shrnutí nemění úkoly; ty upravujte v seznamu pod ním.

Uložený text má v zápatí štítek **Upraveno ručně**; po najetí myší se zobrazí autor a čas úpravy. Automatické zpracování ho nikdy nepřepíše, ani po novém přepisu nebo opravách Učení. Může proto popisovat starší vstup. Ruční **Shrnout znovu**, změna profilu nebo **Vygenerovat znovu** vyžaduje před nahrazením ručních úprav potvrzení. Vlastník zde může místo toho zvolit **Napsat připomínku**. Potvrzené nahrazení štítek ruční úpravy odstraní.

<span id="correct-a-summary-with-remarks" />

### Oprava shrnutí pomocí připomínek

Otevřete **Připomínky ke shrnutí** (ikonu bubliny). Dialog uvádí **Uložené připomínky** s autorem a časem, u každé tlačítko **Smazat připomínku** a dále profil, poskytovatele a model, které se použijí.

![Uložené připomínky a model pro opravu](images/summary-remarks.png)

Do pole **Nová připomínka** napište, co shrnutí zkreslilo, a klikněte na **Opravit shrnutí**. Připomínka se uloží a spustí se jeden běh opravy nad původním obsahem, současným shrnutím a všemi uloženými připomínkami. Opravu lze spustit i jen s dosavadními připomínkami. Oprava ručně upraveného textu zachová štítek **Upraveno ručně**. Pokud běh modelu selže, připomínka zůstane uložená pro další pokus.

Připomínky patří k položce a použijí se při každém dalším shrnutí, které spustíte Vy, včetně automatických běhů a běhů po výslovném novém vygenerování, v soukromém pohledu i v Organizaci. Ruční běh jiného uživatele, například kurátora, Vaše připomínky nepoužije. **Smazat připomínku** ovlivní příští běhy; nepřepíše současné shrnutí ani neodstraní jeho štítek původu.

![Ručně upravené shrnutí opravené podle uložené připomínky](images/summary-edited.png)

Vlastník v zápatí vidí **Podle připomínek · 1** (počet použitých připomínek) a kliknutím znovu otevře dialog. Čtenáři vidí výsledný sdílený text, případný štítek **Upraveno ručně** s autorem a časem a **Opraveno podle připomínek**, bez soukromého textu připomínek a ovládání oprav. Běh jiného uživatele odstraní štítek připomínek u daného výsledku, ale uložené připomínky vlastníka zachová pro jeho příští běh.

### Instrukce shrnutí a Vícenásobné shrnování

Klepna obsahuje instrukce shrnutí, například **Obecné shrnutí**, **Poznámky ze schůzky**, **Klíčové body** a **Úkoly**. Nyní jsou součástí profilů zpracování, nikoli výběru u shrnutí. V profilu můžete změnit zaměření, instrukce, jazyk nebo formát výstupu.

![Shrnutí vytvořené dvěma ze tří kroků](images/summary-multi-pass.png)

Profil může shrnout přepis 2krát až 5krát a výsledky sloučit, takže i bod zachycený jen jedním během se objeví ve shrnutí. Cena procesu je přibližně tolikrát vyšší, kolik běhů nastavíte. Zápatí uvádí **více průchodů · 3**. Pokud některý běh selže a shrnutí vznikne z menšího počtu, údaj zežloutne, například **více průchodů · 2/3**; najeďte na něj kurzorem a zobrazí se důvod.

<span id="tasks-from-a-summary" />
<span id="tasks-across-items" />

## Úkoly napříč položkami

### Úkoly ze shrnutí

Shrnutí hledá věci, které někdo slíbil udělat. Úkol již nepatří jednomu shrnutí: shromažďuje zmínky z nahrávek a pošty zařazených do jeho rozsahu složek. **Kde to zaznělo** otevře zvukovou pasáž nebo zvýrazní odpovídající text pošty. **Dřívější zmínka** ukazuje starší důkaz bez změny úkolu.

Jakmile jsou změny úkolů připravené, otevře se za shrnutím vložený prvek **Kontrola úkolů**. Pruh pracovního postupu uvádí **Ke kontrole** a akce **Zkontrolovat úkoly** k němu přeskočí. Pokud úkoly vznikly ze shrnutí, které jste po pracovním postupu spustili sami, kompaktní řádek **Kontrola úkolů** nabídne akci **Kontrola**; teprve toto výslovné kliknutí otevře kontrolu v okně.

![Kontrola navržených úkolů](images/task-review.png)

- Nová akce může nabídnout **Navržené shody** s dřívějšími otevřenými úkoly ze stejného rozsahu složek. Každá karta porovnává **Dřívější úkol** s tím, co **Zaznělo teď**, včetně obou citací a časů, kdy zazněly. Volba **Tentýž úkol: připojit tuto zmínku** propojí novou zmínku, ale jinak dřívější úkol nezmění. Každá navržená shoda je zpočátku nezaškrtnutá bez ohledu na počet kandidátů nebo původ důkazu. Nezaškrtnuté jsou zpočátku také změny termínu a dokončení.
- Pokud je možných kandidátů více, vyberte správný, nebo zvolte **Ponechat jako nový**. **Sloučit do dřívějšího úkolu** prohledá všechny otevřené úkoly v rozsahu složek, nejen navržené kandidáty.
- Změna termínu zobrazuje **Současný termín** i **Navržený termín**. Dokončení je označeno **Vyžaduje potvrzení**. Výrok starší než poslední úprava úkolu se zobrazí jako **Dřívější zmínka** a nevyžaduje rozhodnutí.
- Shrnutí může také navrhnout **Už není potřeba** nebo **Předáno někomu jinému**. Tyto možnosti nejsou nikdy předem vybrané. Neznámý řešitel se zobrazí ke kontrole a nevytvoří se potají.
- Odškrtněte nový úkol, který není skutečný. Před přijetím opravte jeho text, řešitele nebo termín. V zápatí **Přidat úkol** doplní a zaměří úkol, který shrnutí opomenulo, a **Použít vybrané změny** použije vše, co zůstalo zaškrtnuté; **Uložit a pokračovat později** zachová kontrolu bez použití změn.

Kontrola zobrazuje jednu kartu pro každý úkol. Shoda je hlavní rozhodnutí; změny termínu, dokončení, **Už není potřeba** a **Předáno někomu jinému** pro tento úkol jsou uvedeny pod ní. Tlačítko **Kde to zaznělo** ukazuje čas a během přehrávání pasáže se změní na pozastavení. Pokud citaci nelze v přepisu najít, kontrola to napíše místo nefunkčního odkazu.

![Změny úkolu v kontrole](images/task-review-changes.png)

![Výběr dřívějšího úkolu ke sloučení](images/task-merge-earlier.png)

Po přijetí shody ji může vlastník položky v jejím seznamu úkolů zrušit; u sdílené položky to mohou provést také kurátoři. Zrušením se tato zmínka oddělí do vlastního úkolu. Změny polí již použité na dřívější úkol zůstanou použité.

Přijaté úkoly jsou uvedené u položky. Zaškrtněte je po dokončení, nebo použijte **Přidat úkol** pro ruční doplnění. Úkol žije, dokud existuje alespoň jedna zmínka, i když nahradíte shrnutí, které jej původně našlo.

<span id="routed-proposals" />

## Směrované návrhy

Pokud zkontrolujete navrženou změnu, ale nemáte právo ji použít, Klepna ji předá někomu, kdo toto právo má. **Návrhy pro vás** na stránce Úkoly jsou schránkou těchto rozhodnutí a odznak v navigaci uvádí jejich počet. Při použití návrhu se oprávnění zkontroluje znovu.

![Směrovaný návrh úkolu ve schránce na stránce Úkoly](images/tasks-routed.png)

U sdíleného úkolu mohou vlastník jeho domovské položky a kurátoři Organizace upravovat text, termín a řešitele, úkol zahodit, sloučit a uzavřít. Řešitel jej může také uzavřít nebo znovu otevřít, napsat poznámku a sloučit s jiným úkolem přiřazeným jemu. U soukromého úkolu může tyto úkony provádět pouze jeho vlastník. Tato práva úkolů jsou výjimkou z ostatních pravidel úprav sdílených položek.

Po smazání domovské položky se domovem stane nejnovější přeživší zmínka ve stejném rozsahu. Pokud žádná nezůstane, úkol zmizí. Po odebrání sdílené domovské položky z Organizace se domovem stane nejnovější zbývající sdílená zmínka. Pokud žádná nezůstane, úkol se stane soukromým spolu s odebranou položkou. Odebraná zmínka již není v Organizaci viditelná. Retence, která odstraní zvuk nebo vytvořený obsah, domov nepřesouvá.

<span id="the-tasks-page" />

## Stránka Úkoly

**Úkoly** v horní liště zobrazují úkoly z nahrávek i pošty.

![Úkoly přiřazené Vám](images/tasks-mine.png)

- **Moje**: úkoly přiřazené Vám a Vaše vlastní soukromé úkoly. Klepna určí Váš záznam v Almanachu podle e-mailové adresy; otevřete svůj záznam v Almanachu a zvolte **To jsem já**, pokud se Vám zde úkoly nezobrazují.
- **Sledované**: úkoly, které výslovně sledujete, a úkoly z Vašich položek přiřazené jiným osobám nebo nikomu. **Přestat sledovat** odebere oba druhy. Kurátoři mohou přepnout na **Všechny úkoly Organizace**; účet Organizace nadále vidí všechny sdílené úkoly. Staré odkazy `tab=tracked` otevírají tuto záložku.
- **Všechny**: každý úkol, který smíte vidět: Vaše vlastní soukromé úkoly a úkoly z Vašich položek, z položek Organizace i z položek, které s Vámi někdo sdílí. Filtr složky zahrnuje i podsložky a filtr řešitele funguje jako ve Sledovaných. Účet Organizace má Sledované a Všechny, bez Moje.

![Úkoly, které sledujete](images/tasks-tracked.png)

Filtry zobrazí otevřené, hotové nebo zahozené úkoly, úkoly z jedné složky i úkoly po termínu, splatné tento týden nebo zatím bez termínu. Seznam lze třídit podle novosti nebo termínu splnění. U každého úkolu najdete akce, ke kterým máte oprávnění, a **Kde to zaznělo** pro každou zmínku.

V knihovně otevřou **Úkoly ve složce** (seznam úkolů pod názvem složky) stejný seznam v pravém panelu, seskupený podle složek, s výchozím **Všechny**. **Otevřít v Úkolech** zachová složku i seznam. Viz [Úkoly ve složce](recordings.md#folder-tasks).

### Vlastní úkoly

**Přidat úkol** najdete vpravo nahoře v seznamech **Moje** a **Všechny**, vedle řazení. Dokud je formulář otevřený, tlačítko je neaktivní; úkol přidáte nebo zrušíte tlačítky formuláře. Formulář se otevře jako první řádek seznamu a po přidání jeho místo nahoře zaujme nový úkol. Zadejte nejvýše 2 000 znaků a volitelný termín. **Jen vy** znamená, že autor je vždy řešitelem a jediným čtenářem, i když Úkoly otevře kurátor nebo účet Organizace. Můžete upravit text a termín, úkol dokončit, zahodit, obnovit i sloučit. Nemá nahrávku, nelze jej sdílet ani změnit řešitele, nezvyšuje odznak a přežije retenci i smazání položek.

Štítek složky vedle **Jen vy** umožňuje úkol volitelně zařadit do jedné z Vašich soukromých složek. Výchozí je soukromá složka vybraná ve filtru Úkolů, jinak **Bez složky**. V řádku zdroje úkolu klikněte na název složky nebo **Zařadit do složky**; volba **Bez složky** zařazení zruší. U nezařazeného úkolu se akce při použití myši zobrazí po najetí nebo zaměření klávesnicí, na dotykovém zařízení je stále viditelná. Složka slouží jen k orientaci: nikomu neuděluje přístup a úkoly nemění počty položek ve sloupcích knihovny. Úkoly z nahrávek a pošty nadále používají složky své zdrojové položky.

Výběr soukromé složky v seznamu **Moje** nebo **Všechny** zahrne vlastní úkoly zařazené do ní i jejích podsložek. Kořen **Soukromé** obsahuje všechny Vaše vlastní úkoly včetně nezařazených, stejně jako **Všechny složky**. Složka Organizace vlastní úkoly skryje. Smazání složky nebo její přesun mimo soukromý strom zruší zařazení úkolu ve stejné transakci; úkol přežije a zůstane soukromý.

Pravé tlačítko na **Úkoly** v navigaci, klávesa místní nabídky, Shift+F10 nebo dlouhý dotyk otevřou Moje se zaměřeným formulářem. Ctrl+kliknutí a prostřední tlačítko nadále otevřou novou záložku prohlížeče. Pro nabídku prohlížeče podržte při kliknutí pravým tlačítkem Shift, Ctrl, Alt nebo Meta.

### Poznámky a sledování

Zaškrtnutí úkolu otevře nepovinnou poznámku. Zvolte **Přeskočit** nebo **Uložit poznámku**. Akce **Poznámka** ji otevře kdykoli. Úkol má jednu šifrovanou poznámku do 2 000 znaků; uložení nahradí předchozí text. Všichni čtenáři úkolu ji vidí spolu s autorem a časem. Psát ji může každý, kdo smí úkol označit jako hotový. Poznámky se prohledávají a zálohují, do instrukcí pro shrnutí se neposílají.

**Sledovat** je dostupné u viditelných úkolů pod nahrávkou i poštou a na stránce Úkoly. Stav **Sledujete** zůstává viditelný. Sledování přežije odebrání sdílení: úkol se skryje a po obnovení viditelnosti se vrátí. Sledující může otevřít detail úkolu. Sledování i jeho výslovné zrušení patří do osobní zálohy sledujícího. Vlastní úkoly ani změny sledovaných úkolů nezvyšují odznak přiřazených úkolů.

Na stránce Úkoly je zdroj malé tlačítko pod textem. Pod nahrávkou nebo poštou je **Kde to zaznělo** v řádku řešitele a termínu. Akce se při použití myši zobrazují po najetí nebo zaměření klávesnicí, na dotykovém zařízení jsou stále viditelné.

### Slučování úkolů

**Sloučit do jiného úkolu** spojí dva otevřené úkoly. Řešitel vybírá ze svých ostatních otevřených úkolů napříč nahrávkami, poštou a vlastními úkoly. Okno ukáže náhled vypočtený serverem: text ponechaného úkolu a za ním druhý text na novém řádku, poznámky ve stejném pořadí a dřívější termín. Odkazy na obě položky i sledující zůstanou, čekající návrhy se přesunou. Výsledek přes 2 000 znaků je odmítnut, aby se text neztratil.

Úkol Organizace vždy zůstane. Připojení soukromého úkolu vyžaduje potvrzení, že jeho text a poznámku uvidí všichni čtenáři úkolu Organizace. Sloučení nelze vrátit. Při různých vlastnících dostane vlastník ponechaného úkolu oznámení do stávající schránky návrhů.

### Záloha a obnova úkolů

Osobní záloha obsahuje `tasks/personal.json`, `tasks/follows.json` a poznámky ve stávajících souborech úkolů položek. Záloha Organizace neobsahuje vlastní úkoly ani sledování členů. Po obnově odkazovaných položek a lidí lze přihlášenou relací poslat POST na `/api/tasks/restore` s `{personal, items, follows}`: `personal` je pole vlastních úkolů, `items` obsahuje `{itemId, tasks}` ze souboru `tasks.json` nahrávky nebo pole úkolů pošty a `follows` je pole sledování. Existující úkoly se nemění; ID jiného vlastníka jsou odmítnuta. Odkazy sledování na chybějící úkoly se přeskočí. Tímto se obnovují úkoly; Klepna nemá obecnou obrazovku obnovy celého archivu.

Každý vlastní úkol nese `folderId`. Po obnově soukromých složek ze souboru `organization/folders.json` přidejte do požadavku `folders: [{id, restoredId}]`, kde `id` je ID složky v archivu a `restoredId` je ID obnovené soukromé složky. Odkaz bez mapování se nastaví na null, včetně složek vynechaných ze zálohy. Cílové složky Organizace i jiných uživatelů jsou odmítnuty. Zálohy Organizace se nemění.

Dále: [Almanach](almanac.md)
