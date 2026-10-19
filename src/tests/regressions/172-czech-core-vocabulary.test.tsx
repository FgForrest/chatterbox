// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    within,
} from "@testing-library/react";
import type * as NextIntl from "next-intl";
import type { PropsWithChildren } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator, type TranslationValues } from "use-intl/core";
import { IntlProvider, useTranslations } from "use-intl/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearnReview } from "@/components/learn/learn-review";
import { KnownFacts } from "@/components/people/known-facts";
import { messagesForLocale } from "@/lib/i18n/messages";
import { almanacVocabulary } from "@/lib/knowledge/almanac-vocabulary";
import {
    CORE_ENTITY_TYPES,
    CORE_RELATIONS,
} from "@/lib/knowledge/vocabulary-core";
import { useVocabularyLabels } from "@/lib/knowledge/vocabulary-labels";
import { getVocabularyLabels } from "@/lib/knowledge/vocabulary-labels-server";

vi.mock("next-intl", async (importOriginal) => {
    const original = await importOriginal<typeof NextIntl>();
    return {
        ...original,
        useExtracted: () => {
            const translate = useTranslations();
            const ids = new Map(
                Object.entries(messagesForLocale("en")).map(([id, source]) => [
                    source,
                    id,
                ]),
            );
            return (
                message: string | { id: string; message: string },
                values?: TranslationValues,
            ) =>
                translate(
                    typeof message === "string"
                        ? (ids.get(message) ?? message)
                        : message.id,
                    values,
                );
        },
    };
});

vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("next-intl/server", () => ({
    getTranslations: async () =>
        createTranslator({
            locale: "cs-CZ",
            messages: messagesForLocale("cs-CZ"),
        }),
}));

function Czech({ children }: PropsWithChildren) {
    return (
        <IntlProvider locale="cs-CZ" messages={messagesForLocale("cs-CZ")}>
            {children}
        </IntlProvider>
    );
}

const newRecord = {
    id: "new",
    kind: "new_record",
    preTicked: false,
    decision: null,
    choice: null,
    version: 0,
    dependsOnLabel: null,
    payload: {
        ref: "n1",
        kind: "entity",
        typeKey: "term",
        name: "Alfa",
        evidenceMs: [],
        reason: "",
    },
};
const fact = {
    id: "fact",
    kind: "fact",
    preTicked: false,
    decision: null,
    choice: null,
    version: 0,
    dependsOnLabel: null,
    payload: {
        subject: { personId: "jan" },
        relationKey: "has_role",
        object: { literal: "vedoucí projektu" },
        startMs: 0,
    },
};
const review = {
    run: { id: "run", status: "ready" },
    available: true,
    names: { jan: "Jan Novák" },
    types: { jan: "person" },
    relations: { has_role: "has the role" },
    entityTypes: [
        ...CORE_ENTITY_TYPES.filter((type) => type.key !== "person"),
        { key: "p_custom", label: "Custom term" },
    ],
    items: [newRecord, fact],
};

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("core vocabulary messages", () => {
    it.each([
        "en",
        "cs-CZ",
    ] as const)("covers every stable key in %s", (locale) => {
        const messages: Record<string, string> = messagesForLocale(locale);
        for (const [prefix, entries] of [
            ["coreType_", CORE_ENTITY_TYPES],
            ["coreRelation_", CORE_RELATIONS],
        ] as const) {
            for (const entry of entries) {
                const id = `${prefix}${entry.key}`;
                expect(messages[id]?.trim(), id).toBeTruthy();
                if (locale === "en") expect(messages[id], id).toBe(entry.label);
            }
        }
    });

    it.each([
        "en",
        "cs-CZ",
    ] as const)("resolves every client label by key in %s during server rendering", (locale) => {
        const messages: Record<string, string> = messagesForLocale(locale);
        function Labels() {
            const labels = useVocabularyLabels();
            for (const type of CORE_ENTITY_TYPES) {
                expect(labels.entityType(type.key, "stale stored label")).toBe(
                    messages[`coreType_${type.key}`],
                );
            }
            for (const relation of CORE_RELATIONS) {
                expect(
                    labels.relation(relation.key, "stale stored label"),
                ).toBe(messages[`coreRelation_${relation.key}`]);
            }
            expect(labels.entityType("p_custom", "Person")).toBe("Person");
            expect(labels.relation("p_custom", "works for")).toBe("works for");
            expect(labels.entityType("future_type")).toBe("future_type");
            expect(labels.relation("future_relation")).toBe("future_relation");
            expect(labels.entityType("constructor", "Custom")).toBe("Custom");
            return null;
        }
        renderToStaticMarkup(
            <IntlProvider locale={locale} messages={messages}>
                <Labels />
            </IntlProvider>,
        );
    });

    it("resolves server labels without changing stored vocabulary or model labels", async () => {
        const labels = await getVocabularyLabels();
        const vocabulary = {
            entityTypes: CORE_ENTITY_TYPES.map((type) => ({
                ...type,
                kind: "entity" as const,
                layer: "core" as const,
                adoptedAsKey: null,
            })),
            relationTypes: CORE_RELATIONS.map((relation) => ({
                ...relation,
                subjectTypes: [...relation.subjectTypes],
                objectTypes: [...relation.objectTypes],
                kind: "relation" as const,
                layer: "core" as const,
                adoptedAsKey: null,
            })),
        };
        const before = structuredClone(vocabulary);
        const localized = almanacVocabulary(vocabulary, labels);
        const messages: Record<string, string> = messagesForLocale("cs-CZ");
        for (const type of CORE_ENTITY_TYPES) {
            expect(localized.typeLabels[type.key]).toBe(
                messages[`coreType_${type.key}`],
            );
        }
        for (const relation of localized.relations) {
            expect(relation.label).toBe(
                messages[`coreRelation_${relation.key}`],
            );
        }
        expect(vocabulary).toEqual(before);
        expect(
            CORE_ENTITY_TYPES.find((type) => type.key === "term")?.label,
        ).toBe("Term");
        expect(
            CORE_RELATIONS.find((relation) => relation.key === "has_role")
                ?.label,
        ).toBe("has the role");
    });
});

