import { APP_REPOSITORY, isReleaseVersion } from "@/lib/version";

/**
 * The newest release of this build's repository (`YYYY.N`), or null when
 * GitHub cannot be reached or the latest release carries another kind of tag.
 * Cached for five minutes.
 */
export async function fetchLatestReleaseVersion(): Promise<string | null> {
    try {
        const res = await fetch(
            `https://api.github.com/repos/${APP_REPOSITORY}/releases/latest`,
            {
                headers: {
                    Accept: "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
                next: { revalidate: 300 },
            },
        );
        if (!res.ok) return null;
        const data = (await res.json()) as { tag_name?: unknown };
        const tag = typeof data.tag_name === "string" ? data.tag_name : null;
        return tag && isReleaseVersion(tag) ? tag : null;
    } catch {
        return null;
    }
}
