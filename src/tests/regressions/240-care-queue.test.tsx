// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import type * as NextIntl from "next-intl";
import type { TranslationValues } from "use-intl/core";
import { IntlProvider, useTranslations } from "use-intl/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AlmanacLayout from "@/app/(app)/almanac/layout";
import { CareProblemCard } from "@/components/almanac/care-problem-card";
import { CareQueue } from "@/components/almanac/care-queue";
import { FolderCareFlags } from "@/components/almanac/folder-care-flags";
import { messagesForLocale } from "@/lib/i18n/messages";
import type { CareProblem } from "@/lib/knowledge/care-types";

const mocks = vi.hoisted(() => ({
    fetch: vi.fn(),
    refresh: vi.fn(),
    curator: vi.fn().mockResolvedValue(true),
    count: vi.fn().mockResolvedValue(7),
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: mocks.refresh }),
    usePathname: () => "/almanac/care",
}));
vi.mock("next-intl", async (original) => {
    const module = await original<typeof NextIntl>();
    return {
        ...module,
        useExtracted: () => {
            const translate = useTranslations();
            const ids = new Map(
                Object.entries(messagesForLocale("en")).map(([id, source]) => [
                    source,
                    id,
                ]),
            );
            return (message: string, values?: TranslationValues) =>
                translate(ids.get(message) ?? message, values);
        },
    };
});
vi.mock("@/lib/auth-server", () => ({
    requireAuth: async () => ({ user: { id: "curator" } }),
}));
vi.mock("@/lib/authz/curator", () => ({
    userCuratesOrganizationNow: mocks.curator,
}));
vi.mock("@/lib/knowledge/care-access", () => ({ canOpenCare: mocks.curator }));
vi.mock("@/lib/knowledge/care-summary", () => ({ careCount: mocks.count }));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("@/components/almanac/compare-join-dialog", () => ({
    CompareJoinDialog: () => null,
}));
const problem: CareProblem = {
    key: "a".repeat(64),
    kind: "fact_conflict",
    records: [{ id: "subject", kind: "entity", name: "Velnaro" }],
    relationKey: "means",
    relationLabel: "Means",
    options: [
        { id: "first", label: "First meaning" },
        { id: "second", label: "Second meaning" },
    ],
};
function wrapper({ children }: { children: React.ReactNode }) {
    return (
        <IntlProvider
            locale="en"
            messages={messagesForLocale("en")}
            timeZone="UTC"
        >
            {children}
        </IntlProvider>
    );
}
beforeEach(() => {
    mocks.fetch.mockReset().mockResolvedValue(Response.json({ fixed: true }));
    mocks.refresh.mockClear();
    mocks.count.mockClear();
    mocks.curator.mockResolvedValue(true);
    vi.stubGlobal("fetch", mocks.fetch);
    sessionStorage.clear();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe.each(["Care", "folder"] as const)("%s problem fixes", (variant) => {
    function mount(value = problem) {
        return render(
            variant === "Care" ? (
                <CareProblemCard problem={value} onResolved={vi.fn()} />
            ) : (
                <FolderCareFlags
                    care={{ problems: [value], duplicates: [] }}
                    recordId="subject"
                    onChanged={vi.fn()}
                />
            ),
            { wrapper },
        );
    }
    it("shows evidence and fixes using the same server action", async () => {
        mount();
        expect(screen.getByText("Velnaro").getAttribute("href")).toBe(
            "/almanac/things/subject",
        );
        fireEvent.click(
            screen.getByRole("button", {
                name: "Keep First meaning",
                hidden: true,
            }),
        );
        await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
        expect(mocks.fetch).toHaveBeenCalledWith(
            "/api/knowledge/care",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({
                    key: problem.key,
                    action: "keep",
                    optionId: "first",
                }),
            }),
        );
        expect(screen.queryByText("Velnaro")).toBeNull();
    });
    it("restores a failed optimistic dismissal", async () => {
        mocks.fetch.mockResolvedValue(Response.json({}, { status: 409 }));
        mount();
        fireEvent.click(
            screen.getByRole("button", { name: "Dismiss", hidden: true }),
        );
        await waitFor(() => expect(screen.getByText("Velnaro")).toBeTruthy());
        expect(mocks.refresh).not.toHaveBeenCalled();
    });
    it("offers delete and keep for a thin record", async () => {
        mount({
            ...problem,
            kind: "thin",
            options: [],
            lastAt: "2025-01-01T00:00:00Z",
        });
        expect(
            screen.getByRole("button", { name: "Delete", hidden: true }),
        ).toBeTruthy();
        fireEvent.click(
            screen.getByRole("button", { name: "Keep", hidden: true }),
        );
        await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
        expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).action).toBe(
            "dismiss",
        );
    });
});

