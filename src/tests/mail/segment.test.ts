import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { htmlToText } from "@/lib/mail/html-text";
import {
    MAIL_PARSER_VERSION,
    parseClaimedDate,
    type SegmentInput,
    segmentMail,
} from "@/lib/mail/segment";

import { isContactLine } from "@/lib/mail/signature-patterns";

const FIXTURES = join(__dirname, "fixtures");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

const JAN = { address: "jan@company.example", name: "Jan Novotny" };

function shape(result: ReturnType<typeof segmentMail>) {
    return result.segments.map((segment) => ({
        role: segment.role,
        depth: segment.depth,
        ref: segment.participantRef,
        text: segment.text,
    }));
}

describe("mail segmentation", () => {
    it("splits a Gmail reply: body, signature, quoted part with its author and signature", () => {
        const result = segmentMail({
            text: null,
            html: fixture("gmail-reply.html"),
            from: JAN,
            to: [{ address: "acme-weekly@klepna.example", name: "" }],
            sentAt: new Date("2026-10-09T12:02:00Z"),
            fromAuthenticated: true,
        });
        expect(shape(result)).toEqual([
            {
                role: "body",
                depth: 0,
                ref: "p1",
                text: "Eva's conditions are below, we answer by Friday.",
            },
            {
                role: "signature",
                depth: 0,
                ref: "p1",
                text: "Best regards,\nJan Novotny\nHead of Sales | Acme Industries\n+420 123 456 789",
            },
            {
                role: "quoted",
                depth: 1,
                ref: "p3",
                text: "We can accept the price if delivery is in November.",
            },
            {
                role: "quoted_signature",
                depth: 1,
                ref: "p3",
                text: "Eva Buyer\nHead of Purchasing, Client Ltd.",
            },
        ]);
        expect(result.participants).toEqual([
            {
                ref: "p1",
                roles: ["from"],
                displayName: "Jan Novotny",
                address: "jan@company.example",
                authenticated: true,
            },
            {
                ref: "p2",
                roles: ["to"],
                displayName: null,
                address: "acme-weekly@klepna.example",
                authenticated: false,
            },
            {
                ref: "p3",
                roles: ["quoted_author"],
                displayName: "Eva Buyer",
                address: "eva@client.example",
                authenticated: false,
            },
        ]);
        expect(result.segments[2]?.at?.toISOString().slice(0, 10)).toBe(
            "2026-10-08",
        );
    });

    it("reads a Czech Gmail forward's header block as a forwarded part", () => {
        const result = segmentMail({
            text: null,
            html: fixture("gmail-forward-cs.html"),
            from: JAN,
            sentAt: null,
            fromAuthenticated: true,
        });
        expect(shape(result)).toEqual([
            {
                role: "body",
                depth: 0,
                ref: "p1",
                text: "Přeposílám k vyřízení.",
            },
            {
                role: "quoted",
                depth: 1,
                ref: "p2",
                text: "Dobrý den,\nmůžeme přijmout cenu, pokud dodáte v listopadu.",
            },
            {
                role: "quoted_signature",
                depth: 1,
                ref: "p2",
                text: "S pozdravem\nEva Buyer\nvedoucí nákupu",
            },
        ]);
        expect(result.participants[1]).toMatchObject({
            address: "eva@client.example",
            displayName: "Eva Buyer",
            roles: ["quoted_author"],
        });
        expect(result.segments[1]?.at?.toISOString().slice(0, 16)).toBe(
            "2026-10-08T17:40",
        );
    });

    it("reads an Outlook reply's header block, in Czech, without any markup", () => {
        const result = segmentMail({
            text: fixture("outlook-reply-cs.txt"),
            html: null,
            from: { address: "dvorak@company.example", name: "Karel Dvořák" },
            sentAt: null,
            fromAuthenticated: true,
        });
        expect(shape(result)).toEqual([
            {
                role: "body",
                depth: 0,
                ref: "p1",
                text: "Děkuji, posílám podklady.",
            },
            {
                role: "signature",
                depth: 0,
                ref: "p1",
                text: "S pozdravem\nKarel Dvořák\nObchodní ředitel\nAcme Industries s.r.o.\ntel. +420 777 000 111",
            },
            {
                role: "quoted",
                depth: 1,
                ref: "p2",
                text: "Dobrý den, můžeme přijmout cenu, pokud dodáte v listopadu.\n\nEva Buyer",
            },
        ]);
        expect(result.segments[2]?.at?.toISOString().slice(0, 10)).toBe(
            "2026-10-08",
        );
    });

    it("follows `>` quoting into nested parts", () => {
        const result = segmentMail({
            text: fixture("plain-quoted.txt"),
            html: null,
            from: JAN,
            sentAt: null,
            fromAuthenticated: false,
        });
        expect(shape(result)).toEqual([
            {
                role: "body",
                depth: 0,
                ref: "p1",
                text: "Sounds good, let's do it.",
            },
            {
                role: "quoted",
                depth: 1,
                ref: "p2",
                text: "We can accept the price.",
            },
            {
                role: "quoted",
                depth: 2,
                ref: null,
                text: "Is the price final?\nJan",
            },
        ]);
        expect(result.participants[0]?.authenticated).toBe(false);
    });

    it("splits off a `-- ` signature and a trailing disclaimer", () => {
        const result = segmentMail({
            text: fixture("signature-disclaimer.txt"),
            html: null,
            from: JAN,
            sentAt: null,
            fromAuthenticated: true,
        });
        expect(shape(result).map((s) => [s.role, s.ref])).toEqual([
            ["body", "p1"],
            ["signature", "p1"],
            ["disclaimer", null],
        ]);
        expect(result.segments[1]?.text).toBe("Jan Novotny\nHead of Sales");
    });

    it("reads Apple Mail's attribution in its own blockquote", () => {
        const result = segmentMail({
            text: null,
            html: fixture("apple-reply.html"),
            from: JAN,
            sentAt: null,
            fromAuthenticated: true,
        });
        expect(shape(result)).toEqual([
            { role: "body", depth: 0, ref: "p1", text: "Agreed." },
            {
                role: "quoted",
                depth: 1,
                ref: "p2",
                text: "Shall we meet on Monday?",
            },
        ]);
    });

    it("keeps a mail without quotes or signature as one body", () => {
        const result = segmentMail({
            text: "Just a note.\nSecond line.",
            html: null,
            from: JAN,
            sentAt: null,
            fromAuthenticated: true,
        });
        expect(shape(result)).toEqual([
            {
                role: "body",
                depth: 0,
                ref: "p1",
                text: "Just a note.\nSecond line.",
            },
        ]);
    });

    it("merges one person's roles into one participant", () => {
        const result = segmentMail({
            text: "x",
            html: null,
            from: JAN,
            to: [JAN],
            cc: [{ address: "JAN@company.example", name: "" }],
            sentAt: null,
            fromAuthenticated: true,
        });
        expect(result.participants).toHaveLength(1);
        expect(result.participants[0]?.roles).toEqual(["from", "to", "cc"]);
    });
});

