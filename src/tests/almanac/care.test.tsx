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
import type * as NextIntl from "next-intl";
import type { TranslationValues } from "use-intl/core";
import { IntlProvider, useTranslations } from "use-intl/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CareLoading from "@/app/(app)/almanac/care/loading";
import CarePage from "@/app/(app)/almanac/care/page";
import { AlmanacTabs } from "@/components/almanac/almanac-tabs";
import { CareQueue } from "@/components/almanac/care-queue";
import { EntityActions } from "@/components/almanac/entity-actions";
import { mergeLikelihoods } from "@/components/almanac/merge-likelihoods";
import { MergeTargetPicker } from "@/components/almanac/merge-target-picker";
import { PersonActions } from "@/components/people/person-actions";
import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import { messagesForLocale } from "@/lib/i18n/messages";
import type { DuplicateComparison } from "@/lib/knowledge/duplicate-comparison";
import {
    type DuplicateCandidate,
    listDuplicateCandidates,
} from "@/lib/knowledge/duplicates";

vi.mock("next-intl", async (importOriginal) => {
    const original = await importOriginal<typeof NextIntl>();
    return {
        ...original,
        useExtracted: () => {
            const translate = useTranslations();
            const ids = new Map(
                Object.entries(messagesForLocale("en")).map(([id, source]) => [
                    source,
                    id,
                ]),
            );
            return (
                message: string | { id: string; message: string },
                values?: TranslationValues,
            ) =>
                translate(
                    typeof message === "string"
                        ? (ids.get(message) ?? message)
                        : message.id,
                    values,
                );
        },
    };
});

