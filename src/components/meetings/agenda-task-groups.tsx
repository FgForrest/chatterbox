"use client";

import "./agenda-order.css";
import { ArrowDown, ArrowUp, ChevronDown, GripVertical } from "lucide-react";
import { useExtracted } from "next-intl";
import { type HTMLAttributes, type ReactNode, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ActionTooltip } from "@/components/ui/tooltip";
import { agendaTaskOrderPositions } from "@/lib/meetings/positions";
import {
    agendaTaskGroupKey,
    groupAgendaTasks,
} from "@/lib/meetings/task-groups";
import { cn } from "@/lib/utils";
import { moveBefore } from "./agenda-order";
import type { MeetingDetail, MeetingTask } from "./types";
import type { AgendaController } from "./use-agenda";
import { useAgendaCollapse } from "./use-agenda-collapse";

type Group = ReturnType<typeof groupAgendaTasks<MeetingTask>>[number];
interface RowControls {
    rowProps: HTMLAttributes<HTMLLIElement>;
    leading: ReactNode;
    actions: ReactNode;
}
type Drag =
    | { kind: "group"; key: string }
    | { kind: "task"; key: string; id: string };

function TaskGroup({
    agendaId,
    group,
    canEdit,
    groupDragging,
    headerControls,
    renderTask,
    onOrder,
    announce,
    drag,
}: {
    agendaId: string;
    group: Group;
    canEdit: boolean;
    groupDragging: boolean;
    headerControls: {
        props: HTMLAttributes<HTMLDivElement>;
        grip: ReactNode;
        actions: ReactNode;
    };
    renderTask: (task: MeetingTask, controls: RowControls) => ReactNode;
    onOrder: (group: Group, ids: string[]) => void;
    announce: (message: string) => void;
    drag: { current: Drag | null };
}) {
    const i18n = useExtracted();
    const key = agendaTaskGroupKey(group.name);
    const [collapsed, toggle] = useAgendaCollapse(agendaId, `group:${key}`);
    const [lifted, setLifted] = useState<string | null>(null);
    const [target, setTarget] = useState<{ id: string; after: boolean } | null>(
        null,
    );
    const name = group.name ?? i18n("No assignee");
    const move = (from: number, to: number, after = false) => {
        if (!canEdit || from < 0 || to < 0 || to >= group.tasks.length) return;
        const next = moveBefore(group.tasks, from, to, after);
        if (next.every((task, index) => task.id === group.tasks[index].id))
            return;
        onOrder(
            group,
            next.map((task) => task.id),
        );
        announce(
            i18n("Task {position, number} of {count, number}", {
                position:
                    next.findIndex((task) => task.id === group.tasks[from].id) +
                    1,
                count: next.length,
            }),
        );
    };
    return (
        <section className="space-y-2" aria-label={name}>
            <div
                {...headerControls.props}
                className={cn(
                    "agenda-order-row relative flex items-center gap-2 rounded-md py-1 text-sm font-medium",
                    headerControls.props.className,
                )}
            >
                {headerControls.grip}
                <ActionTooltip
                    label={
                        collapsed
                            ? i18n("Expand tasks: {name}", { name })
                            : i18n("Collapse tasks: {name}", { name })
                    }
                >
                    <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-expanded={!collapsed && !groupDragging}
                        aria-label={
                            collapsed
                                ? i18n("Expand tasks: {name}", { name })
                                : i18n("Collapse tasks: {name}", { name })
                        }
                        onClick={toggle}
                    >
                        <ChevronDown
                            className={cn(
                                "size-3.5",
                                !collapsed && !groupDragging && "rotate-180",
                            )}
                        />
                    </Button>
                </ActionTooltip>
                <span
                    className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px]"
                    aria-hidden="true"
                >
                    {group.name
                        ?.split(" ")
                        .map((word) => word[0])
                        .slice(0, 2)
                        .join("") ?? "?"}
                </span>
                <h3>{name}</h3>
                {!group.invited && group.name && (
                    <span className="rounded border px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                        {i18n("Not invited")}
                    </span>
                )}
                <span className="text-xs font-normal text-muted-foreground">
                    {i18n("{count, plural, one {# task} other {# tasks}}", {
                        count: group.tasks.length,
                    })}
                </span>
                {headerControls.actions}
            </div>
            {!collapsed && !groupDragging && (
                <ul
                    className="divide-y rounded-lg border"
                    onDragLeave={(event) => {
                        if (
                            !(event.relatedTarget instanceof Node) ||
                            !event.currentTarget.contains(event.relatedTarget)
                        )
                            setTarget(null);
                    }}
                >
                    {group.tasks.map((task, index) =>
                        renderTask(task, {
                            rowProps: {
                                tabIndex: canEdit ? 0 : undefined,
                                onKeyDown: (event) => {
                                    if (
                                        !canEdit ||
                                        !event.altKey ||
                                        !["ArrowUp", "ArrowDown"].includes(
                                            event.key,
                                        )
                                    )
                                        return;
                                    event.preventDefault();
                                    event.stopPropagation();
                                    move(
                                        index,
                                        index +
                                            (event.key === "ArrowUp" ? -1 : 1),
                                        event.key === "ArrowDown",
                                    );
                                },
                                onDragOver: (event) => {
                                    if (
                                        !canEdit ||
                                        drag.current?.kind !== "task" ||
                                        drag.current.key !== key
                                    ) {
                                        setTarget(null);
                                        return;
                                    }
                                    event.preventDefault();
                                    event.stopPropagation();
                                    event.dataTransfer.dropEffect = "move";
                                    const rect =
                                        event.currentTarget.getBoundingClientRect();
                                    setTarget({
                                        id: task.id,
                                        after:
                                            event.clientY >
                                            rect.top + rect.height / 2,
                                    });
                                },
                                onDrop: (event) => {
                                    if (
                                        !canEdit ||
                                        drag.current?.kind !== "task" ||
                                        drag.current.key !== key
                                    )
                                        return;
                                    event.preventDefault();
                                    event.stopPropagation();
                                    const rect =
                                        event.currentTarget.getBoundingClientRect();
                                    move(
                                        group.tasks.findIndex(
                                            (task) =>
                                                task.id ===
                                                (drag.current?.kind === "task"
                                                    ? drag.current.id
                                                    : null),
                                        ),
                                        index,
                                        event.clientY >
                                            rect.top + rect.height / 2,
                                    );
                                    drag.current = null;
                                    setLifted(null);
                                    setTarget(null);
                                },
                                className: cn(
                                    lifted === task.id &&
                                        "z-10 rounded border border-primary shadow-lg",
                                    target?.id === task.id &&
                                        (target.after
                                            ? "agenda-insert-after"
                                            : "agenda-insert-before"),
                                ),
                            },
                            leading: canEdit && (
                                <ActionTooltip label={i18n("Drag")}>
                                    <button
                                        type="button"
                                        className="agenda-handle mt-1 cursor-grab text-muted-foreground focus-visible:outline-ring"
                                        aria-label={i18n("Drag task")}
                                        draggable
                                        onDragStart={(event) => {
                                            event.stopPropagation();
                                            const row =
                                                event.currentTarget.closest(
                                                    "li",
                                                );
                                            if (row)
                                                event.dataTransfer.setDragImage?.(
                                                    row,
                                                    20,
                                                    20,
                                                );
                                            event.dataTransfer.effectAllowed =
                                                "move";
                                            event.dataTransfer.setData(
                                                "application/x-chatterbox-agenda-task",
                                                task.id,
                                            );
                                            drag.current = {
                                                kind: "task",
                                                key,
                                                id: task.id,
                                            };
                                            setLifted(task.id);
                                        }}
                                        onDragEnd={() => {
                                            drag.current = null;
                                            setLifted(null);
                                            setTarget(null);
                                        }}
                                    >
                                        <GripVertical className="size-4" />
                                    </button>
                                </ActionTooltip>
                            ),
                            actions: canEdit && (
                                <>
                                    <ActionTooltip label={i18n("Move up")}>
                                        <Button
                                            size="icon-xs"
                                            variant="ghost"
                                            aria-label={i18n("Move task up")}
                                            disabled={index === 0}
                                            onClick={() =>
                                                move(index, index - 1)
                                            }
                                        >
                                            <ArrowUp className="size-3" />
                                        </Button>
                                    </ActionTooltip>
                                    <ActionTooltip label={i18n("Move down")}>
                                        <Button
                                            size="icon-xs"
                                            variant="ghost"
                                            aria-label={i18n("Move task down")}
                                            disabled={
                                                index === group.tasks.length - 1
                                            }
                                            onClick={() =>
                                                move(index, index + 1, true)
                                            }
                                        >
                                            <ArrowDown className="size-3" />
                                        </Button>
                                    </ActionTooltip>
                                </>
                            ),
                        }),
                    )}
                </ul>
            )}
        </section>
    );
}

