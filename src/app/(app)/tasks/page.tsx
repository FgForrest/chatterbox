import { Suspense } from "react";
import { TaskList } from "@/components/tasks/task-list";
import { requireAuth } from "@/lib/auth-server";
import { isOrgAccount } from "@/lib/org/config";

export const dynamic = "force-dynamic";

/**
 * The tasks of the viewer: theirs to do (Mine), and those they keep an eye
 * on (Tracked: the rest of their recordings' tasks; for the organization
 * account, the shared recordings').
 */
export default async function TasksPage() {
    const session = await requireAuth();
    const organization = await isOrgAccount(session.user.id);
    return (
        <Suspense>
            <TaskList organization={organization} />
        </Suspense>
    );
}
