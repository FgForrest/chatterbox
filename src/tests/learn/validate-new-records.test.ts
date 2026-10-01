import { describe, expect, it } from "vitest";
import type { LearnNewRecord, LearnOutput } from "@/lib/learn/output";
import { type LearnRunFrame, validateLearnOutput } from "@/lib/learn/validate";
import {
    MAX_NEW_RECORDS,
    newRecordFingerprint,
} from "@/lib/learn/validate-new-records";
import type { TranscriptTurn } from "@/lib/transcription/turns";

const TURNS: TranscriptTurn[] = [
    {
        speaker: "speaker_0",
        startMs: 0,
        endMs: 10_000,
        text: "Dobrý den, tady Petra Kolářová z firmy Veltrix.",
    },
    {
        speaker: "speaker_1",
        startMs: 10_000,
        endMs: 20_000,
        text: "Ahoj, já jsem Tomáš. Pracujeme na projektu Lumenka a řešíme náš backlog.",
    },
    {
        speaker: "speaker_0",
        startMs: 20_000,
        endMs: 30_000,
        text: "Lumenku stihneme, Holoubek to potvrdil a náš backlog je krátký.",
    },
    {
        speaker: "speaker_1",
        startMs: 30_000,
        endMs: 40_000,
        text: "Velrix chce vidět sprint. Obchod řeší Marek Holub.",
    },
];

function frame(overrides: Partial<LearnRunFrame> = {}): LearnRunFrame {
    return {
        revision: 1,
        currentRevision: 1,
        transcriptKey: "t1@1",
        turns: TURNS,
        language: "cs",
        provider: "openai",
        people: new Map([
            ["p-marek", { name: "Marek Holub", aliases: ["Holoubek"] }],
        ]),
        entities: new Map([
            ["e-orbita", { typeKey: "project", name: "Orbita" }],
        ]),
        entityTypes: new Set(["organization", "project", "product", "term"]),
        relations: new Map([
            [
                "works_for",
                {
                    subjectTypes: ["person"],
                    objectTypes: ["organization"],
                    objectKind: "entity",
                },
            ],
            [
                "works_on",
                {
                    subjectTypes: ["person", "organization"],
                    objectTypes: ["project", "product"],
                    objectKind: "entity",
                },
            ],
        ]),
        answeredLabels: new Map(),
        confirmedHeardAs: new Set(),
        knownFacts: new Map(),
        dismissed: new Set(),
        ...overrides,
    };
}

function output(overrides: Partial<LearnOutput> = {}): LearnOutput {
    return {
        newRecords: [],
        speakers: [],
        corrections: [],
        facts: [],
        relationPhrases: [],
        ...overrides,
    };
}

function record(
    ref: string,
    name: string,
    evidence: string,
    extra: Partial<LearnNewRecord> = {},
): LearnNewRecord {
    return {
        ref,
        kind: "entity",
        typeKey: "organization",
        name,
        speakerLabel: null,
        evidence: [evidence],
        reason: "named in the meeting",
        ...extra,
    };
}

const worksFor = (
    subject: LearnOutput["facts"][number]["subject"],
    object: LearnOutput["facts"][number]["object"],
): LearnOutput["facts"][number] => ({
    subject,
    relationKey: "works_for",
    object,
    start: "0:00",
    end: "0:00",
    speakerLabel: null,
    sensitivity: "none",
});

const kinds = (result: ReturnType<typeof validateLearnOutput>) =>
    result.items.map((item) => item.kind);

