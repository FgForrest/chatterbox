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
import { AlmanacTabs } from "@/components/almanac/almanac-tabs";
import { EntityActions } from "@/components/almanac/entity-actions";
import { FactDialog } from "@/components/almanac/fact-dialog";
import { ImportDialog } from "@/components/almanac/import-dialog";
import { ThingsList } from "@/components/almanac/things-list";
import { PeopleList } from "@/components/people/people-list";

const refresh = vi.fn();
const push = vi.fn();
let pathname = "/almanac";
vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh, push }),
    usePathname: () => pathname,
}));
vi.mock("sonner", () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

// cmdk measures its list and scrolls to the selected item.
globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

type Route =
    | unknown
    | { inTurn: unknown[] }
    | { status: number; body: unknown };

/** Answer each `METHOD url` with its body; `{status, body}` for an error. */
function respond(routes: Record<string, Route>) {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        const key = `${init?.method ?? "GET"} ${url}`;
        let route = routes[key] as Record<string, unknown> | undefined;
        if (route && Array.isArray(route.inTurn)) {
            route = (
                route.inTurn.length > 1 ? route.inTurn.shift() : route.inTurn[0]
            ) as Record<string, unknown>;
        }
        if (route === undefined) return new Response("{}", { status: 404 });
        if (typeof route.status === "number" && "body" in route) {
            return Response.json(route.body, { status: route.status });
        }
        return Response.json(route);
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    pathname = "/almanac";
});

describe("AlmanacTabs", () => {
    it("marks the tab a page belongs to, a person's page under People", () => {
        respond({ "GET /api/learn/pending": { count: 2 } });
        pathname = "/almanac/p-1";
        render(<AlmanacTabs />);
        expect(
            screen
                .getByRole("link", { name: "People" })
                .getAttribute("aria-current"),
        ).toBe("page");
        cleanup();
        pathname = "/almanac/things/e-1";
        render(<AlmanacTabs />);
        expect(
            screen
                .getByRole("link", { name: "Things" })
                .getAttribute("aria-current"),
        ).toBe("page");
    });

    it("counts the reviews waiting", async () => {
        respond({ "GET /api/learn/pending": { count: 2 } });
        render(<AlmanacTabs />);
        expect(
            await screen.findByRole("link", { name: /Review\s*2/ }),
        ).toBeTruthy();
    });
});

describe("ThingsList", () => {
    const THINGS = [
        {
            id: "e-orion",
            name: "Orion",
            typeKey: "project",
            description: "Billing rewrite",
            scope: "personal" as const,
        },
        {
            id: "e-acme",
            name: "Acme",
            typeKey: "organization",
            description: null,
            scope: "org" as const,
            nicknames: ["Akmeho"],
        },
    ];
    const LABELS = { project: "Project", organization: "Organization" };
    const TYPES = [
        { key: "organization", label: "Organization" },
        { key: "project", label: "Project" },
    ];

    it("searches by name or description, and narrows by type", () => {
        render(
            <ThingsList things={THINGS} typeLabels={LABELS} types={TYPES} />,
        );
        expect(screen.getAllByRole("link")).toHaveLength(2);
        fireEvent.change(
            screen.getByRole("textbox", { name: "Search things" }),
            {
                target: { value: "billing" },
            },
        );
        expect(screen.getAllByRole("link")).toHaveLength(1);
        expect(
            screen.getByRole("link", { name: /Orion/ }).getAttribute("href"),
        ).toBe("/almanac/things/e-orion");
        fireEvent.change(
            screen.getByRole("textbox", { name: "Search things" }),
            {
                target: { value: "akmeh" },
            },
        );
        expect(
            screen.getByRole("link", { name: /Acme/ }).getAttribute("href"),
        ).toBe("/almanac/things/e-acme");
        fireEvent.change(
            screen.getByRole("textbox", { name: "Search things" }),
            {
                target: { value: "" },
            },
        );
        fireEvent.change(
            screen.getByRole("combobox", { name: "Kind of thing" }),
            {
                target: { value: "organization" },
            },
        );
        expect(screen.getAllByRole("link")).toHaveLength(1);
        expect(screen.getByText(/Organization · Organization/)).toBeTruthy();
    });

    it("adds a thing with its nicknames", async () => {
        const fetch = respond({
            "POST /api/knowledge/entities": { entity: { id: "e-new" } },
        });
        render(<ThingsList things={[]} typeLabels={LABELS} types={TYPES} />);
        expect(
            screen.getByText("What do your recordings talk about?"),
        ).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Add thing" }));
        fireEvent.change(screen.getByLabelText("Kind of thing"), {
            target: { value: "project" },
        });
        fireEvent.change(screen.getByLabelText("Name"), {
            target: { value: "Atlas" },
        });
        fireEvent.change(
            screen.getByLabelText("Nicknames (optional, separated by commas)"),
            { target: { value: "ATL, Atlasko" } },
        );
        // The form's own button, once it is open.
        fireEvent.click(screen.getByRole("button", { name: "Add thing" }));
        await waitFor(() =>
            expect(fetch).toHaveBeenCalledWith(
                "/api/knowledge/entities",
                expect.objectContaining({
                    body: JSON.stringify({
                        typeKey: "project",
                        name: "Atlas",
                        description: null,
                        nicknames: ["ATL", "Atlasko"],
                    }),
                }),
            ),
        );
        await waitFor(() => expect(refresh).toHaveBeenCalled());
    });
});

