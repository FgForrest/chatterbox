import { describe, expect, it } from "vitest";
import { chooseLearnPath } from "@/lib/learn/provider";

describe("chooseLearnPath", () => {
    const mcpUrl = "http://riffado:3000/api/mcp/learn";

    it("takes the bridge for its presets, once built and pointed at the MCP URL", () => {
        for (const provider of ["Claude Code", "Codex"]) {
            expect(
                chooseLearnPath({ provider }, { mcpUrl, bridgeReady: true }),
            ).toBe("bridge");
            expect(
                chooseLearnPath(
                    { provider },
                    { mcpUrl: undefined, bridgeReady: true },
                ),
            ).toBe("fallback");
        }
    });

    it("takes the fallback for any other provider, and for all until the bridge path is built", () => {
        expect(
            chooseLearnPath(
                { provider: "OpenAI" },
                { mcpUrl, bridgeReady: true },
            ),
        ).toBe("fallback");
        expect(chooseLearnPath({ provider: "Claude Code" }, { mcpUrl })).toBe(
            "fallback",
        );
    });
});
