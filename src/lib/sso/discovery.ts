import {
    type GenericOAuthConfig,
    genericOAuth,
} from "better-auth/plugins/generic-oauth";

/** Stop waiting for an operation after `timeoutMs`; the operation itself keeps running. */
export async function withSsoDeadline<T>(
    operation: Promise<T>,
    timeoutMs: number,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    reject(new Error("SSO initialization timed out"));
                }, timeoutMs);
                timer.unref?.();
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * The provider plugin with discovery bounded by `timeoutMs`: past the
 * deadline the instance initializes without the provider, and the late
 * discovery result is discarded. Provider and token validation stay the
 * library's.
 */
export function boundedSsoProvider(
    config: GenericOAuthConfig & { discoveryUrl: string },
    timeoutMs: number,
) {
    const plugin = genericOAuth({ config: [config] });
    const bounded: typeof plugin = {
        ...plugin,
        async init(context) {
            try {
                return await withSsoDeadline(plugin.init(context), timeoutMs);
            } catch {
                context.logger.warn("SSO discovery unavailable");
                return {
                    context: { socialProviders: context.socialProviders },
                };
            }
        },
    };
    return bounded;
}
