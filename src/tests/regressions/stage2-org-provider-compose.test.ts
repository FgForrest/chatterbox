import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Stage 2 Organization provider deploy surface", () => {
    it("passes the optional per-member call cap through official Compose", () => {
        const compose = readFileSync(
            join(process.cwd(), "docker-compose.yml"),
            "utf8",
        );
        expect(compose).toContain(
            "ORG_PROVIDER_CALLS_PER_MEMBER_PER_HOUR: $" +
                "{ORG_PROVIDER_CALLS_PER_MEMBER_PER_HOUR:-}",
        );
    });
});
