// @vitest-environment jsdom
import {
    act,
    cleanup,
    createEvent,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { createElement } from "react";
import type { TranslationValues } from "use-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { AgendaBody } from "@/components/meetings/agenda-body";
import { OutlineEditor } from "@/components/meetings/outline-editor";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import { moveAgendaPoint } from "@/lib/meetings/point-order";
import {
    agendaTextBase64,
    createAgendaTextDoc,
} from "@/lib/meetings/text-model";
import { at, detail, point } from "../meetings/ui-fixtures";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("next-intl", () => ({
    useExtracted: () => (text: string, values?: TranslationValues) =>
        translatedSourceMessage("en", text, values),
    useLocale: () => "en",
    useFormatter: () => ({ dateTime: (value: Date) => value.toISOString() }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
beforeEach(() => {
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
});

it.each([
    "queued",
    "running",
] as const)("shows a reloaded %s suggestion job in its section without stealing focus or scrolling", (state) => {
    const server = detail({
        aiSuggestions: { available: true, reason: null, job: { state } },
    });
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(server)),
    );
    render(
        createElement(AgendaBody, {
            id: "agenda",
            initial: server,
            userId: "owner",
        }),
        { wrapper: ConfirmDialogProvider },
    );
    const section = screen.getByRole("region", {
        name: "Suggestions from activity since the last meeting",
    });
    expect(within(section).getByRole("status").textContent).toContain(
        state === "queued"
            ? "Suggestions queued…"
            : "Analyzing previous meetings and tasks…",
    );
    expect(section.getAttribute("aria-busy")).toBe("true");
    expect(section.querySelector(".motion-safe\\:animate-spin")).toBeTruthy();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
});

it.each([
    false,
    true,
])("reveals a locally queued job immediately and scrolls/focuses it once (reduced motion: %s)", async (reduced) => {
    vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({ matches: reduced })),
    );
    let server = detail();
    let complete: (response: Response) => void = () => {};
    vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
            if (init?.method === "POST")
                return new Promise<Response>((resolve) => {
                    complete = resolve;
                });
            return Response.json(server);
        }),
    );
    render(
        createElement(AgendaBody, {
            id: "agenda",
            initial: server,
            userId: "owner",
        }),
        { wrapper: ConfirmDialogProvider },
    );
    fireEvent.click(screen.getByRole("button", { name: "Suggest points" }));
    await act(async () => {});
    const section = screen.getByRole("region", {
        name: "Suggestions from activity since the last meeting",
    });
    expect(within(section).getByRole("status").textContent).toContain(
        "Suggestions queued…",
    );
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledExactlyOnceWith({
        behavior: reduced ? "instant" : "smooth",
        block: "nearest",
    });
    expect(document.activeElement).toBe(within(section).getByRole("heading"));
    server = {
        ...server,
        aiSuggestions: { ...server.aiSuggestions, job: { state: "running" } },
    };
    await act(async () => complete(Response.json({ success: true })));
    expect(within(section).getByRole("status").textContent).toContain(
        "Analyzing previous meetings and tasks…",
    );
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledOnce();
    server = {
        ...server,
        aiSuggestions: { ...server.aiSuggestions, job: { state: null } },
        suggestions: [
            {
                id: "ai",
                agendaId: "agenda",
                userId: "owner",
                kind: "ai",
                state: "open",
                text: "Review the plan",
                parentPointId: null,
                originPointId: null,
                createdByUserId: "owner",
                sources: { itemIds: [], taskIds: [] },
                createdAt: at,
                updatedAt: at,
            },
        ],
    };
    await act(async () =>
        window.dispatchEvent(
            new CustomEvent("agenda-text-saved", { detail: "agenda" }),
        ),
    );
    expect(within(section).getByText("Review the plan")).toBeTruthy();
    expect(
        within(section).queryByText("Analyzing previous meetings and tasks…"),
    ).toBeNull();
    expect(section.getAttribute("aria-busy")).toBe("false");
    const announcement = screen.getByText("Point suggestions are ready.");
    expect(announcement.closest('[aria-live="polite"]')).toBeTruthy();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledOnce();
});

