import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordIntent, requestAdvance } = vi.hoisted(() => ({
    recordIntent: vi.fn(async () => {}),
    requestAdvance: vi.fn(async () => null),
}));

vi.mock("@/lib/pipeline/share-intent", () => ({
    recordIntendedPlacementInTx: recordIntent,
}));
vi.mock("@/lib/pipeline/trigger", () => ({
    requestAdvanceInTx: requestAdvance,
}));
vi.mock("@/lib/pipeline/state", () => ({
    updatePhaseInTx: vi.fn(),
}));
vi.mock("@/lib/profiles/resolve-for-placement", () => ({
    resolveProfileForPlacements: vi.fn(),
}));

import { requestArrivalInTx } from "@/lib/pipeline/arrival";

describe("folder-known-at-arrival", () => {
    const onConflictDoNothing = vi.fn(async () => {});
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const tx = { insert: vi.fn(() => ({ values })) };

    beforeEach(() => {
        vi.clearAllMocks();
        requestAdvance.mockResolvedValue(null);
    });

    it("creates a personal assignment before requesting processing", async () => {
        await requestArrivalInTx(tx as never, {
            itemId: "recording",
            userId: "owner",
            folder: {
                folderId: "personal-folder",
                ownerId: "owner",
                scope: "personal",
            },
        });

        expect(values).toHaveBeenCalledWith({
            itemId: "recording",
            userId: "owner",
            folderId: "personal-folder",
        });
        expect(onConflictDoNothing).toHaveBeenCalledOnce();
        expect(requestAdvance).toHaveBeenCalledWith(tx, {
            itemId: "recording",
            userId: "owner",
            view: "private",
            reason: "arrival",
        });
    });

    it("records an Organization intent before requesting processing", async () => {
        await requestArrivalInTx(tx as never, {
            itemId: "recording",
            userId: "owner",
            folder: {
                folderId: "org-folder",
                ownerId: "organization",
                scope: "org",
            },
        });

        expect(recordIntent).toHaveBeenCalledWith(tx, {
            ownerUserId: "owner",
            itemId: "recording",
            folderId: "org-folder",
            requestPipeline: false,
        });
        expect(tx.insert).not.toHaveBeenCalled();
        expect(requestAdvance).toHaveBeenCalledOnce();
    });

    it("leaves placement empty when the client chooses File later", async () => {
        await requestArrivalInTx(tx as never, {
            itemId: "recording",
            userId: "owner",
        });

        expect(tx.insert).not.toHaveBeenCalled();
        expect(recordIntent).not.toHaveBeenCalled();
        expect(requestAdvance).toHaveBeenCalledOnce();
    });
});