describe("HTML to text", () => {
    it("drops style and script, decodes entities, keeps blocks on lines", () => {
        expect(
            htmlToText(
                "<style>p{color:red}</style><p>A&amp;B&nbsp;&#x2013; &quot;C&quot;</p><script>alert(1)</script><div>D</div>",
            ),
        ).toBe('A&B – "C"\n\nD');
    });
});

describe("claimed dates", () => {
    it("reads the dates reply headers write", () => {
        const day = (text: string) =>
            parseClaimedDate(text)?.toISOString().slice(0, 10) ?? null;
        expect(day("Thu, Oct 8, 2026 at 5:40 PM")).toBe("2026-10-08");
        expect(day("8. 10. 2026 v 17:40")).toBe("2026-10-08");
        expect(day("čtvrtek 8. října 2026 17:40")).toBe("2026-10-08");
        expect(day("whenever")).toBeNull();
    });
});

const PETRA = { address: "petra.novakova@example.cz", name: "Petra Nováková" };

function segmentV2(text: string, input: Partial<SegmentInput> = {}) {
    return segmentMail({
        text,
        html: null,
        from: PETRA,
        sentAt: null,
        fromAuthenticated: true,
        ...input,
    }).segments;
}

describe("mail signature detection version 2", () => {
    it("records parser version 2", () => expect(MAIL_PARSER_VERSION).toBe(2));

    it("detects a Gmail forward with only the forwarder's signature", () => {
        const segments = segmentV2("", {
            html: fixture("signature-gmail-forward.html"),
        });
        expect(segments.map((segment) => segment.role)).toEqual([
            "signature",
            "quoted",
        ]);
        expect(segments[0]).toMatchObject({ signatureCue: "markup", depth: 0 });
        expect(segments[0]?.text).toBe(
            fixture("signature-contact.txt").trim().replace(", Ph.D.", ""),
        );
        expect(segments[1]?.text).toBe("Posílám podklady k projektu.");
    });

    it.each([
        "signature-outlook-web.html",
        "signature-outlook-classic.html",
        "signature-thunderbird.html",
    ])("keeps client markup in %s within its part", (name) => {
        const segments = segmentV2("", { html: fixture(name) });
        expect(segments.map((segment) => segment.role)).toEqual([
            "body",
            "signature",
            "quoted",
        ]);
        expect(segments[1]).toMatchObject({ signatureCue: "markup", depth: 0 });
        expect(segments[2]?.signatureCue).toBeUndefined();
    });

    it.each([
        'class="other gmail_signature other"',
        'data-smartmail="gmail_signature"',
        'id="signature"',
        'class="other moz-signature"',
    ])("recognises %s inside a quote", (attribute) => {
        const segments = segmentV2("", {
            html: `<blockquote><div>Quoted body</div><div ${attribute}>Example signature</div></blockquote>`,
        });
        expect(segments.map((segment) => segment.role)).toEqual([
            "quoted",
            "quoted_signature",
        ]);
        expect(segments[1]).toMatchObject({ signatureCue: "markup", depth: 1 });
    });

    it("reads Apple Mail's signature container as text, its footer by the footer rule", () => {
        expect(
            segmentV2("", { html: fixture("signature-apple.html") }).map(
                (segment) => [segment.role, segment.signatureCue],
            ),
        ).toEqual([
            ["body", undefined],
            ["signature", "footer"],
            ["quoted", undefined],
        ]);
        expect(
            segmentV2("", {
                html: '<div id="AppleMailSignature">Díky, potvrzuji.<br><br>Sent from my iPhone</div>',
            }).map((segment) => [segment.role, segment.text]),
        ).toEqual([
            ["body", "Díky, potvrzuji."],
            ["signature", "Sent from my iPhone"],
        ]);
    });

    it("keeps unmarked text in reading order and markup wins over text cues", () => {
        const segments = segmentV2("", {
            html: '<div>Body<br>-- <br>Keep here</div><div class="gmail_signature">Signature</div><div>After signature</div>',
        });
        expect(segments.map((segment) => [segment.role, segment.text])).toEqual(
            [
                ["body", "Body\n--\nKeep here"],
                ["signature", "Signature"],
                ["body", "After signature"],
            ],
        );
        expect(segments[1]?.signatureCue).toBe("markup");
    });

    it("ends an open-only Outlook marker at a quote-level boundary", () => {
        const segments = segmentV2("", {
            html: '<blockquote><a name="_MailAutoSig"></a>Quoted signature</blockquote><div>Own body</div>',
        });
        expect(segments.map((segment) => [segment.role, segment.text])).toEqual(
            [
                ["quoted_signature", "Quoted signature"],
                ["body", "Own body"],
            ],
        );
    });

    it.each([
        ["Ing. Petra Nováková, Ph.D. | Vedoucí projektu", PETRA],
        ["Mgr. NOVÁKOVÁ Petra", PETRA],
        ["Petra Nováková", { ...PETRA, name: "" }],
        ["Petra Nováková", { address: "petra_novakova@example.cz", name: "" }],
        ["Petra Nováková", { address: "petra-novakova@example.cz", name: "" }],
    ])("detects a name and contact block: %s", (name, from) => {
        const text = fixture("signature-contact.txt").replace(
            /^.*\n/,
            `${name}\n`,
        );
        const segments = segmentV2(`Podklady přikládám.\n\n${text}`, { from });
        expect(segments.map((segment) => segment.role)).toEqual([
            "body",
            "signature",
        ]);
        expect(segments[1]).toMatchObject({
            signatureCue: "contact",
            text: text.trim(),
        });
    });

    it("uses the quoted author rather than From for contact detection", () => {
        const segments = segmentV2(
            "Body\nOn 19 Oct 2026, Eva Vzorová <eva@example.cz> wrote:\n> Quoted body\n> Eva Vzorová\n> eva@example.cz\n> +420 600 000 000",
        );
        expect(segments.at(-1)).toMatchObject({
            role: "quoted_signature",
            signatureCue: "contact",
        });
    });

    it("matches normalised known signatures and their first two lines", () => {
        const knownSignatures = [
            "Petra Nováková | Vedoucí projektu\nExample, a.s.\nStarý řádek",
        ];
        const segments = segmentV2(
            "Body\nPETRA Novakova · Vedoucí   projektu\nExample, a.s.\nNový řádek",
            { knownSignatures },
        );
        expect(segments[1]).toMatchObject({
            role: "signature",
            signatureCue: "known",
        });
        expect(
            segmentV2("Body\nOddělení", { knownSignatures: ["Oddělení"] })[1]
                ?.signatureCue,
        ).toBe("known");
    });

    it("does not let a known signature's first lines swallow a P.S.", () => {
        const knownSignatures = [
            "Petra Nováková | Vedoucí projektu\nExample, a.s.\nVzorová 12/34",
        ];
        const text =
            "Body\nPetra Nováková | Vedoucí projektu\nExample, a.s.\nP.S. Nezapomeňte prosím poslat podepsanou smlouvu do pátku, jinak termín nestihneme.";
        expect(
            segmentV2(text, { knownSignatures }).map((segment) => segment.role),
        ).toEqual(["body"]);
    });

    it("does not match a known near-miss, a single prefix, or a quoted part", () => {
        const knownSignatures = ["Oddělení\nExample, a.s.\nVzorová"];
        for (const text of [
            "Body\nOddělení\nJiná společnost",
            "Body\nOddělení",
            "> Oddělení\n> Example, a.s.\n> Vzorová",
        ]) {
            expect(
                segmentV2(text, { knownSignatures }).every(
                    (segment) => segment.signatureCue === undefined,
                ),
            ).toBe(true);
        }
    });

    it.each([
        "Sent from my iPhone",
        "Odesláno z iPhonu",
        "Odesláno z mobilu",
        "Get Outlook for Android",
        "Získat aplikaci Outlook pro iOS",
    ])("detects footer %s", (footer) => {
        expect(segmentV2(`Body\n${footer}`)[1]).toMatchObject({
            role: "signature",
            signatureCue: "footer",
            text: footer,
        });
    });

    it("records delimiter and closing cues before weaker signals", () => {
        expect(
            segmentV2("Body\n-- \nPetra\nSent from my iPhone")[1]?.signatureCue,
        ).toBe("delimiter");
        expect(
            segmentV2("Body\nBest regards,\nPetra\nSent from my iPhone")[1]
                ?.signatureCue,
        ).toBe("closing");
        expect(segmentV2("> -- \n> Petra")[0]?.signatureCue).toBe("delimiter");
    });

    it.each([
        "Kontakt na technika: Petra Nováková, +420 600 000 000, petra@example.cz",
        "Petra Nováková to schválila.\npetra@example.cz\n+420 600 000 000",
        "Zásilku prosím doručte sem:\nExample, a.s.\nVzorová 12/34\nPraha 1, 110 00",
        "Petra Nováková\nCena: 125 000 Kč\nSplatnost: 14. 11. 2026",
        "Petra Nováková\nCena: 12500 Kč\nCelkem 15000 EUR",
        "Petra Nováková\npetra@example.cz\n+420 600 000 000\nToto je věta která má více než osm slov.",
    ])("keeps substantive contact or price information: %s", (text) => {
        expect(segmentV2(text)).toEqual([
            expect.objectContaining({ role: "body", text }),
        ]);
    });

    it("starts a contact signature at the last name line, keeping earlier lines naming the author", () => {
        const signature = "Petra Nováková\npetra@example.cz\n+420 600 000 000";
        const segments = segmentV2(
            `Petra Nováková posílá podklady\nTermín je zítra\n${signature}`,
        );
        expect(segments.map((segment) => [segment.role, segment.text])).toEqual(
            [
                ["body", "Petra Nováková posílá podklady\nTermín je zítra"],
                ["signature", signature],
            ],
        );
    });

    it("enforces block, line, name and footer limits", () => {
        const contacts = "\npetra@example.cz\n+420 600 000 000";
        for (const text of [
            `Petra Nováková${contacts}${"\nDepartment".repeat(8)}`,
            `Petra Nováková${contacts}\n${"x".repeat(101)}`,
            `Petra Nováková ${"x".repeat(70)}${contacts}`,
            `Body\nSent from ${"x".repeat(60)}`,
            "Sent from my iPhone\nBody",
        ])
            expect(segmentV2(text).map((segment) => segment.role)).toEqual([
                "body",
            ]);
        expect(
            segmentV2(`Petra Nováková${contacts}`, {
                from: { address: "pn@example.cz", name: "" },
            })[0]?.role,
        ).toBe("body");
    });
});