it("shows failure and retry in the same suggestion section", async () => {
    let server = detail({
        aiSuggestions: {
            available: true,
            reason: null,
            job: { state: "running" },
        },
    });
    vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
            if (init?.method === "POST")
                server = {
                    ...server,
                    aiSuggestions: {
                        ...server.aiSuggestions,
                        job: { state: "queued" },
                    },
                };
            return Response.json(server);
        }),
    );
    render(
        createElement(AgendaBody, {
            id: "agenda",
            initial: server,
            userId: "owner",
        }),
        { wrapper: ConfirmDialogProvider },
    );
    const section = screen.getByRole("region", {
        name: "Suggestions from activity since the last meeting",
    });
    server = {
        ...server,
        aiSuggestions: {
            ...server.aiSuggestions,
            job: { state: "failed", errorCode: "AI_PROVIDER_API_ERROR" },
        },
    };
    await act(async () =>
        window.dispatchEvent(
            new CustomEvent("agenda-text-saved", { detail: "agenda" }),
        ),
    );
    expect(within(section).getByRole("alert").textContent).toContain(
        "The provider returned invalid agenda suggestions. Try again.",
    );
    await act(async () =>
        fireEvent.click(
            within(section).getByRole("button", { name: "Try again" }),
        ),
    );
    expect(within(section).getByRole("status").textContent).toContain(
        "Suggestions queued…",
    );
});

it("keeps a failed queue request visible with retry", async () => {
    const server = detail();
    vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) =>
            init?.method === "POST"
                ? Response.json(
                      { error: "Unavailable", code: "INTERNAL_ERROR" },
                      { status: 500 },
                  )
                : Response.json(server),
        ),
    );
    render(
        createElement(AgendaBody, {
            id: "agenda",
            initial: server,
            userId: "owner",
        }),
        { wrapper: ConfirmDialogProvider },
    );
    await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Suggest points" })),
    );
    const section = screen.getByRole("region", {
        name: "Suggestions from activity since the last meeting",
    });
    expect(within(section).getByRole("alert")).toBeTruthy();
    expect(
        within(section).getByRole("button", { name: "Try again" }),
    ).toBeTruthy();
});

it("announces a completed job with no suggestions and does not scroll for a remote start", async () => {
    let server = detail();
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(server)),
    );
    render(
        createElement(AgendaBody, {
            id: "agenda",
            initial: server,
            userId: "owner",
        }),
        { wrapper: ConfirmDialogProvider },
    );
    server = {
        ...server,
        aiSuggestions: { ...server.aiSuggestions, job: { state: "running" } },
    };
    await act(async () =>
        window.dispatchEvent(
            new CustomEvent("agenda-text-saved", { detail: "agenda" }),
        ),
    );
    const section = screen.getByRole("region", {
        name: "Suggestions from activity since the last meeting",
    });
    server = {
        ...server,
        aiSuggestions: { ...server.aiSuggestions, job: { state: null } },
    };
    await act(async () =>
        window.dispatchEvent(
            new CustomEvent("agenda-text-saved", { detail: "agenda" }),
        ),
    );
    await waitFor(() =>
        expect(
            within(section).getByText("No new points to suggest."),
        ).toBeTruthy(),
    );
    expect(
        screen
            .getAllByText("No new points to suggest.")
            .some((node) => node.closest('[aria-live="polite"]')),
    ).toBeTruthy();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
])("keeps the draft at its live anchor after incoming points (after point: %s, renumber: %s)", async (anchored, renumber) => {
    const points = [
        point("Root"),
        point("Second", { position: 1 }),
        point("Third", { position: 2 }),
    ];
    const props = {
        detail: detail({ points }),
        userId: "owner",
        onPatch: vi.fn(),
        onRemove: vi.fn(),
        onAdd: vi.fn().mockResolvedValue(true),
    };
    const view = render(createElement(OutlineEditor, props));
    if (anchored)
        fireEvent.keyDown(screen.getAllByLabelText("Discussion point")[1], {
            key: "Enter",
        });
    else fireEvent.click(screen.getByRole("button", { name: "Add a point…" }));
    const draft = screen.getByLabelText("New discussion point");
    fireEvent.change(draft, { target: { value: "Local draft" } });
    view.rerender(
        createElement(OutlineEditor, {
            ...props,
            detail: detail({
                points: [
                    ...points.map((p) => ({
                        ...p,
                        position: p.position + (renumber ? 4 : 0),
                    })),
                    point("zAccepted", {
                        text: "Accepted",
                        position: renumber ? 7 : 3,
                        origin: "ai",
                    }),
                ],
            }),
        }),
    );
    const fields = [
        ...view.container.querySelectorAll<HTMLTextAreaElement>(
            "textarea[data-point-editor], textarea[placeholder]",
        ),
    ];
    expect(fields.map((input) => input.value)).toEqual(
        anchored
            ? ["Root", "Second", "Local draft", "Third", "Accepted"]
            : ["Root", "Second", "Third", "Accepted", "Local draft"],
    );
    expect(document.activeElement).toBe(draft);
    await act(async () => fireEvent.keyDown(draft, { key: "Enter" }));
    expect(props.onAdd).toHaveBeenCalledWith(
        "Local draft",
        null,
        (anchored ? 2 : 4) + (renumber ? 4 : 0),
    );
});

