import Link from "next/link";
import { getExtracted } from "next-intl/server";
import { env } from "@/lib/env";
import { fetchLatestReleaseVersion } from "@/lib/releases";

import {
    APP_VERSION,
    compareReleaseVersions,
    releaseUrlFor,
} from "@/lib/version";

/**
 * Self-host-only "update available" indicator. Renders nothing on the
 * hosted instance (operators control deploys there -- a badge would be
 * noise + leak of internal state) and nothing when the operator opts
 * out via `DISABLE_UPDATE_CHECK=true`.
 *
 * Compares against the latest release of this build's own repository.
 * Failure modes degrade silently to "no badge":
 *   - GitHub API down / rate-limited      -> fetchLatestReleaseVersion() returns null
 *   - Egress blocked at network layer     -> fetchLatestReleaseVersion() returns null
 *   - Latest tag isn't a `YYYY.N` release -> fetchLatestReleaseVersion() returns null
 *   - A dev build (`dev`, `dev-<sha>`)    -> no comparison, returns null here
 *   - Current version >= latest           -> returns null here
 *
 * The fetch is cached 5 minutes (Next `revalidate: 300`) so this runs
 * at most ~12 times/hour per server, regardless of traffic.
 *
 * Server component on purpose: `env.IS_HOSTED` and `env.DISABLE_UPDATE_CHECK`
 * are server-only, and we don't want the badge to hydrate / flash on
 * the client.
 */
export async function UpdateBadge() {
    const i18n = await getExtracted();
    if (env.IS_HOSTED) return null;
    if (env.DISABLE_UPDATE_CHECK) return null;

    const latest = await fetchLatestReleaseVersion();
    if (!latest) return null;
    const cmp = compareReleaseVersions(APP_VERSION, latest);
    if (cmp === null) return null;
    if (cmp >= 0) return null;

    return (
        <Link
            href={releaseUrlFor(latest)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-primary/70 hover:text-primary transition-colors font-mono uppercase tracking-wider underline decoration-dotted underline-offset-2"
            aria-label={i18n("Update available: {version}", {
                version: latest,
            })}
            title={i18n(
                "Update available: {version} (running {currentVersion})",
                { version: latest, currentVersion: APP_VERSION },
            )}
        >
            {i18n("{version} available", { version: latest })}
        </Link>
    );
}
