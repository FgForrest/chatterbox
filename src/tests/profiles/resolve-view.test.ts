import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getProfile: vi.fn(),
    ensureProfiles: vi.fn(),
    select: vi.fn(),
}));

vi.mock("@/db", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: vi.fn().mockResolvedValue("org-1"),
    isOrgScopeEnabled: vi.fn().mockReturnValue(true),
}));
vi.mock("@/lib/profiles/seed", () => ({
    ensureProfiles: mocks.ensureProfiles,
}));
vi.mock("@/lib/profiles/store", () => ({ getProfile: mocks.getProfile }));
vi.mock("@/lib/encryption/fields", () => ({
    decryptText: vi.fn((value: string | null) => value),
}));
vi.mock("@/lib/profiles/access", () => ({
    mayUseProfile: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
}));

import { ErrorCode } from "@/lib/errors";
import {
    loadSelectedProfileRevision,
    resolveSelectedProfile,
} from "@/lib/profiles/resolve";

function noRows() {
    return {
        from: () => ({
            innerJoin: () => ({
                where: () => ({ limit: () => Promise.resolve([]) }),
            }),
        }),
    };
}

describe("Organization profile selection", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.ensureProfiles.mockResolvedValue(undefined);
        mocks.getProfile.mockResolvedValue(null);
        mocks.select.mockImplementation(noRows);
    });

    it("does not resolve the actor's personal profile on the Organization view", async () => {
        await expect(
            resolveSelectedProfile({
                profileId: "personal-profile",
                actorUserId: "member-1",
                view: "org",
            }),
        ).resolves.toBeNull();

        expect(mocks.getProfile).toHaveBeenCalledTimes(1);
        expect(mocks.getProfile).toHaveBeenCalledWith(
            "org-1",
            "personal-profile",
            "member-1",
        );
    });

    it("rejects a personal immutable revision on the Organization view", async () => {
        await expect(
            loadSelectedProfileRevision({
                revisionId: "personal-revision",
                actorUserId: "member-1",
                channel: "audio",
                view: "org",
            }),
        ).rejects.toMatchObject({
            code: ErrorCode.INVALID_INPUT,
            statusCode: 400,
        });

        expect(mocks.select).toHaveBeenCalledTimes(1);
    });
});