it.each([
    ["up", false],
    ["drag", false],
    ["indent", false],
    ["up", true],
    ["drag", true],
    ["indent", true],
] as const)("moves an accepted suggestion with %s while the add row remains open (collaborative: %s)", async (action, collaborative) => {
    const doc = createAgendaTextDoc("Accepted");
    let server = detail({
        textProtocol: collaborative ? 1 : undefined,
        points: [
            point("Root"),
            point("Second", { position: 1 }),
            point("Third", { position: 2 }),
        ],
        suggestions: [
            {
                id: "suggestion",
                agendaId: "agenda",
                userId: "owner",
                kind: "ai",
                state: "open",
                text: "Accepted",
                parentPointId: null,
                originPointId: null,
                createdByUserId: "owner",
                sources: { itemIds: [], taskIds: [] },
                createdAt: at,
                updatedAt: at,
            },
        ],
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/text?"))
            return Response.json({
                field: "point:zAccepted:text",
                update: agendaTextBase64(Y.encodeStateAsUpdate(doc)),
                stateVector: agendaTextBase64(Y.encodeStateVector(doc)),
                version: 1,
                materializedVersion: 0,
            });
        if (init?.method === "PATCH") {
            const body = JSON.parse(String(init.body));
            if (url.includes("/suggestions/"))
                server = {
                    ...server,
                    version: server.version + 1,
                    suggestions: [],
                    points: [
                        ...server.points,
                        point("zAccepted", {
                            text: "Accepted",
                            position: 3,
                            origin: "ai",
                        }),
                    ],
                };
            else {
                const current = server.points.find((p) =>
                    url.endsWith(`/points/${p.id}`),
                );
                if (!current || current.version !== body.version)
                    return Response.json(
                        { error: "Agenda point changed", code: "CONFLICT" },
                        { status: 409 },
                    );
                const moved = moveAgendaPoint(
                    server.points,
                    current.id,
                    body.parentId,
                    body.siblingIndex,
                );
                if (!moved) throw new Error("Invalid move");
                server = {
                    ...server,
                    version: server.version + 1,
                    points: moved.map((p) => ({
                        ...p,
                        version: p.version + 1,
                    })),
                };
            }
            return Response.json({ success: true });
        }
        return Response.json(server);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(
        createElement(AgendaBody, {
            id: "agenda",
            initial: server,
            userId: "owner",
        }),
        { wrapper: ConfirmDialogProvider },
    );
    fireEvent.click(screen.getByRole("button", { name: "Add a point…" }));
    const suggestions = screen
        .getByRole("heading", {
            name: "Suggestions from activity since the last meeting",
        })
        .closest("section");
    if (!suggestions) throw new Error("Missing suggestions");
    await act(async () =>
        fireEvent.click(
            within(suggestions).getByRole("button", {
                name: "Add",
            }),
        ),
    );
    const accepted = screen.getByRole("group", { name: "Accepted" });
    if (collaborative) {
        const input =
            within(accepted).getByLabelText<HTMLTextAreaElement>(
                "Discussion point",
            );
        await act(async () => input.focus());
        expect(input.readOnly).toBe(false);
    }
    if (action === "drag") {
        const dataTransfer = {
            effectAllowed: "",
            dropEffect: "",
            setData: vi.fn(),
        };
        fireEvent.dragStart(
            within(accepted).getByRole("button", { name: "Drag point" }),
            { dataTransfer },
        );
        const target = screen.getByRole("group", { name: "Root" });
        const drop = createEvent.drop(target, { dataTransfer });
        Object.defineProperties(drop, {
            clientX: { value: 0 },
            clientY: { value: 0 },
        });
        await act(async () => fireEvent(target, drop));
    } else
        await act(async () =>
            fireEvent.click(
                within(accepted).getByRole("button", {
                    name: action === "up" ? "Move point up" : "Indent point",
                }),
            ),
        );
    const expected =
        action === "up"
            ? ["Root", "Second", "Accepted", "Third"]
            : action === "drag"
              ? ["Accepted", "Root", "Second", "Third"]
              : ["Root", "Second", "Third", "Accepted"];
    expect(
        [...document.querySelectorAll(".agenda-point-row")].map((row) =>
            row.getAttribute("aria-label"),
        ),
    ).toEqual(expected);
    expect(server.points.find((p) => p.id === "zAccepted")?.parentId).toBe(
        action === "indent" ? "Third" : null,
    );
    expect(
        fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH"),
    ).toHaveLength(2);
    view.unmount();
    doc.destroy();
});

it("keeps a nested draft after its anchor when points arrive and the anchor moves", () => {
    const root = point("Root");
    const child = point("Child", { parentId: "Root" });
    const props = {
        detail: detail({
            points: [root, child, point("Other", { position: 1 })],
        }),
        userId: "owner",
        onPatch: vi.fn(),
        onRemove: vi.fn(),
        onAdd: vi.fn().mockResolvedValue(true),
    };
    const view = render(createElement(OutlineEditor, props));
    fireEvent.keyDown(screen.getAllByLabelText("Discussion point")[1], {
        key: "Enter",
    });
    const draft = screen.getByLabelText("New discussion point");
    view.rerender(
        createElement(OutlineEditor, {
            ...props,
            detail: detail({
                points: [
                    root,
                    { ...child, parentId: "Other" },
                    point("Other", { position: 1 }),
                    point("New child", { parentId: "Other", position: 1 }),
                ],
            }),
        }),
    );
    const fields = [
        ...view.container.querySelectorAll(
            "textarea[data-point-editor], textarea[placeholder]",
        ),
    ];
    expect(fields.indexOf(draft)).toBe(3);
    expect(draft.parentElement?.style.paddingLeft).toBe("20px");
    expect(document.activeElement).toBe(draft);
});

it("resolves a queued add against incoming points and keeps its preview above the draft", async () => {
    const props = {
        detail: detail({ points: [point("Root")] }),
        userId: "owner",
        pendingPaths: ["/points"],
        onPatch: vi.fn(),
        onRemove: vi.fn(),
        onAdd: vi.fn().mockResolvedValue(true),
    };
    const view = render(createElement(OutlineEditor, props));
    fireEvent.click(screen.getByRole("button", { name: "Add a point…" }));
    const draft = screen.getByLabelText("New discussion point");
    fireEvent.change(draft, { target: { value: "Queued point" } });
    fireEvent.keyDown(draft, { key: "Enter" });
    expect(
        screen.getByText("Queued point").compareDocumentPosition(draft) &
            Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await act(async () =>
        view.rerender(
            createElement(OutlineEditor, {
                ...props,
                pendingPaths: [],
                detail: detail({
                    points: [point("Root"), point("Incoming", { position: 5 })],
                }),
            }),
        ),
    );
    expect(props.onAdd).toHaveBeenCalledExactlyOnceWith(
        "Queued point",
        null,
        6,
    );
});

it("indents the anchored draft under the preceding point despite an equal-position arrival", async () => {
    const props = {
        detail: detail({
            points: [point("zRoot"), point("aNext", { position: 1 })],
        }),
        userId: "owner",
        onPatch: vi.fn(),
        onRemove: vi.fn(),
        onAdd: vi.fn().mockResolvedValue(true),
    };
    render(createElement(OutlineEditor, props));
    fireEvent.keyDown(screen.getAllByLabelText("Discussion point")[0], {
        key: "Enter",
    });
    const draft = screen.getByLabelText("New discussion point");
    fireEvent.keyDown(draft, { key: "Tab" });
    fireEvent.change(draft, { target: { value: "Nested" } });
    await act(async () => fireEvent.keyDown(draft, { key: "Enter" }));
    expect(props.onAdd).toHaveBeenCalledWith(
        "Nested",
        "zRoot",
        expect.any(Number),
    );
});

it.each([
    true,
    false,
])("uses the text's first line box for root and nested bullets (editable: %s)", (editable) => {
    const props = {
        detail: detail({
            points: [
                point("Root", { text: "Long root\nsecond line" }),
                point("Child", {
                    parentId: "Root",
                    text: "Long child\nsecond line",
                }),
            ],
            permissions: { view: true, edit: editable, manage: editable },
        }),
        userId: "owner",
        onPatch: vi.fn(),
        onRemove: vi.fn(),
        onAdd: vi.fn().mockResolvedValue(true),
    };
    const view = render(createElement(OutlineEditor, props));
    for (const row of view.container.querySelectorAll(".agenda-point-row")) {
        const line = row.firstElementChild;
        const marker = line?.firstElementChild;
        const text = editable
            ? line?.querySelector("label")
            : line?.children[1];
        for (const element of [marker, text]) {
            expect(element?.classList.contains("leading-6")).toBe(true);
            expect(element?.classList.contains("py-1")).toBe(true);
            expect(element?.classList.contains("border")).toBe(true);
        }
        expect(line?.classList.contains("items-start")).toBe(true);
    }
    if (editable) {
        fireEvent.click(screen.getByRole("button", { name: "Add a point…" }));
        const draft = screen.getByLabelText("New discussion point");
        const bullet = draft.previousElementSibling;
        for (const element of [bullet, draft]) {
            expect(element?.classList.contains("leading-6")).toBe(true);
            expect(element?.classList.contains("py-1")).toBe(true);
        }
        expect(draft.parentElement?.classList.contains("items-start")).toBe(
            true,
        );
    }
});

it.each([
    null,
    "Parent",
])("saves between equal-position siblings under %s in displayed order", async (parentId) => {
    let server = detail({
        points: [
            ...(parentId ? [point(parentId)] : []),
            point("A", { parentId, position: 7 }),
            point("B", { parentId, position: 7 }),
        ],
    });
    vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
            if (init?.method === "POST") {
                const body = JSON.parse(String(init.body));
                const added = point("New", body);
                const points =
                    body.siblingIndex === undefined
                        ? [
                              ...server.points.map((p) =>
                                  p.position >= body.position
                                      ? { ...p, position: p.position + 1 }
                                      : p,
                              ),
                              added,
                          ]
                        : moveAgendaPoint(
                              [...server.points, added],
                              added.id,
                              parentId,
                              body.siblingIndex,
                          );
                if (!points) throw new Error("Invalid insertion");
                server = { ...server, points, version: server.version + 1 };
                return Response.json(added);
            }
            return Response.json(server);
        }),
    );
    const view = render(
        createElement(AgendaBody, {
            id: "agenda",
            initial: server,
            userId: "owner",
        }),
        { wrapper: ConfirmDialogProvider },
    );
    fireEvent.keyDown(
        within(screen.getByRole("group", { name: "A" })).getByLabelText(
            "Discussion point",
        ),
        { key: "Enter" },
    );
    const draft = screen.getByLabelText("New discussion point");
    expect(
        [
            ...view.container.querySelectorAll<HTMLTextAreaElement>(
                "textarea[data-point-editor], textarea[placeholder]",
            ),
        ].map((input) => input.value),
    ).toEqual([...(parentId ? [parentId] : []), "A", "", "B"]);
    fireEvent.change(draft, { target: { value: "New" } });
    await act(async () => fireEvent.keyDown(draft, { key: "Enter" }));
    expect(
        [...view.container.querySelectorAll(".agenda-point-row")].map((row) =>
            row.getAttribute("aria-label"),
        ),
    ).toEqual([...(parentId ? [parentId] : []), "A", "New", "B"]);
});