describe("Czech vocabulary rendering", () => {
    it("shows Czech Learn type options and a Czech fact sentence from English API labels", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json(review)),
        );
        render(
            <LearnReview
                recordingId="recording"
                source="riffado"
                turns={[]}
                showTrigger={false}
            />,
            { wrapper: Czech },
        );
        const select = await screen.findByRole("combobox");
        const options = within(select).getAllByRole(
            "option",
        ) as HTMLOptionElement[];
        expect(
            options.map((option) => [option.value, option.textContent]),
        ).toEqual([
            ["organization", "Organizace"],
            ["team", "Tým"],
            ["project", "Projekt"],
            ["product", "Produkt nebo systém"],
            ["term", "Pojem"],
            ["location", "Místo"],
            ["document", "Dokument"],
            ["p_custom", "Custom term"],
        ]);
        expect(
            screen.getByRole("checkbox", {
                name: 'Jan Novák — má roli — "vedoucí projektu"',
            }),
        ).toBeTruthy();
        expect(screen.queryByText(/has the role/)).toBeNull();
    });

    it("shows translated types and relations in finished Learn results", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json({
                    ...review,
                    run: { id: "run", status: "finished" },
                    items: review.items.map((item) => ({
                        ...item,
                        outcome: "applied",
                    })),
                }),
            ),
        );
        render(
            <LearnReview
                recordingId="recording"
                source="riffado"
                turns={[]}
                showTrigger={false}
            />,
            { wrapper: Czech },
        );
        fireEvent.click(
            await screen.findByRole("button", { name: "Zobrazit výsledky" }),
        );
        expect(screen.getByText(/Alfa \(Pojem\)/)).toBeTruthy();
        expect(screen.getByText(/Jan Novák — má roli/)).toBeTruthy();
    });

    it("shows translated Almanac fact headings while preserving custom relations", () => {
        render(
            <KnownFacts
                name="Jan Novák"
                relations={[
                    {
                        key: "works_for",
                        label: "works for",
                        facts: [
                            {
                                id: "work",
                                direction: "subject",
                                other: {
                                    kind: "entity",
                                    id: "org",
                                    text: "Acme",
                                },
                                scope: "personal",
                                origin: "manual",
                                evidence: [],
                            },
                        ],
                    },
                    {
                        key: "p_custom",
                        label: "works for",
                        facts: [
                            {
                                id: "custom",
                                direction: "subject",
                                other: { kind: "literal", text: "Own value" },
                                scope: "personal",
                                origin: "manual",
                                evidence: [],
                            },
                        ],
                    },
                ]}
            />,
            { wrapper: Czech },
        );
        expect(
            screen.getByRole("heading", { name: "pracuje pro" }),
        ).toBeTruthy();
        expect(screen.getByRole("heading", { name: "works for" })).toBeTruthy();
        expect(screen.getByRole("link", { name: /Acme/ })).toBeTruthy();
    });
});
