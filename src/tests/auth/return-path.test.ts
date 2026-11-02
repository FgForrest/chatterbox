import { describe, expect, it } from "vitest";
import { loginReturnPath } from "@/lib/auth/return-path";

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
