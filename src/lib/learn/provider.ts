/**
 * Which path a Learn run takes (Task 3.7), recorded on the run:
 * - `bridge` (path 1): the Claude Code or Codex preset, which runs the CLI
 *   through the agent bridge, calling Riffado's tools over MCP, when this
 *   instance names the MCP URL the bridge may call (`LEARN_MCP_URL`) and
 *   the bridge path is built;
 * - `fallback` (path 2): any other chat provider, and the bridge until
 *   then; the server does the lookups itself (`run-fallback.ts`).
 */

export type LearnPath = "bridge" | "fallback";

/** Presets that run a CLI through the agent bridge. */
const BRIDGE_PRESETS = new Set(["Claude Code", "Codex"]);

/** The bridge path is built (Task 3.6, on Spike 0.1's flags). */
export const BRIDGE_PATH_READY = true;

export function chooseLearnPath(
    credentials: { provider: string },
    {
        mcpUrl,
        bridgeReady = BRIDGE_PATH_READY,
    }: { mcpUrl: string | undefined; bridgeReady?: boolean },
): LearnPath {
    return bridgeReady && mcpUrl && BRIDGE_PRESETS.has(credentials.provider)
        ? "bridge"
        : "fallback";
}
