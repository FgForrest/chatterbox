import { vi } from "vitest";
import type { ActorContext } from "@/lib/authz/model";

/** The actor `requireApiSessionActor` gives a signed-in user in `AUTHZ_MODE=local`. */
export function localActor(userId: string): ActorContext {
    return {
        kind: "user",
        actorId: userId,
        issuer: null,
        subject: null,
        capabilities: new Set(["use"]),
        clientId: null,
        clientPermissions: new Set(),
        verifiedAt: null,
    };
}

/**
 * A mocked `@/lib/auth-server` with `requireApiSessionActor` built on its
 * own `requireApiSession`, so routes that need the actor see the same user.
 */
export function withSessionActor<
    T extends {
        requireApiSession: (
            request: Request,
        ) => Promise<{ user: { id: string } }>;
    },
>(mocked: T) {
    return {
        ...mocked,
        requireApiSessionActor: vi.fn(async (request: Request) => {
            const session = await mocked.requireApiSession(request);
            return {
                session,
                actor: localActor(session.user.id),
                authTime: null,
            };
        }),
    };
}
