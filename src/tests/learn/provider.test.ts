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

    it("takes the fallback for any other provider, and for all when the bridge path is off", () => {
        expect(
            chooseLearnPath(
                { provider: "OpenAI" },
                { mcpUrl, bridgeReady: true },
            ),
        ).toBe("fallback");
        expect(
            chooseLearnPath(
                { provider: "Claude Code" },
                { mcpUrl, bridgeReady: false },
            ),
        ).toBe("fallback");
    });

    it("is built: the bridge presets take it by default where the MCP URL is set", () => {
        expect(chooseLearnPath({ provider: "Codex" }, { mcpUrl })).toBe(
            "bridge",
        );
    });
});
