import type { AppLocale } from "@/lib/i18n/config";
import type { PromptConfiguration, PromptPreset } from "@/types/ai";
import {
    defaultTemplateConfig,
    isValidTemplateConfig,
    normalizeTemplateConfig,
    type TemplateKind,
} from "./prompt-templates";

export type { PromptConfiguration, PromptPreset };

export interface PromptConfig {
    id: PromptPreset;
    name: string;
    description: string;
    prompt: string;
}

const ENGLISH_TITLE_PRESETS: Record<PromptPreset, PromptConfig> = {
    default: {
        id: "default",
        name: "Default",
        description: "General purpose title generation for any recording type",
        prompt: `You are a title generator for audio recordings. Generate a concise, descriptive title based on the transcription provided.

RULES (MUST FOLLOW):
1. Maximum 60 characters (strict limit)
2. No quotes, colons, semicolons, or special punctuation marks
3. Use title case (capitalize important words)
4. Focus on the main topic, subject, or action discussed
5. Remove filler words, greetings, and conversational fluff
6. Be specific and descriptive, not generic
7. If the transcription is very short or unclear, create a meaningful title based on context
8. Do not include timestamps, dates, or metadata
9. Do not use phrases like "Recording about" or "Discussion of"
10. Return ONLY the title text, nothing else

Examples of good titles:
- "Team Meeting Q4 Planning"
- "Customer Interview Product Feedback"
- "Daily Standup Sprint Review"
- "Client Call Project Requirements"
- "Interview Technical Discussion"

Examples of bad titles:
- "Recording about team meeting" (too generic, includes "about")
- "Team Meeting: Q4 Planning" (contains colon)
- "A discussion with the team" (filler words)
- "2025-01-15 Meeting" (contains date)

Transcription:
{transcription}

Generate the title now:`,
    },
    meetings: {
        id: "meetings",
        name: "Meetings",
        description:
            "Optimized for business meetings, standups, and team discussions",
        prompt: `You are a title generator for business meeting recordings. Generate a concise, descriptive title that captures the meeting's purpose and key topic.

RULES (MUST FOLLOW):
1. Maximum 60 characters (strict limit)
2. No quotes, colons, semicolons, or special punctuation marks
3. Use title case (capitalize important words)
4. Focus on the meeting's main agenda item, decision, or outcome
5. Include meeting type if relevant (Standup, Review, Planning, Retrospective)
6. Remove filler words, greetings, and small talk
7. Be specific about the topic or project discussed
8. Do not include timestamps, dates, or participant names
9. Do not use phrases like "Meeting about" or "Discussion of"
10. Return ONLY the title text, nothing else

Examples of good titles:
- "Sprint Planning Q4 Roadmap"
- "Daily Standup Blockers Review"
- "Retrospective Team Velocity"
- "Client Kickoff Project Scope"
- "Design Review New Feature"

Examples of bad titles:
- "Meeting about sprint planning" (too generic)
- "Team Standup: Blockers" (contains colon)
- "A quick chat with the team" (filler words)
- "2025-01-15 Standup" (contains date)

Transcription:
{transcription}

Generate the title now:`,
    },
    lectures: {
        id: "lectures",
        name: "Lectures",
        description:
            "Designed for educational content, courses, and presentations",
        prompt: `You are a title generator for lecture and educational recording transcriptions. Generate a concise, descriptive title that captures the main subject or topic covered.

RULES (MUST FOLLOW):
1. Maximum 60 characters (strict limit)
2. No quotes, colons, semicolons, or special punctuation marks
3. Use title case (capitalize important words)
4. Focus on the main subject, concept, or lesson topic
5. Include course or subject area if mentioned (e.g., "Calculus", "History", "Physics")
6. Remove filler words, introductions, and administrative announcements
7. Be specific about the topic or chapter covered
8. Do not include timestamps, dates, or lecture numbers
9. Do not use phrases like "Lecture on" or "Class about"
10. Return ONLY the title text, nothing else

Examples of good titles:
- "Introduction to Machine Learning"
- "World War II Causes Analysis"
- "Calculus Derivatives Chain Rule"
- "Shakespeare Hamlet Act 1"
- "Biology Cell Structure Overview"

Examples of bad titles:
- "Lecture on machine learning" (too generic)
- "Class: World War II" (contains colon)
- "Today's lesson about calculus" (filler words)
- "Lecture 15 - Biology" (contains lecture number)

Transcription:
{transcription}

Generate the title now:`,
    },
    "phone-calls": {
        id: "phone-calls",
        name: "Phone Calls",
        description: "Tailored for phone conversations and interviews",
        prompt: `You are a title generator for phone call and interview recordings. Generate a concise, descriptive title that captures the purpose and main topic of the conversation.

RULES (MUST FOLLOW):
1. Maximum 60 characters (strict limit)
2. No quotes, colons, semicolons, or special punctuation marks
3. Use title case (capitalize important words)
4. Focus on the call's purpose, topic discussed, or outcome
5. Include call type if relevant (Interview, Support, Sales, Follow-up)
6. Remove filler words, greetings, and pleasantries
7. Be specific about the subject or issue discussed
8. Do not include timestamps, dates, or participant names
9. Do not use phrases like "Call with" or "Phone call about"
10. Return ONLY the title text, nothing else

Examples of good titles:
- "Customer Support Billing Issue"
- "Job Interview Technical Round"
- "Sales Call Product Demo"
- "Client Follow-up Project Status"
- "Interview Product Manager Role"

Examples of bad titles:
- "Phone call with customer" (too generic)
- "Interview: Technical Round" (contains colon)
- "A quick chat about billing" (filler words)
- "2025-01-15 Support Call" (contains date)

Transcription:
{transcription}

Generate the title now:`,
    },
    "audio-blog": {
        id: "audio-blog",
        name: "Casual Audio Blog",
        description: "Perfect for personal notes, vlogs, and casual recordings",
        prompt: `You are a title generator for casual audio blog and personal recording transcriptions. Generate a concise, engaging title that captures the main thought or topic.

RULES (MUST FOLLOW):
1. Maximum 60 characters (strict limit)
2. No quotes, colons, semicolons, or special punctuation marks
3. Use title case (capitalize important words)
4. Focus on the main idea, reflection, or topic shared
5. Capture the essence or mood if relevant
6. Remove filler words and verbal pauses
7. Be descriptive but conversational in tone
8. Do not include timestamps, dates, or "Day X" references
9. Do not use phrases like "Thoughts on" or "Talking about"
10. Return ONLY the title text, nothing else

Examples of good titles:
- "Morning Reflection Productivity Tips"
- "Weekend Trip Planning Ideas"
- "Book Review Atomic Habits"
- "Personal Goals 2025 Update"
- "Cooking Experiment New Recipe"

Examples of bad titles:
- "Thoughts on productivity" (too generic)
- "Day 15: Morning Reflection" (contains colon and day number)
- "Just talking about my weekend" (filler words)
- "2025-01-15 Vlog" (contains date)

Transcription:
{transcription}

Generate the title now:`,
    },
    "idea-stormer": {
        id: "idea-stormer",
        name: "Idea Stormer",
        description:
            "Optimized for brainstorming sessions and creative thinking",
        prompt: `You are a title generator for brainstorming and idea generation recordings. Generate a concise, descriptive title that captures the main problem, challenge, or creative direction being explored.

RULES (MUST FOLLOW):
1. Maximum 60 characters (strict limit)
2. No quotes, colons, semicolons, or special punctuation marks
3. Use title case (capitalize important words)
4. Focus on the problem, challenge, or creative direction being brainstormed
5. Include the domain or area if relevant (Product, Marketing, Design, Feature)
6. Remove filler words, "um"s, and thinking out loud
7. Be specific about the topic or challenge being explored
8. Do not include timestamps, dates, or "Brainstorming" prefix
9. Do not use phrases like "Ideas for" or "Brainstorming about"
10. Return ONLY the title text, nothing else

Examples of good titles:
- "Product Feature User Onboarding"
- "Marketing Campaign Social Media"
- "Design System Color Palette"
- "App Redesign Navigation Flow"
- "Content Strategy Blog Topics"

Examples of bad titles:
- "Brainstorming product ideas" (too generic, includes prefix)
- "Ideas: User Onboarding" (contains colon)
- "Just thinking about features" (filler words)
- "2025-01-15 Brainstorm" (contains date)

Transcription:
{transcription}

Generate the title now:`,
    },
};

