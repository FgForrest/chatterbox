// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PersonPage from "@/app/(app)/almanac/[id]/page";
import EntityPage from "@/app/(app)/almanac/things/[id]/page";
import ThingsPage from "@/app/(app)/almanac/things/page";
import VocabularyPage from "@/app/(app)/almanac/vocabulary/page";
import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import type { KnowledgeTarget } from "@/lib/knowledge/aliases";
import type { PageRelation } from "@/lib/knowledge/fact-page";
import { listOwnTypes } from "@/lib/knowledge/vocabulary";

const viewer = vi.hoisted(() => ({ id: "curator" }));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
    notFound: () => {
        throw new Error("Not found");
    },
    redirect: vi.fn(),
}));
vi.mock("next-intl", () => ({
    useExtracted: () => (message: string, values?: Record<string, string>) =>
        Object.entries(values ?? {}).reduce(
            (text, [key, value]) => text.replace(`{${key}}`, value),
            message,
        ),
    useLocale: () => "en",
}));
vi.mock("next-intl/server", () => ({
    getExtracted: async () => (message: string) => message,
}));
vi.mock("@/lib/auth-server", () => ({
    requireAuth: async () => ({
        user: { id: viewer.id, email: `${viewer.id}@example.test` },
    }),
}));
vi.mock("@/lib/authz/curator", () => ({ userCuratesOrganizationNow: vi.fn() }));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => "org",
    isOrgAccount: async () => false,
}));
vi.mock("@/db", () => ({
    db: {
        select: () => ({
            from: () => {
                const chain = { innerJoin: () => chain, where: async () => [] };
                return chain;
            },
        }),
    },
}));
vi.mock("@/lib/knowledge/people", () => ({
    getPerson: async () => ({
        id: "person",
        displayName: "Karel Kratochvíl",
        primaryEmail: null,
        notes: null,
        mergedIntoId: null,
        scope: "org",
    }),
}));
vi.mock("@/lib/knowledge/entities", () => ({
    listEntities: async () => [],
    getEntity: async () => ({
        id: "thing",
        name: "Orion",
        typeKey: "project",
        description: null,
        notes: null,
        mergedIntoId: null,
        scope: "org",
    }),
}));
vi.mock("@/lib/knowledge/aliases", () => ({
    listAliases: async (_userId: string, target: KnowledgeTarget) =>
        (["org", "personal"] as const)
            .filter((scope) => viewer.id !== "org" || scope === "org")
            .map((scope) => ({
                id: `${scope}-alias`,
                text: `${scope} nickname`,
                kind: "alias" as const,
                scope,
                language: null,
                provider: null,
                personId: "personId" in target ? target.personId : null,
                entityId: "entityId" in target ? target.entityId : null,
            })),
    aliasTextsVisibleTo: async () => new Map(),
}));
vi.mock("@/lib/knowledge/fact-page", () => ({
    factsForPage: async (): Promise<PageRelation[]> => [
        {
            key: "described_as",
            label: "described as",
            facts: (["org", "personal"] as const)
                .filter((scope) => viewer.id !== "org" || scope === "org")
                .map((scope) => ({
                    id: `${scope}-fact`,
                    direction: "subject",
                    other: { kind: "literal", text: `${scope} fact` },
                    scope,
                    origin: "manual",
                    evidence: [],
                })),
        },
    ],
}));
vi.mock("@/lib/knowledge/vocabulary", () => ({
    listOwnTypes: vi.fn(async () => [
        {
            kind: "entity",
            key: "o_custom",
            label: "Initiative",
            adoptedFromShare: true,
            uses: 0,
        },
    ]),
    vocabularyVisibleTo: async () => ({
        entityTypes: [
            { kind: "entity", key: "project", label: "Project", layer: "core" },
            { kind: "entity", key: "o_team", label: "Team", layer: "org" },
            {
                kind: "entity",
                key: "u_initiative",
                label: "Private initiative",
                layer: "private",
            },
        ],
        relationTypes: [],
    }),
}));
vi.mock("@/lib/knowledge/vocabulary-labels", () => ({
    useVocabularyLabels: () => ({
        entityType: (key: string, fallback?: string) => fallback ?? key,
        relation: (key: string, fallback?: string) => fallback ?? key,
    }),
}));
vi.mock("@/lib/knowledge/vocabulary-labels-server", () => ({
    getVocabularyLabels: async () => ({
        entityType: (key: string, fallback?: string) => fallback ?? key,
        relation: (key: string, fallback?: string) => fallback ?? key,
    }),
}));

