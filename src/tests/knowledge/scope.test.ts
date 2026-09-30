import { describe, expect, it } from "vitest";
import { readableScopes } from "@/lib/knowledge/scope";

describe("readableScopes", () => {
    it("reads the Organization's and the owner's on a private recording", () => {
        expect(
            readableScopes(
                { kind: "recording", ownerUserId: "alice", shared: false },
                "org",
            ),
        ).toEqual(["org", "alice"]);
    });

    it("reads the Organization's alone on a shared recording", () => {
        expect(
            readableScopes(
                { kind: "recording", ownerUserId: "alice", shared: true },
                "org",
            ),
        ).toEqual(["org"]);
    });

    it("shows a person the Organization's and their own on the pages", () => {
        expect(
            readableScopes({ kind: "pages", viewerUserId: "bob" }, "org"),
        ).toEqual(["org", "bob"]);
        expect(
            readableScopes({ kind: "pages", viewerUserId: "org" }, "org"),
        ).toEqual(["org"]);
    });

    it("reads only one's own without an Organization", () => {
        expect(
            readableScopes(
                { kind: "recording", ownerUserId: "alice", shared: true },
                null,
            ),
        ).toEqual(["alice"]);
        expect(
            readableScopes({ kind: "pages", viewerUserId: "bob" }, null),
        ).toEqual(["bob"]);
    });
});
