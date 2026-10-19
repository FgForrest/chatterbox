import { notFound } from "next/navigation";
import { TaskDetail } from "@/components/tasks/task-detail";
import { getSessionActor, requireAuth } from "@/lib/auth-server";
import { taskViewer } from "@/lib/tasks/access";
import { getCallerTask } from "@/lib/tasks/tasks";

export default async function TaskPage({
    params,
}: {
    params: Promise<{ taskId: string }>;
}) {
    const session = await requireAuth();
    const actor = await getSessionActor();
    const viewer = await taskViewer(session.user, actor ?? undefined);
    const { taskId } = await params;
    const task = await getCallerTask(viewer, taskId);
    if (!task) notFound();
    return <TaskDetail key={task.id} initialTask={task} />;
}