it("never shows flags or fixes without curator-only data", () => {
    render(<FolderCareFlags recordId="subject" onChanged={vi.fn()} />, {
        wrapper,
    });
    expect(screen.queryByText(/open problem/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
});
it("loads each new Care section and keeps the duplicate section", async () => {
    mocks.fetch.mockImplementation(async (url) =>
        Response.json(
            String(url).includes("shares")
                ? { groups: [], nextOffset: null, openCount: 0 }
                : {
                      problems: [problem],
                      nextOffset: null,
                      counts: {
                          fact_conflict: 1,
                          correction_conflict: 0,
                          thin: 0,
                      },
                      limited: false,
                  },
        ),
    );
    render(
        <CareQueue
            initial={{ candidates: [], limited: false, nextCursor: null }}
            sessionKey="curator"
        />,
        { wrapper },
    );
    for (const name of [
        "Conflicting facts",
        "Corrections pointing two ways",
        "Thin records",
    ]) {
        fireEvent.click(
            screen.getByRole("button", { name: new RegExp(`^${name}`) }),
        );
        expect(await screen.findByText("Velnaro")).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: /^New from sharing/ }));
    expect(
        await screen.findByText(/Shares made before the upgrade/),
    ).toBeTruthy();
    fireEvent.click(
        screen.getByRole("button", { name: /^Possible duplicates/ }),
    );
    expect(screen.getByRole("button", { name: "People" })).toBeTruthy();
});
it("shows per-share additions, review links, safe undo outcomes and the private-title fallback", async () => {
    mocks.fetch.mockImplementation(async (_url, init) =>
        init?.method === "POST"
            ? Response.json({
                  removed: ["addition"],
                  kept: [{ id: "other", reason: "later_share" }],
              })
            : Response.json({
                  groups: [
                      {
                          id: "share",
                          item: null,
                          sharer: "Jitka Dvořáková",
                          createdAt: "2026-10-22T10:00:00Z",
                          reviewedAt: null,
                          undoneAt: null,
                          nextOffset: null,
                          additions: [
                              {
                                  id: "addition",
                                  kind: "person",
                                  targetId: "person",
                                  personId: "person",
                                  entityId: null,
                                  label: "Nela Starling",
                                  removedAt: null,
                                  keptReason: null,
                              },
                              {
                                  id: "other",
                                  kind: "entity",
                                  targetId: "term",
                                  personId: null,
                                  entityId: "term",
                                  label: "Velnaro",
                                  removedAt: null,
                                  keptReason: null,
                              },
                          ],
                      },
                  ],
                  nextOffset: null,
                  openCount: 1,
              }),
    );
    render(
        <CareQueue
            initial={{ candidates: [], limited: false, nextCursor: null }}
            sessionKey="curator"
        />,
        { wrapper },
    );
    fireEvent.click(screen.getByRole("button", { name: /^New from sharing/ }));
    expect(await screen.findByText("Item no longer shared")).toBeTruthy();
    expect(
        screen
            .getAllByRole("link", { name: "Review record" })[0]
            .getAttribute("href"),
    ).toBe("/almanac/person");
    fireEvent.click(
        screen.getByRole("button", {
            name: "Undo all additions from this share",
        }),
    );
    expect(await screen.findByText("Kept: used by a later share")).toBeTruthy();
    expect(screen.getByText("Removed 1; kept 1.")).toBeTruthy();
});
it("loads a share fix only when its folder flag is expanded", async () => {
    mocks.fetch.mockResolvedValue(
        Response.json({
            groups: [
                {
                    id: "share",
                    item: null,
                    sharer: "Jitka Dvořáková",
                    createdAt: "2026-10-22T10:00:00Z",
                    reviewedAt: null,
                    undoneAt: null,
                    nextOffset: null,
                    additions: [],
                },
            ],
            nextOffset: null,
            openCount: 1,
        }),
    );
    const { container } = render(
        <FolderCareFlags
            care={{
                problems: [],
                duplicates: [],
                shareRefs: [
                    { id: "subject", kind: "record", eventId: "share" },
                ],
            }}
            recordId="subject"
            onChanged={vi.fn()}
        />,
        { wrapper },
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
    const details = container.querySelector("details");
    if (!details) throw new Error("missing flag");
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(await screen.findByText("Item no longer shared")).toBeTruthy();
    expect(String(mocks.fetch.mock.calls[0][0])).toContain("eventId=share");
});
it("feeds the Care badge from the layout and avoids loading it for members", async () => {
    render(await AlmanacLayout({ children: null }), { wrapper });
    expect(screen.getByRole("link", { name: "Care7" })).toBeTruthy();
    expect(mocks.count).toHaveBeenCalledWith("curator");
    cleanup();
    mocks.count.mockClear();
    mocks.curator.mockResolvedValue(false);
    render(await AlmanacLayout({ children: null }), { wrapper });
    expect(screen.queryByRole("link", { name: /Care/ })).toBeNull();
    expect(mocks.count).not.toHaveBeenCalled();
});
