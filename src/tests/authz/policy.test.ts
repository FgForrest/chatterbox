/**
 * The authorization catalog and policy: implications are validated
 * (unknown grants, cycles, duplicates), expansion is transitive and drops
 * anything unknown, and no capability implies another except as listed.
 */

import { describe, expect, it } from "vitest";
import {
    CAPABILITIES,
    IMPLICATIONS,
    isCapability,
    isGrant,
    MCP_PERMISSIONS,
} from "@/lib/authz/catalog";
import type { ActorContext } from "@/lib/authz/model";
import {
    CatalogError,
    expandGrants,
    hasCapability,
    mayCurate,
    mayManageAccess,
    mayUse,
    validateImplications,
} from "@/lib/authz/policy";

function actor(...capabilities: string[]): Pick<ActorContext, "capabilities"> {
    return { capabilities: expandGrants(capabilities) };
}

describe("authorization catalog", () => {
    it("names three capabilities and six MCP permissions", () => {
        expect([...CAPABILITIES]).toEqual([
            "use",
            "org.curate",
            "access.manage",
        ]);
        expect(MCP_PERMISSIONS).toHaveLength(6);
        expect(isGrant("tasks:write")).toBe(true);
        expect(isGrant("realm-admin")).toBe(false);
        expect(isCapability("tasks:read")).toBe(false);
    });

    it("implies tasks:read from tasks:write and nothing else", () => {
        expect(IMPLICATIONS).toEqual([
            { from: "tasks:write", to: "tasks:read" },
        ]);
        expect([...expandGrants(["tasks:write"])].sort()).toEqual([
            "tasks:read",
            "tasks:write",
        ]);
        expect([...expandGrants(["access.manage"])]).toEqual(["access.manage"]);
        expect([...expandGrants(["org.curate"])]).toEqual(["org.curate"]);
    });

    it("drops unknown grants instead of passing them through", () => {
        expect([
            ...expandGrants(["use", "admin", 3, null, "realm-admin"]),
        ]).toEqual(["use"]);
    });

    it("expands transitively", () => {
        const chain = [
            { from: "mail:read", to: "summaries:read" },
            { from: "summaries:read", to: "transcripts:read" },
        ] as const;
        expect([...expandGrants(["mail:read"], chain)].sort()).toEqual([
            "mail:read",
            "summaries:read",
            "transcripts:read",
        ]);
    });

    it.each([
        [[{ from: "nope", to: "use" }], "unknown grant nope"],
        [[{ from: "use", to: "nope" }], "unknown grant nope"],
        [[{ from: "use", to: "use" }], "use implies itself"],
        [
            [
                { from: "use", to: "org.curate" },
                { from: "use", to: "org.curate" },
            ],
            "duplicate implication",
        ],
        [
            [
                { from: "use", to: "org.curate" },
                { from: "org.curate", to: "access.manage" },
                { from: "access.manage", to: "use" },
            ],
            "implication cycle",
        ],
    ])("refuses invalid implications %#", (implications, message) => {
        expect(() =>
            validateImplications(
                implications as unknown as Parameters<
                    typeof validateImplications
                >[0],
            ),
        ).toThrow(CatalogError);
        expect(() =>
            validateImplications(
                implications as unknown as Parameters<
                    typeof validateImplications
                >[0],
            ),
        ).toThrow(message);
    });

    it("accepts the shipped implications", () => {
        expect(() => validateImplications(IMPLICATIONS)).not.toThrow();
    });
});

describe("authorization policy", () => {
    it("refuses everything without use", () => {
        const noUse = actor("org.curate", "access.manage");
        expect(mayUse(noUse)).toBe(false);
        expect(mayCurate(noUse)).toBe(false);
        expect(mayManageAccess(noUse)).toBe(false);
        expect(hasCapability(noUse, "org.curate")).toBe(false);
    });

    it("keeps curation and access management independent", () => {
        const admin = actor("use", "access.manage");
        expect(mayManageAccess(admin)).toBe(true);
        expect(mayCurate(admin)).toBe(false);

        const curator = actor("use", "org.curate");
        expect(mayCurate(curator)).toBe(true);
        expect(mayManageAccess(curator)).toBe(false);
    });

    it("lets a plain user use the application only", () => {
        const user = actor("use");
        expect(mayUse(user)).toBe(true);
        expect(mayCurate(user)).toBe(false);
        expect(mayManageAccess(user)).toBe(false);
    });
});
