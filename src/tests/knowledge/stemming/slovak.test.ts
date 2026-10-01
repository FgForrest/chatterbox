import { describe, expect, it } from "vitest";
import { normalizeName } from "@/lib/knowledge/name-match";
import { slovakVariants } from "@/lib/knowledge/stemming/slovak";

const meets = (heard: string, written: string) => {
    const theirs = new Set(slovakVariants(normalizeName(written)));
    return slovakVariants(normalizeName(heard)).some((variant) =>
        theirs.has(variant),
    );
};

const misses = (table: Record<string, string[]>) =>
    Object.entries(table).flatMap(([name, forms]) =>
        forms
            .filter((form) => !meets(form, name))
            .map((form) => `${form} → ${name}`),
    );

/** Names and the forms Slovak gives them, one per declension pattern. */
const DECLENSIONS: Record<string, string[]> = {
    // chlap, with k~c
    Novák: ["Nováka", "Novákovi", "Novákom", "Nováci", "Novákov"],
    Milan: ["Milana", "Milanovi", "Milanom", "Milanovia"],
    // "Peter" drops its e before r ("Petra"), which the rules only undo
    // before k: the light stemmer under-stems it.
    // the epenthetic e/o before k
    Hudáček: ["Hudáčka", "Hudáčkovi", "Hudáčkom"],
    Kežmarok: ["Kežmarku", "Kežmarkom"],
    // hrdina
    Kuba: ["Kubu", "Kubovi", "Kubom", "Kubovia"],
    Sloboda: ["Slobodu", "Slobodovi", "Slobodom"],
    // dub
    Zvolen: ["Zvolena", "Zvolene", "Zvolenom"],
    Prešov: ["Prešova", "Prešove", "Prešovom"],
    // stroj
    Kováč: ["Kováča", "Kováčovi", "Kováčom"],
    počítač: ["počítača", "počítači", "počítačom", "počítače", "počítačov"],
    // žena
    Bratislava: ["Bratislavy", "Bratislave", "Bratislavu", "Bratislavou"],
    Petra: ["Petry", "Petre", "Petru", "Petrou"],
    Žilina: ["Žiliny", "Žiline", "Žilinou"],
    // ulica, with c~k
    Levoča: ["Levoče", "Levoči", "Levoču", "Levočou"],
    Táňa: ["Táne", "Táni", "Táňu", "Táňou"],
    Mária: ["Márie", "Márii", "Máriu", "Máriou"],
    // dlaň
    Sereď: ["Serede", "Seredi", "Seredou"],
    dlaň: ["dlane", "dlani", "dlaňou", "dlaniam", "dlaniach"],
    // kosť
    kosť: ["kosti", "kosťou", "kostiam", "kostiach"],
    radosť: ["radosti", "radosťou"],
    // mesto
    Slovensko: ["Slovenska", "Slovensku", "Slovenskom"],
    Česko: ["Česka", "Česku", "Českom"],
    // srdce
    srdce: ["srdca", "srdcu", "srdcom"],
    more: ["mora", "moru", "morom"],
    // vysvedčenie
    Záhorie: ["Záhoria", "Záhoriu", "Záhorím"],
    Považie: ["Považia", "Považiu", "Považím"],
    // dievča
    // "dievča" -> "dievčaťa": evitaDB's tables leave the "-at-" neuters out
    // on purpose, so no form of the paradigm meets its nominative.
    // adjectives
    Veselý: ["Veselého", "Veselému", "Veselom", "Veselým"],
    Čierny: ["Čierneho", "Čiernemu", "Čiernom", "Čiernym"],
    Veselá: ["Veselej", "Veselú", "Veselou"],
    Nováková: ["Novákovej", "Novákovú", "Novákovou"],
    Horváthová: ["Horváthovej", "Horváthovú", "Horváthovou"],
    // borrowed names, declined as Slovak does
    Kubernetes: ["Kubernetesu", "Kubernetesom"],
    Linux: ["Linuxu", "Linuxom"],
    Slack: ["Slacku", "Slackom"],
    Excel: ["Excelu", "Exceli", "Excelom"],
};

/**
 * evitaDB's Slovak fixture (`SlovakAnalysisFixture`): lemmas and the forms an
 * e-shop stores or is searched by.
 */
