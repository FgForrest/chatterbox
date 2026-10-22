// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import type { TranslationValues } from "use-intl/core";
import { IntlProvider } from "use-intl/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearnWidget } from "@/components/learn/learn-widget";
import { useLearnApiErrorMessage } from "@/components/learn/review-error";
import { AiCostSummary } from "@/components/recordings/ai-cost-summary";
import {
    messagesForLocale,
    translatedSourceMessage,
} from "@/lib/i18n/messages";
import type { MailDetail } from "@/lib/mail/detail";

vi.mock("sonner", () => ({
    toast: {
        error: vi.fn(),
        info: vi.fn(),
        success: vi.fn(),
        warning: vi.fn(),
    },
}));
vi.mock("@/components/help/help-button", () => ({ HelpLink: () => null }));
vi.mock("next-intl", () => ({
    useLocale: () => "cs-CZ",
    useExtracted:
        () =>
        (
            message: string | { id: string; message: string },
            values?: TranslationValues,
        ) =>
            translatedSourceMessage(
                "cs-CZ",
                typeof message === "string" ? message : message.message,
                values,
            ),
}));

const reason =
    "Mluvčí se v nahrávce nepředstavil a jeho jméno není možné spolehlivě určit.";
const ready = {
    run: { id: "run", status: "ready" },
    items: [
        {
            id: "speaker",
            kind: "speaker",
            version: 0,
            decision: null,
            choice: null,
            preTicked: false,
            dependsOnLabel: null,
            payload: {
                label: "speaker_0",
                personId: null,
                evidenceMs: [0],
                reason,
            },
        },
        {
            id: "new",
            kind: "new_record",
            version: 0,
            decision: null,
            choice: null,
            preTicked: false,
            dependsOnLabel: null,
            payload: {
                ref: "n1",
                kind: "entity",
                typeKey: "project",
                name: "Atlas",
                evidenceMs: [0],
                evidence: [],
                reason,
            },
        },
        {
            id: "fact",
            kind: "fact",
            version: 0,
            decision: null,
            choice: null,
            preTicked: false,
            dependsOnLabel: null,
            payload: {
                subject: { personId: "p1" },
                relationKey: "works_on",
                object: { entityId: "e1" },
                startMs: 0,
            },
        },
        {
            id: "correction",
            kind: "correction",
            version: 0,
            decision: null,
            choice: null,
            preTicked: false,
            dependsOnLabel: null,
            payload: {
                kind: "correct",
                heard: "Atlass",
                target: { entityId: "e1" },
                replacement: "Atlas",
                anchors: [{ turnIndex: 0 }],
            },
        },
        {
            id: "phrase",
            kind: "relation_phrase",
            version: 0,
            decision: null,
            choice: null,
            preTicked: false,
            dependsOnLabel: null,
            payload: {
                phrase: "spravuje",
                subject: { personId: "p1" },
                object: { entityId: "e1" },
                objectKind: "entity",
                count: 1,
            },
        },
    ],
    names: { p1: "Jan Novák", e1: "Atlas" },
    types: { p1: "person", e1: "project" },
    relations: { works_on: "works on" },
    entityTypes: [{ key: "project", label: "Project" }],
    available: true,
};

function Czech({ children }: { children: ReactNode }) {
    return (
        <IntlProvider locale="cs-CZ" messages={messagesForLocale("cs-CZ")}>
            {children}
        </IntlProvider>
    );
}

