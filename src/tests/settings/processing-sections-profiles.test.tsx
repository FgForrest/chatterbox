// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { MailSection } from "@/components/settings-sections/mail-section";
import { SummarySection } from "@/components/settings-sections/summary-section";
import { TranscriptionSection } from "@/components/settings-sections/transcription-section";
import type { TemplateConfiguration } from "@/lib/ai/prompt-templates";

const { toastSuccess, translate } = vi.hoisted(() => ({
    toastSuccess: vi.fn(),
    translate: (text: string, values?: Record<string, unknown>) =>
        Object.entries(values ?? {}).reduce(
            (result, [key, value]) => result.replace(`{${key}}`, String(value)),
            text,
        ),
}));

vi.mock("next-intl", () => ({
    useExtracted: () => translate,
    useLocale: () => "en",
}));
vi.mock("sonner", () => ({
    toast: { error: vi.fn(), success: toastSuccess, warning: vi.fn() },
}));
vi.mock("@/components/settings/provider-role-select", () => ({
    ProviderRoleSelect: ({ purpose }: { purpose: string }) => (
        <div>Provider role: {purpose}</div>
    ),
}));
vi.mock("@/components/settings/profile-editor", () => ({
    ProfileEditor: ({ profileId }: { profileId: string | null }) => (
        <div role="dialog">Profile editor {profileId}</div>
    ),
}));

const legacyTemplates: TemplateConfiguration = {
    selectedPrompt: "general",
    templates: [
        {
            id: "general",
            name: null,
            prompt: null,
            createdAt: "1970-01-01T00:00:00.000Z",
        },
        {
            id: "meeting-notes",
            name: "Edited meetings",
            prompt: "Edited built-in {transcription}",
            createdAt: "1970-01-01T00:00:00.000Z",
        },
        {
            id: "custom-template",
            name: "Customer call",
            prompt: "Custom prompt {transcription}",
            createdAt: "2026-10-15T00:00:00.000Z",
        },
    ],
};

const legacyTitleTemplates: TemplateConfiguration = {
    selectedPrompt: "default",
    templates: [
        {
            id: "default",
            name: null,
            prompt: null,
            createdAt: "1970-01-01T00:00:00.000Z",
        },
        {
            id: "meetings",
            name: "Edited meeting titles",
            prompt: "Edited title prompt {transcription}",
            createdAt: "1970-01-01T00:00:00.000Z",
        },
    ],
};

const legacyTopicTemplates: TemplateConfiguration = {
    selectedPrompt: "default",
    templates: [
        {
            id: "default",
            name: null,
            prompt: null,
            createdAt: "1970-01-01T00:00:00.000Z",
        },
        {
            id: "custom-topics",
            name: "Short chapters",
            prompt: "Use short chapters {transcription}",
            createdAt: "2026-10-15T00:00:00.000Z",
        },
    ],
};

interface FetchCall {
    url: string;
    method: string;
    body: Record<string, unknown> | null;
}

