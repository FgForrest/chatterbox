import { describe, expect, it } from "vitest";
import { canChangeItem } from "@/lib/sharing/change-permission";

describe("canChangeItem", () => {
    it.each([
        {
            name: "private own unshared",
            input: {
                view: "private",
                isOwn: true,
                isOrgAccount: false,
                canCurate: false,
            },
            expected: true,
        },
        {
            name: "private own shared",
            input: {
                view: "private",
                isOwn: true,
                isOrgAccount: false,
                canCurate: false,
            },
            expected: true,
        },
        {
            name: "private not own",
            input: {
                view: "private",
                isOwn: false,
                isOrgAccount: false,
                canCurate: true,
            },
            expected: false,
        },
        {
            name: "owner in Organization view",
            input: {
                view: "org",
                isOwn: true,
                isOrgAccount: false,
                canCurate: false,
            },
            expected: true,
        },
        {
            name: "Organization account",
            input: {
                view: "org",
                isOwn: false,
                isOrgAccount: true,
                canCurate: false,
            },
            expected: true,
        },
        {
            name: "curator who is not the Organization account",
            input: {
                view: "org",
                isOwn: false,
                isOrgAccount: false,
                canCurate: true,
            },
            expected: true,
        },
        {
            name: "Organization viewer without either permission",
            input: {
                view: "org",
                isOwn: false,
                isOrgAccount: false,
                canCurate: false,
            },
            expected: false,
        },
    ] as const)("returns $expected for $name", ({ input, expected }) => {
        expect(canChangeItem(input)).toBe(expected);
    });
});
