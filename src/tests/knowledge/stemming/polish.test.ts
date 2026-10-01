import { describe, expect, it } from "vitest";
import { normalizeName } from "@/lib/knowledge/name-match";
import { polishVariants } from "@/lib/knowledge/stemming/polish";

const meets = (heard: string, written: string) => {
    const theirs = new Set(polishVariants(normalizeName(written)));
    return polishVariants(normalizeName(heard)).some((variant) =>
        theirs.has(variant),
    );
};

/** Names and the forms Polish gives them, one per declension pattern. */
const DECLENSIONS: Record<string, string[]> = {
    // masculine personal; Snowball has no "-owie" ("Nowakowie" keeps "ow")
    Tomasz: ["Tomasza", "Tomaszowi", "Tomaszem", "Tomaszu"],
    Jan: ["Jana", "Janowi", "Janem", "Janie"],
    Nowak: ["Nowaka", "Nowakowi", "Nowakiem", "Nowaku"],
    // "Piotrze" keeps the rz Snowball does not take back to r
    Piotr: ["Piotra", "Piotrowi", "Piotrem"],
    Michał: ["Michała", "Michałowi", "Michałem", "Michale"],
    // Marek ("Marka") and Paweł ("Pawła") lose an e Snowball never restores
    // masculine non-personal
    Kraków: ["Krakowa", "Krakowowi", "Krakowem", "Krakowie"],
    Gdańsk: ["Gdańska", "Gdańskowi", "Gdańskiem", "Gdańsku"],
    Wrocław: ["Wrocławia", "Wrocławiowi", "Wrocławiem", "Wrocławiu"],
    Poznań: ["Poznania", "Poznaniowi", "Poznaniem", "Poznaniu"],
    // masculine in -a
    Kuba: ["Kuby", "Kubie", "Kubę", "Kubą", "Kubo"],
    Kosma: ["Kosmy", "Kosmie", "Kosmę", "Kosmą"],
    // feminine in -a, hard and soft
    Anna: ["Anny", "Annie", "Annę", "Anną", "Anno"],
    // "Marcie" turns the t into c, which Snowball keeps
    Marta: ["Marty", "Martę", "Martą", "Marto"],
    Warszawa: ["Warszawy", "Warszawie", "Warszawę", "Warszawą"],
    Kasia: ["Kasi", "Kasię", "Kasią", "Kasiu"],
    // "Zofii" and "Zofio" keep the i that "Zofia" loses with "-ia"
    Zofia: ["Zofię", "Zofią"],
    // feminine soft stems
    Łódź: ["Łodzi", "Łodzią"],
    Bydgoszcz: ["Bydgoszczy", "Bydgoszczą"],
    // neuter
    Opole: ["Opola", "Opolu", "Opolem"],
    Gniezno: ["Gniezna", "Gnieznu", "Gnieznem", "Gnieźnie"],
    Zakopane: ["Zakopanego", "Zakopanemu", "Zakopanem"],
    // adjectival surnames
    // "Kowalscy" turns sk into sc, which Snowball keeps
    Kowalski: ["Kowalskiego", "Kowalskiemu", "Kowalskim"],
    Kowalska: ["Kowalskiej", "Kowalską"],
    Wysocki: ["Wysockiego", "Wysockiemu", "Wysockim"],
    Wysocka: ["Wysockiej", "Wysocką"],
    // borrowed names, declined as Polish does
    Excel: ["Excela", "Excelowi", "Excelem", "Excelu"],
    Slack: ["Slacka", "Slackowi", "Slackiem", "Slacku"],
    Kubernetes: ["Kubernetesa", "Kubernetesem", "Kubernetesie"],
    // "Dockerze" keeps the rz, as "Piotrze" does
    Docker: ["Dockera", "Dockerowi", "Dockerem"],
    // evitaDB's own Polish vocabulary
    telefon: ["telefonu", "telefony", "telefonów"],
    komputer: ["komputera", "komputery", "komputerów"],
    prezent: ["prezentu", "prezenty", "prezentów"],
    czarny: ["czarna", "czarne", "czarnych"],
    skórzany: ["skórzana", "skórzane", "skórzanych"],
    kupił: ["kupiła", "kupili", "kupiły"],
    koszula: ["koszule", "koszul", "koszulach"],
    szafa: ["szafy", "szaf", "szafach"],
};

describe("Polish stem variants", () => {
    it("meet every form of a name with the name", () => {
        const missed = Object.entries(DECLENSIONS).flatMap(([name, forms]) =>
            forms
                .filter((form) => !meets(form, name))
                .map((form) => `${form} → ${name}`),
        );
        expect(missed).toEqual([]);
    });

    it("meet whether either side kept its accents", () => {
        expect(meets("Krakowem", "Kraków")).toBe(true);
        expect(meets("Krakowem", "Krakow")).toBe(true);
        expect(meets("Gdańskiem", "Gdansk")).toBe(true);
        expect(meets("Lodzi", "Łódź")).toBe(true);
        expect(meets("Kowalską", "Kowalska")).toBe(true);
        expect(meets("Kowalska", "Kowalską")).toBe(true);
    });

    it("keep apart names that merely start alike", () => {
        expect(meets("Nowa", "Nowak")).toBe(false);
        expect(meets("Jana", "Janusz")).toBe(false);
        expect(meets("Kraków", "Krakowski")).toBe(false);
        expect(meets("Marta", "Martyna")).toBe(false);
        expect(meets("Lista", "Liść")).toBe(false);
    });

    it("give the stems evitaDB's walk gives where the folds are ambiguous", () => {
        const stems = (word: string) => polishVariants(word).sort();
        expect(stems("pasza")).toEqual(["pa", "pas", "pasz", "pasza"]);
        expect(stems("ziemie")).toEqual(["ziem", "ziemi", "ziemie"]);
        expect(stems("okecie")).toEqual(["ok", "oke", "okeci", "okecie"]);
        expect(stems("bladnales")).toEqual(["bladn", "bladnal", "bladnales"]);
        expect(stems("spala")).toEqual(["sp", "spal", "spala"]);
        expect(stems("palac")).toEqual(["pal", "palac"]);
        expect(stems("krakow")).toEqual(["krak", "krakow"]);
        expect(stems("gorajacego")).toEqual(["gor", "gorajac", "gorajacego"]);
        expect(stems("chcialbym")).toEqual(["chc", "chcial", "chcialbym"]);
        expect(stems("oda")).toEqual(["od", "oda"]);
    });

    it("include the word itself, and stay within their bound", () => {
        // evitaDB's boundary words for the Polish walk
        const words = [
            ...["pasza", "kasze", "lepsza", "lepsze", "arabie", "ziemie"],
            ...["okecie", "kopcie", "dziecie", "bladnales", "xxales"],
            ...["xxiales", "metal", "spal", "spala", "spalo", "bralyscie"],
            ...["robilismy", "palac", "kupiec", "splacic", "wlasc", "bojac"],
            ...["grajac", "krakow", "sklepow", "xxow", "najlepszego"],
            ...["najlepszych", "lepszymi", "gorajacego", "bolszego", "to"],
            ...["ta", "te", "oda", "idea", "ie", "cie", "e", "a", ""],
            ...["chcialbym", "robilibyscie", "abysmy"],
        ];
        for (const word of words) {
            const variants = polishVariants(word);
            expect(variants).toContain(word);
            expect(variants.length).toBeLessThanOrEqual(24);
        }
    });
});
