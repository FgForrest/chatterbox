// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

import { Markdown } from "@/components/markdown";
import {
    type SpeakerResponseRow,
    SpeakerTags,
} from "@/components/people/speaker-tags";
import type { PlayAtTarget } from "@/components/playback/play-at-button";
import { PlaybackProvider } from "@/components/playback/playback-context";
import type { SpeakerAttributions } from "@/lib/knowledge/speaker-references";
import { createTestPlayback } from "@/tests/helpers/playback";

interface FetchScenario {
    initialSpeakers?: unknown[];
    savedSpeakers?: unknown[];
    people?: unknown[];
    /** Answer every change with 409, as after a re-transcription. */
    conflict?: boolean;
    /** Fail the first read of the speakers. */
    failFirstRead?: boolean;
    /** The version reads report, when not `VERSION`. */
    readVersion?: { transcriptionId: string; revision: number };
}

function response(body: unknown, status = 200): Response {
    return { ok: status < 400, status, json: async () => body } as Response;
}

/** The transcript version the route reports, and every change sends back. */
const VERSION = { transcriptionId: "tx-1", revision: 3 };

function stubFetch(scenario: FetchScenario) {
    let reads = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
            if (scenario.conflict) {
                return response({ error: "The transcript changed" }, 409);
            }
            return response({
                ...VERSION,
                speakers: scenario.savedSpeakers ?? [],
            });
        }
        if (url === "/api/people") {
            return response({ people: scenario.people ?? [] });
        }
        reads++;
        if (scenario.failFirstRead && reads === 1) {
            return response({ error: "Unavailable" }, 503);
        }
        return response({
            ...(scenario.readVersion ?? VERSION),
            speakers: scenario.initialSpeakers ?? [],
        });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

function SpeakerTagsHarness({
    onAttributionsChange,
    onSeek,
    nextSpeakerTurn,
    shownVersion,
    onStale,
    onUnknownLabelsChange,
    readOnly,
    view,
    speakers = [{ speaker: "speaker_0", label: "Speaker 0" }],
}: {
    onAttributionsChange: (attributions: SpeakerAttributions) => void;
    onSeek?: (ms: number) => void;
    nextSpeakerTurn?: (
        speaker: string | readonly string[],
    ) => PlayAtTarget | null;
    shownVersion?: { transcriptionId: string; revision: number };
    onStale?: () => void;
    onUnknownLabelsChange?: (labels: ReadonlySet<string>) => void;
    readOnly?: boolean;
    view?: "private" | "org";
    speakers?: { speaker: string; label: string }[];
}) {
    const [attributions, setAttributions] = useState<SpeakerAttributions>({});
    const handleAttributionsChange = useCallback(
        (next: SpeakerAttributions) => {
            setAttributions(next);
            onAttributionsChange(next);
        },
        [onAttributionsChange],
    );

    return (
        <PlaybackProvider
            playback={
                onSeek || nextSpeakerTurn
                    ? createTestPlayback({ play: onSeek ?? vi.fn() }).playback
                    : null
            }
        >
            <SpeakerTags
                recordingId="rec-1"
                source="riffado"
                speakers={speakers}
                attributions={attributions}
                onAttributionsChange={handleAttributionsChange}
                nextSpeakerTurn={nextSpeakerTurn}
                shownVersion={shownVersion}
                onStale={onStale}
                onUnknownLabelsChange={onUnknownLabelsChange}
                readOnly={readOnly}
                view={view}
            />
        </PlaybackProvider>
    );
}

function renderTags(
    onAttributionsChange = vi.fn(),
    onSeek?: (ms: number) => void,
    page: {
        shownVersion?: { transcriptionId: string; revision: number };
        onStale?: () => void;
    } = {},
) {
    return render(
        <SpeakerTagsHarness
            onAttributionsChange={onAttributionsChange}
            onSeek={onSeek}
            shownVersion={page.shownVersion}
            onStale={page.onStale}
        />,
    );
}

function SpeakerSummaryHarness() {
    const [attributions, setAttributions] = useState<SpeakerAttributions>({});

    return (
        <>
            <SpeakerTags
                recordingId="rec-1"
                source="plaud"
                speakers={[{ speaker: "Speaker 0", label: "Speaker 0" }]}
                attributions={attributions}
                onAttributionsChange={setAttributions}
            />
            <Markdown speakerAttributions={attributions}>
                {"### Attendees\n\n- Speaker 0 — leads the meeting"}
            </Markdown>
        </>
    );
}