describe("curator Almanac pages", () => {
    beforeEach(() => {
        viewer.id = "curator";
        vi.mocked(userCuratesOrganizationNow).mockResolvedValue(true);
    });
    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
    });

    it("shows merge, rename, email and erase for a curator on an Organization person", async () => {
        render(await PersonPage({ params: Promise.resolve({ id: "person" }) }));
        for (const name of ["Merge into…", "Rename", "Erase", "This is me"]) {
            expect(screen.getByRole("button", { name })).toBeTruthy();
        }
        expect(userCuratesOrganizationNow).toHaveBeenCalledWith("curator");
    });

    it("hides person management from a member", async () => {
        vi.mocked(userCuratesOrganizationNow).mockResolvedValue(false);
        render(await PersonPage({ params: Promise.resolve({ id: "person" }) }));
        for (const name of ["Merge into…", "Rename", "Erase", "This is me"]) {
            expect(screen.queryByRole("button", { name })).toBeNull();
        }
    });

    it("shows Organization thing management to a curator", async () => {
        render(await EntityPage({ params: Promise.resolve({ id: "thing" }) }));
        for (const name of ["Merge into…", "Edit", "Change type", "Erase"]) {
            expect(screen.getByRole("button", { name })).toBeTruthy();
        }
    });

    it("hides Organization thing management from a member", async () => {
        vi.mocked(userCuratesOrganizationNow).mockResolvedValue(false);
        render(await EntityPage({ params: Promise.resolve({ id: "thing" }) }));
        for (const name of ["Merge into…", "Edit", "Change type", "Erase"]) {
            expect(screen.queryByRole("button", { name })).toBeNull();
        }
    });

    describe.each([
        ["person", PersonPage],
        ["thing", EntityPage],
    ] as const)("%s facts and nicknames", (id, page) => {
        it.each([
            ["curator", true],
            ["member", false],
        ] as const)("keeps personal controls and checks Organization controls for a %s", async (userId, canCurate) => {
            viewer.id = userId;
            vi.mocked(userCuratesOrganizationNow).mockResolvedValue(canCurate);
            render(await page({ params: Promise.resolve({ id }) }));

            for (const scope of ["org", "personal"] as const) {
                const fact = screen.getByText(`${scope} fact`).closest("li");
                expect(fact).not.toBeNull();
                if (!fact) throw new Error("Missing fact row");
                for (const name of ["Change fact", "Erase fact"]) {
                    const control = within(fact).queryByRole("button", {
                        name,
                    });
                    if (scope === "personal" || canCurate) {
                        expect(control).not.toBeNull();
                    } else {
                        expect(control).toBeNull();
                    }
                }
                expect(screen.getByText(`${scope} nickname`)).toBeTruthy();
                const remove = screen.queryByRole("button", {
                    name: `Remove ${scope} nickname`,
                });
                if (scope === "personal" || canCurate) {
                    expect(remove).not.toBeNull();
                } else {
                    expect(remove).toBeNull();
                }
            }
            expect(userCuratesOrganizationNow).toHaveBeenCalledWith(userId);
        });

        it("keeps Organization controls for the local Organization account", async () => {
            viewer.id = "org";
            render(await page({ params: Promise.resolve({ id }) }));
            for (const name of [
                "Change fact",
                "Erase fact",
                "Remove org nickname",
            ]) {
                expect(screen.getByRole("button", { name })).toBeTruthy();
            }
            expect(userCuratesOrganizationNow).toHaveBeenCalledWith("org");
        });
    });

    it("opens the Organization vocabulary for its curator", async () => {
        render(await VocabularyPage());
        expect(
            screen.getByRole("heading", { name: "Organization vocabulary" }),
        ).toBeTruthy();
        expect(screen.getByText("Initiative")).toBeTruthy();
        expect(listOwnTypes).toHaveBeenCalledWith("org");
    });
    it("keeps a curator's private vocabulary accessible", async () => {
        render(
            await VocabularyPage({
                searchParams: Promise.resolve({ scope: "personal" }),
            }),
        );
        expect(
            screen.getByRole("heading", { name: "Your vocabulary" }),
        ).toBeTruthy();
        expect(listOwnTypes).toHaveBeenCalledWith("curator");
    });

    it("offers private, Organization and core types for a curator's new private thing", async () => {
        render(await ThingsPage());
        fireEvent.click(screen.getByRole("button", { name: "Add thing" }));
        const choices = within(
            screen.getByRole("combobox", { name: "Kind of thing" }),
        );
        for (const name of ["Private initiative", "Team", "Project"]) {
            expect(choices.getByRole("option", { name })).toBeTruthy();
        }
    });

    it("shows members their private vocabulary only", async () => {
        vi.mocked(userCuratesOrganizationNow).mockResolvedValue(false);
        render(await VocabularyPage());
        expect(screen.queryByText("Organization vocabulary")).toBeNull();
        expect(listOwnTypes).toHaveBeenCalledWith("curator");
    });
});

vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (text: string) => text,
}));
vi.mock("@/lib/sharing/shared", () => ({
    sharedRecordingCondition: () => undefined,
}));
