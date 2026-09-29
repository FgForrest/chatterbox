import { describe, expect, it } from "vitest";
import { chooseLearnPath } from "@/lib/learn/provider";

describe("chooseLearnPath", () => {
    const mcpUrl = "http://riffado:3000/api/mcp/learn";
    const bridgeUrl = "http://agent-bridge:8787/v1";

    it("takes the bridge for its presets pointed at this instance's bridge, with the tools URL set", () => {
        for (const provider of ["Claude Code", "Codex"]) {
            expect(
                chooseLearnPath(
                    { provider, baseUrl: "HTTP://agent-bridge:8787/v1/" },
                    { mcpUrl, bridgeUrl },
                ),
            ).toBe("bridge");
            expect(
                chooseLearnPath(
                    { provider, baseUrl: bridgeUrl },
                    { mcpUrl: undefined, bridgeUrl },
                ),
            ).toBe("fallback");
        }
    });

    it("never sends a run's token to an endpoint merely labelled as a bridge", () => {
        expect(
            chooseLearnPath(
                { provider: "Codex", baseUrl: "https://attacker.example/v1" },
                { mcpUrl, bridgeUrl },
            ),
        ).toBe("fallback");
        expect(
            chooseLearnPath(
                { provider: "Codex", baseUrl: bridgeUrl },
                { mcpUrl, bridgeUrl: undefined },
            ),
        ).toBe("fallback");
        expect(
            chooseLearnPath(
                { provider: "OpenAI", baseUrl: bridgeUrl },
                { mcpUrl, bridgeUrl },
            ),
        ).toBe("fallback");
        expect(
            chooseLearnPath(
                { provider: "Claude Code", baseUrl: bridgeUrl },
                { mcpUrl, bridgeUrl, bridgeReady: false },
            ),
        ).toBe("fallback");
    });
});
