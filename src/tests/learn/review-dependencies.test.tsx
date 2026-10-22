// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearnWidget } from "@/components/learn/learn-widget";

vi.mock("sonner", () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

interface Item {
    id: string;
    kind: string;
    preTicked: boolean;
    decision: "accepted" | "rejected" | null;
    choice: Record<string, unknown> | null;
    version: number;
    dependsOnLabel: string | null;
    payload: Record<string, unknown>;
}

function item(
    id: string,
    kind: string,
    payload: Record<string, unknown>,
): Item {
    return {
        id,
        kind,
        payload,
        preTicked: false,
        decision: null,
        choice: null,
        version: 0,
        dependsOnLabel: null,
    };
}

function record(id = "record", ref = "n1", name = "Žárník") {
    return item(id, "new_record", {
        ref,
        name,
        kind: "entity",
        typeKey: "term",
        evidenceMs: [],
        reason: "A term mentioned here",
        evidence: [],
    });
}

function correction(id = "correction") {
    return item(id, "correction", {
        kind: "correct",
        heard: "žarnyk",
        replacement: "Žárník",
        target: { newRef: "n1" },
        anchors: [{ turnIndex: 0, charStart: 0, charEnd: 6 }],
    });
}

function fact() {
    return item("fact", "fact", {
        subject: { newRef: "n1" },
        relationKey: "means",
        object: { literal: "a fictional term" },
        startMs: 0,
    });
}

function serve(items: Item[]) {
    const applied: string[][] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
            const target = items.find((candidate) =>
                url.includes(`/items/${candidate.id}`),
            );
            if (!target) return Response.json({}, { status: 404 });
            const body = JSON.parse(String(init.body)) as {
                decision: Item["decision"];
                choice: Item["choice"];
                version: number;
            };
            expect(body.version).toBe(target.version);
            Object.assign(target, body, { version: body.version + 1 });
            return Response.json({ version: target.version });
        }
        if (init?.method === "POST" && url.includes("/finish")) {
            applied.push(
                items
                    .filter((candidate) => candidate.decision === "accepted")
                    .map((candidate) => candidate.id),
            );
            return Response.json({
                status: "finished",
                applied: applied.at(-1)?.length,
                skipped: [],
            });
        }
        return Response.json({
            run: { id: "run", status: "ready" },
            available: true,
            items,
            names: {},
            types: {},
            relations: { means: "means" },
            entityTypes: [{ key: "term", label: "Term" }],
        });
    });
    vi.stubGlobal("fetch", fetch);
    return { fetch, applied };
}

