---
title: Statistiky
description: Nahraný čas, zpracování, náklady a místo pro Váš účet i celý tým.
---

Otevřete **Statistiky** v patičce kterékoliv stránky po přihlášení. Klepna zobrazí posledních 90 dní v pohledu Organizace, pokud je dostupný, jinak Moje.

## Čí data

- **Moje** zahrnuje Vaše nahrávky, poštu a úkoly, vlastní záznamy v Almanachu a požadavky AI placené Vaším účtem. Zpracování soukromých položek placené Organizací patří do útraty Organizace.
- **Organizace** zahrnuje položky právě sdílené ve složkách Organizace, záznamy Almanachu vlastněné Organizací a požadavky placené Organizací. Žebříček ukazuje příspěvky členů Organizaci. Položka ve více složkách Organizace se počítá jen jednou.
- **Všichni** zahrnuje položky všech účtů, včetně soukromých, pouze jako čísla. Žebříček vidí každý přihlášený člen. Pohled nikdy neodhaluje názvy položek, hlavičky pošty, přepisy, shrnutí ani text úkolů.

Organizace a Všichni jsou dostupné jen při vlastní instalaci ve sdíleném režimu. Organizace navíc vyžaduje organizační účet. Hostovaná služba a místní režim mají jen Moje. Organizační účet se nikdy neobjeví mezi lidmi v žebříčku.

## Výběr období

Zvolte **30 dní**, **90 dní** nebo **Rok**. Tažením přes vlnu nahraného času vyberete vlastní období. Všechny grafy, součty a žebříčky výběr okamžitě následují. Vybrané období je zvýrazněné, zbytek roku zůstává tlumený.

Na vlnu můžete také přejít klávesnicí a prohlížet ji šipkami. Enter nastaví začátek výběru, po přesunu další Enter jeho konec. Shift se šipkou výběr rozšiřuje. Escape zruší výběr klávesnicí. U grafů procházejte úseky šipkami, Home a End. Najetí nebo zaměření modelu, člověka či buňky teplotní mapy ukáže čísla. Každá vizualizace má **Zobrazit jako tabulku**.

Období do 62 dní používá denní úseky. Delší období používá sedmidenní úseky končící posledním dnem výběru, případně s kratším prvním úsekem. Dny i hodiny teplotní mapy odpovídají časovému pásmu prohlížeče. Měření místa používá datum v UTC. Nahraný čas patří ke dni začátku nahrávky, graf počtu nahrávek ke dni importu. Změna porovnává stejně dlouhé předchozí období, u Roku i předchozí rok.

## Co čísla znamenají

Grafy ukazují nahrávky a dokončené požadavky na přepis a shrnutí, přijatou a shrnutou poštu, nové, hotové, zahozené a otevřené úkoly, útratu za AI podle kroků, místo na disku, modely podle ceny či počtu úloh, žebříček lidí, začátky nahrávek, růst Almanachu a opravené přeslechy a dobu od konce nahrávky po první shrnutí.

Žebříček lze řadit podle nahraného času, pošty, vyřešených úkolů nebo útraty za AI. Vyřešený úkol se připisuje členovi, který jej označil jako hotový. Útrata se připisuje tomu, kdo požadavek provedl, podle pravidla plátce pro daný pohled. Jména pocházejí ze zobrazovaných jmen účtů kolegů; chybějící jméno se zobrazí jako **Člen**. V pohledu Moje žebříček není.

Součty Almanachu zahrnují existující osoby, věci, pojmy a přezdívky. Sloučené záznamy se nepočítají. Sdílení záznam přesune nebo sloučí místo vytvoření druhé kopie. Firmy a projekty zahrnují i další typy věcí kromě pojmů. Doba do shrnutí ukazuje medián a 90. percentil ze všech nahrávek v úseku, nikoli průměr denních percentilů. Úsek bez shrnutí nemá hodnotu.

## Odhady a omezení

- **Historie místa na disku je měřená od data uvedeného nad grafem** a má plné čáry. První běh údržby každého dne v UTC zapíše jeden snímek pro každý existující účet. Další běhy měření daného dne nemění; účty vytvořené později získají první snímek následující den. Zvuk zahrnuje stažené a uchované soubory, pošta uchované původní zprávy včetně příloh. Organizace používá sdílené bajty naměřené v daný den; Všichni vynechávají duplicitní úložiště organizačního účtu. Chybějící dny přebírají poslední měření. Starší historie má přerušované čáry a dopočítává se z dochovaných údajů a dat smazání či retence. Doprovodné soubory, vlny a exporty nejsou zahrnuty. Snímky jsou odvozená data a přenosné zálohy je neobsahují.
- Vyřešené úkoly používají záznam změn stavu včetně člena, který změnu provedl. Znovuotevření zachovává dřívější vyřešení. Zahozené úkoly se počítají jen po přijetí; odmítnuté návrhy se nepočítají. Starší úkoly bez historie používají poslední stav a datum změny, dřívější změny tedy zůstávají neznámé. Otevřené úkoly sledují zaznamenané přechody s odhadovaným počátečním stavem starších úkolů. Archivy úkolů obsahují volitelnou historii změn; starší archivy lze nadále obnovit.
- Útrata za AI používá uložené ceny poskytovatelů. Opravy přepisu patří do Učení. Neznámé typy operací se zobrazí jako Ostatní. Úlohy bez známé ceny se počítají do využití modelu, ale ne do útraty. Cena na hodinu nahrávky nezahrnuje zpracování pošty. U Claude Code a Codexu jde o odhad odpovídajícího API, ne o platbu za předplatné.
- Přepis v prohlížeči, embeddingy, neúspěšná volání a práce před zavedením měření nemají událost využití. Trvalé smazání položky smaže i její události. Opakovaná spuštění se počítají zvlášť; víceprůchodové zpracování může pro jedno shrnutí vytvořit několik požadavků.
- Kromě měřeného místa sledují pohledy aktuálně uchované a sdílené položky. Smazání úkolu smaže i jeho historii změn. Statistiky nejsou trvalým auditem vlastnictví, sdílení ani vymazaného obsahu.

Dále: [Exporty, zálohy a retence](exports-backups-retention.md)