afterEach(async () => {
    cleanup();
    await act(async () => {});
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe.each(["audio", "mail"] as const)("Czech %s Learn review", (kind) => {
    it.each([
        "private",
        "org",
    ] as const)("localizes sections, controls, counts, vocabulary and reasons in %s view", async (view) => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json(ready)),
        );
        render(
            <Czech>
                <LearnWidget
                    kind={kind}
                    recordingId="item"
                    view={view}
                    turns={[
                        {
                            speaker: "speaker_0",
                            startMs: 0,
                            endMs: 1000,
                            text: "Atlass",
                        },
                    ]}
                    mailDetail={
                        {
                            segments: [],
                            participants: [],
                        } as unknown as MailDetail
                    }
                    frame="inline"
                    showTrigger={false}
                />
            </Czech>,
        );
        await screen.findByRole("button", {
            name: translatedSourceMessage("cs-CZ", "Finish review"),
        });
        expect(screen.getAllByText(reason).length).toBeGreaterThan(0);
        expect(screen.getByRole("option", { name: "Projekt" })).toBeTruthy();
        expect(document.body.textContent).not.toMatch(
            /\b(Speakers|Corrections|Project|works on|Learn|Someone else|Dismiss)\b/,
        );
        expect(document.body.textContent).toContain(
            translatedSourceMessage("cs-CZ", "works on"),
        );
        if (kind === "audio") {
            expect(screen.getByText("Mluvčí 0")).toBeTruthy();
            fireEvent.click(
                screen.getByRole("button", {
                    name: translatedSourceMessage("cs-CZ", "Someone else…"),
                }),
            );
            expect(
                await screen.findByRole("heading", {
                    name: translatedSourceMessage(
                        "cs-CZ",
                        "Identify {speaker}",
                        { speaker: "Mluvčí 0" },
                    ),
                }),
            ).toBeTruthy();
            expect(document.body.textContent).not.toContain("speaker_0");
        }
    });
});

function ErrorProbe({ response }: { response: Response }) {
    const message = useLearnApiErrorMessage();
    return (
        <button
            type="button"
            onClick={async () =>
                toast.error(
                    await message(response, "Rozhodnutí se nepodařilo uložit"),
                )
            }
        >
            Test
        </button>
    );
}

it.each([
    {
        body: {
            code: "CONFLICT",
            error: "The proposal changed after this review opened",
        },
        expected: "Rozhodnutí se nepodařilo uložit",
    },
    {
        body: {
            code: "AI_PROVIDER_NOT_CONFIGURED",
            error: "No AI provider configured",
        },
        expected: translatedSourceMessage(
            "cs-CZ",
            "Learn needs a chat provider. Add one in Settings → Providers.",
        ),
    },
    {
        body: {
            code: "AI_PROVIDER_API_ERROR",
            error: "Provider says: English diagnostic",
        },
        expected: translatedSourceMessage(
            "cs-CZ",
            "The provider's answer was not one Learn could use. Try again, or pick another model for Learn in Settings → Providers.",
        ),
    },
    {
        body: { code: "RATE_LIMITED", error: "Slow down" },
        expected: translatedSourceMessage(
            "cs-CZ",
            "Too many requests. Please wait a moment and try again.",
        ),
    },
])("localizes server failures: $body.code", async ({ body, expected }) => {
    render(
        <Czech>
            <ErrorProbe response={Response.json(body, { status: 400 })} />
        </Czech>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expected));
});

it("localizes both server-composed mail participant reasons", () => {
    expect(
        translatedSourceMessage("cs-CZ", "Another address of a known person"),
    ).toBe("Další adresa známé osoby");
    expect(translatedSourceMessage("cs-CZ", "A participant of the mail")).toBe(
        "Účastník zprávy",
    );
});

it("localizes every operation in the metadata cost breakdown", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
            Response.json({
                totalUsd: 1,
                requestCount: 6,
                unknownCount: 0,
                payers: [],
                byOperation: {
                    transcription: 0.1,
                    summary: 0.1,
                    title: 0.1,
                    topics: 0.1,
                    learn: 0.1,
                    correction: 0.1,
                },
                byService: { "Codex · gpt-model": 1 },
                unknownByService: {},
            }),
        ),
    );
    render(
        <Czech>
            <AiCostSummary recordingId="item" />
        </Czech>,
    );
    const trigger = await screen.findByRole("button", {
        name: `${translatedSourceMessage("cs-CZ", "Estimated AI spend")}: $1.00`,
    });
    fireEvent.keyDown(trigger, { key: "Enter" });
    await screen.findByRole("dialog");
    for (const label of [
        "Transcription",
        "Summary",
        "Title",
        "Topics",
        "Learn",
        "Correction pass",
    ]) {
        expect(
            screen.getByText(translatedSourceMessage("cs-CZ", label)),
        ).toBeTruthy();
    }
    expect(document.body.textContent).not.toMatch(
        /\b(learn|correction|transcription|summary|topics|title)\b/,
    );
    expect(screen.getByText("Codex · gpt-model")).toBeTruthy();
});