it("keeps saving and queued additions before existing siblings and indents under the last queued point", async () => {
    let server = detail({
        points: [
            point("A"),
            point("B", { position: 1 }),
            point("C", { position: 2 }),
        ],
    });
    const completions: (() => void)[] = [];
    const requests: {
        text: string;
        parentId: string | null;
        position: number;
    }[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
            if (init?.method === "POST") {
                const body = JSON.parse(String(init.body));
                requests.push(body);
                await new Promise<void>((resolve) => completions.push(resolve));
                const added = point(body.text, body);
                server = {
                    ...server,
                    version: server.version + 1,
                    points: [
                        ...server.points.map((p) =>
                            p.position >= body.position
                                ? { ...p, position: p.position + 1 }
                                : p,
                        ),
                        added,
                    ],
                };
                return Response.json(added);
            }
            return Response.json(server);
        }),
    );
    const view = render(
        createElement(AgendaBody, {
            id: "agenda",
            initial: server,
            userId: "owner",
        }),
        { wrapper: ConfirmDialogProvider },
    );
    fireEvent.keyDown(screen.getAllByLabelText("Discussion point")[0], {
        key: "Enter",
    });
    const draft = screen.getByLabelText("New discussion point");
    const order = () =>
        [
            ...view.container.querySelectorAll(
                "fieldset.agenda-point-row, textarea[placeholder], output[data-queued-point]",
            ),
        ].map((element) =>
            element instanceof HTMLTextAreaElement
                ? element.value
                : element instanceof HTMLFieldSetElement
                  ? element.getAttribute("aria-label")
                  : element.textContent,
        );
    fireEvent.change(draft, { target: { value: "First" } });
    await act(async () => fireEvent.keyDown(draft, { key: "Enter" }));
    fireEvent.change(draft, { target: { value: "Second" } });
    fireEvent.keyDown(draft, { key: "Enter" });
    expect(
        screen
            .getByText("Second")
            .compareDocumentPosition(screen.getByRole("group", { name: "B" })) &
            Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(order()).toEqual(["A", "First", "Second", "", "B", "C"]);
    fireEvent.keyDown(draft, { key: "Tab" });
    expect(draft.parentElement?.style.paddingLeft).toBe("20px");
    fireEvent.change(draft, { target: { value: "Nested" } });
    fireEvent.keyDown(draft, { key: "Enter" });
    expect(requests).toHaveLength(1);
    await act(async () => completions[0]());
    expect(requests[1]).toMatchObject({
        text: "Second",
        parentId: null,
        position: 2,
    });
    await act(async () => completions[1]());
    expect(requests[2]).toMatchObject({ text: "Nested", parentId: "Second" });
    await act(async () => completions[2]());
    expect(
        [...view.container.querySelectorAll(".agenda-point-row")].map((row) =>
            row.getAttribute("aria-label"),
        ),
    ).toEqual(["A", "First", "Second", "Nested", "B", "C"]);
});

