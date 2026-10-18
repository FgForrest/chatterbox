import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
    profileDeleteDisposition: vi.fn(),
    listActorProfiles: vi.fn(),
    getDefaultProfileState: vi.fn(),
}));

vi.mock("@/lib/org/config", () => ({ getOrgUserId: async () => null }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));
vi.mock("@/lib/profiles/access", () => ({
    mayEditProfile: async () => false,
}));
vi.mock("@/lib/profiles/providers", () => ({
    validateProfileProviderPins: vi.fn(),
}));
vi.mock("@/lib/profiles/store", () => ({
    createProfile: vi.fn(),
    getDefaultProfileState: mocks.getDefaultProfileState,
    listActorProfiles: mocks.listActorProfiles,
    profileDeleteDisposition: mocks.profileDeleteDisposition,
}));
vi.mock("@/app/api/settings/profiles/_shared", () => ({
    ensureActorProfiles: vi.fn(),
    parseSettings: vi.fn(),
    profileChannelSchema: z.enum(["audio", "mail"]),
    profileDetail: vi.fn(),
    profileRouteActor: async () => ({
        userId: "user-1",
        actor: {
            kind: "user",
            actorId: "user-1",
            capabilities: new Set(["use"]),
        },
    }),
    profileScopeSchema: z.enum(["personal", "organization"]),
    profileSummary: async (profile: unknown) => profile,
    validationError: vi.fn(),
}));

import { GET } from "@/app/api/settings/profiles/route";

describe("profile list route", () => {
    it("does not inspect profile history while listing profiles", async () => {
        const profile = {
            id: "profile-1",
            name: "Recordings",
            channel: "audio",
            scope: "personal",
        };
        mocks.listActorProfiles.mockResolvedValue({
            items: [profile],
            total: 1,
        });
        mocks.getDefaultProfileState.mockResolvedValue({
            effective: profile,
            organizationDefault: null,
            source: "personal",
            pointerId: null,
            explicitUnavailable: false,
        });

        const response = await GET(
            new Request(
                "https://app.example.test/api/settings/profiles?channel=audio&pageSize=100",
            ),
        );

        expect(response.status).toBe(200);
        expect(mocks.profileDeleteDisposition).not.toHaveBeenCalled();
    });
});
