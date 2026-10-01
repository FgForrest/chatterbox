// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

import { Markdown } from "@/components/markdown";
import { SpeakerTags } from "@/components/people/speaker-tags";
import type { SpeakerAttributions } from "@/lib/knowledge/speaker-references";

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
    shownVersion,
    onStale,
    readOnly,
    speakers = [{ speaker: "speaker_0", label: "Speaker 0" }],
}: {
    onAttributionsChange: (attributions: SpeakerAttributions) => void;
    onSeek?: (ms: number) => void;
    shownVersion?: { transcriptionId: string; revision: number };
    onStale?: () => void;
    readOnly?: boolean;
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
        <SpeakerTags
            recordingId="rec-1"
            source="riffado"
            speakers={speakers}
            attributions={attributions}
            onAttributionsChange={handleAttributionsChange}
            onSeek={onSeek}
            shownVersion={shownVersion}
            onStale={onStale}
            readOnly={readOnly}
        />
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

    it("links a confirmed person and unlinks them from the cross button", async () => {
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

        const personLink = await screen.findByRole("link", { name: "Jan" });
        expect(personLink.getAttribute("href")).toBe("/almanac/person-1");

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
        render(
            <SpeakerTagsHarness
                onAttributionsChange={vi.fn()}
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
        expect(screen.getByText("Speaker 2")).toBeDefined();
        expect(screen.getByText("Managed by the Organization")).toBeDefined();
        expect(screen.queryAllByRole("button")).toEqual([]);
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

            await screen.findByRole("link", { name: "Jan Novotný" });
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

            expect(onSeek).toHaveBeenCalledWith(42_000);
        });
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

        await screen.findByRole("link", { name: "Petra" });
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

        await screen.findByRole("link", { name: "Nova" });
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
        await screen.findByRole("link", { name: "Jan" });

        rerender(<SpeakerTagsHarness onAttributionsChange={refreshedChange} />);

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        expect(screen.getByRole("link", { name: "Jan" })).toBeDefined();
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
            ).toHaveLength(2);
        });
        expect(screen.queryByRole("link", { name: "Speaker 0" })).toBeNull();
    });
});
