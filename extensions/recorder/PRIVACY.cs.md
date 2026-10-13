# Zásady ochrany soukromí rozšíření Klepna – nahrávání schůzek

Aktualizováno: 13. října 2026

Tyto zásady popisují **rozšíření prohlížeče Klepna – nahrávání schůzek**. Nenahrazují zásady ochrany soukromí serveru Klepny ani jiných služeb, které si zvolíte.

## Jaká data rozšíření zpracovává

- Když spustíte nahrávání, rozšíření zachytává zvuk mikrofonu a zvuk vybrané karty se schůzkou nebo systémový zvuk zvolený v dialogu Chromu. Obraz obrazovky neukládá.
- Pokud zapnete rozpoznávání schůzek, kontroluje adresy a stav zvuku karet prohlížeče, aby rozpoznalo podporované služby a nabídlo nahrávání. Historii prohlížení ani adresy karet neodesílá.
- Do úložiště rozšíření v prohlížeči ukládá adresu serveru, klíč pro nahrávání s oprávněním pouze k zápisu, nastavení a stav nahrávání. Klíč používá k ověření odesílání na zvolený server.
- Zvukové části a údaje o relaci dočasně ukládá do soukromého souborového systému Chromu, aby mohlo navázat na přerušené odesílání. Po úspěšném odeslání nebo při zahození relace je odstraní. Při neúspěšném odeslání mohou zůstat uložené, dokud odeslání nezopakujete nebo relaci nezahodíte. Uložený zvuk ani klíč rozšíření **nešifruje**; chraňte přístup ke svému počítači a profilu prohlížeče.
- Ve výchozím nastavení po úspěšném odeslání stáhne také zvukovou kopii `.webm` do složky Stažené soubory. V Možnostech můžete nastavit dotaz na místo uložení nebo stahování vypnout. Stažený soubor zůstane v počítači, dokud jej nesmažete.

## Kam se data odesílají

Rozšíření odesílá zvuk a údaje o nahrávání přímo na **adresu serveru Klepny, kterou při propojení povolíte**, s použitím klíče pro nahrávání. Ze stejného serveru načítá nastavení nahrávání. Vzdálený server musí používat HTTPS; pro místní vývoj na `localhost` lze použít HTTP. Rozšíření neposílá nahrávky na server vybraný vydavatelem rozšíření a nepoužívá je k reklamě, analytice ani prodeji.

Po přijetí dat o nich rozhoduje provozovatel serveru: o ukládání, době uchování, přepisu, použití služeb AI či úložišť, přístupu, exportu a mazání. Pokud provozujete vlastní server, odpovídáte za jeho nastavení a za informace či zásady ochrany soukromí, které pro něj vyžadují právní předpisy. Pokud server provozuje někdo jiný, před propojením si přečtěte jeho zásady. Vlastní server může podle nastavení provozovatele předávat data dalším službám; rozšíření to nemůže řídit.

## Nahrávání dalších osob

Vy rozhodujete, kdy spustíte nahrávání a který server je obdrží. Informujte účastníky schůzky a získejte souhlas, pokud jej vyžadují právní předpisy nebo pravidla schůzky. Zaškrtávací políčko rozšíření potvrzuje vaše prohlášení; samo o sobě nezískává souhlas ostatních účastníků.

## Vaše možnosti

Můžete zastavit nahrávání, změnit cílový server, zneplatnit klíč na serveru, změnit nebo vypnout místní stahování a rozšíření odebrat. Smazání místní kopie nebo vyrovnávací paměti neodstraní nahrávku již přijatou serverem. Pro smazání na serveru použijte jeho ovládací prvky nebo kontaktujte provozovatele. Při odebrání rozšíření prohlížeč běžně odstraní jeho úložiště, stažené soubory a kopie na serveru však zůstávají.

## Změny zásad a kontakt

Při změně nakládání s daty v rozšíření tyto zásady aktualizujeme a tam, kde je to vyžadováno, požádáme o nový souhlas. Dotazy k rozšíření můžete zadat jako [issue v repozitáři Chatterbox](https://github.com/FgForrest/chatterbox/issues). Dotazy ke zpracování dat na vlastním serveru směřujte na jeho provozovatele.
