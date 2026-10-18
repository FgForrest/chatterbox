import { describe, expect, it } from "vitest";
import { defaultProfileRule } from "@/lib/profiles/default-rule";

describe.each([
    {
        name: "uses a usable explicit pointer",
        input: {
            pointerId: "org-explicit",
            pointerProfileId: "org-explicit",
            personalDefaultId: "personal",
            organizationDefaultId: "org-default",
        },
        expected: {
            kind: "resolved",
            profileId: "org-explicit",
            source: "pointer",
        },
    },
    {
        name: "stops when an explicit pointer is unavailable",
        input: {
            pointerId: "org-explicit",
            pointerProfileId: null,
            personalDefaultId: "personal",
            organizationDefaultId: "org-default",
        },
        expected: {
            kind: "explicit_unavailable",
            profileId: "org-explicit",
        },
    },
    {
        name: "keeps an existing personal default",
        input: {
            pointerId: null,
            pointerProfileId: null,
            personalDefaultId: "personal",
            organizationDefaultId: "org-default",
        },
        expected: {
            kind: "resolved",
            profileId: "personal",
            source: "personal",
        },
    },
    {
        name: "follows the Organization default without a personal default",
        input: {
            pointerId: null,
            pointerProfileId: null,
            personalDefaultId: null,
            organizationDefaultId: "org-default",
        },
        expected: {
            kind: "resolved",
            profileId: "org-default",
            source: "organization",
        },
    },
    {
        name: "reports a missing default when no source exists",
        input: {
            pointerId: null,
            pointerProfileId: null,
            personalDefaultId: null,
            organizationDefaultId: null,
        },
        expected: { kind: "missing" },
    },
])("defaultProfileRule: $name", ({ input, expected }) => {
    it("selects the expected branch", () => {
        expect(defaultProfileRule(input)).toEqual(expected);
    });
});
