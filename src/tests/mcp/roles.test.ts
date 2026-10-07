import { describe, expect, it } from "vitest";
import { rolesFromPayload } from "@/lib/mcp/roles";

const AUDIENCE = "riffado-mcp";

function payload(roles: unknown): Record<string, unknown> {
    return {
        resource_access: {
            [AUDIENCE]: { roles },
            other: { roles: ["tasks:write", "knowledge:read"] },
        },
    };
}

describe("rolesFromPayload", () => {
    it("reads the audience client's roles only", () => {
        expect([
            ...rolesFromPayload(payload(["knowledge:read"]), AUDIENCE),
        ]).toEqual(["knowledge:read"]);
        expect(
            rolesFromPayload(
                { resource_access: { other: { roles: ["tasks:read"] } } },
                AUDIENCE,
            ).size,
        ).toBe(0);
    });

    it("ignores realm roles", () => {
        expect(
            rolesFromPayload(
                { realm_access: { roles: ["knowledge:read"] } },
                AUDIENCE,
            ).size,
        ).toBe(0);
    });

    it("ignores unknown roles and junk", () => {
        expect(
            rolesFromPayload(
                payload(["admin", 3, null, "transcripts:read"]),
                AUDIENCE,
            ),
        ).toEqual(new Set(["transcripts:read"]));
        expect(rolesFromPayload({}, AUDIENCE).size).toBe(0);
        expect(rolesFromPayload({ resource_access: "x" }, AUDIENCE).size).toBe(
            0,
        );
        expect(
            rolesFromPayload(
                { resource_access: { [AUDIENCE]: null } },
                AUDIENCE,
            ).size,
        ).toBe(0);
        expect(rolesFromPayload(payload("tasks:read"), AUDIENCE).size).toBe(0);
    });

    it("does not read inherited properties as a client", () => {
        expect(
            rolesFromPayload(payload(["knowledge:read"]), "toString").size,
        ).toBe(0);
    });

    it("drops tasks:write without tasks:read", () => {
        expect(rolesFromPayload(payload(["tasks:write"]), AUDIENCE).size).toBe(
            0,
        );
        expect(
            rolesFromPayload(payload(["tasks:write", "tasks:read"]), AUDIENCE),
        ).toEqual(new Set(["tasks:read", "tasks:write"]));
    });

    it("grants every known role", () => {
        expect(
            rolesFromPayload(
                payload([
                    "knowledge:read",
                    "transcripts:read",
                    "summaries:read",
                    "tasks:read",
                    "tasks:write",
                ]),
                AUDIENCE,
            ).size,
        ).toBe(5);
    });
});
