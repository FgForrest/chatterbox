/**
 * Which path a Learn run takes (Task 3.7), recorded on the run:
 * - `bridge` (path 1): the credential points at this instance's agent
 *   bridge (`LEARN_BRIDGE_URL`, compared exactly) with a Claude Code or
 *   Codex preset, and the bridge can call Riffado's tools back
 *   (`LEARN_MCP_URL`): only then does a run's token leave the server. The
 *   preset name alone is a label a person can type on any endpoint;
 * - `fallback` (path 2): anything else; the server does the lookups
 *   itself (`run-fallback.ts`).
 */

export type LearnPath = "bridge" | "fallback";

/** Presets that run a CLI through the agent bridge. */
const BRIDGE_PRESETS = new Set(["Claude Code", "Codex"]);

/** The bridge path is built (Task 3.6, on Spike 0.1's flags). */
export const BRIDGE_PATH_READY = true;

/** A base URL as compared: no trailing slashes, scheme and host lower case. */
export function normalizeBaseUrl(url: string | null | undefined): string {
    if (!url) return "";
    try {
        const parsed = new URL(url.trim());
        return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`.toLowerCase();
    } catch {
        return "";
    }
}

export function chooseLearnPath(
    credentials: { provider: string; baseUrl?: string | null },
    {
        mcpUrl,
        bridgeUrl,
        bridgeReady = BRIDGE_PATH_READY,
    }: {
        mcpUrl: string | undefined;
        bridgeUrl: string | undefined;
        bridgeReady?: boolean;
    },
): LearnPath {
    const bridge = normalizeBaseUrl(bridgeUrl);
    return bridgeReady &&
        mcpUrl &&
        bridge &&
        BRIDGE_PRESETS.has(credentials.provider) &&
        normalizeBaseUrl(credentials.baseUrl) === bridge
        ? "bridge"
        : "fallback";
}
