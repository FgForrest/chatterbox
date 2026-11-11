import { expect, it, vi } from "vitest";
import { loadPrivateCategorizationPanel } from "@/lib/pipeline/categorization-presentation";

const mock = vi.hoisted(() => ({ folders: vi.fn() }));
vi.mock("@/db", () => ({
    db: {
        select: () => {
            const chain = {
                from: () => chain,
                leftJoin: () => chain,
                where: () =>
                    Object.assign(Promise.resolve([]), {
                        limit: async () => [
                            {
                                kind: "audio",
                                currentProfileId: null,
                                viewerLocale: "en",
                            },
                        ],
                    }),
            };
            return chain;
        },
    },
}));
vi.mock("@/lib/authz/curator", () => ({
    userCuratesOrganizationNow: async () => false,
}));
vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (value: string) => value,
}));
vi.mock("@/lib/folders/folders", () => ({
    listFolderOrganization: mock.folders,
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => "org",
    isOrgScopeEnabled: () => true,
}));
vi.mock("@/lib/profiles/seed", () => ({ ensureProfiles: async () => {} }));
vi.mock("@/lib/profiles/store", () => ({
    listProfiles: async () => ({ items: [] }),
    getDefaultProfileState: async () => ({ organizationDefault: null }),
}));
vi.mock("@/lib/profiles/resolve-for-placement", () => ({
    resolveProfileForPlacements: async () => ({
        status: "choose",
        candidates: [{ kind: "manual_only" }],
    }),
}));
it.each([
    "restricted",
    "restricting",
])("carries %s and authorized metadata through the categorization projection", async (flag) => {
    mock.folders.mockResolvedValue({
        folders: [
            {
                id: "org",
                parentId: null,
                scope: "org",
                kind: "public",
                name: "Organization",
            },
            {
                id: "r",
                parentId: "org",
                scope: "org",
                kind: "custom",
                name: "Acme pilot",
                [flag]: true,
                access: true,
                restrictedRole: "manager",
                managers: [{ name: "Robin Fields" }],
                accessRequest: "none",
            },
        ],
        assignments: [{ recordingId: "item", folderId: "r" }],
    });
    const data = await loadPrivateCategorizationPanel("owner", "item");
    expect(data?.folders.find((folder) => folder.id === "r")).toMatchObject({
        [flag]: true,
        access: true,
        restrictedRole: "manager",
        managers: [{ name: "Robin Fields" }],
        accessRequest: "none",
    });
    expect(data?.selectedFolderIds).toEqual(["r"]);
    expect(mock.folders).toHaveBeenLastCalledWith("owner");
});