it.each([
    "queued",
    "running",
] as const)("replaces a local request failure with a remote %s job and its results", async (state) => {
    let server = detail();
    vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) =>
            init?.method === "POST"
                ? Response.json(
                      { error: "Unavailable", code: "INTERNAL_ERROR" },
                      { status: 500 },
                  )
                : Response.json(server),
        ),
    );
    render(
        createElement(AgendaBody, {
            id: "agenda",
            initial: server,
            userId: "owner",
        }),
        { wrapper: ConfirmDialogProvider },
    );
    await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Suggest points" })),
    );
    const section = screen.getByRole("region", {
        name: "Suggestions from activity since the last meeting",
    });
    expect(within(section).getByRole("alert")).toBeTruthy();
    await act(async () =>
        window.dispatchEvent(
            new CustomEvent("agenda-text-saved", { detail: "agenda" }),
        ),
    );
    expect(within(section).getByRole("alert")).toBeTruthy();
    server = {
        ...server,
        aiSuggestions: { ...server.aiSuggestions, job: { state } },
    };
    await act(async () =>
        window.dispatchEvent(
            new CustomEvent("agenda-text-saved", { detail: "agenda" }),
        ),
    );
    expect(within(section).queryByRole("alert")).toBeNull();
    expect(section.getAttribute("aria-busy")).toBe("true");
    expect(within(section).getByRole("status").textContent).toContain(
        state === "queued"
            ? "Suggestions queued…"
            : "Analyzing previous meetings and tasks…",
    );
    server = {
        ...server,
        aiSuggestions: { ...server.aiSuggestions, job: { state: null } },
    };
    await act(async () =>
        window.dispatchEvent(
            new CustomEvent("agenda-text-saved", { detail: "agenda" }),
        ),
    );
    expect(section.getAttribute("aria-busy")).toBe("false");
    expect(within(section).queryByRole("alert")).toBeNull();
    expect(within(section).getByText("No new points to suggest.")).toBeTruthy();
});

