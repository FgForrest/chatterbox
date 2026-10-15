import { AsyncLocalStorage } from "node:async_hooks";
import type { Capability } from "@/lib/authz/catalog";
import type { VerifiedIdentity } from "@/lib/identity/ports";
import type { ProviderTokens } from "@/lib/sso/tokens";

/**
 * What a verified sign-in callback grants: the identity from the verified
 * ID token, the capabilities from the verified access token, and the
 * tokens that renew them. Lives only for the callback request.
 */
export interface LoginGrant {
    identity: VerifiedIdentity;
    capabilities: Capability[];
    tokens: ProviderTokens;
}

interface AuthRequestScope {
    grant: LoginGrant | null;
    startedAt: Date;
}

const storage = new AsyncLocalStorage<AuthRequestScope>();

/** Run one auth request with its own scope for a login grant. */
export function runInAuthRequest<T>(run: () => T): T {
    return storage.run({ grant: null, startedAt: new Date() }, run);
}

/** Keep the verified grant of this sign-in for the session it creates. */
export function setLoginGrant(grant: LoginGrant): void {
    const scope = storage.getStore();
    if (!scope) {
        throw new Error("A login grant outside an auth request");
    }
    scope.grant = grant;
}

/** The verified grant of this request's sign-in, or null. */
export function currentLoginGrant(): LoginGrant | null {
    return storage.getStore()?.grant ?? null;
}

/** When this callback began, before exchanging its authorization code. */
export function authRequestStartedAt(): Date {
    const scope = storage.getStore();
    if (!scope) throw new Error("An auth callback outside an auth request");
    return scope.startedAt;
}
