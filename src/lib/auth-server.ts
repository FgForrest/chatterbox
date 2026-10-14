import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "@/db";
import { userSettings, users } from "@/db/schema";
import type { ActorContext } from "@/lib/authz/model";
import {
    type SessionAccess,
    type SessionRefusal,
    sessionAccess,
} from "@/lib/authz/session-access";
import {
    SSO_ACCESS_DENIED_ERROR,
    SSO_SESSION_ENDED_ERROR,
    SSO_UNAVAILABLE_ERROR,
} from "@/lib/sso/constants";
import { auth } from "./auth";
import { AppError, ErrorCode } from "./errors";

type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

/** The signed-in session and whether its access holds now. */
const getSessionWithAccess = cache(
    async (): Promise<{
        session: AuthSession;
        access: SessionAccess;
    } | null> => {
        const session = await auth.api.getSession({
            headers: await headers(),
        });
        if (!session?.user) return null;
        return {
            session,
            access: await sessionAccess({
                id: session.session.id,
                userId: session.user.id,
            }),
        };
    },
);

/** The signed-in session, or null when there is none or its access no longer holds. */
export const getSession = cache(async () => {
    const resolved = await getSessionWithAccess();
    return resolved?.access.ok ? resolved.session : null;
});

/** The server-side authorization context of the signed-in session, or null. */
export const getSessionActor = cache(async (): Promise<ActorContext | null> => {
    const resolved = await getSessionWithAccess();
    return resolved?.access.ok ? resolved.access.actor : null;
});

const LOGIN_ERRORS: Record<SessionRefusal, string> = {
    ended: SSO_SESSION_ENDED_ERROR,
    "not-granted": SSO_ACCESS_DENIED_ERROR,
    unavailable: SSO_UNAVAILABLE_ERROR,
    "org-account": SSO_SESSION_ENDED_ERROR,
};

/** Require an authenticated, non-suspended session. Redirects on failure. */
export async function requireAuth() {
    const resolved = await getSessionWithAccess();

    if (!resolved) {
        redirect("/login");
    }
    if (!resolved.access.ok) {
        redirect(`/login?error=${LOGIN_ERRORS[resolved.access.reason]}`);
    }
    const { session } = resolved;

    const [u] = await db
        .select({ suspendedAt: users.suspendedAt })
        .from(users)
        .where(eq(users.id, session.user.id))
        .limit(1);
    if (u?.suspendedAt) {
        redirect("/suspended");
    }

    return session;
}

/**
 * Redirects to `/dashboard` unless the session's account has finished
 * onboarding (`userSettings.onboardingCompleted`). Call after
 * `requireAuth()` from any authenticated content page other than
 * `/dashboard` itself, which owns the mandatory onboarding dialog and
 * must not redirect into itself.
 *
 * Deliberately separate from `requireAuth()` (rather than folded into
 * it) so it doesn't blanket-apply to every `requireAuth()` caller --
 * notably `/dev/demo-dashboard`, which renders fixtures, not a real
 * account, and must never be gated on this.
 */
export async function requireCompletedOnboarding(
    session: NonNullable<Awaited<ReturnType<typeof getSession>>>,
) {
    const [row] = await db
        .select({ onboardingCompleted: userSettings.onboardingCompleted })
        .from(userSettings)
        .where(eq(userSettings.userId, session.user.id))
        .limit(1);

    if (!row?.onboardingCompleted) {
        redirect("/dashboard");
    }
}

export async function redirectIfAuthenticated() {
    const session = await getSession();

    if (session?.user) {
        redirect("/dashboard");
    }
}

/** The API error for a session whose access does not hold. */
export function sessionRefusalError(reason: SessionRefusal): AppError {
    switch (reason) {
        case "not-granted":
            return new AppError(
                ErrorCode.ACCESS_NOT_GRANTED,
                "Your access to this application has been withdrawn",
                403,
            );
        case "unavailable":
            return new AppError(
                ErrorCode.ACCESS_UNVERIFIABLE,
                "Your access could not be verified right now. Try again shortly.",
                503,
            );
        default:
            return new AppError(
                ErrorCode.AUTH_SESSION_MISSING,
                "Unauthorized",
                401,
            );
    }
}

/** API-route auth gate. Throws typed `AppError` on failure. */
export async function requireApiSession(
    request: Request,
): Promise<AuthSession> {
    return (await requireApiSessionActor(request)).session;
}

/** API-route auth gate that also returns the server-side actor context. */
export async function requireApiSessionActor(request: Request): Promise<{
    session: AuthSession;
    actor: ActorContext;
    authTime: Date | null;
}> {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
        throw new AppError(ErrorCode.AUTH_SESSION_MISSING, "Unauthorized", 401);
    }
    const access = await sessionAccess({
        id: session.session.id,
        userId: session.user.id,
    });
    if (!access.ok) throw sessionRefusalError(access.reason);

    const [u] = await db
        .select({ suspendedAt: users.suspendedAt })
        .from(users)
        .where(eq(users.id, session.user.id))
        .limit(1);

    if (u?.suspendedAt) {
        throw new AppError(
            ErrorCode.ACCOUNT_SUSPENDED,
            "Account suspended",
            403,
        );
    }

    return { session, actor: access.actor, authTime: access.authTime };
}