vi.mock("next/navigation", () => ({
    usePathname: () => "/almanac/care",
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
    notFound: () => {
        throw new Error("Not found");
    },
}));
vi.mock("@/lib/auth-server", () => ({
    requireAuth: async () => ({ user: { id: "curator" } }),
}));
vi.mock("@/lib/authz/curator", () => ({
    userCuratesOrganizationNow: vi.fn(async () => true),
}));
vi.mock("@/lib/knowledge/care-access", () => ({
    canOpenCare: (actorId: string) => userCuratesOrganizationNow(actorId),
}));
vi.mock("next-intl/server", () => ({
    getExtracted: async () => (message: string) => message,
}));
vi.mock("@/lib/knowledge/duplicates", () => ({
    listDuplicateCandidates: vi.fn(async () => ({
        candidates: [],
        nextCursor: null,
        limited: false,
    })),
}));
vi.mock("@/components/learn/review-events", () => ({
    usePendingReviews: () => 0,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

const candidate: DuplicateCandidate = {
    key: "person:left:right",
    score: 0.84,
    confidence: "high",
    for: ["nickname"],
    against: ["different_emails"],
    survivorId: "left",
    left: {
        id: "left",
        kind: "person",
        name: "Ondřej Kalous",
        typeKey: "person",
        primaryEmail: "ondrej@kestrel.example",
        emails: [],
        aliases: ["OK"],
        heardAs: [],
        evidenceCount: 8,
    },
    right: {
        id: "right",
        kind: "person",
        name: "Ondra Kalous",
        typeKey: "person",
        primaryEmail: null,
        emails: [],
        aliases: [],
        heardAs: ["Kalus"],
        evidenceCount: 2,
    },
};
const comparison: DuplicateComparison = {
    kind: "person",
    survivorId: "left",
    version: "a".repeat(64),
    itemsLimited: false,
    relationLabels: { o_position: "Position" },
    clashes: [
        { relationKey: "o_position", factIds: ["fact-left", "fact-right"] },
    ],
    left: {
        ...candidate.left,
        facts: [
            {
                id: "fact-left",
                relationKey: "o_position",
                text: "Coordinator",
                direction: "subject",
            },
        ],
        appearances: [{ itemId: "shared", title: "Planning session" }],
        tasks: [{ id: "task-1", itemId: "shared", text: "Send notes" }],
    },
    right: {
        ...candidate.right,
        facts: [
            {
                id: "fact-right",
                relationKey: "o_position",
                text: "Lead",
                direction: "subject",
            },
        ],
        appearances: [],
        tasks: [],
    },
};
const initial = { candidates: [candidate], nextCursor: null, limited: false };

function respond({ rejectDismiss = false, staleMerge = false } = {}) {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/compare")) {
            if (init?.method === "POST")
                return staleMerge
                    ? Response.json(
                          {
                              error: "These records changed. Compare them again.",
                              code: "CONFLICT",
                              details: { reason: "stale_comparison" },
                          },
                          { status: 409 },
                      )
                    : Response.json({ survivorId: "left" });
            return Response.json(comparison);
        }
        if (init?.method === "POST")
            return rejectDismiss
                ? Response.json({ error: "Try again" }, { status: 503 })
                : Response.json({ dismissed: true });
        return Response.json(initial);
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
}
afterEach(async () => {
    cleanup();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe("Almanac curator care", () => {
    it("only shows Care to curators and marks it active, with no count yet", () => {
        render(<AlmanacTabs canCurate={false} />);
        expect(screen.queryByRole("link", { name: "Care" })).toBeNull();
        cleanup();
        render(<AlmanacTabs canCurate />);
        expect(
            screen
                .getByRole("link", { name: "Care" })
                .getAttribute("aria-current"),
        ).toBe("page");
    });
    it("refuses a member opening the page directly", async () => {
        vi.mocked(userCuratesOrganizationNow).mockResolvedValueOnce(false);
        await expect(CarePage()).rejects.toThrow("Not found");
    });
    it("shows paired records, evidence and amber contrary signals, then remembers Not the same", async () => {
        const fetch = respond();
        render(<CareQueue initial={initial} sessionKey="curator" />);
        expect(screen.getByText("Ondřej Kalous")).toBeTruthy();
        expect(
            screen.getByText("Known given-name nickname, same surname"),
        ).toBeTruthy();
        expect(
            screen.getByText("Different emails at different domains").className,
        ).toContain("amber");
        fireEvent.click(screen.getByRole("button", { name: "Not the same" }));
        await waitFor(() =>
            expect(fetch).toHaveBeenCalledWith(
                "/api/knowledge/duplicates",
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify({
                        kind: "person",
                        left: "left",
                        right: "right",
                    }),
                }),
            ),
        );
        expect(screen.queryByText("Ondřej Kalous")).toBeNull();
        expect(screen.getByText("All done here.")).toBeTruthy();
    });
    it("restores a card when a dismissal fails", async () => {
        respond({ rejectDismiss: true });
        render(<CareQueue initial={initial} sessionKey="curator" />);
        fireEvent.click(screen.getByRole("button", { name: "Not the same" }));
        await screen.findByText("Ondřej Kalous");
    });
    it("Later lasts for the tab session without persisting a dismissal", async () => {
        const fetch = respond();
        render(<CareQueue initial={initial} sessionKey="curator" />);
        fireEvent.click(screen.getByRole("button", { name: "Later" }));
        expect(fetch).not.toHaveBeenCalled();
        cleanup();
        render(<CareQueue initial={initial} sessionKey="curator" />);
        await waitFor(() =>
            expect(screen.queryByText("Ondřej Kalous")).toBeNull(),
        );
    });
    it("requires a clash choice and sends chosen name and fact to compare-and-join", async () => {
        const fetch = respond();
        render(<CareQueue initial={initial} sessionKey="curator" />);
        fireEvent.click(screen.getByRole("button", { name: "Merge…" }));
        await screen.findByRole("radio", { name: "Lead" });
        expect(
            (
                screen.getByRole("button", {
                    name: "Merge into “Ondřej Kalous”",
                }) as HTMLButtonElement
            ).disabled,
        ).toBe(true);
        expect(screen.getByText("Planning session")).toBeTruthy();
        expect(screen.getByText("Send notes")).toBeTruthy();
        fireEvent.click(screen.getByRole("radio", { name: "Ondra Kalous" }));
        fireEvent.click(screen.getByRole("radio", { name: "Lead" }));
        fireEvent.click(
            screen.getByRole("button", { name: "Merge into “Ondra Kalous”" }),
        );
        await waitFor(() =>
            expect(fetch).toHaveBeenCalledWith(
                "/api/knowledge/duplicates/compare",
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify({
                        kind: "person",
                        survivorId: "left",
                        loserId: "right",
                        nameSourceId: "right",
                        factChoices: { o_position: "fact-right" },
                        version: comparison.version,
                    }),
                }),
            ),
        );
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });
    it("removes every pending pair involving either merged record", async () => {
        respond();
        const related: DuplicateCandidate = {
            ...candidate,
            key: "person:left:third",
            right: { ...candidate.right, id: "third", name: "Jitka Dvořáková" },
        };
        render(
            <CareQueue
                initial={{ ...initial, candidates: [candidate, related] }}
                sessionKey="curator"
            />,
        );
        fireEvent.click(screen.getAllByRole("button", { name: "Merge…" })[0]);
        fireEvent.click(await screen.findByRole("radio", { name: "Lead" }));
        fireEvent.click(
            screen.getByRole("button", { name: "Merge into “Ondřej Kalous”" }),
        );
        await waitFor(() =>
            expect(screen.queryByText("Jitka Dvořáková")).toBeNull(),
        );
        expect(screen.getByText("All done here.")).toBeTruthy();
    });
    it("keeps a failed stale merge open and offers a fresh comparison", async () => {
        respond({ staleMerge: true });
        render(<CareQueue initial={initial} sessionKey="curator" />);
        fireEvent.click(screen.getByRole("button", { name: "Merge…" }));
        fireEvent.click(await screen.findByRole("radio", { name: "Lead" }));
        fireEvent.click(
            screen.getByRole("button", { name: "Merge into “Ondřej Kalous”" }),
        );
        expect(await screen.findByRole("alert")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Compare again" }));
        await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
        expect(screen.getByRole("dialog")).toBeTruthy();
    });
    it("loads only people on the server and provides a route loading state", async () => {
        const page = await CarePage();
        expect(listDuplicateCandidates).toHaveBeenCalledWith("curator", {
            kind: "person",
        });
        render(page);
        expect(screen.getByText("All done here.")).toBeTruthy();
        cleanup();
        render(await CareLoading());
        expect(screen.getByText("Loading…")).toBeTruthy();
    });
    it("renders loading immediately and requests only the selected kind", async () => {
        const requests: { url: string; signal?: AbortSignal | null }[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn((url: string, init?: RequestInit) => {
                requests.push({ url, signal: init?.signal });
                return new Promise<Response>(() => {});
            }),
        );
        render(<CareQueue sessionKey="curator" />);
        expect(screen.getByText("Loading…")).toBeTruthy();
        expect(screen.queryByText("All done here.")).toBeNull();
        expect(requests.map(({ url }) => url)).toEqual([
            "/api/knowledge/duplicates?kind=person",
        ]);
        fireEvent.click(screen.getByRole("button", { name: "Things" }));
        expect(requests.map(({ url }) => url)).toEqual([
            "/api/knowledge/duplicates?kind=person",
            "/api/knowledge/duplicates?kind=entity",
        ]);
        expect(requests[0].signal?.aborted).toBe(true);
    });
    it("does not persist an in-flight dismissal when another card is postponed", async () => {
        let finish: (response: Response) => void = () => {};
        vi.stubGlobal(
            "fetch",
            vi.fn(
                () =>
                    new Promise<Response>((resolve) => {
                        finish = resolve;
                    }),
            ),
        );
        const second: DuplicateCandidate = {
            ...candidate,
            key: "person:second:third",
            left: { ...candidate.left, id: "second", name: "Zavi Duspektor" },
            right: { ...candidate.right, id: "third", name: "Zavi Duspektar" },
        };
        const page = { ...initial, candidates: [candidate, second] };
        render(<CareQueue initial={page} sessionKey="curator" />);
        fireEvent.click(
            screen.getAllByRole("button", { name: "Not the same" })[0],
        );
        fireEvent.click(screen.getByRole("button", { name: "Later" }));
        expect(screen.queryByText(candidate.left.name)).toBeNull();
        await act(async () =>
            finish(
                Response.json(
                    { error: "Try again", code: "SERVICE_UNAVAILABLE" },
                    { status: 503 },
                ),
            ),
        );
        expect(screen.getByText(candidate.left.name)).toBeTruthy();
        cleanup();
        render(<CareQueue initial={page} sessionKey="curator" />);
        expect(screen.getByText(candidate.left.name)).toBeTruthy();
        expect(screen.queryByText(second.left.name)).toBeNull();
    });
    it("translates stale comparisons and task headings into Czech", async () => {
        respond({ staleMerge: true });
        render(<CareQueue initial={initial} sessionKey="curator" />, {
            wrapper: ({ children }) => (
                <IntlProvider
                    locale="cs-CZ"
                    messages={messagesForLocale("cs-CZ")}
                >
                    {children}
                </IntlProvider>
            ),
        });
        fireEvent.click(screen.getByRole("button", { name: "Sloučit…" }));
        fireEvent.click(await screen.findByRole("radio", { name: "Lead" }));
        expect(screen.getByText("Otevřené úkoly")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: /Sloučit do/ }));
        expect((await screen.findByRole("alert")).textContent).toContain(
            "Tyto záznamy se změnily. Porovnejte je znovu.",
        );
    });
    it.each([
        "person",
        "entity",
    ] as const)("shows %s merge candidates before slow scores and re-ranks after arrival", async (kind) => {
        let finish: (response: Response) => void = () => {};
        const rows = [
            {
                id: "first",
                displayName: "Nelo Xavitor",
                name: "Nelo Xavitor",
                primaryEmail: null,
                scope: "org",
            },
            {
                id: "strong",
                displayName: "Vemi Ziltor",
                name: "Vemi Ziltor",
                primaryEmail: null,
                scope: "org",
            },
        ];
        vi.stubGlobal(
            "fetch",
            vi.fn((url: string) =>
                url.includes("/duplicates")
                    ? new Promise<Response>((resolve) => {
                          finish = resolve;
                      })
                    : Promise.resolve(
                          Response.json({ people: rows, entities: rows }),
                      ),
            ),
        );
        render(
            kind === "person" ? (
                <PersonActions
                    canCurateOrganization
                    person={{
                        id: "source",
                        displayName: "Zavi Duspektor",
                        primaryEmail: null,
                        scope: "org",
                    }}
                />
            ) : (
                <EntityActions
                    canCurateOrganization
                    entity={{
                        id: "source",
                        name: "Zavi Duspektor",
                        typeKey: "project",
                        description: null,
                        notes: null,
                        scope: "org",
                    }}
                    canManage
                    types={[]}
                />
            ),
        );
        fireEvent.click(screen.getByRole("button", { name: "Merge into…" }));
        await screen.findByRole("option", { name: /Nelo Xavitor/ });
        expect(screen.getAllByRole("option")[0].textContent).toContain(
            "Nelo Xavitor",
        );
        await act(async () =>
            finish(
                Response.json({
                    ...initial,
                    candidates: [
                        {
                            ...candidate,
                            left: { ...candidate.left, id: "source" },
                            right: { ...candidate.right, id: "strong" },
                        },
                    ],
                }),
            ),
        );
        await waitFor(() =>
            expect(screen.getAllByRole("option")[0].textContent).toContain(
                "Vemi Ziltor",
            ),
        );
    });
    it("bounds picker score requests to three seconds and returns the plain list on abort", async () => {
        const controller = new AbortController();
        const timeout = vi
            .spyOn(AbortSignal, "timeout")
            .mockReturnValue(controller.signal);
        vi.stubGlobal(
            "fetch",
            vi.fn(
                (_url: string, init?: RequestInit) =>
                    new Promise<Response>((_resolve, reject) =>
                        init?.signal?.addEventListener("abort", () =>
                            reject(new Error("aborted")),
                        ),
                    ),
            ),
        );
        try {
            const result = mergeLikelihoods("person", "source");
            expect(timeout).toHaveBeenCalledWith(3000);
            controller.abort();
            expect(await result).toBeNull();
        } finally {
            timeout.mockRestore();
        }
    });
    it("uses the request signal when AbortSignal.any is unavailable", async () => {
        const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any");
        Object.defineProperty(AbortSignal, "any", {
            configurable: true,
            value: undefined,
        });
        const controller = new AbortController();
        const fetch = vi.fn(
            (_url: string, init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    expect(init?.signal).toBe(controller.signal);
                    init?.signal?.addEventListener("abort", () =>
                        reject(new Error("aborted")),
                    );
                }),
        );
        vi.stubGlobal("fetch", fetch);
        try {
            const result = mergeLikelihoods(
                "person",
                "source",
                controller.signal,
            );
            expect(fetch).toHaveBeenCalledOnce();
            controller.abort();
            expect(await result).toBeNull();
        } finally {
            if (descriptor)
                Object.defineProperty(AbortSignal, "any", descriptor);
            else Reflect.deleteProperty(AbortSignal, "any");
        }
    });
    it("shows None in every facts cell when both records have no facts", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json({
                    ...comparison,
                    clashes: [],
                    left: { ...comparison.left, facts: [] },
                    right: { ...comparison.right, facts: [] },
                }),
            ),
        );
        render(<CareQueue initial={initial} sessionKey="curator" />);
        fireEvent.click(screen.getByRole("button", { name: "Merge…" }));
        const label = await screen.findByText("Facts");
        const row = label.closest("tr");
        expect(row).toBeTruthy();
        if (row) expect(within(row).getAllByText("None")).toHaveLength(3);
        expect(
            screen.getByText("Record that stays").parentElement?.className,
        ).toContain("gap-1");
    });
    it.each([
        [
            "GET",
            "stale_comparison",
            "Tyto záznamy se změnily. Porovnejte je znovu.",
        ],
        [
            "GET",
            "too_many_forms",
            "Příliš mnoho jmen nebo e-mailů pro jedno porovnání",
        ],
        ["GET", "too_many_facts", "Příliš mnoho faktů pro jedno porovnání"],
        [
            "POST",
            "missing_clash_choice",
            "U každého rozporu vyberte hodnotu, která zůstane",
        ],
        ["POST", "chosen_fact_changed", "Vybraný fakt se změnil"],
        ["POST", "email_conflict", "E-mail patří jiné osobě"],
        ["POST", "type_mismatch", "Sloučit lze pouze věci stejného typu"],
        [
            "POST",
            "incompatible_facts",
            "Fakt by neodpovídal ponechanému typu. Nejprve jej změňte nebo smažte.",
        ],
        ["POST", "name_conflict", "Věc tohoto typu už má toto jméno"],
    ])("translates %s conflict %s into Czech", async (method, reason, translated) => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (_url: string, init?: RequestInit) =>
                (init?.method ?? "GET") === method
                    ? Response.json(
                          {
                              error: "Untranslated server conflict",
                              code: "CONFLICT",
                              details: { reason },
                          },
                          { status: 409 },
                      )
                    : Response.json(comparison),
            ),
        );
        render(<CareQueue initial={initial} sessionKey="curator" />, {
            wrapper: ({ children }) => (
                <IntlProvider
                    locale="cs-CZ"
                    messages={messagesForLocale("cs-CZ")}
                >
                    {children}
                </IntlProvider>
            ),
        });
        fireEvent.click(screen.getByRole("button", { name: "Sloučit…" }));
        if (method === "POST") {
            fireEvent.click(await screen.findByRole("radio", { name: "Lead" }));
            fireEvent.click(screen.getByRole("button", { name: /Sloučit do/ }));
        }
        expect((await screen.findByRole("alert")).textContent).toContain(
            translated,
        );
    });
    it("ranks likely matches before the original unrelated order", async () => {
        render(
            <MergeTargetPicker
                source={{ id: "source", name: "Ondra Kalous", kind: "person" }}
                value=""
                onChange={vi.fn()}
                candidates={[
                    { id: "unrelated", name: "Zim Teral" },
                    { id: "match", name: "Ondřej Kalous" },
                ]}
            />,
        );
        await waitFor(() =>
            expect(screen.getAllByRole("option")[0].textContent).toContain(
                "Ondřej Kalous",
            ),
        );
        expect(screen.getByText("Likely match")).toBeTruthy();
    });

    it("honors server contrary evidence and dismissals when ranking a curator's merge picker", () => {
        render(
            <MergeTargetPicker
                source={{ id: "source", name: "Ondra Kalous", kind: "person" }}
                value=""
                onChange={vi.fn()}
                candidates={[
                    {
                        id: "dismissed",
                        name: "Ondra Kalous",
                        duplicateScore: 0,
                    },
                    {
                        id: "speakers",
                        name: "Ondra Kalous",
                        duplicateScore: 0.2,
                    },
                    {
                        id: "match",
                        name: "Ondřej Kalous",
                        duplicateScore: 0.84,
                    },
                ]}
            />,
        );
        expect(screen.getAllByRole("option")[0].textContent).toContain(
            "Ondřej Kalous",
        );
        expect(screen.getAllByText("Likely match")).toHaveLength(1);
    });

    it("shows a custom Organization type's readable label", () => {
        const thing: DuplicateCandidate = {
            ...candidate,
            key: "entity:left:right",
            left: {
                ...candidate.left,
                kind: "entity",
                typeKey: "o_internal",
                typeLabel: "Initiative",
            },
            right: {
                ...candidate.right,
                kind: "entity",
                typeKey: "o_internal",
                typeLabel: "Initiative",
            },
        };
        render(
            <CareQueue
                initial={{ ...initial, candidates: [thing] }}
                sessionKey="curator"
            />,
        );
        expect(screen.getAllByText("Initiative")).toHaveLength(2);
        expect(screen.queryByText("o_internal")).toBeNull();
    });
});
