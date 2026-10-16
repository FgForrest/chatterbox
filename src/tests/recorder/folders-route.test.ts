import { beforeEach, describe, expect, it, vi } from "vitest";

const { gate, listFolderOrganization, orgEnabled } = vi.hoisted(() => ({
    gate: vi.fn(),
    listFolderOrganization: vi.fn(),
    orgEnabled: { value: true },
}));

vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
vi.mock("@/lib/recording-sessions/route-gate", () => ({
    gateRecordingSessionRequest: gate,
}));
vi.mock("@/lib/folders/folders", () => ({ listFolderOrganization }));
vi.mock("@/lib/org/config", () => ({
    isOrgScopeEnabled: () => orgEnabled.value,
}));

import { GET } from "@/app/api/v1/recorder/folders/route";

describe("GET /api/v1/recorder/folders", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        orgEnabled.value = true;
        gate.mockResolvedValue({
            authn: {
                user: { id: "owner" },
                via: "api-key",
                apiKeyId: "recorder-key",
                scopes: ["recordings:write"],
            },
        });
        listFolderOrganization.mockResolvedValue({
            folders: [
                {
                    id: "private-root",
                    parentId: null,
                    name: "Private",
                    scope: "personal",
                },
                {
                    id: "personal",
                    parentId: "private-root",
                    name: "Project",
                    scope: "personal",
                },
                {
                    id: "org-root",
                    parentId: null,
                    name: "Organization",
                    scope: "org",
                },
                {
                    id: "org",
                    parentId: "org-root",
                    name: "Sales",
                    scope: "org",
                },
            ],
            assignments: [],
        });
    });

    it("uses the recorder gate and excludes roots", async () => {
        const response = await GET(
            new Request("https://app.test/api/v1/recorder/folders"),
        );

        expect(gate).toHaveBeenCalledOnce();
        expect(listFolderOrganization).toHaveBeenCalledWith("owner");
        await expect(response.json()).resolves.toEqual({
            data: [
                {
                    id: "personal",
                    name: "Project",
                    path: "Private / Project",
                    scope: "personal",
                },
                {
                    id: "org",
                    name: "Sales",
                    path: "Organization / Sales",
                    scope: "org",
                },
            ],
        });
    });

    it("returns a rate-limit response from the shared gate", async () => {
        gate.mockResolvedValue({
            response: new Response("limited", { status: 429 }),
        });
        expect(
            (await GET(new Request("https://app.test/api/v1/recorder/folders")))
                .status,
        ).toBe(429);
        expect(listFolderOrganization).not.toHaveBeenCalled();
    });

    it("returns a scope rejection from the shared gate", async () => {
        gate.mockResolvedValue({
            response: new Response("forbidden", { status: 403 }),
        });
        expect(
            (await GET(new Request("https://app.test/api/v1/recorder/folders")))
                .status,
        ).toBe(403);
        expect(listFolderOrganization).not.toHaveBeenCalled();
    });

    it("excludes Organization folders when they are not writable", async () => {
        orgEnabled.value = false;
        const response = await GET(
            new Request("https://app.test/api/v1/recorder/folders"),
        );
        expect((await response.json()).data).toEqual([
            {
                id: "personal",
                name: "Project",
                path: "Private / Project",
                scope: "personal",
            },
        ]);
    });
});
