import { describe, expect, it } from "vitest";
import { stemmingLanguage } from "@/lib/knowledge/stemming";
import { detectLanguage } from "@/lib/knowledge/stemming/detect-language";
import { detectMailLanguage } from "@/lib/mail/language";

const samples = [
    [
        "cs",
        "Dobrý den, posílám požadavek na změnu, který jsme pro vás připravili, aby vše bylo v pořádku.",
    ],
    [
        "sk",
        "Dobrý deň, posielam požiadavku na zmenu, ktorú sme pre vás pripravili, aby všetko bolo v poriadku.",
    ],
    [
        "pl",
        "Proszę o sprawdzenie, czy są już wszystkie dokumenty, które były dla nas i dla was przygotowane.",
    ],
    [
        "en",
        "Please review the documents that we have prepared for you and let us know if the schedule is correct.",
    ],
    [
        "de",
        "Bitte prüfen Sie die Unterlagen, die wir für Sie vorbereitet haben, und ob der Zeitplan für uns richtig ist.",
    ],
    [
        "ro",
        "Vă trimitem un document care este pentru voi și pentru noi, dar nu este încă gata să fie publicat.",
    ],
    [
        "ca",
        "Aquest document és per nosaltres i per vosaltres però no és el que hem preparat amb els altres.",
    ],
    [
        "da",
        "Jeg har et dokument til dig og det er ikke det som vi skal sende med vores næste brev til jer og hvad vi gør hvornår.",
    ],
    [
        "es",
        "Este documento es para nosotros y para ustedes pero no es el que hemos preparado con los otros.",
    ],
    [
        "eu",
        "Hau da gure dokumentua eta hori ez da zure dokumentua baina zer behar dute eta nola dago hori.",
    ],
    [
        "fi",
        "Tämä on meidän asiakirja ja nämä ovat teidän mutta se ei ole vielä valmis kun olemme täällä.",
    ],
    [
        "fr",
        "Ce document est pour nous et pour vous mais ce ne sont pas les documents que nous avons dans le dossier.",
    ],
    [
        "ga",
        "Tá an doiciméad seo le fáil agus níl sé sin mar atá sé anois ach ní raibh siad anseo.",
    ],
    [
        "hu",
        "Ez a dokumentum az önök számára van és nem az amit mi kértünk mert azt még meg kell írni.",
    ],
    [
        "it",
        "Questo documento è per noi e per voi ma non è quello che abbiamo preparato con gli altri.",
    ],
    [
        "nl",
        "Dit is het document dat wij voor u hebben en het wordt niet naar de andere mensen gestuurd.",
    ],
    [
        "no",
        "Jeg har et dokument til deg og det er ikke det som vi skal sende med våre neste brev til dere og hva vi gjør når.",
    ],
    [
        "pt",
        "Este documento é para nós e para vocês mas não é o que temos preparado com os outros.",
    ],
    [
        "sv",
        "Detta är vårt dokument och det är inte det som vi ska skicka till våra vänner från kontoret.",
    ],
    [
        "tr",
        "Bu bir belge ve bu belge sizin için ama biz daha çok bilgi ile nasıl devam edeceğiz bilmiyoruz.",
    ],
    [
        "ru",
        "Это письмо содержит информацию о том как мы будем работать над новым проектом вместе.",
    ],
    [
        "ar",
        "هذه رسالة تحتوي على معلومات عن المشروع الجديد الذي نعمل عليه مع الفريق اليوم",
    ],
    [
        "hy",
        "Այս նամակը պարունակում է տեղեկություններ նոր նախագծի մասին որը մենք այսօր քննարկում ենք միասին",
    ],
    [
        "ta",
        "இந்த கடிதம் புதிய திட்டம் பற்றி நாம் இன்று ஒன்றாக விவாதிக்கும் தகவல்களை கொண்டுள்ளது",
    ],
] as const;

function unaccented(text: string): string {
    return text.normalize("NFD").replace(/\p{M}/gu, "").replaceAll("ł", "l");
}

describe("language detection", () => {
    it.each(
        samples,
    )("detects %s and returns a recognized code", (language, text) => {
        expect(detectLanguage(text)).toBe(language);
        expect(stemmingLanguage(detectLanguage(text))).toBe(
            language === "en" ? null : language,
        );
        expect(detectLanguage(text.normalize("NFD"))).toBe(language);
    });

    it.each(
        samples.slice(0, 5),
    )("detects %s without accents", (language, text) => {
        expect(detectLanguage(unaccented(text))).toBe(language);
    });

    it.each([
        [
            "cs",
            "To je to, co jsme pro vás připravili, ale ještě to není hotové.",
        ],
        [
            "sk",
            "To je to, čo sme pre vás pripravili, ale ešte to nie je hotové.",
        ],
        ["cs", "dobry den, posilam pozadavek na upravu"],
        [
            "cs",
            "Dobry den, posilam pozadavek na upravu pro vase oddeleni, ktery jsme uz probirali.",
        ],
        [
            "sk",
            "Dobry den, posielam poziadavku na upravu pre vase oddelenie, ktory sme uz preberali.",
        ],
    ])("distinguishes Czech and Slovak: %s", (language, text) => {
        expect(detectLanguage(text)).toBe(language);
        expect(detectLanguage(unaccented(text))).toBe(language);
    });

    it.each([
        "",
        "Dobrý den, děkuji.",
        "Prosím o doplnění požadavku.",
        "The document is ready.",
        "orchard telescope notebook garden lantern river",
        "a i v na do z",
        "Привет как дела",
        "一 二 三 四 五 六 七 八",
    ])("leaves insufficient evidence undetected: %s", (text) => {
        expect(detectLanguage(text)).toBeNull();
    });

    it("does not choose between equally represented Czech and Slovak", () => {
        expect(detectLanguage(`${samples[0][1]} ${samples[1][1]}`)).toBeNull();
    });

    it("leaves mixed scripts undecided without a dominant script", () => {
        expect(
            detectLanguage(
                "Это письмо содержит информацию о новом проекте The document is ready for us",
            ),
        ).toBeNull();
    });

    it("handles long tokens without treating fragments as evidence", () => {
        expect(detectLanguage("x".repeat(100_000))).toBeNull();
        expect(detectLanguage("word.".repeat(20_000))).toBeNull();
    });

    it("ignores addresses, URLs and numbers as words and evidence", () => {
        const noise =
            "https://example.test/the/and/we/are http://example.test/die/der/und www.example.test/pro/vas the.and.we@sample.invalid 123 456 2026-10-20";
        expect(detectLanguage(noise)).toBeNull();
        expect(detectLanguage(`Dobrý den. ${noise}`)).toBeNull();
        expect(detectLanguage(`${samples[0][1]} ${noise.repeat(10)}`)).toBe(
            "cs",
        );
    });

    it("detects only body and quoted segments, including known quotes", () => {
        const segment = { index: 0, participantRef: null, depth: 0, at: null };
        expect(
            detectMailLanguage([
                { ...segment, role: "body", text: "Krátká odpověď." },
                {
                    ...segment,
                    role: "quoted",
                    knownItemId: "original",
                    text: samples[0][1],
                },
                ...(
                    ["signature", "quoted_signature", "disclaimer"] as const
                ).map((role) => ({
                    ...segment,
                    role,
                    text: samples[4][1].repeat(20),
                })),
            ]),
        ).toBe("cs");
    });
});