it("keeps a queued child attached to the point that is still saving", async () => {
    let server = detail({ points: [point("A"), point("B", { position: 1 })] });
    const completions: (() => void)[] = [];
    const requests: {
        text: string;
        parentId: string | null;
        position: number;
    }[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
            if (init?.method === "POST") {
                const body = JSON.parse(String(init.body));
                requests.push(body);
                await new Promise<void>((resolve) => completions.push(resolve));
                const added = point(body.text, body);
                server = {
                    ...server,
                    version: server.version + 1,
                    points: [
                        ...server.points.map((p) =>
                            p.position >= body.position
                                ? { ...p, position: p.position + 1 }
                                : p,
                        ),
                        added,
                    ],
                };
                return Response.json(added);
            }
            return Response.json(server);
        }),
    );
    render(
        createElement(AgendaBody, {
            id: "agenda",
            initial: server,
            userId: "owner",
        }),
        { wrapper: ConfirmDialogProvider },
    );
    fireEvent.keyDown(screen.getAllByLabelText("Discussion point")[0], {
        key: "Enter",
    });
    const draft = screen.getByLabelText("New discussion point");
    fireEvent.change(draft, { target: { value: "First" } });
    await act(async () => fireEvent.keyDown(draft, { key: "Enter" }));
    fireEvent.keyDown(draft, { key: "Tab" });
    fireEvent.change(draft, { target: { value: "Nested" } });
    fireEvent.keyDown(draft, { key: "Enter" });
    await act(async () => completions[0]());
    expect(requests[1]).toMatchObject({ text: "Nested", parentId: "First" });
    await act(async () => completions[1]());
});

