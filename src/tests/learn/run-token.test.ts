import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: { BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00" },
}));

import {
    issueLearnRunToken,
    LEARN_RUN_TOKEN_MAX_AGE_MS,
    verifyLearnRunToken,
} from "@/lib/learn/run-token";

describe("Learn run tokens", () => {
    const now = 1_790_000_000_000;

    it("names the run it was issued for, within its lifetime", () => {
        const token = issueLearnRunToken("Run-AbC_1", now);
        expect(verifyLearnRunToken(token, now + 1_000)).toBe("Run-AbC_1");
        expect(
            verifyLearnRunToken(token, now + LEARN_RUN_TOKEN_MAX_AGE_MS + 1),
        ).toBeNull();
        // Not before it was issued (a clock pointed back).
        expect(verifyLearnRunToken(token, now - 60_000)).toBeNull();
    });

    it("refuses a token for another run, a changed time, or a forged signature", () => {
        const token = issueLearnRunToken("run-1", now);
        const [version, , issued, signature] = token.split(".");
        expect(
            verifyLearnRunToken(
                [version, "run-2", issued, signature].join("."),
                now,
            ),
        ).toBeNull();
        expect(
            verifyLearnRunToken(
                [version, "run-1", String(now + 5), signature].join("."),
                now + 10,
            ),
        ).toBeNull();
        expect(
            verifyLearnRunToken(
                [version, "run-1", issued, "A".repeat(43)].join("."),
                now,
            ),
        ).toBeNull();
        expect(verifyLearnRunToken("garbage", now)).toBeNull();
        expect(verifyLearnRunToken("", now)).toBeNull();
    });

    it("is signed with a key of its own, not the server secret itself", () => {
        const signature = createHmac(
            "sha256",
            "test-secret-test-secret-test-secret-00",
        )
            .update(`riffado:learn-run-token\nrun-1\n${now}`)
            .digest("base64url");
        expect(
            verifyLearnRunToken(
                ["lr1", "run-1", String(now), signature].join("."),
                now,
            ),
        ).toBeNull();
    });
});
