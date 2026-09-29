// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearnReview } from "@/components/learn/learn-review";

vi.mock("sonner", () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

const TURNS = [
    { speaker: "speaker_0", startMs: 0, endMs: 5_000, text: "Máme tu Tavesy." },
    { speaker: "speaker_1", startMs: 5_000, endMs: 9_000, text: "Vedu Orion." },
];

const READY = {
    run: { id: "run-1", status: "ready" },
    available: true,
    names: { "e-tavesi": "Tavesi", "e-orion": "Orion", "p-jan": "Jan" },
    types: {
        "e-tavesi": "organization",
        "e-orion": "project",
        "p-jan": "person",
    },
    relations: { leads: "leads" },
    items: [
        {
            id: "i-correction",
            kind: "correction",
            preTicked: true,
            decision: null,
            choice: null,
            version: 0,
            dependsOnLabel: null,
            payload: {
                kind: "correct",
                heard: "Tavesy",
                target: { entityId: "e-tavesi" },
                replacement: "Tavesi",
                anchors: [{ turnIndex: 0, charStart: 8, charEnd: 14 }],
            },
        },
        {
            id: "i-fact",
            kind: "fact",
            preTicked: false,
            decision: null,
            choice: null,
            version: 0,
            dependsOnLabel: null,
            payload: {
                subject: { personId: "p-jan" },
                relationKey: "leads",
                object: { entityId: "e-orion" },
                startMs: 5_000,
                endMs: 9_000,
                speakerLabel: null,
            },
        },
    ],
};

function respond(routes: Record<string, unknown>) {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        const key = `${init?.method ?? "GET"} ${url}`;
        const body = routes[key];
        if (body === undefined) return new Response("{}", { status: 404 });
        return Response.json(body);
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
}

describe("LearnReview", () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("offers nothing where Learn is not available", async () => {
        const fetch = respond({
            "GET /api/recordings/rec-1/review?source=riffado": {
                run: null,
                items: [],
                names: {},
                types: {},
                relations: {},
                available: false,
            },
        });
        render(
            <LearnReview recordingId="rec-1" source="riffado" turns={TURNS} />,
        );
        await waitFor(() => expect(fetch).toHaveBeenCalled());
        expect(screen.queryByRole("button", { name: /Learn/ })).toBeNull();
    });

    it("opens the review with its two defaults, keeps a decision, and finishes with the versions shown", async () => {
        const fetch = respond({
            "GET /api/recordings/rec-1/review?source=riffado&view=org": READY,
            "PATCH /api/recordings/rec-1/review/items/i-fact?source=riffado&view=org":
                {
                    version: 1,
                },
            "POST /api/recordings/rec-1/review/finish?source=riffado&view=org":
                {
                    status: "finished",
                    applied: 2,
                    dismissed: 0,
                    skipped: [],
                },
        });
        const onFinished = vi.fn();
        render(
            <LearnReview
                recordingId="rec-1"
                view="org"
                source="riffado"
                turns={TURNS}
                onFinished={onFinished}
            />,
        );
        fireEvent.click(
            await screen.findByRole("button", { name: /Review \(2\)/ }),
        );

        const correction = screen.getByRole("checkbox", {
            name: "Correct Tavesy",
        }) as HTMLInputElement;
        const fact = screen.getByRole("checkbox", {
            name: "Jan — leads — Orion",
        }) as HTMLInputElement;
        expect(correction.checked).toBe(true);
        expect(fact.checked).toBe(false);

        fireEvent.click(fact);
        await waitFor(() =>
            expect(fetch).toHaveBeenCalledWith(
                "/api/recordings/rec-1/review/items/i-fact?source=riffado&view=org",
                expect.objectContaining({
                    method: "PATCH",
                    body: JSON.stringify({
                        decision: "accepted",
                        version: 0,
                        choice: null,
                    }),
                }),
            ),
        );
        await waitFor(() => expect(fact.checked).toBe(true));

        fireEvent.click(screen.getByRole("button", { name: "Finish review" }));
        await waitFor(() => expect(onFinished).toHaveBeenCalled());
        expect(fetch).toHaveBeenCalledWith(
            "/api/recordings/rec-1/review/finish?source=riffado&view=org",
            expect.objectContaining({
                body: JSON.stringify({
                    versions: { "i-correction": 0, "i-fact": 1 },
                }),
            }),
        );
    });

    it("hands its proposals to the transcript, and a tick there is kept like one here", async () => {
        const fetch = respond({
            "GET /api/recordings/rec-1/review?source=riffado": READY,
            "PATCH /api/recordings/rec-1/review/items/i-correction?source=riffado":
                {
                    version: 1,
                },
        });
        const onMarks = vi.fn();
        const { unmount } = render(
            <LearnReview
                recordingId="rec-1"
                source="riffado"
                turns={TURNS}
                onMarks={onMarks}
            />,
        );
        await waitFor(() =>
            expect(onMarks).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    corrections: [
                        expect.objectContaining({
                            itemId: "i-correction",
                            ticked: true,
                        }),
                    ],
                }),
            ),
        );
        onMarks.mock.lastCall?.[0].decide("i-correction", "rejected");
        await waitFor(() =>
            expect(fetch).toHaveBeenCalledWith(
                "/api/recordings/rec-1/review/items/i-correction?source=riffado",
                expect.objectContaining({
                    method: "PATCH",
                    body: JSON.stringify({
                        decision: "rejected",
                        version: 0,
                        choice: null,
                    }),
                }),
            ),
        );
        await waitFor(() =>
            expect(onMarks).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    corrections: [expect.objectContaining({ ticked: false })],
                }),
            ),
        );
        unmount();
        expect(onMarks).toHaveBeenLastCalledWith(null);
    });

    it("keeps a fact waiting on its speaker until that speaker is ticked, and says what it replaces", async () => {
        const item = (overrides: Record<string, unknown>) => ({
            preTicked: false,
            decision: null,
            choice: null,
            version: 0,
            dependsOnLabel: null,
            ...overrides,
        });
        const fetch = respond({
            "GET /api/recordings/rec-1/review?source=riffado": {
                ...READY,
                names: { ...READY.names, "e-acme": "Acme" },
                items: [
                    item({
                        id: "i-speaker",
                        kind: "speaker",
                        payload: {
                            label: "speaker_1",
                            personId: "p-jan",
                            evidenceMs: [5_000],
                            reason: "introduces himself",
                        },
                    }),
                    item({
                        id: "i-works",
                        kind: "fact",
                        dependsOnLabel: "speaker_1",
                        payload: {
                            subject: { speakerLabel: "speaker_1" },
                            relationKey: "works_for",
                            object: { entityId: "e-tavesi" },
                            startMs: 5_000,
                            endMs: 9_000,
                            speakerLabel: "speaker_1",
                            replaces: {
                                factId: "f-acme",
                                object: { entityId: "e-acme" },
                            },
                        },
                    }),
                ],
            },
            "PATCH /api/recordings/rec-1/review/items/i-speaker?source=riffado":
                {
                    version: 1,
                },
        });
        render(
            <LearnReview recordingId="rec-1" source="riffado" turns={TURNS} />,
        );
        fireEvent.click(
            await screen.findByRole("button", { name: "Review (2)" }),
        );
        const fact = screen.getByRole("checkbox", {
            name: /speaker_1 — works_for — Tavesi/,
        }) as HTMLInputElement;
        expect(fact.disabled).toBe(true);
        expect(screen.getByText("replaces Acme")).toBeTruthy();
        fireEvent.click(
            screen.getByRole("checkbox", { name: "Accept speaker_1 as Jan" }),
        );
        await waitFor(() => expect(fact.disabled).toBe(false));
        expect(fetch).toHaveBeenCalled();
    });

    it("answers a speaker nobody was proposed for: unknown, or someone else", async () => {
        const nobody = {
            id: "i-nobody",
            kind: "speaker",
            preTicked: false,
            decision: null,
            choice: null,
            version: 0,
            dependsOnLabel: null,
            payload: {
                label: "speaker_2",
                personId: null,
                evidenceMs: [],
                reason: "",
            },
        };
        const fetch = respond({
            "GET /api/recordings/rec-1/review?source=riffado": {
                ...READY,
                items: [nobody],
            },
            "PATCH /api/recordings/rec-1/review/items/i-nobody?source=riffado":
                { version: 1 },
        });
        render(
            <LearnReview recordingId="rec-1" source="riffado" turns={TURNS} />,
        );
        fireEvent.click(
            await screen.findByRole("button", { name: "Review (1)" }),
        );
        const accept = screen.getByRole("checkbox", {
            name: "Accept speaker_2 as ?",
        }) as HTMLInputElement;
        expect(accept.disabled).toBe(true);
        expect(
            screen.getByRole("button", { name: "Someone else…" }),
        ).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Unknown" }));
        await waitFor(() =>
            expect(fetch).toHaveBeenCalledWith(
                "/api/recordings/rec-1/review/items/i-nobody?source=riffado",
                expect.objectContaining({
                    body: JSON.stringify({
                        decision: "accepted",
                        version: 0,
                        choice: { unknown: true },
                    }),
                }),
            ),
        );
    });

    it("follows a run it found learning until its review is ready", async () => {
        let calls = 0;
        const fetch = vi.fn(async () => {
            calls++;
            return Response.json(
                calls < 3
                    ? {
                          ...READY,
                          run: { id: "run-1", status: "running" },
                          items: [],
                      }
                    : READY,
            );
        });
        vi.stubGlobal("fetch", fetch);
        render(
            <LearnReview
                recordingId="rec-1"
                source="riffado"
                turns={TURNS}
                pollMs={5}
            />,
        );
        expect(
            await screen.findByRole("button", { name: "Review (2)" }),
        ).toBeTruthy();
    });

    it("says which items it could not apply, and why, in the reader's words", async () => {
        respond({
            "GET /api/recordings/rec-1/review?source=riffado": READY,
            "POST /api/recordings/rec-1/review/finish?source=riffado": {
                status: "finished",
                applied: 1,
                dismissed: 0,
                skipped: [
                    {
                        itemId: "i-fact",
                        code: "speaker_not_named",
                        reason: "Its speaker is not named yet",
                    },
                ],
            },
        });
        render(
            <LearnReview recordingId="rec-1" source="riffado" turns={TURNS} />,
        );
        fireEvent.click(
            await screen.findByRole("button", { name: "Review (2)" }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Finish review" }));
        await waitFor(() =>
            expect(toast.warning).toHaveBeenCalledWith(
                "Jan — leads — Orion: its speaker is not named yet",
            ),
        );
    });

    it("offers the organization account one thing to do with a phrase: make it the Organization's", async () => {
        respond({
            "GET /api/recordings/rec-1/review?source=riffado&view=org": {
                ...READY,
                items: [
                    {
                        id: "i-phrase",
                        kind: "relation_phrase",
                        preTicked: false,
                        decision: null,
                        choice: null,
                        version: 0,
                        dependsOnLabel: null,
                        payload: {
                            phrase: "vede",
                            subject: { personId: "p-jan" },
                            object: { entityId: "e-orion" },
                            objectKind: "entity",
                            startMs: 5_000,
                            endMs: 9_000,
                            count: 1,
                        },
                    },
                ],
            },
        });
        render(
            <LearnReview
                recordingId="rec-1"
                view="org"
                source="riffado"
                turns={TURNS}
            />,
        );
        fireEvent.click(
            await screen.findByRole("button", { name: "Review (1)" }),
        );
        expect(
            screen.getByRole("button", {
                name: "Create as an Organization relation",
            }),
        ).toBeTruthy();
        expect(
            screen.queryByRole("button", { name: "Suggest to Organization" }),
        ).toBeNull();
        expect(
            screen.queryByRole("button", { name: "Create as my relation" }),
        ).toBeNull();
    });

    it("creates a relation of one value when asked", async () => {
        const phrase = {
            id: "i-phrase",
            kind: "relation_phrase",
            preTicked: false,
            decision: null,
            choice: null,
            version: 0,
            dependsOnLabel: null,
            payload: {
                phrase: "pracuje pro",
                subject: { personId: "p-jan" },
                object: { entityId: "e-tavesi" },
                objectKind: "entity",
                startMs: 5_000,
                endMs: 9_000,
                count: 1,
            },
        };
        const fetch = respond({
            "GET /api/recordings/rec-1/review?source=riffado": {
                ...READY,
                items: [phrase],
            },
            "PATCH /api/recordings/rec-1/review/items/i-phrase?source=riffado":
                { version: 1 },
        });
        render(
            <LearnReview recordingId="rec-1" source="riffado" turns={TURNS} />,
        );
        fireEvent.click(
            await screen.findByRole("button", { name: "Review (1)" }),
        );
        fireEvent.change(
            screen.getByRole("combobox", { name: "How many values" }),
            { target: { value: "one" } },
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Create as my relation" }),
        );
        await waitFor(() =>
            expect(fetch).toHaveBeenCalledWith(
                "/api/recordings/rec-1/review/items/i-phrase?source=riffado",
                expect.objectContaining({
                    body: expect.stringContaining('"cardinality":"one"'),
                }),
            ),
        );
    });
});
