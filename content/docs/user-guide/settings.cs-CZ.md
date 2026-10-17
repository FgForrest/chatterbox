---
title: Nastavení
description: Profily zpracování, poskytovatelé AI a ceny, výchozí hodnoty účtu a zobrazení.
---

Otevřete Nastavení z nabídky účtu (kulaté tlačítko s Vaší iniciálou), nebo stiskněte `,`. Sekce jsou seskupeny vlevo.

**Nápověda** v horní části Nastavení otevře tuto příručku přímo v sekci, kterou máte otevřenou.

![Nápověda pro sekci Shrnutí](images/help-drawer-settings.png)

## Profily

V **Nastavení → Profily** volíte, jak se nahrávky a pošta přepisují, učí, pojmenovávají, shrnují a převádějí na úkoly. Profily nahrazují dřívější přepínače automatizace účtu a výběr šablony vedle tlačítka **Shrnout**.

Použijte **Nový profil pro nahrávky** nebo **Nový profil pro poštu**, případně duplikujte existující profil. Každý krok má jeden přepínač **Spouštět automaticky**. Editor obsahuje také poskytovatele, model, jazyk, instrukce, formát výstupu a nastavení funkce **Vícenásobné shrnování**. Můžete nastavit jeden výchozí profil pro nahrávky a jeden pro poštu, nepoužívané profily archivovat a později je obnovit.

Je-li Organizace povolena, členové vidí profily Organizace a mohou je duplikovat do osobních profilů. Kurátoři mohou sdílené verze upravovat. Viz [Zpracování a profily](processing-and-profiles.md).

## Poskytovatelé AI

![Poskytovatelé AI](images/settings-providers.png)

**Nastavení → Poskytovatelé** odděluje karty **Vaši poskytovatelé** a **Poskytovatelé organizace**. Použijte tlačítko **Přidat poskytovatele** na kartě, kam klíč patří, vyberte službu, vložte její API klíč a zvolte model. Chatterbox nabízí přednastavení pro OpenAI, Groq, Together AI, OpenRouter, Google Gemini, ElevenLabs, Speechmatics, LM Studio a Ollama, přičemž varianta **Vlastní** přijme libovolnou službu s OpenAI-kompatibilní adresou. Klíče jsou ukládány šifrovaně a z bezpečnostních důvodů se již dále nezobrazují.

![Úprava poskytovatele](images/settings-provider-edit.png)

