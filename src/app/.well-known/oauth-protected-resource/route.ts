import { protectedResourceMetadata } from "@/lib/mcp/metadata";

export const dynamic = "force-dynamic";

/** RFC 9728 metadata of the MCP resource, at the root fallback path. */
export function GET(): Promise<Response> {
    return protectedResourceMetadata();
}