describe("Learn's new records", () => {
    it("proposes a thing named in its evidence, unticked, and what refers to it by its ref", () => {
        const result = validateLearnOutput(
            output({
                newRecords: [record("n1", "Veltrix", "0:00")],
                facts: [worksFor({ personId: "p-marek" }, { newRef: "n1" })],
            }),
            frame(),
        );
        expect(kinds(result)).toEqual(["new_record", "fact"]);
        const [added, fact] = result.items;
        expect(added).toMatchObject({
            preTicked: false,
            fingerprint: newRecordFingerprint(
                "entity",
                "organization",
                "Veltrix",
            ),
            payload: {
                ref: "n1",
                kind: "entity",
                typeKey: "organization",
                name: "Veltrix",
                evidenceMs: [0],
            },
        });
        expect(fact?.payload).toMatchObject({ object: { newRef: "n1" } });
    });

    it("takes a name the Almanac has for that record, a nickname included", () => {
        const result = validateLearnOutput(
            output({
                newRecords: [
                    record("n1", "Orbita", "0:10", { typeKey: "product" }),
                    record("n2", "Holoubek", "0:20", {
                        kind: "person",
                        typeKey: null,
                    }),
                ],
                facts: [
                    {
                        ...worksFor({ newRef: "n2" }, { newRef: "n1" }),
                        relationKey: "works_on",
                    },
                ],
            }),
            frame(),
        );
        expect(kinds(result)).toEqual(["fact"]);
        expect(result.items[0]?.payload).toMatchObject({
            subject: { personId: "p-marek" },
            object: { entityId: "e-orbita" },
        });
    });

    it("names nobody where two people have that name, and drops what refers to it", () => {
        const result = validateLearnOutput(
            output({
                newRecords: [
                    record("n1", "Marek Holub", "0:30", {
                        kind: "person",
                        typeKey: null,
                    }),
                ],
                facts: [worksFor({ newRef: "n1" }, { entityId: "e-orbita" })],
            }),
            frame({
                people: new Map([
                    ["p-marek", { name: "Marek Holub" }],
                    ["p-marek-2", { name: "Marek Holub" }],
                ]),
            }),
        );
        expect(result.items).toEqual([]);
        expect(result.dropped).toMatchObject({
            ambiguousName: 1,
            unknownRef: 1,
        });
    });

    it("drops a thing of a type a new thing may not take, and a ref nobody declared", () => {
        const result = validateLearnOutput(
            output({
                newRecords: [
                    record("n1", "Veltrix", "0:00", { typeKey: "planet" }),
                ],
                facts: [
                    worksFor({ personId: "p-marek" }, { newRef: "n1" }),
                    worksFor({ personId: "p-marek" }, { newRef: "n9" }),
                ],
            }),
            frame(),
        );
        expect(result.items).toEqual([]);
        expect(result.dropped).toMatchObject({ badType: 1, unknownRef: 2 });
    });

    it("needs the name said where its evidence is, or written there by a correction for it", () => {
        const heardAt = TURNS[3]?.text.indexOf("Velrix") ?? -1;
        const dropped = validateLearnOutput(
            output({ newRecords: [record("n1", "Veltrix", "0:30")] }),
            frame(),
        );
        expect(dropped.items).toEqual([]);
        expect(dropped.dropped).toMatchObject({ notInEvidence: 1 });

        const misheard = validateLearnOutput(
            output({
                newRecords: [record("n1", "Veltrix", "0:30")],
                corrections: [
                    {
                        turnIndex: 3,
                        charStart: heardAt,
                        charEnd: heardAt + "Velrix".length,
                        heard: "Velrix",
                        kind: "correct",
                        target: { newRef: "n1" },
                        replacement: "Veltrix",
                    },
                ],
            }),
            frame(),
        );
        expect(kinds(misheard)).toEqual(["new_record", "correction"]);
        expect(misheard.items[1]).toMatchObject({
            preTicked: false,
            payload: { target: { newRef: "n1" }, replacement: "Veltrix" },
        });
    });

    it("finds a misheard name through a correction that writes it inflected", () => {
        const turns: TranscriptTurn[] = [
            {
                speaker: "speaker_0",
                startMs: 0,
                endMs: 10_000,
                text: "Mluvil jsem s Weltriksem o smlouvě.",
            },
        ];
        const heardAt = turns[0]?.text.indexOf("Weltriksem") ?? -1;
        const result = validateLearnOutput(
            output({
                newRecords: [record("n1", "Veltrix", "0:00")],
                corrections: [
                    {
                        turnIndex: 0,
                        charStart: heardAt,
                        charEnd: heardAt + "Weltriksem".length,
                        heard: "Weltriksem",
                        kind: "correct",
                        target: { newRef: "n1" },
                        replacement: "Veltrixem",
                    },
                ],
            }),
            frame({ turns }),
        );
        expect(kinds(result)).toEqual(["new_record", "correction"]);
    });

    it("keeps a name on a denied topic out", () => {
        const turns: TranscriptTurn[] = [
            {
                speaker: "speaker_0",
                startMs: 0,
                endMs: 10_000,
                text: "Jana chodí na Therapy Hub každý týden.",
            },
        ];
        const result = validateLearnOutput(
            output({
                newRecords: [
                    record("n1", "Therapy Hub", "0:00", {
                        typeKey: "organization",
                    }),
                ],
            }),
            frame({ turns }),
        );
        expect(result.items).toEqual([]);
        expect(result.dropped).toMatchObject({ sensitive: 1 });
    });

    it("asks whether a name close to a known one is that one, misheard", () => {
        const result = validateLearnOutput(
            output({
                newRecords: [
                    record("n1", "Orbitta", "0:00", { typeKey: "project" }),
                    record("n2", "Veltrix", "0:00"),
                ],
            }),
            frame({
                turns: [
                    {
                        speaker: "speaker_0",
                        startMs: 0,
                        endMs: 10_000,
                        text: "Orbitta a Veltrix jedou.",
                    },
                ],
            }),
        );
        expect(result.items.map((item) => item.payload)).toMatchObject([
            { name: "Orbitta", maybe: { entityId: "e-orbita" } },
            { name: "Veltrix" },
        ]);
        expect(result.items[1]?.payload).not.toHaveProperty("maybe");
    });

    it("hints a known record behind a first name, or a letter off, and not behind a longer name or another person's forms", () => {
        const result = validateLearnOutput(
            output({
                newRecords: [
                    record("n1", "Marek", "0:00", {
                        kind: "person",
                        typeKey: null,
                    }),
                    record("n2", "Orbita server", "0:00", {
                        typeKey: "product",
                    }),
                    record("n3", "Velltrix", "0:00"),
                    record("n4", "Marie Holubová", "0:00", {
                        kind: "person",
                        typeKey: null,
                    }),
                ],
            }),
            frame({
                turns: [
                    {
                        speaker: "speaker_0",
                        startMs: 0,
                        endMs: 10_000,
                        text: "Marek pustil Orbita server pro Velltrix, ptala se Marie Holubová.",
                    },
                ],
                entities: new Map([
                    ["e-orbita", { typeKey: "project", name: "Orbita" }],
                    ["e-veltrix", { typeKey: "organization", name: "Veltrix" }],
                ]),
            }),
        );
        expect(
            result.items.map((item) => {
                const payload = item.payload as {
                    name: string;
                    maybe?: unknown;
                };
                return [payload.name, payload.maybe];
            }),
        ).toEqual([
            ["Marek", { personId: "p-marek" }],
            // "Orbita" names a project: the server is something else.
            ["Orbita server", undefined],
            ["Velltrix", { entityId: "e-veltrix" }],
            // Holubová is not Marek Holub, whatever her stem.
            ["Marie Holubová", undefined],
        ]);
    });

    it("hints the known thing of the same type, and none where two fit", () => {
        const said = frame({
            turns: [
                {
                    speaker: "speaker_0",
                    startMs: 0,
                    endMs: 10_000,
                    text: "Apolo a Kometta jedou.",
                },
            ],
            entities: new Map([
                ["e-apollo-org", { typeKey: "organization", name: "Apollo" }],
                ["e-apollo-prj", { typeKey: "project", name: "Apollo" }],
                ["e-kometa", { typeKey: "project", name: "Kometa" }],
                ["e-komet", { typeKey: "project", name: "Kometta s.r.o." }],
            ]),
        });
        const result = validateLearnOutput(
            output({
                newRecords: [
                    record("n1", "Apolo", "0:00", { typeKey: "project" }),
                    record("n2", "Kometta", "0:00", { typeKey: "project" }),
                ],
            }),
            said,
        );
        expect(result.items[0]?.payload).toMatchObject({
            maybe: { entityId: "e-apollo-prj" },
        });
        expect(result.items[1]?.payload).not.toHaveProperty("maybe");
    });

    it("finds a name inflected as Czech says it", () => {
        const result = validateLearnOutput(
            output({
                newRecords: [
                    record("n1", "Lumenka", "0:20", { typeKey: "project" }),
                ],
            }),
            frame(),
        );
        expect(kinds(result)).toEqual(["new_record"]);
    });

    it("keeps a common word out: a person needs a capital, a term two turns", () => {
        const result = validateLearnOutput(
            output({
                newRecords: [
                    record("n1", "backlog", "0:10", { typeKey: "term" }),
                    record("n2", "sprint", "0:30", { typeKey: "term" }),
                    record("n3", "tomáš", "0:10", {
                        kind: "person",
                        typeKey: null,
                    }),
                ],
            }),
            frame(),
        );
        expect(
            result.items.map((item) => (item.payload as { name: string }).name),
        ).toEqual(["backlog"]);
        expect(result.dropped).toMatchObject({ generic: 2 });
    });

    it("joins refs that name one record, and points what refers to either at it", () => {
        const result = validateLearnOutput(
            output({
                newRecords: [
                    record("w1n1", "Veltrix", "0:00"),
                    record("w2n1", "veltrix", "0:30", {
                        evidence: ["0:30"],
                    }),
                ],
                corrections: [],
                facts: [worksFor({ personId: "p-marek" }, { newRef: "w2n1" })],
            }),
            frame({
                turns: [
                    ...TURNS.slice(0, 3),
                    {
                        speaker: "speaker_1",
                        startMs: 30_000,
                        endMs: 40_000,
                        text: "Veltrix chce vidět sprint.",
                    },
                ],
            }),
        );
        expect(kinds(result)).toEqual(["new_record", "fact"]);
        expect(result.items[0]?.payload).toMatchObject({
            ref: "w1n1",
            evidenceMs: [0, 30_000],
        });
        expect(result.items[1]?.payload).toMatchObject({
            object: { newRef: "w1n1" },
        });
    });

    it("takes a ref the answer defines twice, differently, for nothing", () => {
        const result = validateLearnOutput(
            output({
                newRecords: [
                    record("n1", "Veltrix", "0:00"),
                    record("n1", "Lumenka", "0:10", { typeKey: "project" }),
                    record("n2", "Lumenka", "0:10", { typeKey: "project" }),
                    record("n2", "Lumenka", "0:20", { typeKey: "project" }),
                ],
                facts: [worksFor({ personId: "p-marek" }, { newRef: "n1" })],
            }),
            frame(),
        );
        expect(
            result.items.map((item) => (item.payload as { name: string }).name),
        ).toEqual(["Lumenka"]);
        expect(result.dropped).toMatchObject({ conflicting: 1, unknownRef: 1 });
    });

    it("does not propose again a record rejected on any recording, nor what refers to it", () => {
        const result = validateLearnOutput(
            output({
                newRecords: [record("n1", "Veltrix", "0:00")],
                facts: [worksFor({ personId: "p-marek" }, { newRef: "n1" })],
            }),
            frame({
                dismissed: new Set([
                    newRecordFingerprint("entity", "organization", " veltrix "),
                ]),
            }),
        );
        expect(result.items).toEqual([]);
        expect(result.dropped).toMatchObject({ dismissed: 1, unknownRef: 1 });
    });

    it(`keeps at most ${MAX_NEW_RECORDS}`, () => {
        const text = Array.from(
            { length: MAX_NEW_RECORDS + 2 },
            (_, index) => `Firma${String.fromCharCode(65 + index)}`,
        );
        const result = validateLearnOutput(
            output({
                newRecords: text.map((name, index) =>
                    record(`n${index}`, name, "0:00"),
                ),
            }),
            frame({
                turns: [
                    {
                        speaker: "speaker_0",
                        startMs: 0,
                        endMs: 10_000,
                        text: text.join(", "),
                    },
                ],
            }),
        );
        expect(result.items).toHaveLength(MAX_NEW_RECORDS);
        expect(result.dropped).toMatchObject({ budget: 2 });
    });

    it("marks a person named by one word, for the reviewer", () => {
        const result = validateLearnOutput(
            output({
                newRecords: [
                    record("n1", "Tomáš", "0:10", {
                        kind: "person",
                        typeKey: null,
                    }),
                    record("n2", "Petra Kolářová", "0:00", {
                        kind: "person",
                        typeKey: null,
                    }),
                ],
            }),
            frame(),
        );
        expect(result.items.map((item) => item.payload)).toMatchObject([
            { name: "Tomáš", onlyFirstName: true },
            { name: "Petra Kolářová" },
        ]);
        expect(result.items[1]?.payload).not.toHaveProperty("onlyFirstName");
    });

    it("proposes a new person as the speaker they introduce themselves as", () => {
        const result = validateLearnOutput(
            output({
                newRecords: [
                    record("n1", "Petra Kolářová", "0:00", {
                        kind: "person",
                        typeKey: null,
                        speakerLabel: "speaker_0",
                    }),
                ],
                speakers: [
                    {
                        label: "speaker_0",
                        personId: null,
                        evidence: ["0:00"],
                        reason: "introduces herself",
                    },
                ],
            }),
            frame(),
        );
        expect(kinds(result)).toEqual(["new_record", "speaker"]);
        expect(result.items[1]?.payload).toMatchObject({
            label: "speaker_0",
            personId: null,
            newRef: "n1",
        });
    });

    it("links a speaker only where they speak or answer, and judges the first name there", () => {
        const turns: TranscriptTurn[] = [
            {
                speaker: "speaker_0",
                startMs: 0,
                endMs: 10_000,
                text: "Vilda se hlásí, tuším, co chce říct.",
            },
            {
                speaker: "speaker_1",
                startMs: 10_000,
                endMs: 20_000,
                text: "No, já chci říct spíš to, že to byl jen začátek.",
            },
            {
                speaker: "speaker_0",
                startMs: 20_000,
                endMs: 30_000,
                text: "Dobře.",
            },
            {
                speaker: "speaker_1",
                startMs: 30_000,
                endMs: 40_000,
                text: "Jo.",
            },
            {
                speaker: "speaker_0",
                startMs: 40_000,
                endMs: 50_000,
                text: "Hm.",
            },
            {
                speaker: "speaker_0",
                startMs: 50_000,
                endMs: 60_000,
                text: "To padlo mezi Vildou Brázdou a Tomášem.",
            },
        ];
        const vilda = (evidence: string[]) =>
            record("n1", "Vilda Brázda", "0:00", {
                kind: "person",
                typeKey: null,
                speakerLabel: "speaker_1",
                evidence,
            });
        // Addressed as Vilda, answers; the surname only far off.
        const addressed = validateLearnOutput(
            output({ newRecords: [vilda(["0:00", "0:50"])] }),
            frame({ turns }),
        );
        expect(addressed.items[1]?.payload).toMatchObject({
            label: "speaker_1",
            newRef: "n1",
            evidenceMs: [0],
            onlyFirstName: true,
        });
        // Only mentioned: no speaker at all.
        const mentioned = validateLearnOutput(
            output({ newRecords: [vilda(["0:50"])] }),
            frame({ turns }),
        );
        expect(kinds(mentioned)).toEqual(["new_record"]);
        expect(mentioned.items[0]?.payload).not.toHaveProperty("speakerLabel");
    });

    it("does not link a speaker through a turn that does not say the name", () => {
        const turns: TranscriptTurn[] = [
            {
                speaker: "speaker_0",
                startMs: 0,
                endMs: 10_000,
                text: "Volala Alena Brabcová, že to posune.",
            },
            {
                speaker: "speaker_2",
                startMs: 10_000,
                endMs: 20_000,
                text: "A co říkala dál?",
            },
            {
                speaker: "speaker_0",
                startMs: 20_000,
                endMs: 30_000,
                text: "Nic moc.",
            },
            {
                speaker: "speaker_1",
                startMs: 30_000,
                endMs: 40_000,
                text: "Jo, chápu.",
            },
        ];
        const result = validateLearnOutput(
            output({
                newRecords: [
                    record("n1", "Alena Brabcová", "0:00", {
                        kind: "person",
                        typeKey: null,
                        speakerLabel: "speaker_1",
                        evidence: ["0:00", "0:20"],
                    }),
                ],
            }),
            frame({ turns }),
        );
        expect(kinds(result)).toEqual(["new_record"]);
        expect(result.items[0]?.payload).not.toHaveProperty("speakerLabel");
    });

    it("names no speaker a person answered, nor one the answer names otherwise", () => {
        const newPerson = record("n1", "Petra Kolářová", "0:00", {
            kind: "person",
            typeKey: null,
            speakerLabel: "speaker_0",
        });
        const answered = validateLearnOutput(
            output({ newRecords: [newPerson] }),
            frame({ answeredLabels: new Map([["speaker_0", "p-marek"]]) }),
        );
        expect(kinds(answered)).toEqual(["new_record"]);

        const disagreeing = validateLearnOutput(
            output({
                newRecords: [newPerson],
                speakers: [
                    {
                        label: "speaker_0",
                        personId: "p-marek",
                        evidence: ["0:00"],
                        reason: "guess",
                    },
                ],
            }),
            frame(),
        );
        expect(kinds(disagreeing)).toEqual(["new_record"]);
        expect(disagreeing.dropped).toMatchObject({ conflicting: 2 });
    });

    it("names a known person as a speaker when the answer thought them new", () => {
        const result = validateLearnOutput(
            output({
                newRecords: [
                    record("n1", "Marek Holub", "0:30", {
                        kind: "person",
                        typeKey: null,
                        speakerLabel: "speaker_1",
                    }),
                ],
            }),
            frame(),
        );
        expect(kinds(result)).toEqual(["speaker"]);
        expect(result.items[0]?.payload).toMatchObject({
            label: "speaker_1",
            personId: "p-marek",
        });
    });
});
