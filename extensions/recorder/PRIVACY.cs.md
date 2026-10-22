# Zásady ochrany soukromí rozšíření Klepna – nahrávání schůzek

Aktualizováno: 22. října 2026

Tyto zásady popisují **rozšíření prohlížeče Klepna – nahrávání schůzek**. Nenahrazují zásady ochrany soukromí serveru Klepny ani jiných služeb, které si zvolíte.

## Jaká data rozšíření zpracovává

Při nastavení rozšíření požádá o přístup k mikrofonu a krátce otevře a zastaví zkušební zvukový stream. Tento zkušební zvuk neukládá ani neodesílá. Pokud přístup před nahráváním chybí, musíte mikrofon povolit nebo výslovně zvolit nahrávání bez něj. Rozšíření sděluje po souhlasu s nakládáním s daty stav oprávnění mikrofonu webu právě nastavovaného nebo propojeného serveru prostřednictvím stávajícího kanálu pro rozpoznání a propojení; po souhlasu jej mohou prostřednictvím deklarovaného přímého kanálu pro nastavení získat také stránky pro místní vývoj na localhostu. U služeb Meet, Teams a webového Zoomu jsou výzvy k nahrávání ve výchozím nastavení zapnuté, pokud vaše uložená volba nebo nastavení serveru neurčí jinak. Výzva nikdy nespustí nahrávání bez vašeho zásahu a potvrzení upozornění účastníkům.

- Když spustíte nahrávání, rozšíření zachytává zvuk mikrofonu a zvuk vybrané karty se schůzkou nebo systémový zvuk zvolený v dialogu Chromu. Obraz obrazovky neukládá.
- Pokud zapnete rozpoznávání schůzek, kontroluje adresy a stav zvuku karet prohlížeče, aby rozpoznalo podporované služby a nabídlo nahrávání. Historii prohlížení ani adresy karet neodesílá.
- Do úložiště rozšíření ukládá adresu serveru, nastavení, náhodný identifikátor instalace a stav nahrávání. Identifikátor instalace sdílí po souhlasu s nakládáním s daty pouze s právě nastavovaným nebo propojeným serverem, mimo jiné pro zneplatnění starších klíčů této instalace; stránky pro místní vývoj na localhostu mohou používat také deklarovaný přímý kanál pro nastavení. Nejde o otisk zařízení ani o tajný údaj. Klíč pro nahrávání může vytvářet nahrávky a vyhledávat názvy složek pro jejich zařazení, ale nemůže číst nahrávky. Před uložením do `chrome.storage.local` ho šifruje. Neexportovatelný klíč Web Crypto ukládá do IndexedDB rozšíření. Toto opatření brání běžnému čtení místního úložiště, ale kód spuštěný v rozšíření nebo osoba s kopií celého profilu prohlížeče může klíč stále použít.
- Každou přibližně pětisekundovou zvukovou část šifruje klíčem vydaným vaším serverem ještě před zápisem do soukromého souborového systému Chromu. Šifrované části odesílá na zvolený server přes HTTPS. Server je dešifruje pro běžné uložení, přepis a export. V prohlížeči zůstanou do potvrzení dokončení serverem nebo do vašeho výslovného zahození. Pád prohlížeče či plný disk může nahrávání přerušit; obnovitelný může být jen ověřený začátek. Samotný prohlížeč může při práci se zvukem dočasně ukládat data mimo šifrované úložiště rozšíření.
- Přehratelná místní kopie se automaticky nestahuje. Po dokončení záznamu na serveru ji můžete stáhnout na stránce nahrávky po přihlášení do Klepny. Stažený soubor zůstane v počítači, dokud jej nesmažete.

## Volitelná výzva přímo ve schůzce

Teprve po zapnutí **Výzvy ve schůzce** a povolení volitelného přístupu v Chromu
běží izolovaný skript lišty na Google Meetu (`meet.google.com`), webovém Zoomu
(`zoom.us`), Microsoft Teams (`teams.microsoft.com`, `teams.live.com`,
`teams.cloud.microsoft`), Webexu (`webex.com`) a Whereby (`whereby.com`), včetně
jejich subdomén. Chrome pro těchto sedm adres zobrazí obecné upozornění
**Čtení a úprava dat na různých webech**, nikoli seznam jednotlivých webů. Ovládání zobrazuje jen v podporovaných místnostech schůzek.
Nečte obsah stránek, neprovádí síťové požadavky a nikam neodesílá obsah stránek
ani údaje z webu schůzky. Komunikuje pouze s procesem rozšíření na pozadí kvůli
ovládání nahrávání a výběru složky. Hledání složek používá již propojený server;
klíč pro nahrávání se stránce schůzky nezpřístupňuje. Vypnutí přepínače odebere
přístup k těmto webům, odregistruje skript a skryje jeho ovládání. Bez tohoto
volitelného přístupu zůstává systémové oznámení. Kliknutí na ikonu rozšíření při
zobrazené výzvě uloží vaše potvrzení upozornění účastníkům; samo o sobě nezískává
souhlas ostatních účastníků.

Stránka schůzky může prostřednictvím posluchačů klávesnice ve fázi zachytávání sledovat stisky kláves při hledání složek v liště Klepny.

## Kam se data odesílají

Rozšíření odesílá zvuk a údaje o nahrávání přímo na **adresu serveru Klepny, kterou při propojení povolíte**, s použitím klíče pro nahrávání. Ze stejného serveru načítá nastavení nahrávání. Vzdálený server musí používat HTTPS; pro místní vývoj na `localhost` lze použít HTTP. Rozšíření neposílá nahrávky na server vybraný vydavatelem rozšíření a nepoužívá je k reklamě, analytice ani prodeji.

Po přijetí dat o nich rozhoduje provozovatel serveru: o ukládání, době uchování, přepisu, použití služeb AI či úložišť, přístupu, exportu a mazání. Pokud provozujete vlastní server, odpovídáte za jeho nastavení a za informace či zásady ochrany soukromí, které pro něj vyžadují právní předpisy. Pokud server provozuje někdo jiný, před propojením si přečtěte jeho zásady. Vlastní server může podle nastavení provozovatele předávat data dalším službám; rozšíření to nemůže řídit.

## Nahrávání dalších osob

Vy rozhodujete, kdy spustíte nahrávání a který server je obdrží. Informujte účastníky schůzky a získejte souhlas, pokud jej vyžadují právní předpisy nebo pravidla schůzky. Kliknutím na **Souhlas potvrzen · Nahrávat** potvrdíte připomenutí; samo o sobě to nezískává souhlas ostatních účastníků.

## Vaše možnosti

Můžete zastavit nahrávání, změnit cílový server, zneplatnit klíč na serveru, zahodit šifrované části v prohlížeči a rozšíření odebrat. Čekající části jsou vázané na původní server a účet; změna serveru je nezpřístupní jinde. Smazání staženého souboru nebo vyrovnávací paměti neodstraní nahrávku již přijatou serverem. Pro smazání na serveru použijte jeho ovládací prvky nebo kontaktujte provozovatele. Při odebrání rozšíření prohlížeč běžně odstraní jeho úložiště, stažené soubory a kopie na serveru však zůstávají.

## Změny zásad a kontakt

Při změně nakládání s daty v rozšíření tyto zásady aktualizujeme a tam, kde je to vyžadováno, požádáme o nový souhlas. S dotazy k rozšíření kontaktujte vydavatele, od kterého jste jej získali. Dotazy ke zpracování dat na vlastním serveru směřujte na jeho provozovatele.
