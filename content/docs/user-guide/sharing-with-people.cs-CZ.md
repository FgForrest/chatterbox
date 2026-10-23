---
title: Sdílení s lidmi
description: Pozvěte kolegu ke čtení soukromé nahrávky nebo e-mailu bez zveřejnění Organizaci.
---

Na vlastní instanci se zobrazenou Organizací můžete soukromou nahrávku nebo e-mail sdílet s konkrétními kolegy. V hostované Klepně ani v instalaci bez Organizace tato funkce není dostupná. Účet Organizace nemůže pozvánky přijímat.

## Pozvání kolegy

Otevřete vlastní položku a zvolte **Sdílet**, případně **Sdílet…** v nabídce řádku. Hledejte podle jména nebo e-mailu a zvolte **Přidat**. Dialog uvádí u každého příjemce stav **Čeká na přijetí**, **Přijato**, **Odmítnuto** nebo **Odebráno**. Pozvánku musí každý přijmout. Čekající pozvánky nevyprší.

Čekající pozvánku můžete zrušit, přijatého příjemce odebrat a po odmítnutí nebo odebrání pozvat znovu. Švestkově zbarvené **Sdíleno s N lidmi** otevírá tento seznam. Položka zůstává soukromá pro vás a přijaté příjemce; ostatní členové ani kurátoři Organizace přístup nezískají.

Tlačítko odkazu před kopírováním vysvětlí, kdo soukromý odkaz otevře. Čekající příjemce musí nejdřív přijmout pozvánku. Pokud položku později nasdílíte Organizaci, osobní sdílení i zařazení příjemců zůstanou zachována. V knihovně Organizace pak platí vaše běžná oprávnění člena nebo kurátora; v soukromém stromu zůstává přijatá položka s vaším zařazením. Po odebrání z Organizace opět platí oprávnění příjemce. Počet příjemců nebo **Upravit sdílení** otevře existující sdílení včetně odmítnutých a odebraných pozvánek.

## Přijetí a zařazení

Nové pozvánky se zobrazují v rohovém upozornění a pod **K přijetí** nahoře ve stromu složek. E-mail přijde jen tehdy, pokud jste v Nastavení zapnuli e-mailová oznámení. Před přijetím vidíte název a vlastníka bez přístupu k obsahu.

Zvolte **Přijmout a zařadit…** a vyberte nebo vytvořte vlastní soukromou složku. Přijaté položky se objeví v ní i v **Nedávné** s označením **Sdílí** a jménem vlastníka. Štítek složky mění jen vaše zařazení; neovlivňuje složky vlastníka ani jeho profil zpracování. Názvy složek vlastníka zůstávají skryté.

Položku můžete číst, zvuk přehrát a stáhnout zvuk, přepis i shrnutí. Potvrzená jména mluvčích se zobrazují jako text bez odkazů do Almanachu. Přejmenování, vymazání, zpracování, změny mluvčích, Učení i další sdílení zůstávají vlastníkovi. Úkol přiřazený osobě, jejíž hlavní e-mail odpovídá vašemu přihlašovacímu e-mailu, se objeví v **Úkoly → Moje** a lze jej dokončit nebo znovu otevřít. Ostatní úkoly jsou jen pro čtení.

Přístupu se vzdáte volbou **Odebrat a ukončit sdílení** v nabídce řádku. Originál vlastníka zůstává zachován. Vlastník vás může pozvat znovu.

## AI klienti a zálohy

Vaše [MCP nástroje](../self-hosting/mcp) čtou přijaté položky podle stejných oprávnění k obsahu a mohou dokončit nebo znovu otevřít vám přiřazené úkoly. Osobní sdílení nezveřejňuje poznatky Almanachu ani nic nepředává vašemu Učení.

Přijaté položky se nezahrnují do vašich záloh ani exportů složek. Archiv vlastníka obsahuje `sharing/people.json` se seznamem jeho přímých sdílení bez vašeho zařazení. Po importu obsahu vlastníka lze metadata sdílení obnovit zasláním tohoto seznamu a mapy původních ID položek na nová do `/api/shares/restore`. Existující účty se hledají podle e-mailu; aktivní sdílení se obnovují jako čekající pozvánky. Výsledek uvádí přeskočené chybějící příjemce, chybějící položky, neaktivní záznamy a existující sdílení. Položky, které už vidí Organizace, a neaktivní účty se také přeskakují. Obecný import celého archivu zatím není k dispozici.

## Sdílení složky

V nabídce soukromé složky zvolte **Sdílet složku…**, případně otevřete **Nastavení složky** a část pro sdílení. Pozvěte kolegy a spravujte čekající, přijaté, odmítnuté a odebrané pozvánky stejně jako u jednotlivých položek. Vaše sdílená složka má švestkovou ikonu složky s odchozí šipkou.

Sdílení je živé a zahrnuje jen nahrávky a e-maily přímo ve složce. Podsložky přístup nikdy nedědí. Přidáním položky ji ihned zpřístupníte přijatým příjemcům; odebráním nebo přesunem jinam tento přístup skončí. Položka sdílená jednotlivě i přes složku se v Nedávných, seznamech, hledání i MCP objeví jednou.

Pozvánku ke složce přijmete volbou **Přijmout a připojit…**. Dialog **Připojit sdílenou složku** nabízí **Název u vás**, předvyplněný názvem složky vlastníka, a **Umístit do**, omezené na váš soukromý strom včetně jeho kořene. Ikona s příchozí šipkou a nápověda uvádějí vlastníka i původní název. Přejmenování originálu váš zvolený název nezmění; jiné názvy složek vlastníka neuvidíte.

Připojená složka nemá podsložky. Její nabídka obsahuje **Přejmenovat u mě**, **Přesunout**, jméno vlastníka a **Odebrat a ukončit sdílení** s potvrzením. Nemůžete do ní vkládat vlastní položky ani ji přesunout do Organizace. Otevřete ji ze stromu, hledání složek, naposledy použitých složek i palety příkazů; výběry pro zařazení ji jako cíl nenabízejí.

Přesun originálu ve vlastním soukromém stromu sdílení zachová. Smazáním skončí pozvánky a příjemcům zmizí připojené složky. Soukromou složku nelze přesunout ani zařadit do Organizace. Vlastník může osobní sdílení kdykoli odebrat. Švestkové odchozí označení u položky znamená, že má přímou pozvánku nebo je přímo ve sdílené složce; položky v podsložkách toto označení ani přístup nedědí.

Záloha vlastníka navíc obsahuje `sharing/folders.json`. Zálohy příjemce neobsahují přijaté položky ani záznamy připojených složek. Po importu složek vlastníka pošlete seznam sdílení a mapu původních ID složek na nová do `/api/folder-shares/restore`. Existující příjemci dostanou čekající pozvánky a připojení si zvolí znovu; chybějící nebo neaktivní účty a nedostupné složky se uvedou jako přeskočené.
