import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    recordIntent,
    requestAdvance,
    attachArriving,
    lockFolder,
    lockTree,
    mockEnv,
} = vi.hoisted(() => ({
    lockFolder: vi.fn(async () => {}),
    lockTree: vi.fn(async () => {}),
    mockEnv: { IS_HOSTED: false, SELF_HOST_MODE: "shared" },
    attachArriving: vi.fn(async () => {}),
    recordIntent: vi.fn(async () => {}),
    requestAdvance: vi.fn(async () => null),
}));

vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/db/queries/organization-tree", () => ({ lockOrgTree: lockTree }));

vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));

vi.mock("@/lib/folders/folders", () => ({
    lockCategorizableFolderInTx: lockFolder,
}));

vi.mock("@/lib/meetings/attachment", () => ({
    attachArrivingRecordingInTx: attachArriving,
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
    const tx = {
        insert: vi.fn(() => ({ values })),
        select: vi.fn(() => ({
            from: vi.fn(() => ({
                where: vi.fn(() => ({
                    limit: vi.fn(async () => [{ plaudFileId: "file" }]),
                })),
            })),
        })),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockEnv.IS_HOSTED = false;
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

        expect(lockTree).not.toHaveBeenCalled();
        expect(lockFolder).toHaveBeenCalledWith(
            tx,
            "owner",
            "personal-folder",
            false,
            undefined,
        );
        expect(lockFolder.mock.invocationCallOrder[0]).toBeLessThan(
            values.mock.invocationCallOrder[0],
        );
        expect(values).toHaveBeenCalledWith({
            itemId: "recording",
            userId: "owner",
            folderId: "personal-folder",
        });
        expect(onConflictDoNothing).toHaveBeenCalledOnce();
        expect(attachArriving).toHaveBeenCalledWith(
            tx,
            "owner",
            "recording",
            "file",
            undefined,
            undefined,
            false,
        );
        expect(onConflictDoNothing.mock.invocationCallOrder[0]).toBeLessThan(
            attachArriving.mock.invocationCallOrder[0] ?? 0,
        );
        expect(attachArriving.mock.invocationCallOrder[0]).toBeLessThan(
            requestAdvance.mock.invocationCallOrder[0] ?? 0,
        );
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
            canCurate: undefined,
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
    it("does not serialize hosted arrivals on a global Organization lock", async () => {
        mockEnv.IS_HOSTED = true;
        await requestArrivalInTx(tx as never, {
            itemId: "recording",
            userId: "owner",
        });
        expect(lockTree).not.toHaveBeenCalled();
        expect(requestAdvance).toHaveBeenCalledOnce();
    });
});
