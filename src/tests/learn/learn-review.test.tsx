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
    toast: {
        error: vi.fn(),
        success: vi.fn(),
        warning: vi.fn(),
        info: vi.fn(),
    },
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

/** Answers in turn, the last one from then on. */
function inTurn(...bodies: unknown[]) {
    return { inTurn: bodies };
}

function respond(routes: Record<string, unknown>) {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        const key = `${init?.method ?? "GET"} ${url}`;
        const route = routes[key] as { inTurn?: unknown[] } | undefined;
        const body =
            route?.inTurn !== undefined
                ? route.inTurn.length > 1
                    ? route.inTurn.shift()
                    : route.inTurn[0]
                : route;
        if (body === undefined) return new Response("{}", { status: 404 });
        if (body instanceof Error) throw body;
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

    it("lets a fact be ticked once its speaker is named as someone new", async () => {
        const speaker = {
            id: "i-speaker",
            kind: "speaker",
            preTicked: false,
            decision: "accepted",
            choice: { displayName: "Jan Nový" },
            version: 1,
            dependsOnLabel: null,
            payload: {
                label: "speaker_1",
                personId: null,
                evidenceMs: [],
                reason: "",
            },
        };
        const fact = {
            id: "i-fact",
            kind: "fact",
            preTicked: false,
            decision: null,
            choice: null,
            version: 0,
            dependsOnLabel: "speaker_1",
            payload: {
                subject: { speakerLabel: "speaker_1" },
                relationKey: "leads",
                object: { entityId: "e-orion" },
                startMs: 5_000,
                endMs: 9_000,
                speakerLabel: "speaker_1",
            },
        };
        respond({
            "GET /api/recordings/rec-1/review?source=riffado": {
                ...READY,
                items: [speaker, fact],
            },
        });
        render(
            <LearnReview recordingId="rec-1" source="riffado" turns={TURNS} />,
        );
        fireEvent.click(
            await screen.findByRole("button", { name: "Review (2)" }),
        );
        expect(
            (
                screen.getByRole("checkbox", {
                    name: /speaker_1 — leads — Orion/,
                }) as HTMLInputElement
            ).disabled,
        ).toBe(false);
    });

    describe("once a run is over", () => {
        const REVIEW = "GET /api/recordings/rec-1/review?source=riffado";
        const LEARN = "POST /api/recordings/rec-1/learn?source=riffado";
        const NONE = {
            run: null,
            items: [],
            names: {},
            types: {},
            relations: {},
            available: true,
        };
        const FINISHED = {
            ...READY,
            run: { id: "run-1", status: "finished", errorCode: null },
            items: [
                { ...READY.items[0], outcome: "applied" },
                { ...READY.items[1], outcome: "speaker_not_named" },
                {
                    ...READY.items[1],
                    id: "i-rejected",
                    decision: "rejected",
                    outcome: "rejected",
                },
            ],
        };
        const NOTHING = {
            ...NONE,
            run: { id: "run-1", status: "finished", errorCode: null },
            known: { people: 3, things: 0 },
        };

        it("shows what the review did with each item, and offers Re-learn", async () => {
            const fetch = respond({
                [REVIEW]: FINISHED,
                [LEARN]: { runId: "run-2", jobId: null, created: true },
            });
            render(
                <LearnReview
                    recordingId="rec-1"
                    source="riffado"
                    turns={TURNS}
                />,
            );
            fireEvent.click(
                await screen.findByRole("button", { name: "Learned (1)" }),
            );
            expect(screen.getByText(/"Tavesy" → Tavesi/)).toBeTruthy();
            expect(screen.getByText("applied")).toBeTruthy();
            expect(
                screen.getByText("not applied: its speaker is not named yet"),
            ).toBeTruthy();
            expect(screen.getByText("rejected")).toBeTruthy();
            // Read-only: the one checkbox is Re-learn's, not an item's.
            expect(
                screen
                    .getAllByRole("checkbox")
                    .map(
                        (box) =>
                            box.getAttribute("aria-label") ??
                            box.closest("label")?.textContent,
                    ),
            ).toEqual([
                "Re-learn: also propose again what I rejected on this recording",
            ]);

            fireEvent.click(screen.getByRole("button", { name: "Re-learn" }));
            await waitFor(() =>
                expect(fetch).toHaveBeenCalledWith(
                    "/api/recordings/rec-1/learn?source=riffado",
                    { method: "POST" },
                ),
            );
        });

        it("says a run found nothing, and what it had to go on", async () => {
            respond({ [REVIEW]: NOTHING });
            render(
                <LearnReview
                    recordingId="rec-1"
                    source="riffado"
                    turns={TURNS}
                />,
            );
            fireEvent.click(
                await screen.findByRole("button", {
                    name: "Learned: nothing new",
                }),
            );
            expect(
                screen.getByText("Learn found nothing new in this transcript."),
            ).toBeTruthy();
            expect(
                screen.getByText(/It knows 3 people and no things\./),
            ).toBeTruthy();
            expect(
                screen
                    .getByRole("link", { name: "Add people and things" })
                    .getAttribute("href"),
            ).toBe("/almanac/things");
            expect(
                screen.getByRole("button", { name: "Re-learn" }),
            ).toBeTruthy();
        });

        it("says why a run failed, and offers Re-learn", async () => {
            respond({
                [REVIEW]: {
                    ...NONE,
                    run: {
                        id: "run-1",
                        status: "failed",
                        errorCode: "AI_PROVIDER_API_ERROR",
                    },
                },
            });
            render(
                <LearnReview
                    recordingId="rec-1"
                    source="riffado"
                    turns={TURNS}
                />,
            );
            fireEvent.click(
                await screen.findByRole("button", { name: "Learn failed" }),
            );
            expect(
                screen.getByText(
                    /The provider's answer was not one Learn could use/,
                ),
            ).toBeTruthy();
            expect(
                screen.getByRole("button", { name: "Re-learn" }),
            ).toBeTruthy();
        });

        it("still shows a finished review where Learn cannot run now, without Re-learn", async () => {
            respond({ [REVIEW]: { ...FINISHED, available: false } });
            render(
                <LearnReview
                    recordingId="rec-1"
                    source="riffado"
                    turns={TURNS}
                />,
            );
            fireEvent.click(
                await screen.findByRole("button", { name: "Learned (1)" }),
            );
            expect(
                screen.queryByRole("button", { name: "Re-learn" }),
            ).toBeNull();
        });

        it("shows a failed run where Learn cannot run now, without Re-learn", async () => {
            respond({
                [REVIEW]: {
                    ...NONE,
                    available: false,
                    run: { id: "run-1", status: "failed", errorCode: null },
                },
            });
            render(
                <LearnReview
                    recordingId="rec-1"
                    source="riffado"
                    turns={TURNS}
                />,
            );
            fireEvent.click(
                await screen.findByRole("button", { name: "Learn failed" }),
            );
            expect(
                screen.getByText("Learn stopped on an error. Try again."),
            ).toBeTruthy();
            expect(
                screen.queryByRole("button", { name: "Re-learn" }),
            ).toBeNull();
        });

        it.each([
            [
                "every item rejected",
                FINISHED.items.map((item) => ({
                    ...item,
                    decision: "rejected",
                    outcome: "rejected",
                })),
                "Learned: nothing applied",
            ],
            [
                "a review finished before outcomes were kept",
                FINISHED.items.map((item) => ({ ...item, outcome: null })),
                "Learned",
            ],
        ])("counts only what was applied: %s", async (_name, items, label) => {
            respond({ [REVIEW]: { ...FINISHED, items } });
            render(
                <LearnReview
                    recordingId="rec-1"
                    source="riffado"
                    turns={TURNS}
                />,
            );
            expect(
                await screen.findByRole("button", { name: label }),
            ).toBeTruthy();
        });

        it("forgets the recording's rejections before Re-learn, when asked", async () => {
            const fetch = respond({
                [REVIEW]: FINISHED,
                "DELETE /api/recordings/rec-1/review/dismissals": {
                    forgotten: 1,
                },
                [LEARN]: { runId: "run-2", jobId: null, created: true },
            });
            render(
                <LearnReview
                    recordingId="rec-1"
                    source="riffado"
                    turns={TURNS}
                />,
            );
            fireEvent.click(
                await screen.findByRole("button", { name: "Learned (1)" }),
            );
            fireEvent.click(
                screen.getByRole("checkbox", {
                    name: "Re-learn: also propose again what I rejected on this recording",
                }),
            );
            fireEvent.click(screen.getByRole("button", { name: "Re-learn" }));
            await waitFor(() =>
                expect(fetch).toHaveBeenCalledWith(
                    "/api/recordings/rec-1/learn?source=riffado",
                    { method: "POST" },
                ),
            );
            const calls = fetch.mock.calls.map(
                ([url, init]) => `${init?.method ?? "GET"} ${url}`,
            );
            expect(
                calls.indexOf("DELETE /api/recordings/rec-1/review/dismissals"),
            ).toBeLessThan(calls.indexOf(LEARN));
            expect(
                calls.indexOf("DELETE /api/recordings/rec-1/review/dismissals"),
            ).toBeGreaterThan(-1);
        });

        it.each([
            [
                "suggestions to review",
                { ...READY, run: { id: "run-2", status: "ready" } },
                () =>
                    expect(toast.success).toHaveBeenCalledWith(
                        "Learn found 2 suggestions to review",
                    ),
                "Review (2)",
            ],
            [
                "nothing new",
                NOTHING,
                () =>
                    expect(toast.info).toHaveBeenCalledWith(
                        "Learn found nothing new",
                    ),
                "Learned: nothing new",
            ],
            [
                "a transcript changed meanwhile",
                { ...NONE, run: { id: "run-2", status: "superseded" } },
                () =>
                    expect(toast.warning).toHaveBeenCalledWith(
                        "The transcript changed while Learn ran. Run it again.",
                    ),
                "Learn",
            ],
        ])("tells how a run it started went: %s", async (_name, after, told, button) => {
            respond({
                [REVIEW]: inTurn(NONE, after),
                [LEARN]: { runId: "run-2", jobId: null, created: true },
            });
            render(
                <LearnReview
                    recordingId="rec-1"
                    source="riffado"
                    turns={TURNS}
                />,
            );
            fireEvent.click(
                await screen.findByRole("button", { name: "Learn" }),
            );
            await waitFor(told);
            expect(
                await screen.findByRole("button", { name: button }),
            ).toBeTruthy();
        });
    });

    describe("new records", () => {
        const item = (overrides: Record<string, unknown>) => ({
            preTicked: false,
            decision: null,
            choice: null,
            version: 0,
            dependsOnLabel: null,
            outcome: null,
            ...overrides,
        });
        const records = [
            item({
                id: "i-veltrix",
                kind: "new_record",
                payload: {
                    ref: "n1",
                    kind: "entity",
                    typeKey: "organization",
                    name: "Veltrix",
                    evidenceMs: [0],
                    reason: "the client",
                },
            }),
            item({
                id: "i-petra",
                kind: "new_record",
                payload: {
                    ref: "n2",
                    kind: "person",
                    typeKey: null,
                    name: "Petra Kolářová",
                    evidenceMs: [5_000],
                    reason: "introduces herself",
                    speakerLabel: "speaker_1",
                },
            }),
            item({
                id: "i-speaker",
                kind: "speaker",
                payload: {
                    label: "speaker_1",
                    personId: null,
                    newRef: "n2",
                    evidenceMs: [5_000],
                    reason: "introduces herself",
                },
            }),
            item({
                id: "i-works",
                kind: "fact",
                payload: {
                    subject: { newRef: "n2" },
                    relationKey: "works_for",
                    object: { newRef: "n1" },
                    startMs: 5_000,
                    endMs: 9_000,
                    speakerLabel: null,
                },
            }),
        ];
        const entityTypes = [
            { key: "organization", label: "Organization" },
            { key: "product", label: "Product or system" },
        ];

        it("lists them first, and holds what refers to one until it is ticked", async () => {
            const fetch = respond({
                "GET /api/recordings/rec-1/review?source=riffado": {
                    ...READY,
                    entityTypes,
                    items: records,
                },
                "PATCH /api/recordings/rec-1/review/items/i-veltrix?source=riffado":
                    { version: 1 },
                "PATCH /api/recordings/rec-1/review/items/i-petra?source=riffado":
                    { version: 1 },
            });
            render(
                <LearnReview
                    recordingId="rec-1"
                    source="riffado"
                    turns={TURNS}
                />,
            );
            fireEvent.click(
                await screen.findByRole("button", { name: "Review (4)" }),
            );
            const headings = screen
                .getAllByRole("heading", { level: 3 })
                .map((heading) => heading.textContent);
            expect(headings[0]).toBe("New in the Almanac");
            const fact = screen.getByRole("checkbox", {
                name: "Petra Kolářová — works_for — Veltrix",
            }) as HTMLInputElement;
            const speaker = screen.getByRole("checkbox", {
                name: "Accept speaker_1 as Petra Kolářová",
            }) as HTMLInputElement;
            expect(fact.disabled).toBe(true);
            expect(speaker.disabled).toBe(true);
            expect(
                screen.getByText(
                    "waits for Petra Kolářová, Veltrix to be added",
                ),
            ).toBeTruthy();

            fireEvent.click(
                screen.getByRole("checkbox", {
                    name: "Add Veltrix to the Almanac",
                }),
            );
            await waitFor(() =>
                expect(
                    screen.getByText("waits for Petra Kolářová to be added"),
                ).toBeTruthy(),
            );
            expect(fact.disabled).toBe(true);
            fireEvent.click(
                screen.getByRole("checkbox", {
                    name: "Add Petra Kolářová to the Almanac",
                }),
            );
            await waitFor(() => expect(fact.disabled).toBe(false));
            expect(speaker.disabled).toBe(false);
            expect(fetch).toHaveBeenCalledWith(
                "/api/recordings/rec-1/review/items/i-petra?source=riffado",
                expect.objectContaining({ method: "PATCH" }),
            );
        });

        it("keeps a name and a type the reviewer corrects at once, one save after the other, ticking the record", async () => {
            const fetch = respond({
                "GET /api/recordings/rec-1/review?source=riffado": {
                    ...READY,
                    entityTypes,
                    items: [records[0]],
                },
                "PATCH /api/recordings/rec-1/review/items/i-veltrix?source=riffado":
                    inTurn({ version: 1 }, { version: 2 }),
            });
            render(
                <LearnReview
                    recordingId="rec-1"
                    source="riffado"
                    turns={TURNS}
                />,
            );
            fireEvent.click(
                await screen.findByRole("button", { name: "Review (1)" }),
            );
            const name = screen.getByRole("textbox", { name: "Name" });
            fireEvent.change(name, { target: { value: "Veltrix a.s." } });
            // The type changed at once, before the name's save came back.
            fireEvent.blur(name);
            fireEvent.change(
                screen.getByRole("combobox", { name: "Kind of thing" }),
                { target: { value: "product" } },
            );
            await waitFor(() =>
                expect(
                    fetch.mock.calls.filter(
                        ([, init]) => init?.method === "PATCH",
                    ),
                ).toHaveLength(2),
            );
            const bodies = fetch.mock.calls
                .filter(([, init]) => init?.method === "PATCH")
                .map(([, init]) => JSON.parse(String(init?.body)));
            expect(bodies).toEqual([
                {
                    decision: "accepted",
                    version: 0,
                    choice: { name: "Veltrix a.s.", typeKey: "organization" },
                },
                {
                    decision: "accepted",
                    version: 1,
                    choice: { name: "Veltrix a.s.", typeKey: "product" },
                },
            ]);
        });

        it("keeps the type just chosen when the name is saved before that type's save comes back", async () => {
            const fetch = respond({
                "GET /api/recordings/rec-1/review?source=riffado": {
                    ...READY,
                    entityTypes,
                    items: [records[0]],
                },
                "PATCH /api/recordings/rec-1/review/items/i-veltrix?source=riffado":
                    inTurn({ version: 1 }, { version: 2 }),
            });
            render(
                <LearnReview
                    recordingId="rec-1"
                    source="riffado"
                    turns={TURNS}
                />,
            );
            fireEvent.click(
                await screen.findByRole("button", { name: "Review (1)" }),
            );
            fireEvent.change(
                screen.getByRole("combobox", { name: "Kind of thing" }),
                { target: { value: "product" } },
            );
            const name = screen.getByRole("textbox", { name: "Name" });
            fireEvent.change(name, { target: { value: "Veltrix a.s." } });
            fireEvent.blur(name);
            await waitFor(() =>
                expect(
                    fetch.mock.calls.filter(
                        ([, init]) => init?.method === "PATCH",
                    ),
                ).toHaveLength(2),
            );
            const choices = fetch.mock.calls
                .filter(([, init]) => init?.method === "PATCH")
                .map(([, init]) => JSON.parse(String(init?.body)).choice);
            expect(choices).toEqual([
                { name: "Veltrix", typeKey: "product" },
                { name: "Veltrix a.s.", typeKey: "product" },
            ]);
        });

        it("goes on saving an item after one of its saves failed", async () => {
            const fetch = respond({
                "GET /api/recordings/rec-1/review?source=riffado": {
                    ...READY,
                    entityTypes,
                    items: [records[0]],
                },
                "PATCH /api/recordings/rec-1/review/items/i-veltrix?source=riffado":
                    inTurn(new TypeError("offline"), { version: 1 }),
            });
            render(
                <LearnReview
                    recordingId="rec-1"
                    source="riffado"
                    turns={TURNS}
                />,
            );
            fireEvent.click(
                await screen.findByRole("button", { name: "Review (1)" }),
            );
            fireEvent.click(
                screen.getByRole("checkbox", {
                    name: "Add Veltrix to the Almanac",
                }),
            );
            fireEvent.change(
                screen.getByRole("combobox", { name: "Kind of thing" }),
                { target: { value: "product" } },
            );
            await waitFor(() =>
                expect(
                    fetch.mock.calls.filter(
                        ([, init]) => init?.method === "PATCH",
                    ),
                ).toHaveLength(2),
            );
        });

        it("rejects one outright, for every recording, and takes that back", async () => {
            const fetch = respond({
                "GET /api/recordings/rec-1/review?source=riffado": {
                    ...READY,
                    entityTypes,
                    items: [records[0]],
                },
                "PATCH /api/recordings/rec-1/review/items/i-veltrix?source=riffado":
                    inTurn({ version: 1 }, { version: 2 }),
            });
            render(
                <LearnReview
                    recordingId="rec-1"
                    source="riffado"
                    turns={TURNS}
                />,
            );
            fireEvent.click(
                await screen.findByRole("button", { name: "Review (1)" }),
            );
            const never = screen.getByRole("button", {
                name: "Never propose it",
            });
            expect(never.getAttribute("aria-pressed")).toBe("false");
            fireEvent.click(never);
            await waitFor(() =>
                expect(never.getAttribute("aria-pressed")).toBe("true"),
            );
            fireEvent.click(never);
            await waitFor(() =>
                expect(never.getAttribute("aria-pressed")).toBe("false"),
            );
            const decisions = fetch.mock.calls
                .filter(([, init]) => init?.method === "PATCH")
                .map(([, init]) => JSON.parse(String(init?.body)).decision);
            expect(decisions).toEqual(["rejected", null]);
        });

        it("offers the known record a name is close to, in one click", async () => {
            const fetch = respond({
                "GET /api/recordings/rec-1/review?source=riffado": inTurn({
                    ...READY,
                    entityTypes,
                    items: [
                        {
                            ...records[0],
                            payload: {
                                ...(
                                    records[0] as unknown as { payload: object }
                                ).payload,
                                maybe: { entityId: "e-tavesi" },
                            },
                        },
                    ],
                }),
                "PATCH /api/recordings/rec-1/review/items/i-veltrix?source=riffado":
                    { version: 1 },
            });
            render(
                <LearnReview
                    recordingId="rec-1"
                    source="riffado"
                    turns={TURNS}
                />,
            );
            fireEvent.click(
                await screen.findByRole("button", { name: "Review (1)" }),
            );
            expect(
                screen.getByText("Maybe it is Tavesi, misheard?"),
            ).toBeTruthy();
            fireEvent.click(
                screen.getByRole("button", { name: "Yes, it is Tavesi" }),
            );
            await waitFor(() =>
                expect(fetch).toHaveBeenCalledWith(
                    "/api/recordings/rec-1/review/items/i-veltrix?source=riffado",
                    expect.objectContaining({
                        body: JSON.stringify({
                            decision: "accepted",
                            version: 0,
                            choice: { entityId: "e-tavesi" },
                        }),
                    }),
                ),
            );
        });

        it("drops the first-name note once the name is a known person", async () => {
            const honza = item({
                id: "i-honza",
                kind: "new_record",
                payload: {
                    ref: "n3",
                    kind: "person",
                    typeKey: null,
                    name: "Honza",
                    evidenceMs: [1000],
                    reason: "Named in passing.",
                    onlyFirstName: true,
                    maybe: { personId: "p-jan" },
                },
            });
            respond({
                "GET /api/recordings/rec-1/review?source=riffado": inTurn(
                    { ...READY, entityTypes, items: [honza] },
                    {
                        ...READY,
                        entityTypes,
                        items: [
                            {
                                ...honza,
                                decision: "accepted",
                                choice: { personId: "p-jan" },
                                version: 1,
                            },
                        ],
                    },
                ),
                "PATCH /api/recordings/rec-1/review/items/i-honza?source=riffado":
                    { version: 1 },
            });
            render(
                <LearnReview
                    recordingId="rec-1"
                    source="riffado"
                    turns={TURNS}
                />,
            );
            fireEvent.click(
                await screen.findByRole("button", { name: "Review (1)" }),
            );
            expect(
                screen.getByText("Only a first name: add the surname."),
            ).toBeTruthy();
            fireEvent.click(
                screen.getByRole("button", { name: "Yes, it is Jan" }),
            );
            await screen.findByText("Honza is Jan, in the Almanac");
            expect(
                screen.queryByText("Only a first name: add the surname."),
            ).toBeNull();
        });

        it("shows what the finished review did with them", async () => {
            respond({
                "GET /api/recordings/rec-1/review?source=riffado": {
                    ...READY,
                    run: { id: "run-1", status: "finished" },
                    entityTypes,
                    items: [
                        {
                            ...records[0],
                            decision: "rejected",
                            outcome: "rejected",
                        },
                        {
                            ...records[3],
                            decision: "accepted",
                            outcome: "record_not_added",
                        },
                    ],
                },
            });
            render(
                <LearnReview
                    recordingId="rec-1"
                    source="riffado"
                    turns={TURNS}
                />,
            );
            fireEvent.click(
                await screen.findByRole("button", {
                    name: "Learned: nothing applied",
                }),
            );
            expect(screen.getByText("New in the Almanac")).toBeTruthy();
            expect(screen.getByText(/Veltrix \(Organization\)/)).toBeTruthy();
            expect(
                screen.getByText(
                    "not applied: a person or thing it needs was not added",
                ),
            ).toBeTruthy();
        });
    });
});