it.each([
    null,
    "Parent",
])("keeps an optimistic indexed add under %s visible after remote sibling removal", async (parentId) => {
    let server = detail({
        points: [
            ...(parentId ? [point(parentId)] : []),
            ...["A", "B", "C"].map((id) =>
                point(id, { parentId, position: 7 }),
            ),
        ],
    });
    let completePatch = () => {};
    let completeAdd: (response: Response) => void = () => {};
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
            await new Promise<void>((resolve) => {
                completePatch = resolve;
            });
            return Response.json({ success: true });
        }
        if (init?.method === "POST")
            return new Promise<Response>((resolve) => {
                completeAdd = resolve;
            });
        return Response.json(server);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
        createElement(AgendaBody, {
            id: "agenda",
            initial: server,
            userId: "owner",
            variant: "live",
        }),
        { wrapper: ConfirmDialogProvider },
    );
    await act(async () =>
        fireEvent.click(screen.getByRole("checkbox", { name: "Discussed: C" })),
    );
    fireEvent.keyDown(
        within(screen.getByRole("group", { name: "B" })).getByLabelText(
            "Discussion point",
        ),
        { key: "Enter" },
    );
    const draft = screen.getByLabelText("New discussion point");
    fireEvent.change(draft, { target: { value: "Local point" } });
    fireEvent.keyDown(draft, { key: "Enter" });
    expect(screen.getByRole("group", { name: "Local point" })).toBeTruthy();
    server = {
        ...server,
        version: 2,
        points: server.points.filter((p) => !["A", "B"].includes(p.id)),
    };
    await act(async () => completePatch());
    expect(
        fetchMock.mock.calls.find(([, init]) => init?.method === "POST")?.[1]
            ?.body,
    ).toContain('"siblingIndex":2');
    expect(screen.getByRole("group", { name: "Local point" })).toBeTruthy();
    server = {
        ...server,
        version: 3,
        points: [
            ...server.points,
            point("Local point", { parentId, position: 1 }),
        ],
    };
    await act(async () => completeAdd(Response.json({ id: "Local point" })));
    expect(screen.getByRole("group", { name: "Local point" })).toBeTruthy();
});

it.each([
    "viewer",
    "recording",
    "attached",
] as const)("does not announce suggestion completion to a %s", async (mode) => {
    let server = detail({
        permissions: {
            view: true,
            edit: mode !== "viewer",
            manage: mode !== "viewer",
        },
        recordingItemId: mode === "attached" ? "recording" : null,
        aiSuggestions: {
            available: true,
            reason: null,
            job: { state: "running" },
        },
    });
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(server)),
    );
    const view = render(
        createElement(AgendaBody, {
            id: "agenda",
            initial: server,
            userId: "owner",
            variant: mode === "recording" ? "recording" : "meeting",
        }),
        { wrapper: ConfirmDialogProvider },
    );
    server = {
        ...server,
        aiSuggestions: { ...server.aiSuggestions, job: { state: null } },
    };
    await act(async () =>
        window.dispatchEvent(
            new CustomEvent("agenda-text-saved", { detail: "agenda" }),
        ),
    );
    expect(
        view.container.querySelector('[aria-live][aria-atomic="true"]'),
    ).toBeNull();
    expect(screen.queryByText("No new points to suggest.")).toBeNull();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
    server = {
        ...server,
        permissions: { view: true, edit: true, manage: true },
        recordingItemId: null,
    };
    view.rerender(createElement(AgendaBody, { id: "agenda", userId: "owner" }));
    await act(async () =>
        window.dispatchEvent(
            new CustomEvent("agenda-text-saved", { detail: "agenda" }),
        ),
    );
    expect(screen.queryByText("No new points to suggest.")).toBeNull();
});

