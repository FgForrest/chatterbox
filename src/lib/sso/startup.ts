import {
    clearSsoSessionsMarker,
    revokeSessionsOnSsoSwitch,
} from "@/db/queries/sso";
import { env } from "@/lib/env";
import { isSsoConfiguredButIgnored, isSsoEnabled } from "@/lib/sso/config";

/**
 * Startup hook: the first start with single sign-on ends every session
 * opened with a password; a start without it re-arms that for next time.
 */
export async function startSso(): Promise<void> {
    if (env.IS_HOSTED) {
        if (isSsoConfiguredButIgnored()) {
            console.warn(
                "[sso] OIDC_* variables are set but single sign-on is self-host only; ignored because IS_HOSTED=true",
            );
        }
        return;
    }
    try {
        if (!isSsoEnabled()) {
            await clearSsoSessionsMarker();
            return;
        }
        const ended = await revokeSessionsOnSsoSwitch();
        if (ended !== null) {
            console.log(
                `[sso] single sign-on switched on: ended ${ended} existing session(s)`,
            );
        }
    } catch (error) {
        console.error("[sso] could not end pre-SSO sessions:", error);
    }
}
