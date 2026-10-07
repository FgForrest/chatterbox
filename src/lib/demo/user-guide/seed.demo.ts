import { writeFileSync } from "node:fs";
import { afterAll, expect, it } from "vitest";
import { sqlClient } from "@/db";
import { seedUserGuideDemo } from "./seed";

const confirmed = process.env.USER_GUIDE_SEED === "wipe-this-database";

afterAll(async () => {
    await sqlClient?.end();
});

it.runIf(confirmed)(
    "seeds the user guide's demo data",
    async () => {
        const result = await seedUserGuideDemo();
        const out = process.env.USER_GUIDE_SEED_OUT;
        if (out) writeFileSync(out, JSON.stringify(result, null, 2));
        expect(result.audio.length).toBeGreaterThan(0);
    },
    120_000,
);