it.each([
    "Discussion point",
    "Point note",
])("only measures %s while editing and refreshes its height on re-entry", async (label) => {
    const resizeCallbacks: (() => void)[] = [];
    vi.stubGlobal(
        "ResizeObserver",
        class {
            constructor(callback: () => void) {
                resizeCallbacks.push(callback);
            }
            observe = vi.fn();
            disconnect = vi.fn();
        },
    );
    const height = vi
        .spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get")
        .mockReturnValue(80);
    const width = vi
        .spyOn(HTMLTextAreaElement.prototype, "clientWidth", "get")
        .mockReturnValue(400);
    const props = {
        detail: detail({ points: [point("A", { note: "Original note" })] }),
        userId: "owner",
        onPatch: vi.fn(),
        onRemove: vi.fn(),
        onAdd: vi.fn().mockResolvedValue(true),
    };
    const view = render(createElement(OutlineEditor, props));
    const field = screen.getByLabelText<HTMLTextAreaElement>(label);
    height.mockClear();
    view.rerender(
        createElement(OutlineEditor, {
            ...props,
            detail: detail({
                points: [
                    point("A", { text: "Remote point", note: "Remote note" }),
                ],
            }),
        }),
    );
    expect(height).not.toHaveBeenCalled();
    await act(async () => field.focus());
    expect(field.style.height).toBe("80px");
    height.mockReturnValue(120);
    fireEvent.change(field, { target: { value: "A longer local draft" } });
    expect(field.style.height).toBe("120px");
    width.mockReturnValue(200);
    height.mockReturnValue(160);
    act(() => {
        for (const callback of resizeCallbacks) callback();
    });
    expect(field.style.height).toBe("160px");
    await act(async () => field.blur());
    height.mockClear();
    width.mockReturnValue(1);
    act(() => {
        for (const callback of resizeCallbacks) callback();
    });
    view.rerender(
        createElement(OutlineEditor, {
            ...props,
            detail: detail({
                points: [
                    point("A", { text: "Latest point", note: "Latest note" }),
                ],
            }),
        }),
    );
    expect(height).not.toHaveBeenCalled();
    height.mockReturnValue(40);
    await act(async () => field.focus());
    expect(field.style.height).toBe("40px");
    expect(field.style.maxHeight).toBe("");
});

it("aliases identical pending text to the earliest point regardless of array order", async () => {
    const props = {
        detail: detail({ points: [point("Root")] }),
        userId: "owner",
        onPatch: vi.fn(),
        onRemove: vi.fn(),
        onAdd: vi.fn(() => new Promise<boolean>(() => {})),
    };
    const view = render(createElement(OutlineEditor, props));
    fireEvent.click(screen.getByRole("button", { name: "Add a point…" }));
    const draft = screen.getByLabelText("New discussion point");
    fireEvent.change(draft, { target: { value: "Identical" } });
    await act(async () => fireEvent.keyDown(draft, { key: "Enter" }));
    view.rerender(
        createElement(OutlineEditor, {
            ...props,
            pendingPaths: ["/points"],
            detail: detail({
                points: [
                    point("Root"),
                    point("pending-later", {
                        text: "Identical",
                        position: 2,
                        createdAt: "2026-11-03T10:00:02.000Z",
                    }),
                    point("pending-earlier", {
                        text: "Identical",
                        position: 1,
                        createdAt: "2026-11-03T10:00:01.000Z",
                    }),
                ],
            }),
        }),
    );
    const earlier = document.getElementById("point-pending-earlier");
    const later = document.getElementById("point-pending-later");
    if (!earlier || !later) throw new Error("Missing pending points");
    expect(
        earlier.compareDocumentPosition(draft) &
            Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
        draft.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
});

it.each([
    "running",
    null,
] as const)("retains an indistinguishable failed attempt until the server reports %s", async (state) => {
    let server = detail({
        aiSuggestions: {
            available: true,
            reason: null,
            job: { state: "failed", errorCode: "AI_PROVIDER_API_ERROR" },
        },
    });
    vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) =>
            init?.method === "POST"
                ? Response.json(
                      { error: "Unavailable", code: "INTERNAL_ERROR" },
                      { status: 500 },
                  )
                : Response.json(server),
        ),
    );
    render(
        createElement(AgendaBody, {
            id: "agenda",
            initial: server,
            userId: "owner",
        }),
        { wrapper: ConfirmDialogProvider },
    );
    await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Try again" })),
    );
    const section = screen.getByRole("region", {
        name: "Suggestions from activity since the last meeting",
    });
    server = {
        ...server,
        version: server.version + 1,
        aiSuggestions: {
            ...server.aiSuggestions,
            job: { state: "failed", errorCode: "AI_PROVIDER_API_ERROR" },
        },
    };
    await act(async () =>
        window.dispatchEvent(
            new CustomEvent("agenda-text-saved", { detail: "agenda" }),
        ),
    );
    expect(within(section).getByRole("alert").textContent).toContain(
        "The provider returned invalid agenda suggestions.",
    );
    server = {
        ...server,
        aiSuggestions: { ...server.aiSuggestions, job: { state } },
    };
    await act(async () =>
        window.dispatchEvent(
            new CustomEvent("agenda-text-saved", { detail: "agenda" }),
        ),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    if (state === "running")
        expect(within(section).getByRole("status").textContent).toContain(
            "Analyzing previous meetings and tasks…",
        );
    else
        expect(
            screen.queryByRole("region", {
                name: "Suggestions from activity since the last meeting",
            }),
        ).toBeNull();
});