- **Cena.** Chatterbox zná zveřejněné ceny běžných modelů. Pro jiný model nebo odlišnou cenu ji zadejte zde. [Výdaj za AI](recordings.md#what-the-ai-cost) u nových požadavků použije tuto hodnotu; již zpracované náklady si zachovají původní cenu.
- **Duplikovat** vytvoří druhého osobního poskytovatele nebo poskytovatele Organizace se stejným klíčem, například silnější model pouze pro Učení. Klíč se znovu použije, aniž by se zobrazil.
- **Zakázat** ponechá klíč uložený, ale poskytovatele odebere z nových výběrů. Profil nebo role účtu, která na něj výslovně odkazuje, skončí chybou, dokud poskytovatele znovu nepovolíte nebo nevyberete jiného.
- **Claude Code** a **Codex** fungují díky předplatnému služby Claude nebo ChatGPT místo API klíče, přes můstek, který nastaví administrátor. Viz [Pro administrátory](administrators.md#claude-code-and-codex-subscriptions).

Někteří poskytovatelé zajišťují pouze přepis (ElevenLabs, Speechmatics). Kroky shrnutí pak potřebují druhého poskytovatele.

Členové vidí **Poskytovatele organizace** jen pro čtení a mohou kteréhokoli povoleného poskytovatele zvolit jako výchozího pro svůj účet. Osoby s oprávněním `access.manage` je mohou přidávat, duplikovat, upravovat, zakázat, povolit a odstranit, volit výchozí poskytovatele Organizace a na stejné kartě vidí využití podle členů. Výchozí poskytovatel Organizace platí pro všechny členy, včetně soukromých položek, dokud si člen pro stejnou roli nezvolí vlastního poskytovatele. Viz [Poskytovatelé Organizace](organization.md#organization-providers).

## Přepis

Sekce **Přepis** nyní obsahuje výchozí hodnoty účtu pro tlačítko **Přepsat**, generované názvy bez poskytovatele připnutého v profilu a importovaný obsah z diktafonu:

- výchozí poskytovatele přepisu a názvu,
- **Importovat přepisy a shrnutí Plaud** a **Synchronizovat názvy do Plaud**,
- **Primární přepis**, pokud jej vytvořil Plaud i Váš poskytovatel,
- **Výchozí jazyk přepisu**, který se použije při okamžitém přepisu.

Automatický přepis, vytváření názvů a poskytovatelé pro konkrétní profil se nastavují v sekci **Profily**. Názvy bez poskytovatele připnutého v profilu použijí Vaši volbu pro názvy, Vaši volbu pro shrnutí, výchozího poskytovatele Organizace pro názvy, výchozího poskytovatele Organizace pro shrnutí a nakonec Vašeho prvního povoleného poskytovatele chatu. Šablony názvů, které jste před zavedením profilů vytvořili nebo upravili, zůstávají pod **Šablony z doby před profily** a lze je zkopírovat do profilu.

## Témata

Tato sekce zachovává výchozího poskytovatele témat účtu. Profil bez
připnutého poskytovatele témat použije Vaši volbu pro témata, Vaši volbu pro
shrnutí, výchozího poskytovatele Organizace pro témata, výchozího poskytovatele
Organizace pro shrnutí a nakonec Vašeho prvního povoleného poskytovatele chatu. Automatická detekce témat se
nastavuje v sekci **Profily**. Šablony témat, které jste před zavedením profilů
vytvořili nebo upravili, zůstávají jen pro čtení pod **Šablony z doby před
profily**; pomocí **Zkopírovat do profilu** je můžete dál upravovat.

## Učení

Tato sekce zachovává výchozího poskytovatele Učení účtu. Profil bez připnutého
poskytovatele Učení použije Vaši volbu pro Učení, Vaši volbu pro shrnutí,
výchozího poskytovatele Organizace pro Učení, výchozího poskytovatele Organizace
pro shrnutí a nakonec Vašeho prvního povoleného poskytovatele chatu. Automatické Učení a oprava přepisu se nastavují
v sekci **Profily**.

## Shrnutí

Tato sekce zachovává výchozího poskytovatele shrnutí a předvolbu funkce
**Vícenásobné shrnování** účtu. Profil bez připnutého poskytovatele shrnutí
použije Vaši volbu pro shrnutí, výchozího poskytovatele Organizace pro shrnutí
a nakonec Vašeho prvního povoleného poskytovatele chatu. Automatické názvy a shrnutí, jazyk a formát výstupu a chování funkce
**Vícenásobné shrnování** v profilu se nastavují v
sekci **Profily**. Šablony shrnutí, které jste před zavedením profilů vytvořili
nebo upravili, zůstávají jen pro čtení pod **Šablony z doby před profily**;
pomocí **Zkopírovat do profilu** je můžete dál upravovat.

## Zobrazení

![Nastavení zobrazení](images/settings-display.png)

**Jazyk** (English nebo Čeština), způsob zobrazení data, pořadí seznamu nahrávek, počet nahrávek na stránce a motiv.

## Ostatní sekce

- **Plaud účet**: připojení, opětovné připojení či odpojení účtu diktafonu.
- **Synchronizace**: automatická synchronizace a interval jejího spouštění.
- **Přehrávání**: výchozí rychlost a hlasitost, automatické přehrání další nahrávky, zobrazení vlnového průběhu nebo ukazatele postupu.
- **Upozornění**: oznámení v prohlížeči, e-mailem nebo přes Bark na nové nahrávky.
- **Úložiště**: zabrané místo a [Automatické mazání starých dat](exports-backups-retention.md#deleting-old-data-automatically).
- **Export/záloha**: [exporty a zálohy](exports-backups-retention.md#backups).
- **API klíče** a **Webhooky**: propojení Chatterboxu s dalšími nástroji.
- **Google účet**: propojení Google účtu používaného pro [exporty na Google Drive](exports-backups-retention.md#to-google-drive).

Dále: [Chatterbox v Claude](claude.md)
