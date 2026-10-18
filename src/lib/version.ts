/**
 * The version this build runs: a release `YYYY.N` (calendar year, then the
 * release number within that year), `dev-<sha>` for an image built from the
 * `dev` branch, or `dev` for a local build. The image workflow sets it as a
 * build argument.
 */
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION?.trim() || "dev";

/** The GitHub repository (`owner/name`) this build comes from. */
export const APP_REPOSITORY =
    process.env.NEXT_PUBLIC_APP_REPOSITORY?.trim() || "FgForrest/chatterbox";

const CALVER_RE = /^(\d{4})\.(\d+)$/;

/** Whether `value` is a release version (`YYYY.N`). */
export function isReleaseVersion(value: string): boolean {
    return CALVER_RE.test(value);
}

/** Compare two `YYYY.N` versions. Returns `null` (not 0) on anything else. */
export function compareReleaseVersions(
    a: string,
    b: string,
): -1 | 0 | 1 | null {
    const pa = CALVER_RE.exec(a);
    const pb = CALVER_RE.exec(b);
    if (!pa || !pb) return null;
    for (let i = 1; i <= 2; i++) {
        const x = Number(pa[i]);
        const y = Number(pb[i]);
        if (x < y) return -1;
        if (x > y) return 1;
    }
    return 0;
}

/** The GitHub release page of a version, or the release list for a dev build. */
export function releaseUrlFor(version: string): string {
    const base = `https://github.com/${APP_REPOSITORY}/releases`;
    return isReleaseVersion(version) ? `${base}/tag/${version}` : base;
}

export const APP_RELEASE_URL = releaseUrlFor(APP_VERSION);
