# Zásady ochrany soukromí rozšíření Klepna – nahrávání schůzek

Aktualizováno: 13. října 2026

Tyto zásady popisují **rozšíření prohlížeče Klepna – nahrávání schůzek**. Nenahrazují zásady ochrany soukromí serveru Klepny ani jiných služeb, které si zvolíte.

## Jaká data rozšíření zpracovává

- Když spustíte nahrávání, rozšíření zachytává zvuk mikrofonu a zvuk vybrané karty se schůzkou nebo systémový zvuk zvolený v dialogu Chromu. Obraz obrazovky neukládá.
- Pokud zapnete rozpoznávání schůzek, kontroluje adresy a stav zvuku karet prohlížeče, aby rozpoznalo podporované služby a nabídlo nahrávání. Historii prohlížení ani adresy karet neodesílá.
- Do úložiště rozšíření ukládá adresu serveru, nastavení, náhodný identifikátor instalace a stav nahrávání. Identifikátor instalace posílá propojenému serveru, aby mohl zneplatnit starší klíče této instalace; nejde o otisk zařízení ani o tajný údaj. Klíč pro nahrávání s oprávněním pouze k zápisu před uložením do `chrome.storage.local` šifruje. Neexportovatelný klíč Web Crypto ukládá do IndexedDB rozšíření. Toto opatření brání běžnému čtení místního úložiště, ale kód spuštěný v rozšíření nebo osoba s kopií celého profilu prohlížeče může klíč stále použít.
- Každou přibližně pětisekundovou zvukovou část šifruje klíčem vydaným vaším serverem ještě před zápisem do soukromého souborového systému Chromu. Šifrované části odesílá na zvolený server přes HTTPS. Server je dešifruje pro běžné uložení, přepis a export. V prohlížeči zůstanou do potvrzení dokončení serverem nebo do vašeho výslovného zahození. Pád prohlížeče či plný disk může nahrávání přerušit; obnovitelný může být jen ověřený začátek. Samotný prohlížeč může při práci se zvukem dočasně ukládat data mimo šifrované úložiště rozšíření.
- Přehratelná místní kopie se automaticky nestahuje. Po dokončení záznamu na serveru ji můžete stáhnout na stránce nahrávky po přihlášení do Klepny. Stažený soubor zůstane v počítači, dokud jej nesmažete.

## Kam se data odesílají

Rozšíření odesílá zvuk a údaje o nahrávání přímo na **adresu serveru Klepny, kterou při propojení povolíte**, s použitím klíče pro nahrávání. Ze stejného serveru načítá nastavení nahrávání. Vzdálený server musí používat HTTPS; pro místní vývoj na `localhost` lze použít HTTP. Rozšíření neposílá nahrávky na server vybraný vydavatelem rozšíření a nepoužívá je k reklamě, analytice ani prodeji.

Po přijetí dat o nich rozhoduje provozovatel serveru: o ukládání, době uchování, přepisu, použití služeb AI či úložišť, přístupu, exportu a mazání. Pokud provozujete vlastní server, odpovídáte za jeho nastavení a za informace či zásady ochrany soukromí, které pro něj vyžadují právní předpisy. Pokud server provozuje někdo jiný, před propojením si přečtěte jeho zásady. Vlastní server může podle nastavení provozovatele předávat data dalším službám; rozšíření to nemůže řídit.

## Nahrávání dalších osob

Vy rozhodujete, kdy spustíte nahrávání a který server je obdrží. Informujte účastníky schůzky a získejte souhlas, pokud jej vyžadují právní předpisy nebo pravidla schůzky. Kliknutím na **Souhlas potvrzen · Nahrávat** potvrdíte připomenutí; samo o sobě to nezískává souhlas ostatních účastníků.

## Vaše možnosti

Můžete zastavit nahrávání, změnit cílový server, zneplatnit klíč na serveru, zahodit šifrované části v prohlížeči a rozšíření odebrat. Čekající části jsou vázané na původní server a účet; změna serveru je nezpřístupní jinde. Smazání staženého souboru nebo vyrovnávací paměti neodstraní nahrávku již přijatou serverem. Pro smazání na serveru použijte jeho ovládací prvky nebo kontaktujte provozovatele. Při odebrání rozšíření prohlížeč běžně odstraní jeho úložiště, stažené soubory a kopie na serveru však zůstávají.

## Změny zásad a kontakt

Při změně nakládání s daty v rozšíření tyto zásady aktualizujeme a tam, kde je to vyžadováno, požádáme o nový souhlas. S dotazy k rozšíření pište na [application_development@fg.cz](mailto:application_development@fg.cz). Dotazy ke zpracování dat na vlastním serveru směřujte na jeho provozovatele.