describe("signature contact patterns", () => {
    it.each([
        "petra@example.cz",
        "www.example.cz",
        "https://example.cz",
        "+420 600 000 000",
        "00420 600 000 000",
        "600 000 000",
        "Example, s.r.o.",
        "Example, a.s.",
        "Example, spol. s r.o.",
        "Example, v.o.s.",
        "Example, k.s.",
        "Example GmbH",
        "Example Ltd",
        "Example Inc",
        "Example LLC",
        "IČ: 00000000",
        "IČO: 00000000",
        "DIČ: CZ00000000",
        "VAT: 00000000",
        "Vzorová 12/34",
        "Vzorová 635/57a",
        "110 00 Praha",
        "Praha 1, 110 00",
    ])("accepts %s", (line) => expect(isContactLine(line)).toBe(true));
    it.each([
        "125 000 Kč",
        "Cena: 12500 Kč",
        "Celkem 15000 EUR",
        "Price 12500 USD excl. VAT",
        "VAT included",
        "Cena: 125000000 CZK",
        "EUR 600 000 000",
        "$600000000",
        "600000000 USD",
        "600000000 €",
        "14. 11. 2026",
        "14/11/2026",
        "2026-11-14",
        "12/34",
        "11000",
        "Praha 11000",
        "Objednávka 12345",
        "Č.j. 123/2026",
        "Department",
        "600 000",
    ])("rejects %s", (line) => expect(isContactLine(line)).toBe(false));
});

