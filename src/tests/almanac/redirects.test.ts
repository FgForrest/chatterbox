import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";

describe("People became the Almanac", () => {
    it("sends old links to the new pages, entity pages to Things", async () => {
        const redirects = await nextConfig.redirects?.();
        expect(redirects).toEqual([
            {
                source: "/people/entities/:id",
                destination: "/almanac/things/:id",
                permanent: true,
            },
            {
                source: "/people/:path*",
                destination: "/almanac/:path*",
                permanent: true,
            },
        ]);
    });
});