describe("PeopleList", () => {
    it("searches by name, email or nickname", () => {
        render(
            <PeopleList
                people={[
                    {
                        id: "p-vilem",
                        displayName: "Vilém Brázda",
                        primaryEmail: "vilem@example.test",
                        recordingCount: 0,
                        lastSeen: null,
                        nicknames: ["Vilda"],
                    },
                    {
                        id: "p-jana",
                        displayName: "Jana Malá",
                        primaryEmail: null,
                        recordingCount: 0,
                        lastSeen: null,
                    },
                ]}
            />,
        );
        const search = screen.getByRole("textbox", { name: "Search people" });
        fireEvent.change(search, { target: { value: "vild" } });
        expect(screen.getByText("Vilém Brázda")).toBeTruthy();
        expect(screen.queryByText("Jana Malá")).toBeNull();
        fireEvent.change(search, { target: { value: "example.test" } });
        expect(screen.getByText("Vilém Brázda")).toBeTruthy();
    });
});

describe("EntityActions", () => {
    const ENTITY = {
        id: "e-orion",
        name: "Orion",
        typeKey: "project",
        description: null,
        notes: null,
        scope: "personal" as const,
    };

    it("says why a type change was refused, and keeps the dialog open", async () => {
        respond({
            "PATCH /api/knowledge/entities/e-orion": {
                status: 409,
                body: {
                    error: "A fact about it would no longer fit its relation",
                    code: "CONFLICT",
                },
            },
        });
        render(
            <EntityActions
                entity={ENTITY}
                canManage
                types={[
                    { key: "project", label: "Project" },
                    { key: "term", label: "Term" },
                ]}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: "Change type" }));
        fireEvent.change(
            screen.getByRole("combobox", { name: "Kind of thing" }),
            {
                target: { value: "term" },
            },
        );
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() =>
            expect(toast.error).toHaveBeenCalledWith(
                "A fact about it would no longer fit its relation",
            ),
        );
        expect(refresh).not.toHaveBeenCalled();
    });

    it("names the relation of the fact that blocks a type change", async () => {
        respond({
            "PATCH /api/knowledge/entities/e-orion": {
                status: 409,
                body: {
                    error: "A fact about it would no longer fit its relation",
                    code: "CONFLICT",
                    details: { factId: "f-1", relationKey: "leads" },
                },
            },
        });
        render(
            <EntityActions
                entity={ENTITY}
                canManage
                types={[
                    { key: "project", label: "Project" },
                    { key: "term", label: "Term" },
                ]}
                relationLabels={{ leads: "leads" }}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: "Change type" }));
        fireEvent.change(
            screen.getByRole("combobox", { name: "Kind of thing" }),
            { target: { value: "term" } },
        );
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() =>
            expect(toast.error).toHaveBeenCalledWith(
                "A fact “leads” about it would no longer fit. Change or erase it first.",
            ),
        );
    });

    it("merges into a thing of its type, the Organization's only for an Organization thing", async () => {
        const fetch = respond({
            "GET /api/knowledge/entities?typeKey=project": {
                entities: [
                    { id: "e-orion", name: "Orion", scope: "org" },
                    { id: "e-own", name: "Orion (mine)", scope: "personal" },
                    { id: "e-shared", name: "Orion Co", scope: "org" },
                ],
            },
            "POST /api/knowledge/entities/e-orion": {
                entity: { id: "e-shared" },
            },
        });
        render(
            <EntityActions
                entity={{ ...ENTITY, scope: "org" }}
                canManage
                types={[]}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: "Merge into…" }));
        await screen.findByRole("option", { name: /Orion Co/ });
        expect(screen.queryByRole("option", { name: /mine/ })).toBeNull();
        fireEvent.change(
            screen.getByRole("combobox", { name: "Merge target" }),
            {
                target: { value: "e-shared" },
            },
        );
        fireEvent.click(screen.getByRole("button", { name: "Merge" }));
        await waitFor(() =>
            expect(push).toHaveBeenCalledWith("/almanac/things/e-shared"),
        );
        expect(fetch).toHaveBeenCalledWith(
            "/api/knowledge/entities/e-orion",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ mergeIntoId: "e-shared" }),
            }),
        );
    });

    it("offers a member only their own notes on an Organization thing", async () => {
        const fetch = respond({
            "PATCH /api/knowledge/entities/e-orion": { entity: {} },
        });
        render(
            <EntityActions
                entity={{ ...ENTITY, scope: "org" }}
                canManage={false}
                types={[]}
            />,
        );
        expect(screen.queryByRole("button", { name: "Erase" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Your notes" }));
        fireEvent.change(screen.getByRole("textbox", { name: "Your notes" }), {
            target: { value: "Ask Petra first" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() =>
            expect(fetch).toHaveBeenCalledWith(
                "/api/knowledge/entities/e-orion",
                expect.objectContaining({
                    body: JSON.stringify({ description: "Ask Petra first" }),
                }),
            ),
        );
    });
});

describe("FactDialog", () => {
    const RELATIONS = [
        {
            key: "works_for",
            label: "works for",
            subjectTypes: ["person"],
            objectTypes: ["organization"],
            objectKind: "entity" as const,
            cardinality: "one" as const,
        },
        {
            key: "has_role",
            label: "has the role",
            subjectTypes: ["person"],
            objectTypes: [],
            objectKind: "literal" as const,
            cardinality: "many" as const,
        },
        {
            key: "means",
            label: "means",
            subjectTypes: ["term"],
            objectTypes: [],
            objectKind: "literal" as const,
            cardinality: "one" as const,
        },
    ];

    it("offers only relations that take the subject, picks the other side, and asks before replacing its value", async () => {
        const fetch = respond({
            "GET /api/people": { people: [] },
            "GET /api/knowledge/entities": {
                entities: [
                    {
                        id: "e-acme",
                        name: "Acme",
                        typeKey: "organization",
                        scope: "org",
                    },
                    {
                        id: "e-orion",
                        name: "Orion",
                        typeKey: "project",
                        scope: "personal",
                    },
                ],
            },
            "POST /api/knowledge/facts": {
                inTurn: [
                    {
                        status: 409,
                        body: {
                            error: "The fact changed; reload",
                            code: "CONFLICT",
                            details: { currentFactId: "f-old" },
                        },
                    },
                    { id: "f-new" },
                ],
            },
        });
        const onOpenChange = vi.fn();
        render(
            <FactDialog
                open
                onOpenChange={onOpenChange}
                subject={{ kind: "person", id: "p-jan", typeKey: "person" }}
                relations={RELATIONS}
                typeLabels={{ organization: "Organization" }}
            />,
        );
        const relation = screen.getByRole("combobox", { name: "Relation" });
        expect(
            [...relation.querySelectorAll("option")].map((o) => o.textContent),
        ).toEqual(["works for", "has the role"]);
        // Only organizations work for anyone.
        fireEvent.click(await screen.findByRole("option", { name: /Acme/ }));
        expect(screen.queryByRole("option", { name: /Orion/ })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await screen.findByText(/holds one value at a time/);
        fireEvent.click(screen.getByRole("button", { name: "Replace" }));
        await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
        expect(fetch).toHaveBeenLastCalledWith(
            "/api/knowledge/facts",
            expect.objectContaining({
                body: JSON.stringify({
                    subject: { personId: "p-jan" },
                    relationKey: "works_for",
                    object: { entityId: "e-acme" },
                    expectedCurrentFactId: "f-old",
                }),
            }),
        );
        expect(refresh).toHaveBeenCalled();
    });

    it("changes a fact's text in place", async () => {
        const fetch = respond({
            "PUT /api/knowledge/facts/f-1": { id: "f-2" },
        });
        render(
            <FactDialog
                open
                onOpenChange={vi.fn()}
                subject={{ kind: "person", id: "p-jan", typeKey: "person" }}
                relations={RELATIONS}
                typeLabels={{}}
                editing={{
                    factId: "f-1",
                    relationKey: "has_role",
                    other: { kind: "literal", text: "tester" },
                }}
            />,
        );
        expect(
            (
                screen.getByRole("combobox", {
                    name: "Relation",
                }) as HTMLSelectElement
            ).disabled,
        ).toBe(true);
        fireEvent.change(screen.getByRole("textbox", { name: "Text" }), {
            target: { value: "product owner" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() =>
            expect(fetch).toHaveBeenCalledWith(
                "/api/knowledge/facts/f-1",
                expect.objectContaining({
                    method: "PUT",
                    body: JSON.stringify({
                        object: { literal: "product owner" },
                    }),
                }),
            ),
        );
    });
});

describe("FactDialog, a fact changed meanwhile", () => {
    it("says so and shows it as it is now, instead of asking to replace it", async () => {
        respond({
            "PUT /api/knowledge/facts/f-1": {
                status: 409,
                body: {
                    error: "The fact changed; reload",
                    code: "CONFLICT",
                    details: { currentFactId: "f-9" },
                },
            },
        });
        const onOpenChange = vi.fn();
        render(
            <FactDialog
                open
                onOpenChange={onOpenChange}
                subject={{ kind: "person", id: "p-jan", typeKey: "person" }}
                relations={[
                    {
                        key: "has_role",
                        label: "has the role",
                        subjectTypes: ["person"],
                        objectTypes: [],
                        objectKind: "literal",
                        cardinality: "one",
                    },
                ]}
                typeLabels={{}}
                editing={{
                    factId: "f-1",
                    relationKey: "has_role",
                    other: { kind: "literal", text: "tester" },
                }}
            />,
        );
        fireEvent.change(screen.getByRole("textbox", { name: "Text" }), {
            target: { value: "lead" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
        expect(toast.error).toHaveBeenCalledWith(
            "This fact changed meanwhile. Here it is as it is now.",
        );
        expect(screen.queryByText(/holds one value at a time/)).toBeNull();
        expect(refresh).toHaveBeenCalled();
    });
});

describe("ImportDialog", () => {
    it("previews each name, then imports", async () => {
        const preview = {
            rows: [
                {
                    line: 1,
                    name: "Orion",
                    typeKey: "product",
                    typeText: "product",
                    nicknames: ["ORN"],
                    status: "create",
                },
                {
                    line: 2,
                    name: "Mars",
                    typeKey: null,
                    typeText: "planet",
                    nicknames: [],
                    status: "unknown_type",
                },
            ],
            problems: [{ line: 3, text: "oops" }],
            created: 0,
            nicknamesAdded: 0,
            applied: false,
        };
        const fetch = respond({
            "POST /api/knowledge/import": {
                inTurn: [
                    preview,
                    {
                        ...preview,
                        created: 1,
                        nicknamesAdded: 1,
                        applied: true,
                    },
                ],
            },
        });
        const onOpenChange = vi.fn();
        render(
            <ImportDialog
                open
                onOpenChange={onOpenChange}
                typeLabels={{ product: "Product or system" }}
            />,
        );
        fireEvent.change(
            screen.getByRole("textbox", { name: "List to import" }),
            {
                target: { value: "product: Orion (ORN)\nplanet: Mars\noops" },
            },
        );
        fireEvent.click(screen.getByRole("button", { name: "Preview" }));
        expect(await screen.findByText("will be added")).toBeTruthy();
        expect(screen.getByText("unknown type")).toBeTruthy();
        expect(screen.getByText("Lines not understood: 3")).toBeTruthy();
        expect(
            screen
                .getByRole("link", { name: "Vocabulary" })
                .getAttribute("href"),
        ).toBe("/almanac/vocabulary");
        fireEvent.click(screen.getByRole("button", { name: "Import" }));
        await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
        expect(fetch).toHaveBeenLastCalledWith(
            "/api/knowledge/import",
            expect.objectContaining({
                body: JSON.stringify({
                    text: "product: Orion (ORN)\nplanet: Mars\noops",
                    dryRun: false,
                }),
            }),
        );
        expect(toast.success).toHaveBeenCalledWith(
            "Imported: 1 record added, 1 nickname given",
        );
    });
});
