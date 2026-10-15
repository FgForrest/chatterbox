import {
    type AdminContext,
    assertAccessAdministrator,
} from "@/lib/access/service";
import { requireApiSessionActor } from "@/lib/auth-server";

/** The signed-in administrator of an access-management request. */
export async function requireAccessAdministrator(
    request: Request,
): Promise<AdminContext> {
    const { session, actor, authTime } = await requireApiSessionActor(request);
    const context: AdminContext = {
        actor,
        session: { id: session.session.id, userId: session.user.id },
        authTime,
    };
    assertAccessAdministrator(context);
    return context;
}
