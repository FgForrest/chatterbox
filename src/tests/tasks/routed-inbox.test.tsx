// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppNav } from "@/components/app-nav";
import { RoutedProposalsInbox } from "@/components/tasks/routed-proposals-inbox";

vi.mock("next-intl", () => ({
    useExtracted: () => (text: string, values?: Record<string, unknown>) =>
        text.replace(/\{(\w+)\}/g, (_match, key: string) =>
            String(values?.[key] ?? ""),
        ),
    useLocale: () => "en",
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/tasks" }));

const dueProposal = {
    id: "routed-due",
    kind: "due" as const,
    sourceItemId: "mail-1",
    taskId: "task-1",
    taskText: "Send the contract",
    dueDate: "2026-10-29",
    duePhrase: null,
    quote: "Move it to next Thursday",
    evidenceStartMs: null,
    evidenceText: { segmentIndex: 1, charStart: 4, charEnd: 28 },
    version: 2,
    sourceItem: { id: "mail-1", kind: "mail" as const, title: "Re: Contract" },
    attachedBy: null,
};

describe("routed proposals inbox", () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("shows an obsolete re-check reason after Apply", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ proposals: [dueProposal] }))
            .mockResolvedValueOnce(
                Response.json({
                    state: "obsolete",
                    obsoleteReason: "version_changed",
                }),
            );
        vi.stubGlobal("fetch", fetchMock);
        render(<RoutedProposalsInbox />);

        fireEvent.click(await screen.findByRole("button", { name: "Apply" }));
        expect(
            await screen.findByText(
                "Obsolete: the task changed after this proposal was made.",
            ),
        ).toBeTruthy();
        expect(
            screen.getByRole("link", { name: "Show evidence in mail" }),
        ).toBeTruthy();
    });

    it("renders attach_merge as a notice with Dismiss only", async () => {
        const notice = {
            ...dueProposal,
            id: "notice-1",
            kind: "attach_merge" as const,
            dueDate: null,
            evidenceText: null,
            attachedBy: { id: "user-2", name: "Bo" },
        };
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ proposals: [notice] }))
            .mockResolvedValueOnce(
                Response.json({ state: "rejected", obsoleteReason: null }),
            );
        vi.stubGlobal("fetch", fetchMock);
        render(<RoutedProposalsInbox />);

        expect(
            await screen.findByText(
                "Bo attached their task Send the contract from Re: Contract",
            ),
        ).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
        fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
        await waitFor(() =>
            expect(fetchMock).toHaveBeenLastCalledWith(
                "/api/recordings/mail-1/tasks/updates/notice-1",
                expect.objectContaining({ method: "PATCH" }),
            ),
        );
    });

    it("shows the routed-proposal count in the Tasks navigation badge", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) =>
                Response.json({
                    count: String(url).startsWith("/api/tasks") ? 2 : 0,
                }),
            ),
        );
        render(<AppNav />);
        await screen.findByText("2");
        expect(
            document
                .querySelector('a[href="/tasks"]')
                ?.getAttribute("aria-label"),
        ).toContain("new task or proposal for you");
    });
});