describe("SpeakerTags", () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("opens a confirmed person in the picker and unlinks them from the cross button", async () => {
        const fetchMock = stubFetch({
            initialSpeakers: [
                {
                    label: "speaker_0",
                    personId: "person-1",
                    personName: "Jan",
                    status: "confirmed",
                },
            ],
        });
        renderTags();

        const personName = await screen.findByRole("button", { name: "Jan" });
        fireEvent.click(personName);
        expect(await screen.findByRole("combobox")).toBeDefined();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

        fireEvent.click(
            screen.getByRole("button", {
                name: "Unlink Jan from Speaker 0",
            }),
        );

        await waitFor(() => {
            expect(
                screen.getByRole("button", { name: "Speaker 0" }),
            ).toBeDefined();
        });
        const put = fetchMock.mock.calls.find(
            ([, init]) => init?.method === "PUT",
        );
        expect(JSON.parse(String(put?.[1]?.body))).toEqual({
            ...VERSION,
            label: "speaker_0",
        });
    });

    it("shows a shared recording's speakers without a way to change them", async () => {
        const fetchMock = stubFetch({
            initialSpeakers: [
                {
                    label: "speaker_0",
                    personId: "person-1",
                    personName: "Jan",
                    status: "confirmed",
                },
                {
                    label: "speaker_1",
                    personId: null,
                    personName: null,
                    status: "confirmed",
                    markedUnknown: true,
                },
            ],
        });
        const onUnknownLabelsChange = vi.fn();
        render(
            <SpeakerTagsHarness
                onAttributionsChange={vi.fn()}
                onUnknownLabelsChange={onUnknownLabelsChange}
                readOnly
                speakers={[
                    { speaker: "speaker_0", label: "Speaker 0" },
                    { speaker: "speaker_1", label: "Speaker 1" },
                    { speaker: "speaker_2", label: "Speaker 2" },
                ]}
            />,
        );

        const personLink = await screen.findByRole("link", { name: "Jan" });
        expect(personLink.getAttribute("href")).toBe("/almanac/person-1");
        expect(await screen.findByText("Speaker 1: unknown")).toBeDefined();
        expect(onUnknownLabelsChange).toHaveBeenLastCalledWith(
            new Set(["speaker_1"]),
        );
        expect(screen.getByText("Speaker 2")).toBeDefined();
        expect(screen.getByText("Managed by the Organization")).toBeDefined();
        expect(screen.queryAllByRole("button")).toHaveLength(0);
        expect(
            fetchMock.mock.calls.some(([, init]) => init?.method === "PUT"),
        ).toBe(false);
    });

    it("says a recording shared meanwhile is managed by the Organization", async () => {
        const onStale = vi.fn();
        const fetchMock = stubFetch({});
        fetchMock.mockImplementation(
            async (_url: string, init?: RequestInit) =>
                init?.method === "PUT"
                    ? response(
                          {
                              error: "This recording is shared with the Organization",
                              code: "RECORDING_SHARED",
                          },
                          409,
                      )
                    : response({ ...VERSION, speakers: [] }),
        );
        renderTags(vi.fn(), undefined, { onStale });

        fireEvent.click(
            await screen.findByRole("button", { name: "Speaker 0" }),
        );
        fireEvent.click(
            await screen.findByRole("button", { name: /unknown/i }),
        );

        await waitFor(() => {
            expect(toastError).toHaveBeenCalledWith(
                "This recording was shared meanwhile. The Organization manages its speakers now.",
            );
        });
        expect(onStale).toHaveBeenCalled();
    });

    it("marks a speaker unknown from the picker and clears it again", async () => {
        const fetchMock = stubFetch({
            savedSpeakers: [
                {
                    label: "speaker_0",
                    personId: null,
                    personName: null,
                    status: "confirmed",
                    markedUnknown: true,
                },
            ],
        });
        renderTags();

        fireEvent.click(
            await screen.findByRole("button", { name: "Speaker 0" }),
        );
        fireEvent.click(
            await screen.findByRole("button", { name: "Unknown speaker" }),
        );

        await screen.findByText("Speaker 0: unknown");
        const puts = () =>
            fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");
        expect(JSON.parse(String(puts()[0]?.[1]?.body))).toEqual({
            ...VERSION,
            label: "speaker_0",
            unknown: true,
        });

        fireEvent.click(
            screen.getByRole("button", {
                name: "Clear the answer for Speaker 0",
            }),
        );
        await waitFor(() => expect(puts()).toHaveLength(2));
        expect(JSON.parse(String(puts()[1]?.[1]?.body))).toEqual({
            ...VERSION,
            label: "speaker_0",
        });
    });

    it("names the transcript version it saw, and reloads when it changed", async () => {
        const fetchMock = stubFetch({ conflict: true });
        renderTags();

        fireEvent.click(
            await screen.findByRole("button", { name: "Speaker 0" }),
        );
        fireEvent.click(
            await screen.findByRole("button", { name: "Unknown speaker" }),
        );

        await waitFor(() => {
            const reads = fetchMock.mock.calls.filter(
                ([url, init]) =>
                    String(url).includes("/speakers") && !init?.method,
            );
            expect(reads).toHaveLength(2);
        });
        // The picker stays open: nothing was saved.
        expect(
            screen.getByRole("button", { name: "Unknown speaker" }),
        ).toBeDefined();
    });

    it("says so, and loads again, when changed before the speakers loaded", async () => {
        const fetchMock = stubFetch({ failFirstRead: true });
        renderTags();

        fireEvent.click(
            await screen.findByRole("button", { name: "Speaker 0" }),
        );
        fireEvent.click(
            await screen.findByRole("button", { name: "Unknown speaker" }),
        );

        await waitFor(() => {
            expect(toastError).toHaveBeenCalledWith(
                "The speakers are still loading. Try again in a moment.",
            );
        });
        const calls = fetchMock.mock.calls;
        expect(calls.filter(([, init]) => init?.method === "PUT")).toEqual([]);
        await waitFor(() => {
            expect(
                calls.filter(
                    ([url, init]) =>
                        String(url).includes("/speakers") && !init?.method,
                ),
            ).toHaveLength(2);
        });
    });

    describe("the transcript on screen", () => {
        it("is the version a change names", async () => {
            const fetchMock = stubFetch({});
            renderTags(vi.fn(), undefined, { shownVersion: VERSION });

            fireEvent.click(
                await screen.findByRole("button", { name: "Speaker 0" }),
            );
            fireEvent.click(
                await screen.findByRole("button", { name: "Unknown speaker" }),
            );

            await waitFor(() => {
                const put = fetchMock.mock.calls.find(
                    ([, init]) => init?.method === "PUT",
                );
                expect(JSON.parse(String(put?.[1]?.body))).toEqual({
                    ...VERSION,
                    label: "speaker_0",
                    unknown: true,
                });
            });
        });

        it("gets no names from a newer transcript, and is reloaded instead", async () => {
            stubFetch({
                readVersion: { ...VERSION, revision: VERSION.revision + 1 },
                initialSpeakers: [
                    {
                        label: "speaker_0",
                        personId: "person-1",
                        personName: "Jan",
                        status: "confirmed",
                    },
                ],
            });
            const onStale = vi.fn();
            const onAttributionsChange = vi.fn();
            renderTags(onAttributionsChange, undefined, {
                shownVersion: VERSION,
                onStale,
            });

            await waitFor(() => expect(onStale).toHaveBeenCalled());
            expect(onAttributionsChange).not.toHaveBeenCalled();
            expect(screen.queryByRole("link", { name: "Jan" })).toBeNull();
        });

        it("is reloaded when a change finds it replaced", async () => {
            stubFetch({ conflict: true });
            const onStale = vi.fn();
            renderTags(vi.fn(), undefined, { shownVersion: VERSION, onStale });

            fireEvent.click(
                await screen.findByRole("button", { name: "Speaker 0" }),
            );
            fireEvent.click(
                await screen.findByRole("button", { name: "Unknown speaker" }),
            );

            await waitFor(() => expect(onStale).toHaveBeenCalled());
        });
    });

    describe("a suggested name", () => {
        const suggested = {
            label: "speaker_0",
            personId: "person-9",
            personName: "Jan Novotný",
            status: "suggested",
            evidenceStartMs: 42_000,
        };

        it("shows as a question and never as the speaker's name", async () => {
            const onAttributionsChange = vi.fn();
            stubFetch({ initialSpeakers: [suggested] });
            renderTags(onAttributionsChange);

            await screen.findByText("Jan Novotný?");
            // The transcript, summary and exports read confirmed names only.
            expect(onAttributionsChange).toHaveBeenLastCalledWith({});
        });

        it("confirms the person, naming the version it saw", async () => {
            const fetchMock = stubFetch({
                initialSpeakers: [suggested],
                savedSpeakers: [{ ...suggested, status: "confirmed" }],
            });
            renderTags();

            fireEvent.click(
                await screen.findByRole("button", {
                    name: "Confirm Jan Novotný as Speaker 0",
                }),
            );

            await screen.findByRole("button", { name: "Jan Novotný" });
            const put = fetchMock.mock.calls.find(
                ([, init]) => init?.method === "PUT",
            );
            expect(JSON.parse(String(put?.[1]?.body))).toEqual({
                ...VERSION,
                label: "speaker_0",
                personId: "person-9",
            });
        });

        it("rejects the person", async () => {
            const fetchMock = stubFetch({ initialSpeakers: [suggested] });
            renderTags();

            fireEvent.click(
                await screen.findByRole("button", {
                    name: "Speaker 0 is not Jan Novotný",
                }),
            );

            await screen.findByRole("button", { name: "Speaker 0" });
            const put = fetchMock.mock.calls.find(
                ([, init]) => init?.method === "PUT",
            );
            expect(JSON.parse(String(put?.[1]?.body))).toEqual({
                ...VERSION,
                label: "speaker_0",
                personId: "person-9",
                reject: true,
            });
        });

        it("plays the moment it was recognized", async () => {
            const onSeek = vi.fn();
            stubFetch({ initialSpeakers: [suggested] });
            renderTags(vi.fn(), onSeek);

            fireEvent.click(
                await screen.findByRole("button", {
                    name: "Play where Speaker 0 speaks",
                }),
            );

            expect(onSeek).toHaveBeenCalledWith(
                42_000,
                expect.any(String),
                undefined,
            );
        });
    });

    it.each([
        ["confirmed", "Jan", false],
        ["confirmed", null, true],
        ["suggested", "Jan", false],
    ])("separates playback, picker and right-click for %s, %s, unknown=%s", async (status, personName, markedUnknown) => {
        stubFetch({
            initialSpeakers: [
                {
                    label: "speaker_0",
                    personId: personName ? "p-1" : null,
                    personName,
                    status,
                    markedUnknown,
                    evidenceStartMs: 42000,
                },
            ],
        });
        const nextSpeakerTurn = vi.fn<() => PlayAtTarget | null>(() => ({
            ms: 1000,
        }));
        const onSeek = vi.fn();
        render(
            <SpeakerTagsHarness
                onAttributionsChange={vi.fn()}
                nextSpeakerTurn={nextSpeakerTurn}
                onSeek={onSeek}
            />,
        );
        const name = personName
            ? status === "suggested"
                ? "Jan?"
                : "Jan"
            : "Speaker 0: unknown";
        const nameButton = await screen.findByRole("button", {
            name,
        });
        const play = screen.getByRole("button", {
            name:
                status === "suggested"
                    ? "Play where Speaker 0 speaks"
                    : `Play the next turn of ${personName ?? "Speaker 0"}`,
        });
        expect(play.className).toContain("text-primary");
        expect(play.className).toContain("min-h-7");
        expect(play.className).toContain("focus-visible:ring-2");
        fireEvent.click(play);
        if (status === "suggested") {
            expect(onSeek).toHaveBeenCalledWith(
                42000,
                expect.any(String),
                undefined,
            );
            expect(nextSpeakerTurn).not.toHaveBeenCalled();
        } else expect(nextSpeakerTurn).toHaveBeenCalledWith("speaker_0");
        expect(screen.queryByRole("combobox")).toBeNull();
        nextSpeakerTurn.mockClear();
        expect(fireEvent.contextMenu(nameButton)).toBe(false);
        if (status !== "suggested")
            expect(nextSpeakerTurn).toHaveBeenCalledWith("speaker_0");
        nextSpeakerTurn.mockReturnValue(null);
        expect(fireEvent.contextMenu(play)).toBe(true);
        fireEvent.click(nameButton);
        expect(await screen.findByRole("combobox")).toBeDefined();
        expect(
            document.querySelector("fieldset[aria-label='Transcript speakers']")
                ?.children,
        ).toHaveLength(1);
        expect(
            screen.queryByText("Right-click a speaker to hear their next turn"),
        ).toBeNull();
    });

    it("selects an existing person through the modal", async () => {
        const fetchMock = stubFetch({
            people: [
                {
                    id: "person-2",
                    displayName: "Petra",
                    primaryEmail: null,
                },
            ],
            savedSpeakers: [
                {
                    label: "speaker_0",
                    personId: "person-2",
                    personName: "Petra",
                    status: "confirmed",
                },
            ],
        });
        renderTags();

        fireEvent.click(
            await screen.findByRole("button", { name: "Speaker 0" }),
        );
        fireEvent.change(await screen.findByRole("combobox"), {
            target: { value: "Petra" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Select" }));

        await screen.findByRole("button", { name: "Petra" });
        const put = fetchMock.mock.calls.find(
            ([, init]) => init?.method === "PUT",
        );
        expect(JSON.parse(String(put?.[1]?.body))).toEqual({
            ...VERSION,
            label: "speaker_0",
            personId: "person-2",
        });
    });

    it("creates a new person and Cancel makes no change", async () => {
        const fetchMock = stubFetch({
            savedSpeakers: [
                {
                    label: "speaker_0",
                    personId: "person-3",
                    personName: "Nova",
                    status: "confirmed",
                },
            ],
        });
        renderTags();

        fireEvent.click(
            await screen.findByRole("button", { name: "Speaker 0" }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(
            fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT"),
        ).toHaveLength(0);

        fireEvent.click(screen.getByRole("button", { name: "Speaker 0" }));
        fireEvent.change(await screen.findByRole("combobox"), {
            target: { value: "Nova" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Create" }));

        await screen.findByRole("button", { name: "Nova" });
        const put = fetchMock.mock.calls.find(
            ([, init]) => init?.method === "PUT",
        );
        expect(JSON.parse(String(put?.[1]?.body))).toEqual({
            ...VERSION,
            label: "speaker_0",
            displayName: "Nova",
        });
    });

    it("keeps confirmed names visible while refreshing the same transcript", async () => {
        const initialResponse = response({
            speakers: [
                {
                    label: "speaker_0",
                    personId: "person-1",
                    personName: "Jan",
                    status: "confirmed",
                },
            ],
        });
        const pendingRefresh = new Promise<Response>(() => {});
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(initialResponse)
            .mockReturnValueOnce(pendingRefresh);
        vi.stubGlobal("fetch", fetchMock);
        const initialChange = vi.fn();
        const refreshedChange = vi.fn();

        const { rerender } = renderTags(initialChange);
        await screen.findByRole("button", { name: "Jan" });

        rerender(<SpeakerTagsHarness onAttributionsChange={refreshedChange} />);

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        expect(screen.getByRole("button", { name: "Jan" })).toBeDefined();
        expect(refreshedChange).not.toHaveBeenCalledWith({});
    });

    it("projects loaded speaker attributions into summary references", async () => {
        stubFetch({
            initialSpeakers: [
                {
                    label: "Speaker 0",
                    personId: "person-1",
                    personName: "Jakub Kosař",
                    status: "confirmed",
                },
            ],
        });

        render(<SpeakerSummaryHarness />);

        await waitFor(() => {
            expect(
                screen.getAllByRole("link", { name: "Jakub Kosař" }),
            ).toHaveLength(1);
            expect(
                screen.getByRole("button", { name: "Jakub Kosař" }),
            ).toBeDefined();
        });
        expect(screen.queryByRole("link", { name: "Speaker 0" })).toBeNull();
    });
});

describe("confirmed person speaker groups", () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    const voices = [0, 1, 2].map((index) => ({
        speaker: `speaker_${index}`,
        label: `Speaker ${index}`,
    }));
    const linked = (
        label: string,
        personId = "person-1",
    ): SpeakerResponseRow => ({
        label,
        personId,
        personName: "Jan",
        status: "confirmed",
    });
    function server(
        initial = [linked("speaker_0"), linked("speaker_2")],
        fails?: string,
    ) {
        let rows = initial;
        const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
            if (url === "/api/people")
                return response({
                    people: [
                        {
                            id: "person-2",
                            displayName: "Petra",
                            primaryEmail: null,
                            scope: "org",
                        },
                    ],
                });
            if (init?.method === "PUT") {
                const body = JSON.parse(String(init.body)) as {
                    label: string;
                    personId?: string;
                };
                if (body.label === fails)
                    return response({ error: "Save refused" }, 500);
                rows = rows.filter((row) => row.label !== body.label);
                if (body.personId)
                    rows.push({
                        ...linked(body.label, body.personId),
                        personName: "Petra",
                    });
            }
            return response({ ...VERSION, speakers: rows });
        });
        vi.stubGlobal("fetch", fetchMock);
        return fetchMock;
    }
    const chips = () =>
        screen.getByRole("group", { name: "Transcript speakers" });

    it("merges identities in earliest-voice colour, keeping names, suggestions and unlinked voices distinct", async () => {
        server([
            linked("speaker_0"),
            linked("speaker_2"),
            linked("speaker_1", "another-person"),
            { ...linked("speaker_3"), status: "suggested" },
            { ...linked("speaker_4"), status: "suggested" },
        ]);
        const nextSpeakerTurn = vi.fn<() => PlayAtTarget | null>(() => ({
            ms: 1000,
        }));
        render(
            <SpeakerTagsHarness
                onAttributionsChange={vi.fn()}
                nextSpeakerTurn={nextSpeakerTurn}
                speakers={[
                    ...voices,
                    ...[3, 4, 5].map((index) => ({
                        speaker: `speaker_${index}`,
                        label: `Speaker ${index}`,
                    })),
                ]}
            />,
        );
        await waitFor(() =>
            expect(
                within(chips()).getAllByRole("button", { name: "Jan" }),
            ).toHaveLength(2),
        );
        expect(chips().children).toHaveLength(5);
        expect(
            within(chips()).getAllByRole("button", { name: "Jan?" }),
        ).toHaveLength(2);
        const play = within(chips()).getAllByRole("button", {
            name: "Play the next turn of Jan",
        });
        expect(play[0].className).toContain("text-primary");
        expect(play[1].className).toContain("text-emerald-600");
        fireEvent.click(play[0]);
        expect(nextSpeakerTurn).toHaveBeenLastCalledWith([
            "speaker_0",
            "speaker_2",
        ]);
        fireEvent.contextMenu(play[0]);
        expect(nextSpeakerTurn).toHaveBeenLastCalledWith([
            "speaker_0",
            "speaker_2",
        ]);
        expect(document.getElementById("speaker-2")).toBeTruthy();
    });

    it("unlinks every merged voice with separate versioned saves", async () => {
        const fetchMock = server();
        render(
            <SpeakerTagsHarness
                onAttributionsChange={vi.fn()}
                speakers={voices}
            />,
        );
        fireEvent.click(
            await screen.findByRole("button", {
                name: "Unlink Jan from Speaker 0, Speaker 2",
            }),
        );
        await screen.findByRole("button", { name: "Speaker 2" });
        expect(
            within(chips()).queryByRole("button", { name: "Jan" }),
        ).toBeNull();
        expect(
            fetchMock.mock.calls
                .filter(([, init]) => init?.method === "PUT")
                .map(([, init]) => JSON.parse(String(init?.body))),
        ).toEqual([
            { ...VERSION, label: "speaker_0" },
            { ...VERSION, label: "speaker_2" },
        ]);
    });

    it("reloads the true partially unlinked state after a failed save", async () => {
        toastError.mockClear();
        const fetchMock = server(undefined, "speaker_2");
        render(
            <SpeakerTagsHarness
                onAttributionsChange={vi.fn()}
                speakers={voices}
            />,
        );
        fireEvent.click(
            await screen.findByRole("button", {
                name: "Unlink Jan from Speaker 0, Speaker 2",
            }),
        );
        await waitFor(() =>
            expect(
                fetchMock.mock.calls.filter(([, init]) => !init?.method),
            ).toHaveLength(2),
        );
        expect(toastError).toHaveBeenCalled();
        expect(
            within(chips()).getByRole("button", { name: "Speaker 0" }),
        ).toBeTruthy();
        expect(
            within(chips()).getByRole("button", { name: "Jan" }),
        ).toBeTruthy();
        expect(chips().children).toHaveLength(3);
    });

    it.each([
        "unlink",
        "relink",
    ])("lets the picker %s one voice and split the chip", async (action) => {
        const fetchMock = server();
        const nextSpeakerTurn = vi.fn<() => PlayAtTarget | null>(() => ({
            ms: 1000,
        }));
        render(
            <SpeakerTagsHarness
                onAttributionsChange={vi.fn()}
                speakers={voices}
                nextSpeakerTurn={nextSpeakerTurn}
                view="org"
            />,
        );
        fireEvent.click(await screen.findByRole("button", { name: "Jan" }));
        const dialog = within(screen.getByRole("dialog"));
        fireEvent.click(
            dialog.getByRole("button", {
                name: "Play the next turn of Speaker 2",
            }),
        );
        expect(nextSpeakerTurn).toHaveBeenCalledWith("speaker_2");
        if (action === "unlink")
            fireEvent.click(
                dialog.getByRole("button", {
                    name: "Unlink Jan from Speaker 2",
                }),
            );
        else {
            fireEvent.change(dialog.getByRole("combobox"), {
                target: { value: "Discard this search" },
            });
            fireEvent.click(dialog.getByRole("button", { name: "Speaker 2" }));
            expect(dialog.getByRole("combobox")).toHaveProperty("value", "");
            fireEvent.click(
                await dialog.findByRole("button", { name: "Petra" }),
            );
            fireEvent.click(dialog.getByRole("button", { name: "Select" }));
        }
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(chips().children).toHaveLength(3);
        expect(
            within(chips()).getByRole("button", { name: "Jan" }),
        ).toBeTruthy();
        expect(
            within(chips()).getByRole("button", {
                name: action === "unlink" ? "Speaker 2" : "Petra",
            }),
        ).toBeTruthy();
        const puts = fetchMock.mock.calls.filter(
            ([, init]) => init?.method === "PUT",
        );
        expect(puts).toHaveLength(1);
        expect(puts[0][0]).toContain("view=org");
        expect(JSON.parse(String(puts[0][1]?.body))).toEqual({
            ...VERSION,
            label: "speaker_2",
            ...(action === "relink" ? { personId: "person-2" } : {}),
        });
    });

    it("keeps other chips usable while one chip unlinks", async () => {
        let release: (() => void) | undefined;
        const rows = [linked("speaker_0"), linked("speaker_1", "person-2")];
        rows[1] = { ...rows[1], personName: "Petra" };
        vi.stubGlobal(
            "fetch",
            vi.fn(async (_url: string, init?: RequestInit) => {
                if (init?.method === "PUT") {
                    await new Promise<void>((resolve) => {
                        release = resolve;
                    });
                    return response({ ...VERSION, speakers: [rows[1]] });
                }
                return response({ ...VERSION, speakers: rows });
            }),
        );
        render(
            <SpeakerTagsHarness
                onAttributionsChange={vi.fn()}
                speakers={voices.slice(0, 2)}
            />,
        );
        fireEvent.click(
            await screen.findByRole("button", {
                name: "Unlink Jan from Speaker 0",
            }),
        );
        await waitFor(() => expect(release).toBeDefined());
        expect(
            within(chips()).getByRole("button", { name: "Petra" }),
        ).toHaveProperty("disabled", false);
        expect(
            within(chips()).getByRole("button", {
                name: "Unlink Petra from Speaker 1",
            }),
        ).toHaveProperty("disabled", false);
        release?.();
        await screen.findByRole("button", { name: "Speaker 0" });
    });

    it("merges read-only speakers without editing actions", async () => {
        const fetchMock = server();
        render(
            <SpeakerTagsHarness
                onAttributionsChange={vi.fn()}
                speakers={voices}
                readOnly
                view="org"
            />,
        );
        expect(
            (await screen.findByRole("link", { name: "Jan" })).getAttribute(
                "href",
            ),
        ).toBe("/almanac/person-1");
        expect(chips().children).toHaveLength(2);
        expect(
            within(chips()).queryByRole("button", { name: /Unlink/ }),
        ).toBeNull();
        expect(chips().querySelector('[aria-haspopup="dialog"]')).toBeNull();
        expect(screen.getByText("Managed by the Organization")).toBeTruthy();
        expect(
            fetchMock.mock.calls.some(([, init]) => init?.method === "PUT"),
        ).toBe(false);
    });
});
