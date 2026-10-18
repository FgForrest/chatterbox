import { describe, expect, it } from "vitest";
import { buildReportBugMailto, buildReportBugUrl } from "@/lib/report-bug";

function query(url: string): URLSearchParams {
    return new URL(url).searchParams;
}

describe("buildReportBugUrl", () => {
    it("opens a blank issue with the report as title and body", () => {
        const params = query(
            buildReportBugUrl({
                isHosted: false,
                errorId: "err-1",
                page: "/dashboard",
                locale: "en",
            }),
        );

        expect(params.has("template")).toBe(false);
        expect(params.get("title")).toBe("Chatterbox bug report (err-1)");
        expect(params.get("body")).toContain("Error id: `err-1`");
        expect(params.get("body")).toContain("Page: `/dashboard`");
        expect(params.get("body")).toContain("Mode: Self-hosted");
    });

    it("keeps the upstream name and mode on hosted", () => {
        const params = query(
            buildReportBugUrl({
                isHosted: true,
                errorId: "err-2",
                locale: "cs-CZ",
                name: "Riffado",
            }),
        );

        expect(params.get("title")).toBe("Riffado bug report (err-2)");
        expect(params.get("body")).toContain("Mode: Hosted (riffado.com)");
    });

    it("names the product in the interface language", () => {
        const params = query(
            buildReportBugUrl({ isHosted: false, locale: "cs-CZ" }),
        );

        expect(params.get("title")).toBe("Klepna bug report");
    });
});

describe("buildReportBugMailto", () => {
    it("leaves the recipient empty on self-host", () => {
        expect(buildReportBugMailto({ isHosted: false, locale: "en" })).toMatch(
            /^mailto:\?subject=Chatterbox%20bug%20report&body=/,
        );
    });

    it("addresses support on hosted", () => {
        expect(
            buildReportBugMailto({
                isHosted: true,
                locale: "en",
                name: "Riffado",
            }),
        ).toMatch(
            /^mailto:support@riffado\.com\?subject=Riffado%20bug%20report&body=/,
        );
    });
});