describe("signature boundary guards", () => {
    it("keeps a footer after a marked signature in the signature", () => {
        expect(
            segmentV2("", {
                html: '<div>Body</div><div id="Signature">Example signature</div><div>Sent from my iPhone</div>',
            }).map((segment) => [
                segment.role,
                segment.text,
                segment.signatureCue,
            ]),
        ).toEqual([
            ["body", "Body", undefined],
            ["signature", "Example signature\nSent from my iPhone", "markup"],
        ]);
    });
    it("counts internal blank lines toward the contact block limit", () => {
        expect(
            segmentV2(
                `Petra Nováková${"\n\nDepartment".repeat(4)}\npetra@example.cz\n+420 600 000 000`,
            ).map((segment) => segment.role),
        ).toEqual(["body"]);
    });
    it("matches academic titles without removing word prefixes", () => {
        expect(
            segmentV2(
                "Prof. Petra Nováková, Ph.D.\npetra@example.cz\n+420 600 000 000",
            )[0]?.signatureCue,
        ).toBe("contact");
        expect(
            segmentV2(
                "Professor Petra Nováková\npetra@example.cz\n+420 600 000 000",
            )[0]?.role,
        ).toBe("body");
    });
});

describe("contact legal form boundaries", () => {
    it.each([
        "as discussed",
        "incidental detail",
        "ltdsuffix",
        "VATrate",
        "Iceland",
    ])("keeps words that are not legal forms or tax labels: %s", (line) =>
        expect(isContactLine(line)).toBe(false));
});
