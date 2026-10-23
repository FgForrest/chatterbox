import { beforeEach, describe, expect, it, vi } from "vitest";

const { holderAccessMock, isIdpAuthorizationMock, taskViewerMock } = vi.hoisted(
    () => ({
        holderAccessMock: vi.fn(),
        isIdpAuthorizationMock: vi.fn(),
        taskViewerMock: vi.fn(
            async (
                user: { id: string; email: string },
                actor: { capabilities: ReadonlySet<string> },
            ) => ({
                userId: user.id,
                emailHash: user.email,
                isOrg: false,
                isCurator: actor.capabilities.has("curate"),
                orgUserId: "scope-org",
            }),
        ),
    }),
);

vi.mock("@/lib/authz/access-state", () => ({
    holderAccess: holderAccessMock,
}));
vi.mock("@/lib/org/config", () => ({ isOrgScopeVisible: () => false }));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/identity/factory", () => ({
    isIdpAuthorization: isIdpAuthorizationMock,
}));
vi.mock("@/lib/tasks/access", () => ({
    taskViewer: taskViewerMock,
    taskViewerById: vi.fn(),
}));

import type { McpCaller } from "@/lib/mcp/caller";
import { taskViewerFor } from "@/lib/mcp/scope";

const caller: McpCaller = {
    kind: "user",
    userId: "scope-user",
    email: "scope-user@example.test",
    subject: "scope-subject",
    clientId: "scope-client",
    roles: new Set(["tasks:read"]),
    orgUserId: "scope-org",
};

describe("MCP task viewer authorization", () => {
    beforeEach(() => {
        holderAccessMock.mockReset();
        isIdpAuthorizationMock.mockReset();
        taskViewerMock.mockClear();
    });

    it("uses local capabilities only in local authorization mode", async () => {
        isIdpAuthorizationMock.mockReturnValue(false);

        await taskViewerFor(caller);

        const actor = taskViewerMock.mock.calls[0]?.[1];
        expect([
            ...((actor?.capabilities as ReadonlySet<string>) ?? []),
        ]).toEqual(["use"]);
        expect(holderAccessMock).not.toHaveBeenCalled();
    });

    it("fails closed without capabilities or curator rights when IdP access resolution fails", async () => {
        isIdpAuthorizationMock.mockReturnValue(true);
        holderAccessMock.mockResolvedValue({
            ok: false,
            reason: "unavailable",
        });

        const viewer = await taskViewerFor(caller);

        const actor = taskViewerMock.mock.calls[0]?.[1];
        expect([
            ...((actor?.capabilities as ReadonlySet<string>) ?? []),
        ]).toEqual([]);
        expect(viewer.isCurator).toBe(false);
    });
});
