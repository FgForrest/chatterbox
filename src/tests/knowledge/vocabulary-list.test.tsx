// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnType } from "@/lib/knowledge/vocabulary";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh, push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { toast } from "sonner";
import { VocabularyList } from "@/components/people/vocabulary-list";

const types: OwnType[] = [
    {
        kind: "relation",
        key: "o_funds",
        label: "funds",
        adoptedFromShare: true,
        uses: 2,
        shape: {
            subjectTypes: ["person"],
            objectTypes: ["project"],
            objectKind: "entity",
            cardinality: "many",
        },
    },
    {
        kind: "entity",
        key: "o_venue",
        label: "venue",
        adoptedFromShare: false,
        uses: 3,
    },
];

const targets = [
    { kind: "relation" as const, key: "leads", label: "leads", core: true },
    { kind: "relation" as const, key: "o_funds", label: "funds", core: false },
    { kind: "entity" as const, key: "project", label: "project", core: true },
    { kind: "entity" as const, key: "o_venue", label: "venue", core: false },
];

function renderList() {
    return render(
        <VocabularyList
            types={types}
            targets={targets}
            entityTypeLabels={{ project: "project", o_venue: "venue" }}
            organization
        />,
    );
}

type Call = { url: string; method: string; body: unknown };

describe("VocabularyList", () => {
    let calls: Call[] = [];
    let respond: (call: Call) => Response = () => Response.json({});

    beforeEach(() => {
        calls = [];
        refresh.mockClear();
        vi.mocked(toast.error).mockClear();
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string, init?: RequestInit) => {
                const call = {
                    url,
                    method: init?.method ?? "GET",
                    body: init?.body ? JSON.parse(String(init.body)) : null,
                };
                calls.push(call);
                return respond(call);
            }),
        );
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("marks what a share brought, with its shape and uses, and keeps it", async () => {
        respond = () => Response.json({ success: true });
        renderList();
        expect(screen.getByText("From a share")).toBeTruthy();
        expect(
            screen.getByText("Relation person → project · 2 facts"),
        ).toBeTruthy();
        expect(screen.getByText("Kind of thing · 3 entities")).toBeTruthy();
        // Only the adopted one has Keep.
        const keep = screen.getAllByRole("button", { name: "Keep" });
        expect(keep).toHaveLength(1);

        fireEvent.click(keep[0] as HTMLElement);
        await waitFor(() => expect(refresh).toHaveBeenCalled());
        expect(calls).toEqual([
            {
                url: "/api/knowledge/types/relation/o_funds",
                method: "PATCH",
                body: { keep: true },
            },
        ]);
    });

    it("says a name is taken as the server says it, keeping the rename open", async () => {
        respond = () =>
            Response.json(
                {
                    error: "A type with this name already exists",
                    code: "CONFLICT",
                    details: { field: "label" },
                },
                { status: 409 },
            );
        renderList();
        fireEvent.click(
            screen.getAllByRole("button", { name: "Rename" })[0] as HTMLElement,
        );
        fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
            target: { value: "venue" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() =>
            expect(toast.error).toHaveBeenCalledWith(
                "A type with this name already exists",
            ),
        );
        expect(refresh).not.toHaveBeenCalled();
        expect(screen.getByRole("textbox", { name: "Name" })).toBeTruthy();
    });

    it("deletes with the count it showed", async () => {
        respond = () => Response.json({ success: true });
        renderList();
        fireEvent.click(screen.getByRole("button", { name: "Delete venue" }));
        expect(
            screen.getByText(/3 entities of this kind will be deleted/),
        ).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Delete" }));
        await waitFor(() => expect(refresh).toHaveBeenCalled());
        expect(calls).toEqual([
            {
                url: "/api/knowledge/types/entity/o_venue",
                method: "DELETE",
                body: { confirmCount: 3 },
            },
        ]);
    });

    it("merges into another type of its kind with the count it read, and again with a new one", async () => {
        let merges = 0;
        respond = (call) => {
            if (call.method === "GET") return Response.json({ count: 1 });
            merges++;
            return merges === 1
                ? Response.json(
                      {
                          error: "changed",
                          code: "CONFLICT",
                          details: { count: 2 },
                      },
                      { status: 409 },
                  )
                : Response.json({ success: true });
        };
        renderList();
        fireEvent.click(
            screen.getAllByRole("button", {
                name: "Merge into…",
            })[0] as HTMLElement,
        );
        const select = screen.getByRole("combobox", { name: "Merge target" });
        // Relations only, not itself.
        expect(
            Array.from((select as HTMLSelectElement).options).map(
                (option) => option.value,
            ),
        ).toEqual(["", "leads"]);
        fireEvent.change(select, { target: { value: "leads" } });
        expect(
            await screen.findByText(
                "1 fact leads does not take will be deleted.",
            ),
        ).toBeTruthy();
        expect(calls[0]).toMatchObject({
            url: "/api/knowledge/types/relation/o_funds?mergeInto=leads",
            method: "GET",
        });

        fireEvent.click(screen.getByRole("button", { name: "Merge" }));
        expect(
            await screen.findByText(
                "2 facts leads does not take will be deleted.",
            ),
        ).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Merge" }));
        await waitFor(() => expect(merges).toBe(2));
        expect(calls.filter((call) => call.method === "POST")).toEqual([
            {
                url: "/api/knowledge/types/relation/o_funds",
                method: "POST",
                body: { mergeInto: "leads", confirmCount: 1 },
            },
            {
                url: "/api/knowledge/types/relation/o_funds",
                method: "POST",
                body: { mergeInto: "leads", confirmCount: 2 },
            },
        ]);
    });
});
