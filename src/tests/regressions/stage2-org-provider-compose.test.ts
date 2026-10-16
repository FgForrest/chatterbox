import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
    process.env.NEXT_PHASE = "phase-production-build";
});

import { envSchema } from "@/lib/env";

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

    it("defaults an unset or empty call cap to 60", () => {
        expect(envSchema.parse({}).ORG_PROVIDER_CALLS_PER_MEMBER_PER_HOUR).toBe(
            60,
        );
        expect(
            envSchema.parse({
                ORG_PROVIDER_CALLS_PER_MEMBER_PER_HOUR: "",
            }).ORG_PROVIDER_CALLS_PER_MEMBER_PER_HOUR,
        ).toBe(60);
    });

    it("uses a configured numeric call cap", () => {
        expect(
            envSchema.parse({
                ORG_PROVIDER_CALLS_PER_MEMBER_PER_HOUR: "17",
            }).ORG_PROVIDER_CALLS_PER_MEMBER_PER_HOUR,
        ).toBe(17);
    });

    it("rejects a non-numeric call cap", () => {
        expect(() =>
            envSchema.parse({
                ORG_PROVIDER_CALLS_PER_MEMBER_PER_HOUR: "sixty",
            }),
        ).toThrow();
    });
});