describe("processing settings after profiles", () => {
    let calls: FetchCall[];
    let created: number;

    beforeEach(() => {
        calls = [];
        created = 0;
        toastSuccess.mockClear();
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";
                const body = init?.body
                    ? (JSON.parse(String(init.body)) as Record<string, unknown>)
                    : null;
                calls.push({ url, method, body });
                if (url === "/api/settings/user") {
                    return Response.json({
                        summaryPrompt: legacyTemplates,
                        titleGenerationPrompt: legacyTitleTemplates,
                        topicPrompt: legacyTopicTemplates,
                        summaryMultiPass: false,
                        summaryMultiPassRounds: 3,
                        summaryMultiPassAuto: false,
                        summaryMergePrompt: null,
                        defaultTranscriptionLanguage: null,
                        importPlaudContent: true,
                        preferredTranscriptSource: "plaud",
                        syncTitleToPlaud: false,
                        autoLearnOffered: true,
                    });
                }
                if (url === "/api/settings/profiles" && method === "POST") {
                    created += 1;
                    return Response.json(
                        { profile: { id: `copied-${created}` } },
                        { status: 201 },
                    );
                }
                if (url === "/api/mail/addresses") {
                    return Response.json({
                        eligible: true,
                        receiving: true,
                        addresses: [],
                    });
                }
                if (url === "/api/mail/delivery-log") {
                    return Response.json({ entries: [] });
                }
                return Response.json({});
            }),
        );
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("trims Transcription, Topics, Learning, Summary, and Mail to account settings", async () => {
        const { unmount } = render(
            <ConfirmDialogProvider>
                <TranscriptionSection />
            </ConfirmDialogProvider>,
        );
        await screen.findByText("Default transcription language");
        expect(screen.getByText("Provider role: title")).toBeTruthy();
        expect(screen.getByText("Sync titles to Plaud")).toBeTruthy();
        expect(screen.getByText("Set in your profiles")).toBeTruthy();
        expect(screen.queryByText("Auto-transcribe new recordings")).toBeNull();
        expect(screen.queryByText("Transcription quality")).toBeNull();
        expect(screen.queryByText("When Plaud has a transcript")).toBeNull();
        expect(screen.queryByText("Auto-generate titles")).toBeNull();
        expect(screen.getByText("Templates from before profiles")).toBeTruthy();
        unmount();

        render(
            <ConfirmDialogProvider>
                <TranscriptionSection mode="topics" />
            </ConfirmDialogProvider>,
        );
        await screen.findByText("Provider role: topics");
        expect(screen.getByText("Set in your profiles")).toBeTruthy();
        expect(screen.queryByText("Auto-detect topics")).toBeNull();
        expect(screen.getByText("Templates from before profiles")).toBeTruthy();
        cleanup();

        render(
            <ConfirmDialogProvider>
                <TranscriptionSection mode="learning" />
            </ConfirmDialogProvider>,
        );
        await screen.findByText("Provider role: learning");
        expect(screen.getByText("Set in your profiles")).toBeTruthy();
        expect(screen.queryByText("Learn automatically")).toBeNull();
        expect(
            screen.queryByText("Correct the transcript after Learn"),
        ).toBeNull();
        cleanup();

        render(
            <ConfirmDialogProvider>
                <SummarySection />
            </ConfirmDialogProvider>,
        );
        await screen.findByText("Templates from before profiles");
        expect(screen.getByText("Set in your profiles")).toBeTruthy();
        expect(screen.queryByText("AI output language")).toBeNull();
        expect(
            screen.queryByText("Auto-generate summary after transcription"),
        ).toBeNull();
        expect(screen.queryByText("New template")).toBeNull();
        expect(
            screen.getByText(
                "This preference applies when a profile does not pin the Summary provider.",
            ),
        ).toBeTruthy();
        cleanup();

        render(
            <ConfirmDialogProvider>
                <MailSection />
            </ConfirmDialogProvider>,
        );
        await screen.findByText("Your addresses");
        expect(screen.getByText("Set in your profiles")).toBeTruthy();
        expect(screen.queryByText("Process mail automatically")).toBeNull();
    });

    it("copies edited built-in and custom templates into personal recording profiles", async () => {
        render(
            <ConfirmDialogProvider>
                <SummarySection />
            </ConfirmDialogProvider>,
        );
        await screen.findByText("Templates from before profiles");

        expect(
            screen.queryByRole("button", {
                name: "Copy General Summary into a profile",
            }),
        ).toBeNull();

        for (const [name, expectedCount] of [
            ["Edited meetings", 1],
            ["Customer call", 2],
        ] as const) {
            fireEvent.click(
                screen.getByRole("button", {
                    name: `Copy ${name} into a profile`,
                }),
            );
            await waitFor(() =>
                expect(
                    calls.filter(
                        (call) =>
                            call.url === "/api/settings/profiles" &&
                            call.method === "POST",
                    ),
                ).toHaveLength(expectedCount),
            );
            expect(screen.getByRole("dialog").textContent).toContain(
                `copied-${created}`,
            );
            expect(toastSuccess).toHaveBeenLastCalledWith(
                `Profile “${name}” created`,
            );
        }

        const posts = calls.filter(
            (call) =>
                call.url === "/api/settings/profiles" && call.method === "POST",
        );
        for (const post of posts) {
            expect(post.body).toMatchObject({
                channel: "audio",
                scope: "personal",
            });
        }
        const settings = posts.map(
            (post) =>
                post.body?.settings as {
                    steps: {
                        summary: { preset: string; fullPrompt: string | null };
                    };
                },
        );
        expect(settings[0].steps.summary).toMatchObject({
            preset: "meeting-notes",
            fullPrompt: "Edited built-in {transcription}",
        });
        expect(settings[1].steps.summary).toMatchObject({
            preset: "general",
            fullPrompt: "Custom prompt {transcription}",
        });
    });

    it("copies legacy title templates into the Title step", async () => {
        render(
            <ConfirmDialogProvider>
                <TranscriptionSection />
            </ConfirmDialogProvider>,
        );
        await screen.findByText("Edited meeting titles");

        expect(
            screen.queryByRole("button", {
                name: "Copy General into a profile",
            }),
        ).toBeNull();
        fireEvent.click(
            screen.getByRole("button", {
                name: "Copy Edited meeting titles into a profile",
            }),
        );
        await waitFor(() => expect(created).toBe(1));

        const settings = calls
            .filter(
                (call) =>
                    call.url === "/api/settings/profiles" &&
                    call.method === "POST",
            )
            .map(
                (call) =>
                    call.body?.settings as {
                        steps: {
                            title: {
                                preset: string;
                                fullPrompt: string | null;
                            };
                        };
                    },
            );
        expect(settings[0].steps.title).toMatchObject({
            preset: "meetings",
            fullPrompt: "Edited title prompt {transcription}",
        });
        expect(toastSuccess).toHaveBeenLastCalledWith(
            "Profile “Edited meeting titles” created",
        );
    });

    it("copies legacy topic templates into the Topics step", async () => {
        render(
            <ConfirmDialogProvider>
                <TranscriptionSection mode="topics" />
            </ConfirmDialogProvider>,
        );
        await screen.findByText("Short chapters");

        expect(
            screen.queryByRole("button", {
                name: "Copy Chapters into a profile",
            }),
        ).toBeNull();
        fireEvent.click(
            screen.getByRole("button", {
                name: "Copy Short chapters into a profile",
            }),
        );
        await waitFor(() => expect(created).toBe(1));

        const settings = calls
            .filter(
                (call) =>
                    call.url === "/api/settings/profiles" &&
                    call.method === "POST",
            )
            .map(
                (call) =>
                    call.body?.settings as {
                        steps: {
                            topics: {
                                preset: string;
                                fullPrompt: string | null;
                            };
                        };
                    },
            );
        expect(settings[0].steps.topics).toMatchObject({
            preset: "default",
            fullPrompt: "Use short chapters {transcription}",
        });
        expect(toastSuccess).toHaveBeenLastCalledWith(
            "Profile “Short chapters” created",
        );
    });
});