function box(name: string | RegExp): HTMLInputElement {
    return screen.getByRole("checkbox", { name }) as HTMLInputElement;
}

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("Learn new-record dependencies", () => {
    it.each([
        false,
        true,
    ])("accepts a correction and its record, including section tick-all: %s", async (all) => {
        const { fetch, applied } = serve([
            record(),
            correction(),
            correction("another"),
        ]);
        render(<LearnWidget recordingId="recording" showTrigger={false} />);
        await screen.findByRole("checkbox", {
            name: "Add Žárník to the Almanac",
        });
        const section = screen.getByRole("region", { name: "Corrections" });
        const notes = within(section).getAllByRole("button", {
            name: "Žárník",
        });
        expect(notes).toHaveLength(2);
        expect(
            notes.every(
                (note) =>
                    note.parentElement?.textContent === "also adds Žárník",
            ),
        ).toBe(true);
        fireEvent.click(
            all
                ? box("Tick all: Corrections")
                : within(section).getAllByRole("checkbox", {
                      name: "Correct žarnyk",
                  })[0],
        );
        await waitFor(() =>
            expect(box("Add Žárník to the Almanac").checked).toBe(true),
        );
        await waitFor(() =>
            expect(
                within(section)
                    .getAllByRole("checkbox", { name: "Correct žarnyk" })
                    .filter((input) => (input as HTMLInputElement).checked),
            ).toHaveLength(all ? 2 : 1),
        );
        expect(
            within(section).queryByRole("button", { name: "Žárník" }),
        ).toBeNull();
        const finish = screen.getByRole("button", { name: "Finish review" });
        await waitFor(() => expect(finish).toHaveProperty("disabled", false));
        expect(
            fetch.mock.calls.filter(
                ([url, init]) =>
                    url.includes("/items/record") && init?.method === "PATCH",
            ),
        ).toHaveLength(1);
        fireEvent.click(finish);
        await waitFor(() =>
            expect(applied).toEqual([
                all
                    ? ["record", "correction", "another"]
                    : ["record", "correction"],
            ]),
        );
    });

    it.each([
        "audio",
        "mail",
    ] as const)("accepts a %s fact with all its records and clears it when a record is unticked", async (kind) => {
        const relation = fact();
        relation.payload.object = { newRef: "n2" };
        const { fetch, applied } = serve([
            record(),
            record("other-record", "n2", "Větrníkova"),
            relation,
        ]);
        render(
            <LearnWidget
                recordingId="recording"
                kind={kind}
                showTrigger={false}
            />,
        );
        const checkbox = (await screen.findByRole("checkbox", {
            name: "Žárník — means — Větrníkova",
        })) as HTMLInputElement;
        fireEvent.click(checkbox);
        await waitFor(() => expect(checkbox.checked).toBe(true));
        expect(box("Add Žárník to the Almanac").checked).toBe(true);
        expect(box("Add Větrníkova to the Almanac").checked).toBe(true);
        fireEvent.click(box("Add Žárník to the Almanac"));
        await waitFor(() => expect(checkbox.checked).toBe(false));
        await waitFor(() =>
            expect(
                fetch.mock.calls.some(
                    ([, init]) =>
                        init?.method === "PATCH" &&
                        String(init.body).includes('"decision":"rejected"'),
                ),
            ).toBe(true),
        );
        const finish = screen.getByRole("button", { name: "Finish review" });
        await waitFor(() => expect(finish).toHaveProperty("disabled", false));
        fireEvent.click(finish);
        await waitFor(() => expect(applied).toEqual([["other-record"]]));
    });

    it("tick-all accepts a pre-ticked correction whose record was left unticked", async () => {
        const proposed = correction();
        proposed.preTicked = true;
        serve([record(), proposed]);
        render(<LearnWidget recordingId="recording" showTrigger={false} />);
        const checkbox = await screen.findByRole("checkbox", {
            name: "Correct žarnyk",
        });
        expect(checkbox).toHaveProperty("checked", false);
        expect(screen.getByText("0 of 2 will be applied")).toBeTruthy();
        fireEvent.click(box("Tick all: Corrections"));
        await waitFor(() => expect(checkbox).toHaveProperty("checked", true));
        expect(box("Add Žárník to the Almanac").checked).toBe(true);
        expect(screen.getByText("2 of 2 will be applied")).toBeTruthy();
    });

    it("preserves a record rename still saving when its correction is accepted", async () => {
        const { fetch } = serve([record(), correction()]);
        const respond = fetch.getMockImplementation();
        let release: (() => void) | undefined;
        const pending = new Promise<void>((resolve) => {
            release = resolve;
        });
        let held = false;
        fetch.mockImplementation(async (url, init) => {
            if (
                init?.method === "PATCH" &&
                url.includes("/items/record") &&
                !held
            ) {
                held = true;
                await pending;
            }
            if (!respond) throw new Error("Missing response handler");
            return respond(url, init);
        });
        render(<LearnWidget recordingId="recording" showTrigger={false} />);
        const name = await screen.findByRole("textbox", { name: "Name" });
        fireEvent.change(name, { target: { value: "Žárník Nový" } });
        fireEvent.blur(name);
        await waitFor(() => expect(held).toBe(true));
        fireEvent.click(box("Correct žarnyk"));
        await act(async () => {
            release?.();
        });
        await waitFor(() =>
            expect(box("Add Žárník Nový to the Almanac").checked).toBe(true),
        );
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Finish review" }),
            ).toHaveProperty("disabled", false),
        );
        const choices = fetch.mock.calls
            .filter(
                ([url, init]) =>
                    url.includes("/items/record") && init?.method === "PATCH",
            )
            .map(
                ([, init]) =>
                    (
                        JSON.parse(String(init?.body)) as {
                            choice: Item["choice"];
                        }
                    ).choice,
            );
        expect(choices).toEqual([
            { name: "Žárník Nový", typeKey: "term" },
            { name: "Žárník Nový", typeKey: "term" },
        ]);
        expect(box("Correct žarnyk").checked).toBe(true);
    });

    it.each([
        "audio",
        "mail",
    ] as const)("%s fact tick-all adds dependencies and rejecting a record clears its fact", async (kind) => {
        const { applied } = serve([record(), fact()]);
        render(
            <LearnWidget
                recordingId="recording"
                kind={kind}
                showTrigger={false}
            />,
        );
        const checkbox = await screen.findByRole("checkbox", {
            name: 'Žárník — means — "a fictional term"',
        });
        fireEvent.click(box("Tick all: New facts"));
        await waitFor(() => expect(checkbox).toHaveProperty("checked", true));
        expect(box("Add Žárník to the Almanac").checked).toBe(true);
        fireEvent.click(
            screen.getByRole("button", { name: "Never propose it" }),
        );
        await waitFor(() => expect(checkbox).toHaveProperty("checked", false));
        expect(checkbox.getAttribute("aria-disabled")).toBe("true");
        const finish = screen.getByRole("button", { name: "Finish review" });
        await waitFor(() => expect(finish).toHaveProperty("disabled", false));
        fireEvent.click(finish);
        await waitFor(() => expect(applied).toEqual([[]]));
    });

    it("scrolls to and briefly highlights the required record", async () => {
        serve([record(), correction()]);
        render(<LearnWidget recordingId="recording" showTrigger={false} />);
        const button = await screen.findByRole("button", { name: "Žárník" });
        const target = box("Add Žárník to the Almanac").closest("[id]");
        const scroll = vi.fn();
        Object.defineProperty(target, "scrollIntoView", { value: scroll });
        vi.stubGlobal(
            "matchMedia",
            vi.fn(() => ({ matches: true })),
        );
        vi.useFakeTimers();
        fireEvent.click(button);
        expect(scroll).toHaveBeenCalledWith({
            block: "start",
            behavior: "auto",
        });
        expect(target?.className).toContain("ring-2");
        await act(async () => {
            vi.advanceTimersByTime(1800);
        });
        expect(target?.className).not.toContain("ring-2");
    });

    it("explains a rejected dependency and allows the existing rejection toggle to restore it", async () => {
        const rejected = record();
        rejected.decision = "rejected";
        const { fetch } = serve([rejected, correction()]);
        render(<LearnWidget recordingId="recording" showTrigger={false} />);
        const checkbox = await screen.findByRole("checkbox", {
            name: "Correct žarnyk",
        });
        expect(checkbox.getAttribute("aria-disabled")).toBe("true");
        expect(
            screen.getByRole("button", { name: "Žárník" }).parentElement
                ?.textContent,
        ).toBe(
            "Žárník is rejected. Turn off “Never propose it” for that record, or leave this item unticked.",
        );
        expect(box("Tick all: Corrections").disabled).toBe(true);
        fireEvent.click(checkbox);
        expect(screen.getByRole("alert").textContent).toBe(
            checkbox.getAttribute("title"),
        );
        expect(
            fetch.mock.calls.filter(([, init]) => init?.method === "PATCH"),
        ).toHaveLength(0);
        fireEvent.click(
            screen.getByRole("button", { name: "Never propose it" }),
        );
        await waitFor(() =>
            expect(checkbox.getAttribute("aria-disabled")).toBeNull(),
        );
        fireEvent.click(checkbox);
        await waitFor(() =>
            expect(box("Add Žárník to the Almanac").checked).toBe(true),
        );
        expect(box("Correct žarnyk").checked).toBe(true);
    });

    it("explains a speaker-blocked fact on hover, click and Space without saving it", async () => {
        const speaker = item("speaker", "speaker", {
            label: "speaker_0",
            personId: null,
            reason: "Nobody named",
            evidenceMs: [],
        });
        const relation = fact();
        relation.dependsOnLabel = "speaker_0";
        relation.payload.subject = { speakerLabel: "speaker_0" };
        const { fetch } = serve([speaker, relation]);
        render(<LearnWidget recordingId="recording" showTrigger={false} />);
        const checkbox = await screen.findByRole("checkbox", {
            name: 'Speaker 0 — means — "a fictional term"',
        });
        expect(checkbox.getAttribute("aria-disabled")).toBe("true");
        expect(checkbox.getAttribute("title")).toBe(
            "Name and tick Speaker 0 in Speakers first, or leave this item unticked.",
        );
        expect(screen.queryByRole("alert")).toBeNull();
        fireEvent.keyDown(checkbox, { key: " " });
        expect(screen.getByRole("alert").textContent).toBe(
            checkbox.getAttribute("title"),
        );
        fireEvent.click(checkbox);
        expect(
            fetch.mock.calls.filter(([, init]) => init?.method === "PATCH"),
        ).toHaveLength(0);
    });
});
