// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { createTranslator } from "use-intl/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messagesForLocale } from "@/lib/i18n/messages";

vi.mock("next-intl/server", () => ({
    getExtracted: vi.fn(async () => (message: string) => message),
    getTranslations: vi.fn(async () =>
        createTranslator({ locale: "en", messages: messagesForLocale("en") }),
    ),
}));
vi.mock("@/components/people/suggested-relations", () => ({
    SuggestedRelations: () => null,
}));
vi.mock("@/lib/auth-server", () => ({
    requireAuth: vi.fn(async () => ({
        user: { id: "user-1", email: "person@example.test" },
    })),
}));
vi.mock("@/lib/knowledge/availability", () => ({
    isLearnDeploymentAvailable: vi.fn(() => true),
}));
vi.mock("@/lib/knowledge/phrase-groups", () => ({ groupPhrases: vi.fn() }));
vi.mock("@/lib/knowledge/vocabulary", () => ({
    listVocabularyProposals: vi.fn(async () => []),
    vocabularyVisibleTo: vi.fn(async () => ({
        entityTypes: [],
        relationTypes: [],
    })),
}));
vi.mock("@/lib/learn/pending", () => ({ reviewQueue: vi.fn() }));
vi.mock("@/lib/org/config", () => ({ getOrgUserId: vi.fn(async () => "org") }));
vi.mock("@/lib/authz/curator", () => ({ userCuratesOrganizationNow: vi.fn() }));
vi.mock("@/db", () => ({
    db: {
        select: () => ({
            from: () => ({ where: async () => [{ id: "rec-1" }] }),
        }),
    },
}));
vi.mock("@/lib/tasks/access", () => ({
    taskViewer: vi.fn(async () => ({ kind: "user", userId: "user-1" })),
}));
vi.mock("@/lib/tasks/tasks", () => ({
    recordingsAwaitingTaskReview: vi.fn(),
}));

import ReviewQueuePage from "@/app/(app)/almanac/review/page";
import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import { reviewQueue } from "@/lib/learn/pending";
import { recordingsAwaitingTaskReview } from "@/lib/tasks/tasks";

describe("Waiting for review links", () => {
    beforeEach(() => {
        vi.mocked(userCuratesOrganizationNow).mockResolvedValue(false);
        vi.mocked(reviewQueue).mockResolvedValue([]);
        vi.mocked(recordingsAwaitingTaskReview).mockResolvedValue([]);
    });

    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
    });

    it("opens a mail Learn review in the dashboard pane", async () => {
        vi.mocked(reviewQueue).mockResolvedValue([
            { id: "mail / 1", filename: "Budget reply", startTime: new Date() },
        ]);

        render(await ReviewQueuePage());

        expect(
            screen.getByRole("link", { name: "Review" }).getAttribute("href"),
        ).toBe("/dashboard?recording=mail+%2F+1");
    });

    it("deep-links both Organization review sections to their items", async () => {
        vi.mocked(userCuratesOrganizationNow).mockResolvedValue(true);
        vi.mocked(reviewQueue).mockImplementation(
            async (_userId, organization) =>
                organization
                    ? [
                          {
                              id: "mail-1",
                              filename: "Shared mail",
                              startTime: new Date(),
                          },
                      ]
                    : [],
        );
        vi.mocked(recordingsAwaitingTaskReview).mockResolvedValue([
            {
                recordingId: "rec-1",
                title: "Shared recording",
                proposals: 1,
                kind: "audio",
            },
        ]);

        render(await ReviewQueuePage());

        expect(
            screen
                .getAllByRole("link", {
                    name: "Open the Organization library",
                })
                .map((link) => link.getAttribute("href")),
        ).toEqual([
            "/dashboard?recording=mail-1&view=org",
            "/dashboard?recording=rec-1&view=org",
        ]);
    });
    it("keeps a curator's private reviews and task links alongside shared ones", async () => {
        vi.mocked(userCuratesOrganizationNow).mockResolvedValue(true);
        vi.mocked(reviewQueue).mockImplementation(
            async (_userId, organization) => [
                {
                    id: organization ? "shared" : "private",
                    filename: organization ? "Shared review" : "Private review",
                    startTime: new Date(),
                },
            ],
        );
        vi.mocked(recordingsAwaitingTaskReview).mockResolvedValue([
            {
                recordingId: "private-task",
                title: "Private tasks",
                proposals: 1,
                kind: "audio",
            },
        ]);
        render(await ReviewQueuePage());
        expect(
            screen
                .getByRole("link", { name: "Open the Organization library" })
                .getAttribute("href"),
        ).toBe("/dashboard?recording=shared&view=org");
        expect(
            screen
                .getAllByRole("link", { name: "Review" })
                .map((link) => link.getAttribute("href")),
        ).toEqual([
            "/dashboard?recording=private",
            "/dashboard?recording=private-task",
        ]);
        expect(reviewQueue).toHaveBeenCalledWith("user-1", false);
        expect(reviewQueue).toHaveBeenCalledWith("org", true);
    });
});