export function AgendaTaskGroups({
    detail,
    canEdit,
    mutate,
    renderTask,
}: {
    detail: MeetingDetail;
    canEdit: boolean;
    mutate: AgendaController["mutate"];
    renderTask: (task: MeetingTask, controls: RowControls) => ReactNode;
}) {
    const i18n = useExtracted();
    const drag = useRef<Drag | null>(null);
    const [lifted, setLifted] = useState<string | null>(null);
    const [target, setTarget] = useState<{
        key: string;
        after: boolean;
    } | null>(null);
    const [announcement, announce] = useState("");
    const allGroups = groupAgendaTasks(
        detail.tasks.filter((task) => !task.removedAt),
        detail.invitees,
        detail.taskGroupOrder,
    );
    const groups = allGroups.filter((group) => group.tasks.length);
    const moveGroup = (from: number, to: number, after = false) => {
        if (!canEdit || from < 0 || to < 0 || to >= groups.length) return;
        const next = moveBefore(groups, from, to, after);
        if (next.every((group, index) => group === groups[index])) return;
        const taskGroupOrder = [
            ...next,
            ...allGroups.filter((group) => !group.tasks.length),
        ].map((group) => agendaTaskGroupKey(group.name));
        void mutate(
            "",
            "PATCH",
            (value: MeetingDetail) => ({
                taskGroupOrder,
                previous: { taskGroupOrder: value.taskGroupOrder ?? [] },
            }),
            (value) => ({ ...value, taskGroupOrder }),
        );
        announce(
            i18n("{name}: {position, number} of {count, number}", {
                name: groups[from].name ?? i18n("No assignee"),
                position: next.indexOf(groups[from]) + 1,
                count: groups.length,
            }),
        );
    };
    return (
        <>
            <span className="sr-only" aria-live="polite">
                {announcement}
            </span>
            {groups.map((group, index) => {
                const key = agendaTaskGroupKey(group.name);
                const name = group.name ?? i18n("No assignee");
                return (
                    <TaskGroup
                        key={key}
                        agendaId={detail.id}
                        group={group}
                        canEdit={canEdit}
                        drag={drag}
                        groupDragging={lifted !== null}
                        announce={announce}
                        renderTask={renderTask}
                        onOrder={(group, taskIds) => {
                            const positions = agendaTaskOrderPositions(
                                group.tasks,
                            );
                            void mutate(
                                "/tasks",
                                "PATCH",
                                {
                                    groupKey: agendaTaskGroupKey(group.name),
                                    taskIds,
                                },
                                (value) => ({
                                    ...value,
                                    tasks: value.tasks.map((task) => {
                                        const index = taskIds.indexOf(task.id);
                                        return index < 0
                                            ? task
                                            : {
                                                  ...task,
                                                  position: positions[index],
                                              };
                                    }),
                                }),
                            );
                        }}
                        headerControls={{
                            props: {
                                tabIndex: canEdit ? 0 : undefined,
                                className: cn(
                                    lifted === key &&
                                        "border border-primary shadow-lg",
                                    target?.key === key &&
                                        (target.after
                                            ? "agenda-insert-after"
                                            : "agenda-insert-before"),
                                ),
                                onKeyDown: (event) => {
                                    if (
                                        !canEdit ||
                                        !event.altKey ||
                                        !["ArrowUp", "ArrowDown"].includes(
                                            event.key,
                                        )
                                    )
                                        return;
                                    event.preventDefault();
                                    moveGroup(
                                        index,
                                        index +
                                            (event.key === "ArrowUp" ? -1 : 1),
                                        event.key === "ArrowDown",
                                    );
                                },
                                onDragOver: (event) => {
                                    if (
                                        !canEdit ||
                                        drag.current?.kind !== "group"
                                    )
                                        return;
                                    event.preventDefault();
                                    event.dataTransfer.dropEffect = "move";
                                    const rect =
                                        event.currentTarget.getBoundingClientRect();
                                    setTarget({
                                        key,
                                        after:
                                            event.clientY >
                                            rect.top + rect.height / 2,
                                    });
                                },
                                onDragLeave: (event) => {
                                    if (
                                        !(
                                            event.relatedTarget instanceof Node
                                        ) ||
                                        !event.currentTarget.contains(
                                            event.relatedTarget,
                                        )
                                    )
                                        setTarget(null);
                                },
                                onDrop: (event) => {
                                    if (
                                        !canEdit ||
                                        drag.current?.kind !== "group"
                                    )
                                        return;
                                    event.preventDefault();
                                    const rect =
                                        event.currentTarget.getBoundingClientRect();
                                    moveGroup(
                                        groups.findIndex(
                                            (group) =>
                                                agendaTaskGroupKey(
                                                    group.name,
                                                ) === drag.current?.key,
                                        ),
                                        index,
                                        event.clientY >
                                            rect.top + rect.height / 2,
                                    );
                                    drag.current = null;
                                    setLifted(null);
                                    setTarget(null);
                                },
                            },
                            grip: canEdit && (
                                <ActionTooltip label={i18n("Drag")}>
                                    <button
                                        type="button"
                                        draggable
                                        aria-label={i18n("Drag tasks: {name}", {
                                            name,
                                        })}
                                        className="agenda-handle cursor-grab text-muted-foreground"
                                        onDragStart={(event) => {
                                            const header =
                                                event.currentTarget
                                                    .parentElement;
                                            if (header)
                                                event.dataTransfer.setDragImage?.(
                                                    header,
                                                    20,
                                                    20,
                                                );
                                            event.dataTransfer.effectAllowed =
                                                "move";
                                            event.dataTransfer.setData(
                                                "application/x-chatterbox-agenda-group",
                                                key,
                                            );
                                            drag.current = {
                                                kind: "group",
                                                key,
                                            };
                                            setLifted(key);
                                        }}
                                        onDragEnd={() => {
                                            drag.current = null;
                                            setLifted(null);
                                            setTarget(null);
                                        }}
                                    >
                                        <GripVertical className="size-4" />
                                    </button>
                                </ActionTooltip>
                            ),
                            actions: canEdit && (
                                <div className="agenda-actions ml-auto flex items-center gap-1">
                                    <ActionTooltip
                                        label={i18n("Move up: {name}", {
                                            name,
                                        })}
                                    >
                                        <Button
                                            size="icon-xs"
                                            variant="ghost"
                                            aria-label={i18n(
                                                "Move up: {name}",
                                                { name },
                                            )}
                                            disabled={index === 0}
                                            onClick={() =>
                                                moveGroup(index, index - 1)
                                            }
                                        >
                                            <ArrowUp className="size-3" />
                                        </Button>
                                    </ActionTooltip>
                                    <ActionTooltip
                                        label={i18n("Move down: {name}", {
                                            name,
                                        })}
                                    >
                                        <Button
                                            size="icon-xs"
                                            variant="ghost"
                                            aria-label={i18n(
                                                "Move down: {name}",
                                                { name },
                                            )}
                                            disabled={
                                                index === groups.length - 1
                                            }
                                            onClick={() =>
                                                moveGroup(
                                                    index,
                                                    index + 1,
                                                    true,
                                                )
                                            }
                                        >
                                            <ArrowDown className="size-3" />
                                        </Button>
                                    </ActionTooltip>
                                </div>
                            ),
                        }}
                    />
                );
            })}
        </>
    );
}
