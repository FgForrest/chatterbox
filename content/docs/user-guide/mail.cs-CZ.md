---
title: Pošta
description: Posílání pošty do vašich Klepů.
---

Když to váš správce nastaví, může se k nahrávkám přidat i pošta. Pošta poslaná na vaše adresy přistane zašifrovaná ve vašich **Klepech** vedle nahrávek. Přepínač nad seznamem ukazuje **Vše**, **Zvuk** nebo **Pošta**.

Když máte otevřené **Klepy** a dorazí pošta, upozornění **Nový e-mail** ukáže předmět, odesílatele a čas. Výběr ani složka se nezmění. **Otevřít** otevře zprávu a tlačítko Zpět vás vrátí. Upozornění můžete zavřít a poštu si přečíst později v **Nedávných**. Novější příchozí položka upozornění nahradí. Pošta, kterou kolegové sdílejí do Organizace, ho nevyvolá.

Pošta vyžaduje jednotné přihlášení: adresy dostanete, jakmile se přihlásíte účtem své organizace. Když se tak dlouho nepřihlásíte, adresy se pozastaví a obnoví se při dalším přihlášení.

## Vaše adresy

Najdete je v **Nastavení → Pošta**.

- Vaše **schránka** (`zorven@…`) ukládá poštu do Klepů bez složky. Pruh pracovního postupu začíná krokem **Přijato** ve stavu **Hotovo** a krokem **Zařazení** ve stavu **Další**. Vložená karta **Zařadit e-mail** zobrazuje pole **Složka** a **Profil**, případně volbu **Bez automatického zpracování**. Žádný placený krok AI se nespustí, dokud nekliknete na **Zařadit e-mail**.
- Každá složka má adresu (`zorven+weekly@…`), která poštu uloží rovnou do ní. Pošta přeskočí čekání a použije výchozí profil pošty dané složky.

Na tyto adresy se přijímá jen pošta, kterou posíláte sami z účtu, kterým se přihlašujete: přepošlete na ni e-mail, nebo ji při psaní dejte do **Komu**, **Kopie** nebo **Skrytá kopie**. Klepna kontroluje podpis e-mailu, takže nikdo nemůže psát vaším jménem.

## Adresy složek

Adresy složky zobrazíte v **Nastavení složky**, které otevřete u názvu složky nebo v nabídce **⋯**. Řádek **E-mail do složky** ukazuje adresu s tlačítkem kopírování a časem posledního e-mailu. Zkopírujte aktuální adresu, nebo složce dejte vlastní: stará dál funguje jako vedlejší adresa, dokud ji neodeberete. Adresa, která už jednou byla přidělena, se nikdy nepřidělí nikomu jinému. Pošta na kteroukoli z těchto adres se zařadí a může automaticky spustit profil.

Smazání složky natrvalo zastaví její adresy i adresy podsložek. Klepna před potvrzením ukáže, kdy na každou naposledy přišla pošta.

## Složky Organizace

Složky Organizace mají adresy začínající jménem organizace (`acme-weekly@…`). Psát na ně může kterýkoli kolega, v **Komu** nebo **Kopie** (ne ve **Skryté kopii**). E-mail zůstává nejprve soukromý a daná složka je jeho zamýšleným umístěním v Organizaci. Profil Organizace proběhne v soukromém pohledu a Klepna e-mail automaticky nasdílí po dokončení kontroly Učení. Kontrola úkolů sdílení nezdržuje. Při volbě **Bez automatického zpracování** nabízí řádek složek místo toho **Sdílet nyní** a pruh pracovního postupu čeká na Vás.

Sdílet můžete i jakýkoli jiný svůj e-mail, když ho zařadíte do složky Organizace. Kolegové sdílený e-mail čtou i s přílohami a formátovanou podobou; smazat ho nebo stáhnout původní zprávu můžete jen vy.

## Tajné adresy

Pro poštu, kterou neposíláte sami, si v **Nastavení → Pošta** vytvořte **tajnou adresu**. Rozšiřuje Vaši schránku nebo adresu složky o náhodnou část (`zorven.k3x9…@…`) a ukládá poštu stejně, od kohokoli. Tajná adresa rozšiřující schránku nechá poštu čekat na zařazení; adresa rozšiřující složku čekání přeskočí. Psát na ni může každý, kdo ji zná: pojmenujte ji, ať ji poznáte, a když unikne, **vyměňte** ji nebo ji **zastavte**.

### Filtry Gmailu a automatické přeposílání

Automatické přeposílání zachovává původního odesílatele, proto potřebuje tajnou adresu.

1. Vytvořte tajnou adresu a zkopírujte ji.
2. V Gmailu otevřete **Nastavení → Přeposílání a POP/IMAP → Přidat adresu pro přeposílání** a zadejte ji.
3. Gmail na adresu pošle potvrzovací kód. Přijde do vašich Klepů jako e-mail od Googlu: otevřete ho a kód zadejte v Gmailu.
4. Vytvořte filtr Gmailu, který přeposílá na tuto adresu.

## Čtení pošty

E-mail ukazuje odesílatele, s označením **Ověřeno**, když ho podepsala doména odesílatele, dále příjemce a datum. Citované a přeposlané zprávy jsou sbalené pod svým autorem. **Zobrazit formátovaně** ukáže e-mail tak, jak byl navržen, aniž by se cokoli načítalo z internetu. Přílohy jdou jen stáhnout.

Vyhledávání v Klepech najde slova i v přeposlaných a citovaných zprávách. Podpisy a doložky o důvěrnosti se neprohledávají.

S postupem zpracování se v tomto pořadí zobrazují vložené prvky kontroly Učení, **Shrnutí** a **Kontrola úkolů**. Hotové prvky se během další práce skládají do jednoho řádku. Krok, který po pracovním postupu spustíte sami, ukazuje svůj průběh na místě; okno kontroly se otevře až po kliknutí na **Zkontrolovat** nebo **Zobrazit výsledky**.

Pošta odeslaná stroji (automatické odpovědi, konference, oznámení) se uchová, ale je označena **Nezpracováno**. Nespustí se pro ni žádný krok AI.

## Záznam doručení

**Nastavení → Pošta → Záznam doručení** ukazuje, co se za posledních 30 dní stalo s poštou poslanou na vaše adresy: přijato, už přijato, nebo odmítnuto a proč. Odmítnutá pošta se neuchovává.

Další: [Exporty, zálohy a retence](exports-backups-retention.md)