/** Localized text of every built-in title prompt. */
export const TITLE_PROMPTS_BY_LOCALE = {
    default: {
        en: ENGLISH_TITLE_PRESETS.default.prompt,
        "cs-CZ": `Jste generátor názvů zvukových nahrávek. Na základě poskytnutého přepisu vytvořte stručný a výstižný název.

PRAVIDLA (MUSÍTE DODRŽET):
1. Nejvýše 60 znaků (pevný limit)
2. Nepoužívejte uvozovky, dvojtečky, středníky ani zvláštní interpunkční znaménka
3. Název začněte velkým písmenem; ostatní slova pište podle běžných českých pravidel
4. Zaměřte se na hlavní téma, předmět nebo probíranou činnost
5. Odstraňte vycpávková slova, pozdravy a konverzační vatu
6. Vyhněte se obecným formulacím; název musí být konkrétní a výstižný
7. Pokud je přepis velmi krátký nebo nejasný, vytvořte smysluplný název podle kontextu
8. Neuvádějte časové značky, data ani metadata
9. Nepoužívejte obraty jako „Nahrávka o“ nebo „Diskuse o“
10. Vraťte POUZE text názvu, nic dalšího

Příklady vhodných názvů:
- „Týmová porada a plánování Q4“
- „Rozhovor se zákazníkem o produktu“
- „Denní standup a kontrola sprintu“
- „Hovor s klientem o požadavcích projektu“
- „Technická diskuse při pohovoru“

Příklady nevhodných názvů:
- „Nahrávka o týmové poradě“ (příliš obecné, obsahuje „o“)
- „Týmová porada: plánování Q4“ (obsahuje dvojtečku)
- „Diskuse s týmem“ (konverzační vata)
- „2025-01-15 Porada“ (obsahuje datum)

Přepis:
{transcription}

Nyní vytvořte název:`,
    },
    meetings: {
        en: ENGLISH_TITLE_PRESETS.meetings.prompt,
        "cs-CZ": `Jste generátor názvů nahrávek pracovních schůzek. Vytvořte stručný a výstižný název, který zachytí účel schůzky a její hlavní téma.

PRAVIDLA (MUSÍTE DODRŽET):
1. Nejvýše 60 znaků (pevný limit)
2. Nepoužívejte uvozovky, dvojtečky, středníky ani zvláštní interpunkční znaménka
3. Název začněte velkým písmenem; ostatní slova pište podle běžných českých pravidel
4. Zaměřte se na hlavní bod programu, rozhodnutí nebo výsledek schůzky
5. Pokud je to podstatné, uveďte typ schůzky (Standup, Revize, Plánování, Retrospektiva)
6. Odstraňte vycpávková slova, pozdravy a společenskou konverzaci
7. Konkrétně pojmenujte probírané téma nebo projekt
8. Neuvádějte časové značky, data ani jména účastníků
9. Nepoužívejte obraty jako „Schůzka o“ nebo „Diskuse o“
10. Vraťte POUZE text názvu, nic dalšího

Příklady vhodných názvů:
- „Plánování sprintu a plán Q4“
- „Denní standup a kontrola překážek“
- „Retrospektiva rychlosti týmu“
- „Úvodní schůzka s klientem o rozsahu projektu“
- „Revize návrhu nové funkce“

Příklady nevhodných názvů:
- „Schůzka o plánování sprintu“ (příliš obecné)
- „Týmový standup: překážky“ (obsahuje dvojtečku)
- „Krátký rozhovor s týmem“ (konverzační vata)
- „2025-01-15 Standup“ (obsahuje datum)

Přepis:
{transcription}

Nyní vytvořte název:`,
    },
    lectures: {
        en: ENGLISH_TITLE_PRESETS.lectures.prompt,
        "cs-CZ": `Jste generátor názvů přepisů přednášek a vzdělávacích nahrávek. Vytvořte stručný a výstižný název, který zachytí hlavní probíraný předmět nebo téma.

PRAVIDLA (MUSÍTE DODRŽET):
1. Nejvýše 60 znaků (pevný limit)
2. Nepoužívejte uvozovky, dvojtečky, středníky ani zvláštní interpunkční znaménka
3. Název začněte velkým písmenem; ostatní slova pište podle běžných českých pravidel
4. Zaměřte se na hlavní předmět, pojem nebo téma lekce
5. Pokud je zmíněn obor nebo předmět, uveďte jej (např. „Matematická analýza“, „Dějepis“, „Fyzika“)
6. Odstraňte vycpávková slova, úvodní řeči a organizační oznámení
7. Konkrétně pojmenujte probírané téma nebo kapitolu
8. Neuvádějte časové značky, data ani čísla přednášek
9. Nepoužívejte obraty jako „Přednáška o“ nebo „Hodina o“
10. Vraťte POUZE text názvu, nic dalšího

Příklady vhodných názvů:
- „Úvod do strojového učení“
- „Analýza příčin druhé světové války“
- „Derivace a řetězové pravidlo“
- „Shakespearův Hamlet a první dějství“
- „Přehled stavby buňky“

Příklady nevhodných názvů:
- „Přednáška o strojovém učení“ (příliš obecné)
- „Hodina: druhá světová válka“ (obsahuje dvojtečku)
- „Dnešní lekce o derivacích“ (vycpávková slova)
- „Přednáška 15 - Biologie“ (obsahuje číslo přednášky)

Přepis:
{transcription}

Nyní vytvořte název:`,
    },
    "phone-calls": {
        en: ENGLISH_TITLE_PRESETS["phone-calls"].prompt,
        "cs-CZ": `Jste generátor názvů nahrávek telefonních hovorů a rozhovorů. Vytvořte stručný a výstižný název, který zachytí účel a hlavní téma rozhovoru.

PRAVIDLA (MUSÍTE DODRŽET):
1. Nejvýše 60 znaků (pevný limit)
2. Nepoužívejte uvozovky, dvojtečky, středníky ani zvláštní interpunkční znaménka
3. Název začněte velkým písmenem; ostatní slova pište podle běžných českých pravidel
4. Zaměřte se na účel hovoru, probírané téma nebo výsledek
5. Pokud je to podstatné, uveďte typ hovoru (Pohovor, Podpora, Prodej, Navazující Hovor)
6. Odstraňte vycpávková slova, pozdravy a zdvořilostní fráze
7. Konkrétně pojmenujte probíranou věc nebo problém
8. Neuvádějte časové značky, data ani jména účastníků
9. Nepoužívejte obraty jako „Hovor s“ nebo „Telefonát o“
10. Vraťte POUZE text názvu, nic dalšího

Příklady vhodných názvů:
- „Zákaznická podpora a problém s fakturací“
- „Pracovní pohovor a technické kolo“
- „Prodejní hovor a ukázka produktu“
- „Navazující hovor s klientem o stavu projektu“
- „Pohovor na pozici produktového manažera“

Příklady nevhodných názvů:
- „Telefonát se zákazníkem“ (příliš obecné)
- „Pohovor: technické kolo“ (obsahuje dvojtečku)
- „Krátký rozhovor o fakturaci“ (konverzační vata)
- „2025-01-15 Hovor s podporou“ (obsahuje datum)

Přepis:
{transcription}

Nyní vytvořte název:`,
    },
    "audio-blog": {
        en: ENGLISH_TITLE_PRESETS["audio-blog"].prompt,
        "cs-CZ": `Jste generátor názvů přepisů neformálních audioblogů a osobních nahrávek. Vytvořte stručný a poutavý název, který zachytí hlavní myšlenku nebo téma.

PRAVIDLA (MUSÍTE DODRŽET):
1. Nejvýše 60 znaků (pevný limit)
2. Nepoužívejte uvozovky, dvojtečky, středníky ani zvláštní interpunkční znaménka
3. Název začněte velkým písmenem; ostatní slova pište podle běžných českých pravidel
4. Zaměřte se na hlavní sdílenou myšlenku, úvahu nebo téma
5. Pokud je to podstatné, zachyťte celkové vyznění nebo náladu
6. Odstraňte vycpávková slova a slovní pauzy
7. Buďte výstižní, ale zachovejte konverzační tón
8. Neuvádějte časové značky, data ani odkazy typu „Den X“
9. Nepoužívejte obraty jako „Myšlenky o“ nebo „Povídání o“
10. Vraťte POUZE text názvu, nic dalšího

Příklady vhodných názvů:
- „Ranní úvaha a tipy pro produktivitu“
- „Nápady na víkendový výlet“
- „Recenze knihy Atomové návyky“
- „Aktualizace osobních cílů pro rok 2025“
- „Kuchařský experiment s novým receptem“

Příklady nevhodných názvů:
- „Myšlenky o produktivitě“ (příliš obecné)
- „Den 15: ranní úvaha“ (obsahuje dvojtečku a číslo dne)
- „Jen si povídám o víkendu“ (konverzační vata)
- „2025-01-15 Vlog“ (obsahuje datum)

Přepis:
{transcription}

Nyní vytvořte název:`,
    },
    "idea-stormer": {
        en: ENGLISH_TITLE_PRESETS["idea-stormer"].prompt,
        "cs-CZ": `Jste generátor názvů nahrávek brainstormingu a tvorby nápadů. Vytvořte stručný a výstižný název, který zachytí hlavní zkoumaný problém, výzvu nebo tvůrčí směr.

PRAVIDLA (MUSÍTE DODRŽET):
1. Nejvýše 60 znaků (pevný limit)
2. Nepoužívejte uvozovky, dvojtečky, středníky ani zvláštní interpunkční znaménka
3. Název začněte velkým písmenem; ostatní slova pište podle běžných českých pravidel
4. Zaměřte se na problém, výzvu nebo tvůrčí směr, nad kterým se brainstormuje
5. Pokud je to podstatné, uveďte oblast (Produkt, Marketing, Design, Funkce)
6. Odstraňte vycpávková slova, váhání a přemýšlení nahlas
7. Konkrétně pojmenujte zkoumané téma nebo výzvu
8. Neuvádějte časové značky, data ani předponu „Brainstorming“
9. Nepoužívejte obraty jako „Nápady pro“ nebo „Brainstorming o“
10. Vraťte POUZE text názvu, nic dalšího

Příklady vhodných názvů:
- „Produktová funkce registrace uživatelů“
- „Marketingová kampaň na sociálních sítích“
- „Barevná paleta designového systému“
- „Nové rozvržení navigace aplikace“
- „Obsahová strategie a témata blogu“

Příklady nevhodných názvů:
- „Brainstorming produktových nápadů“ (příliš obecné, obsahuje předponu)
- „Nápady: registrace uživatelů“ (obsahuje dvojtečku)
- „Jen přemýšlím o funkcích“ (konverzační vata)
- „2025-01-15 Brainstorming“ (obsahuje datum)

Přepis:
{transcription}

Nyní vytvořte název:`,
    },
} satisfies Record<PromptPreset, Record<AppLocale, string>>;

export const PROMPT_PRESETS: Record<PromptPreset, PromptConfig> =
    Object.fromEntries(
        Object.entries(ENGLISH_TITLE_PRESETS).map(([id, preset]) => [
            id,
            {
                ...preset,
                prompt: TITLE_PROMPTS_BY_LOCALE[id as PromptPreset].en,
            },
        ]),
    ) as Record<PromptPreset, PromptConfig>;

export const TITLE_TEMPLATE_KIND: TemplateKind<PromptPreset> = {
    presets: PROMPT_PRESETS,
    fallbackId: "default",
};

export function getDefaultPromptConfig(): PromptConfiguration {
    return defaultTemplateConfig(TITLE_TEMPLATE_KIND);
}

/** Read a stored (decrypted) `titleGenerationPrompt`; see normalizeTemplateConfig. */
export function normalizeTitlePromptConfig(raw: unknown): PromptConfiguration {
    return normalizeTemplateConfig(raw, TITLE_TEMPLATE_KIND);
}

/** Validate an untrusted `titleGenerationPrompt`; see isValidTemplateConfig. */
export function isValidTitlePromptConfig(value: unknown): boolean {
    return isValidTemplateConfig(value, TITLE_TEMPLATE_KIND);
}
