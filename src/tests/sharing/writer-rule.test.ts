/**
 * The writer rule of a shared recording: by default only the organization
 * account changes it; a caller the server vouched for (a curator) acts for
 * the Organization when told so, and nobody else does.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/env", () => ({ env: {} }));

import { writerRefusal } from "@/lib/sharing/writer-rule";

const base = { ownerUserId: "owner", orgUserId: "org" };

describe("writerRefusal", () => {
    it("keeps the organization account the only writer of a shared recording by default", () => {
        expect(
            writerRefusal({ ...base, actorUserId: "org", shared: true }),
        ).toBeNull();
        expect(
            writerRefusal({ ...base, actorUserId: "curator", shared: true }),
        ).toBe("shared");
        expect(
            writerRefusal({ ...base, actorUserId: "owner", shared: true }),
        ).toBe("shared");
    });

    it("lets a vouched-for curator write a shared recording, under their own id", () => {
        expect(
            writerRefusal({
                ...base,
                actorUserId: "curator",
                shared: true,
                actsForOrganization: true,
            }),
        ).toBeNull();
    });

    it("refuses even the organization account when the server says it does not act for the Organization", () => {
        expect(
            writerRefusal({
                ...base,
                actorUserId: "org",
                shared: true,
                actsForOrganization: false,
            }),
        ).toBe("shared");
    });

    it("leaves an unshared recording to its owner, curator or not", () => {
        expect(
            writerRefusal({
                ...base,
                actorUserId: "owner",
                shared: false,
                actsForOrganization: false,
            }),
        ).toBeNull();
        expect(
            writerRefusal({
                ...base,
                actorUserId: "curator",
                shared: false,
                actsForOrganization: true,
            }),
        ).toBe("withdrawn");
    });
});