const FIXTURE: Record<string, string[]> = {
    čierny: ["čierna", "čierne", "čiernych", "čiernym"],
    biely: ["biela", "biele", "bielych"],
    žltý: ["žltá", "žlté", "žltých"],
    dámsky: ["dámska", "dámske", "dámskych"],
    detský: ["detská", "detské", "detských"],
    anglický: ["anglická", "anglické", "anglických", "anglickí"],
    veľký: ["veľká", "veľké", "veľkých"],
    krásny: ["krásna", "krásne", "krásnych"],
    stôl: ["stola", "stoly", "stolov"],
    stolička: ["stoličky", "stoličiek", "stoličkách"],
    tričko: ["trička", "tričkom"],
    košeľa: ["košele", "košieľ", "košeliach"],
    topánka: ["topánky", "topánok", "topánkach"],
    kabát: ["kabátu", "kabáty", "kabátov"],
    mikina: ["mikine", "mikinách"],
    náramok: ["náramku", "náramky", "náramkov"],
    prívesok: ["prívesku", "prívesky", "príveskov"],
    // "slúchadiel" lengthens inside the stem, which no suffix rule undoes.
    slúchadlá: ["slúchadlám"],
    nábytok: ["nábytku", "nábytkom"],
    skriňa: ["skrine", "skríň", "skriniach"],
    darček: ["darčeka", "darčeky", "darčekov"],
    koža: ["kože", "kožou"],
    hodinky: ["hodiniek", "hodinkách"],
    zákazník: ["zákazníka", "zákazníci"],
    vitamín: ["vitamínu", "vitamíny"],
    chróm: ["chrómu"],
    kategória: ["kategórie", "kategóriám", "kategóriách"],
    bariéra: ["bariéry", "bariér"],
    hypotéka: ["hypotéky", "hypoték"],
};

/** evitaDB's Slovak confusables: unrelated lemmas no rule may merge. */
const CONFUSABLES: [string[], string[]][] = [
    [
        ["ruka", "ruky", "ruke"],
        ["rok", "roku", "roky"],
    ],
    [
        ["buk", "buku", "buky"],
        ["bok", "boku", "boky"],
    ],
    [
        ["cesta", "cesty", "ceste"],
        ["český", "česká", "české", "českých", "českí"],
    ],
    [
        ["forma", "formy", "forme"],
        ["formát", "formátu", "formáty"],
    ],
];

describe("Slovak stem variants", () => {
    it("meet every form of a name with the name", () => {
        expect(misses(DECLENSIONS)).toEqual([]);
    });

    it("meet every form of evitaDB's fixture with its lemma", () => {
        expect(misses(FIXTURE)).toEqual([]);
    });

    it("meet whether either side kept its accents", () => {
        expect(meets("Novakovej", "Nováková")).toBe(true);
        expect(meets("Novákovej", "Novakova")).toBe(true);
        expect(meets("Kezmarku", "Kežmarok")).toBe(true);
        expect(meets("Levoče", "Levoca")).toBe(true);
    });

    it("keep apart names that merely start alike", () => {
        expect(meets("nová", "Novák")).toBe(false);
        expect(meets("Jana", "Janík")).toBe(false);
        expect(meets("Petra", "Petrík")).toBe(false);
        expect(meets("Hora", "Horák")).toBe(false);
        expect(meets("Kováč", "Kováčik")).toBe(false);
        expect(meets("Malá", "Malík")).toBe(false);
    });

    it("keep apart evitaDB's confusables", () => {
        const merged = CONFUSABLES.flatMap(([left, right]) =>
            left.flatMap((a) =>
                right.filter((b) => meets(a, b)).map((b) => `${a} ~ ${b}`),
            ),
        );
        expect(merged).toEqual([]);
    });

    it("fork where the accents decided the rule", () => {
        // "tričkom" strips "om", "chróm" keeps it
        expect(slovakVariants("trickom").sort()).toEqual(["trick", "trickom"]);
        // "stoličiek" shortens and drops the e, "bariér" keeps its ie
        expect(slovakVariants("stoliciek").sort()).toEqual([
            "stolicek",
            "stoliciek",
            "stolicik",
            "stolick",
        ]);
        expect(slovakVariants("bariera").sort()).toEqual([
            "barer",
            "barier",
            "bariera",
        ]);
        // "darček" drops the e, "hypoték" keeps it
        expect(slovakVariants("hypotek").sort()).toEqual(["hypotek", "hypotk"]);
        // "ulici" and "kategóriám" trim the i
        expect(slovakVariants("ulici").sort()).toEqual(["ulici", "ulik"]);
    });

    it("include the word itself, and stay within their bound", () => {
        // evitaDB's boundary words
        for (const word of [
            "",
            "a",
            "om",
            "xxom",
            "xxxom",
            "adenom",
            "agronom",
            "chrom",
            "stoliciek",
            "xxxiek",
            "xxxxek",
            "xxxci",
            "xxxxov",
            "xxxiach",
            "xxovia",
        ]) {
            const variants = slovakVariants(word);
            expect(variants).toContain(word);
            expect(variants.length).toBeLessThanOrEqual(9);
        }
    });
});
