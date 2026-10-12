import { describe, expect, it } from "vitest";
import {
    compareReleaseVersions,
    isReleaseVersion,
    releaseUrlFor,
} from "../lib/version";

describe("isReleaseVersion", () => {
    it("accepts YYYY.N", () => {
        expect(isReleaseVersion("2026.1")).toBe(true);
        expect(isReleaseVersion("2026.123")).toBe(true);
    });

    it("rejects dev builds, semver and v-prefixed tags", () => {
        expect(isReleaseVersion("dev")).toBe(false);
        expect(isReleaseVersion("dev-abc1234")).toBe(false);
        expect(isReleaseVersion("0.6.4")).toBe(false);
        expect(isReleaseVersion("v2026.1")).toBe(false);
        expect(isReleaseVersion("2026.1.0")).toBe(false);
    });
});

describe("compareReleaseVersions", () => {
    it("orders by year, then by number as a number", () => {
        expect(compareReleaseVersions("2026.2", "2026.10")).toBe(-1);
        expect(compareReleaseVersions("2026.10", "2026.2")).toBe(1);
        expect(compareReleaseVersions("2026.99", "2027.1")).toBe(-1);
        expect(compareReleaseVersions("2026.3", "2026.3")).toBe(0);
    });

    it("returns null when either side is not a release", () => {
        expect(compareReleaseVersions("dev-abc1234", "2026.1")).toBeNull();
        expect(compareReleaseVersions("2026.1", "v0.6.4")).toBeNull();
    });
});

describe("releaseUrlFor", () => {
    it("links a release to its tag page and a dev build to the release list", () => {
        expect(releaseUrlFor("2026.4")).toMatch(/\/releases\/tag\/2026\.4$/);
        expect(releaseUrlFor("dev-abc1234")).toMatch(/\/releases$/);
    });
});
