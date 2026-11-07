import { describe, expect, it } from "vitest";
import {
    loginRedirectPath,
    loginReturnPath,
    loginReturnPathWithFragment,
} from "@/lib/auth/return-path";

describe("loginReturnPath", () => {
    it.each([
        "/dashboard?x=1",
        "/tasks#notes",
        "/",
        "/recordings/example",
    ])("accepts %s", (path) => {
        expect(loginReturnPath(path)).toBe(path);
    });
    it.each([
        "//evil.example",
        "https://evil.example",
        "/\\evil",
        "javascript:",
        "/%5cevil",
        "/%2fevil.example",
        "/..//evil.example",
        "/\nevil",
        "/%0aevil",
        "dashboard",
        "",
        null,
        undefined,
        ["/tasks"],
        "/%ZZ",
    ])("refuses %s", (path) => {
        expect(loginReturnPath(path)).toBe("/dashboard");
    });
});

describe("loginRedirectPath", () => {
    it.each([
        "/dashboard?meeting=example",
        "/tasks/example",
        "/almanac/example",
        `/${"a".repeat(1023)}`,
    ])("carries %s with or without an error", (path) => {
        expect(loginRedirectPath(path)).toBe(
            `/login?returnTo=${encodeURIComponent(path)}`,
        );
        expect(loginRedirectPath(path, "example-error")).toBe(
            `/login?error=example-error&returnTo=${encodeURIComponent(path)}`,
        );
    });

    it.each([
        undefined,
        null,
        "/dashboard",
        "//evil.example",
        "/%2fevil.example",
        "https://evil.example",
        `/${"a".repeat(1024)}`,
    ])("omits unsafe, default, or oversized returnTo=%s", (path) => {
        expect(loginRedirectPath(path)).toBe("/login");
        expect(loginRedirectPath(path, "example-error")).toBe(
            "/login?error=example-error",
        );
    });

    it("encodes the error independently of the destination", () => {
        const url = new URL(
            loginRedirectPath(
                "/tasks/example",
                "example&returnTo=//evil.example",
            ),
            "https://example.com",
        );
        expect(url.searchParams.get("error")).toBe(
            "example&returnTo=//evil.example",
        );
        expect(url.searchParams.getAll("returnTo")).toEqual(["/tasks/example"]);
    });
});

describe("loginReturnPathWithFragment", () => {
    it.each([
        ["/settings", "#notifications", "/settings#notifications"],
        ["/tasks?example=1", "#notes", "/tasks?example=1#notes"],
        ["/settings#storage", "#notifications", "/settings#storage"],
        ["/settings", "", "/settings"],
        ["/settings", "notifications", "/settings"],
        [undefined, "#notifications", "/dashboard"],
        ["/dashboard", "#notifications", "/dashboard"],
        ["https://evil.example", "#notifications", "/dashboard"],
        ["/%2fevil.example", "#notifications", "/dashboard"],
        ["/settings", "#%0aexample", "/dashboard"],
    ])("resolves %s with inherited fragment %s", (path, fragment, expected) => {
        expect(loginReturnPathWithFragment(path, fragment)).toBe(expected);
    });
});
