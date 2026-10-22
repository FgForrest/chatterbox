// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EntityDetail } from "@/components/people/entity-detail";
import { PersonDetail } from "@/components/people/person-detail";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

beforeEach(() => {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    Element.prototype.scrollIntoView ??= () => {};
});
afterEach(async () => {
    cleanup();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    vi.unstubAllGlobals();
});

describe.each([
    "person",
    "entity",
] as const)("%s duplicate picker access", (kind) => {
    it.each([
        ["member", "org", false],
        ["curator", "org", true],
        ["member", "personal", false],
        ["curator", "personal", false],
    ] as const)("requests ranking for a %s's %s record: %s", async (role, scope, shouldRequest) => {
        const fetch = vi.fn(async (url: string) => {
            if (url.startsWith("/api/knowledge/duplicates"))
                return Response.json({
                    candidates: [],
                    nextCursor: null,
                    limited: false,
                });
            const row = {
                id: "target",
                displayName: "Vemi Ziltor",
                name: "Vemi Ziltor",
                primaryEmail: null,
                scope,
            };
            return Response.json({ people: [row], entities: [row] });
        });
        vi.stubGlobal("fetch", fetch);
        const editing = {
            subject: {
                kind,
                id: "source",
                typeKey: kind === "person" ? "person" : "project",
            },
            relations: [],
            typeLabels: {},
            canCurateOrganization: role === "curator",
        };
        render(
            kind === "person" ? (
                <PersonDetail
                    person={{
                        id: "source",
                        displayName: "Zavi Duspektor",
                        primaryEmail: null,
                        notes: null,
                        scope,
                    }}
                    appearances={[]}
                    canManage
                    editing={editing}
                />
            ) : (
                <EntityDetail
                    entity={{
                        id: "source",
                        name: "Zavi Duspektor",
                        typeKey: "project",
                        typeLabel: "Project",
                        description: null,
                        notes: null,
                        scope,
                    }}
                    facts={[]}
                    otherNames={[]}
                    canManage
                    editing={editing}
                />
            ),
        );
        expect(fetch).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Merge into…" }));
        await screen.findByRole("option", { name: /Vemi Ziltor/ });
        const requests = fetch.mock.calls.filter(([url]) =>
            url.startsWith("/api/knowledge/duplicates"),
        );
        expect(requests).toHaveLength(shouldRequest ? 1 : 0);
        if (shouldRequest) {
            const query = new URL(requests[0][0], "http://localhost")
                .searchParams;
            expect(query.get("kind")).toBe(kind);
            expect(query.get("sourceId")).toBe("source");
        }
    });
});
