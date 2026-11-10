"use client";

import "./agenda-order.css";

import {
    ArrowDown,
    ArrowUp,
    GripVertical,
    IndentDecrease,
    IndentIncrease,
    Trash2,
} from "lucide-react";
import { useExtracted, useFormatter } from "next-intl";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { LinkedText } from "@/components/ui/linked-text";
import { LinkedTextField } from "@/components/ui/linked-text-field";
import { Textarea } from "@/components/ui/textarea";
import { ActionTooltip } from "@/components/ui/tooltip";
import { hasAgendaContributors } from "@/lib/meetings/attribution";
import type { TreePoint } from "@/lib/meetings/model";
import { moveAgendaPoint, pointSiblings } from "@/lib/meetings/point-order";
import { getPasswordManagerAttributes } from "@/lib/password-manager";
import { cn } from "@/lib/utils";
import {
    outlineDrop,
    outlineMove,
    outlineReorder,
    outlineRows,
} from "./outline";
import { measureCaretLines, pointArrowDirection } from "./point-navigation";
import type { MeetingDetail, MeetingPoint } from "./types";
import { useAgendaText } from "./use-agenda-text";

type PointPatch = {
    text?: string;
    parentId?: string | null;
    position?: number;
    siblingIndex?: number;
    discussed?: boolean;
    note?: string | null;
};
export type { PointPatch };
type PointBindings = Map<string, ReturnType<typeof useAgendaText>>;
type Insertion = {
    parentId: string | null;
    afterId: string | null;
    offset: number;
    position: number;
};

function insertionLocation(points: readonly TreePoint[], insertion: Insertion) {
    const anchor = points.find((point) => point.id === insertion.afterId);
    const parentId = anchor
        ? anchor.parentId
        : points.some((point) => point.id === insertion.parentId)
          ? insertion.parentId
          : null;
    const siblings = pointSiblings(points, parentId);
    const siblingIndex = anchor
        ? Math.min(
              siblings.length,
              siblings.indexOf(anchor) + 1 + insertion.offset,
          )
        : siblings.length;
    return {
        parentId,
        siblingIndex,
        position:
            siblings[siblingIndex]?.position ??
            Math.max(
                insertion.position,
                Math.max(-1, ...points.map((point) => point.position)) + 1,
            ),
    };
}

function PointField({
    point,
    editable,
    onSave,
    onEnter,
    onEmpty,
    pending,
    onRelease,
    onNavigate,
    collaborative = false,
    bindings,
}: {
    point: MeetingPoint;
    editable: boolean;
    onSave: (edit: {
        text?: string;
        version: number;
        outdent?: boolean;
        move?: -1 | 1;
    }) => Promise<boolean> | undefined;
    onEnter: () => void;
    onEmpty: () => void;
    pending: boolean;
    onRelease: () => void;
    onNavigate: (direction: -1 | 1, input: HTMLTextAreaElement) => boolean;
    collaborative?: boolean;
    bindings: PointBindings;
}) {
    const i18n = useExtracted();
    const [draft, setDraft] = useState(point.text);
    const focused = useRef(false);
    const editing = useRef(point);
    const dirty = useRef(false);
    const saving = useRef<Promise<void> | null>(null);
    const [failed, setFailed] = useState(false);
    const released = useRef(false);
    const input = useRef<HTMLTextAreaElement>(null);
    const textSync = useAgendaText(
        input,
        point.agendaId,
        `point:${point.id}:text`,
        collaborative && editable,
        point.version,
        setDraft,
    );
    useEffect(() => {
        const key = `${point.id}:text`;
        bindings.set(key, textSync);
        return () => {
            bindings.delete(key);
        };
    }, [bindings, point.id, textSync]);
    useEffect(() => {
        const field = input.current;
        if (!editable || !field || field.value !== draft) return;
        const resize = () => {
            field.style.height = "0px";
            field.style.height = `${Math.max(32, field.scrollHeight)}px`;
        };
        resize();
        let width = field.clientWidth;
        const observer =
            typeof ResizeObserver === "undefined"
                ? null
                : new ResizeObserver(() => {
                      if (width === field.clientWidth) return;
                      width = field.clientWidth;
                      resize();
                  });
        observer?.observe(field);
        return () => observer?.disconnect();
    }, [draft, editable]);
    useEffect(() => {
        if (!focused.current && !dirty.current) setDraft(point.text);
    }, [point.text]);
    const save = (outdent?: boolean, move?: -1 | 1) => {
        if (textSync.enabled) {
            void textSync.flush().then((saved) => {
                if (saved && (outdent !== undefined || move !== undefined))
                    onSave({
                        version: Math.max(
                            point.version,
                            textSync.materializedVersion() ?? 0,
                        ),
                        outdent,
                        move,
                    });
            });
            return;
        }
        if (saving.current) return;
        const text = draft.trim();
        if (!text && outdent === undefined && move === undefined) return;
        const changed =
            Boolean(text) && dirty.current && text !== editing.current.text;
        if (!changed && outdent === undefined && move === undefined) {
            dirty.current = false;
            if (!focused.current) setDraft(point.text);
            return;
        }
        const operation = onSave({
            version: editing.current.version,
            ...(changed ? { text } : {}),
            ...(outdent !== undefined ? { outdent } : {}),
            ...(move !== undefined ? { move } : {}),
        });
        if (!operation) return;
        saving.current = operation
            .then((saved) => {
                setFailed(!saved);
                if (saved && input.current?.value.trim() === text) {
                    dirty.current = false;
                    editing.current = {
                        ...editing.current,
                        text,
                        version: editing.current.version + 1,
                    };
                }
            })
            .finally(() => {
                saving.current = null;
            });
    };
    if (!editable)
        return (
            <span
                className={cn(
                    "min-w-0 flex-1 border border-transparent px-1 py-1 leading-6 whitespace-pre-wrap",
                    point.discussedAt && "text-muted-foreground line-through",
                )}
            >
                <LinkedText text={point.text} />
            </span>
        );
    return (
        <>
            <LinkedTextField
                text={draft}
                inputRef={input}
                className="flex-1"
                displayClassName={cn(
                    "min-h-8 border border-transparent px-1 py-1 leading-6",
                    point.discussedAt && "text-muted-foreground line-through",
                )}
            >
                <textarea
                    {...getPasswordManagerAttributes()}
                    ref={input}
                    data-point-editor
                    rows={1}
                    aria-label={i18n("Discussion point")}
                    maxLength={2000}
                    value={draft}
                    className={cn(
                        "min-w-0 flex-1 resize-none overflow-hidden rounded border border-transparent bg-transparent px-1 py-1 leading-6 focus:border-input focus:outline-none focus:ring-1 focus:ring-ring",
                        point.discussedAt &&
                            "text-muted-foreground line-through",
                    )}
                    onChange={(event) => {
                        dirty.current = true;
                        setDraft(event.target.value.replace(/[\r\n]/gu, " "));
                    }}
                    onFocus={() => {
                        focused.current = true;
                        editing.current = point;
                        released.current = false;
                    }}
                    onBlur={() => {
                        focused.current = false;
                        if (!textSync.enabled && !draft.trim())
                            setDraft(point.text);
                        else save();
                    }}
                    onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing) return;
                        if (
                            event.altKey &&
                            ["ArrowUp", "ArrowDown"].includes(event.key)
                        ) {
                            event.preventDefault();
                            event.stopPropagation();
                            if (!pending)
                                save(
                                    undefined,
                                    event.key === "ArrowUp" ? -1 : 1,
                                );
                            return;
                        }
                        if (["ArrowUp", "ArrowDown"].includes(event.key)) {
                            const direction = pointArrowDirection(
                                {
                                    ...event,
                                    isComposing: event.nativeEvent.isComposing,
                                    selectionStart:
                                        event.currentTarget.selectionStart,
                                    selectionEnd:
                                        event.currentTarget.selectionEnd,
                                },
                                measureCaretLines(event.currentTarget),
                            );
                            if (
                                direction &&
                                onNavigate(direction, event.currentTarget)
                            ) {
                                event.preventDefault();
                                return;
                            }
                        }
                        if (event.key === "Escape") {
                            event.preventDefault();
                            released.current = true;
                            save();
                            onRelease();
                            return;
                        }
                        if (event.key === "Enter") {
                            event.preventDefault();
                            released.current = false;
                            save();
                            onEnter();
                        }
                        if (event.key === "Tab" && !released.current) {
                            event.preventDefault();
                            save(pending ? undefined : event.shiftKey);
                        }
                        if (event.key === "Backspace" && !draft) {
                            event.preventDefault();
                            onEmpty();
                        }
                    }}
                />
            </LinkedTextField>
            {failed && (
                <span role="alert" className="text-xs text-muted-foreground">
                    {i18n(
                        "Your point was not saved. Your text is kept; focus it again to review and re-apply it.",
                    )}
                </span>
            )}
        </>
    );
}
function PointNote({
    point,
    editable,
    onSave,
    collaborative = false,
    bindings,
}: {
    point: MeetingPoint;
    editable: boolean;
    onSave: (
        note: string | null,
        version: number,
    ) => Promise<boolean> | undefined;
    collaborative?: boolean;
    bindings: PointBindings;
}) {
    const i18n = useExtracted();
    const format = useFormatter();
    const [draft, setDraft] = useState(point.note ?? "");
    const focused = useRef(false);
    const dirty = useRef(false);
    const editing = useRef(point);
    const input = useRef<HTMLTextAreaElement>(null);
    const textSync = useAgendaText(
        input,
        point.agendaId,
        `point:${point.id}:note`,
        collaborative && editable,
        point.version,
        setDraft,
    );
    useEffect(() => {
        const key = `${point.id}:note`;
        bindings.set(key, textSync);
        return () => {
            bindings.delete(key);
        };
    }, [bindings, point.id, textSync]);
    useEffect(() => {
        if (!focused.current && !dirty.current) setDraft(point.note ?? "");
    }, [point.note]);
    return (
        <div className="ml-7 flex items-center gap-2 text-xs text-muted-foreground">
            {point.noteAt && (
                <time dateTime={point.noteAt}>
                    {format.dateTime(new Date(point.noteAt), {
                        hour: "2-digit",
                        minute: "2-digit",
                    })}
                </time>
            )}
            {editable ? (
                <LinkedTextField
                    text={draft}
                    inputRef={input}
                    className="flex-1"
                    displayClassName="min-h-6 p-1"
                >
                    <Textarea
                        autoGrow
                        rows={1}
                        ref={input}
                        aria-label={i18n("Point note")}
                        placeholder={i18n("Note")}
                        maxLength={2000}
                        value={draft}
                        className="min-h-6 min-w-0 flex-1 rounded border border-transparent bg-transparent p-1 text-xs shadow-none focus:border-input focus:outline-none md:text-xs"
                        onFocus={() => {
                            focused.current = true;
                            editing.current = point;
                        }}
                        onChange={(event) => {
                            dirty.current = true;
                            setDraft(
                                event.target.value.replace(/[\r\n]/gu, " "),
                            );
                        }}
                        onBlur={() => {
                            focused.current = false;
                            if (textSync.enabled) {
                                void textSync.flush();
                                return;
                            }
                            if (!dirty.current) return;
                            const note = draft.trim() || null;
                            void Promise.resolve(
                                onSave(note, editing.current.version),
                            ).then((saved) => {
                                if (
                                    saved !== false &&
                                    (input.current?.value.trim() || null) ===
                                        note
                                )
                                    dirty.current = false;
                            });
                        }}
                        onKeyDown={(event) => {
                            if (event.nativeEvent.isComposing) return;
                            if (event.key === "Enter") {
                                event.preventDefault();
                                event.currentTarget.blur();
                            }
                        }}
                    />
                </LinkedTextField>
            ) : (
                point.note && (
                    <span>
                        <LinkedText text={point.note} />
                    </span>
                )
            )}
        </div>
    );
}
export function OutlineEditor({
    detail,
    userId,
    readOnly = false,
    live = false,
    pendingPaths = [],
    showProposers = hasAgendaContributors(detail),
    onPatch,
    onRemove,
    onAdd,
}: {
    detail: MeetingDetail;
    userId?: string;
    readOnly?: boolean;
    live?: boolean;
    pendingPaths?: readonly string[];
    showProposers?: boolean;
    onPatch: (
        point: MeetingPoint,
        patch: PointPatch,
    ) => Promise<boolean> | undefined;
    onRemove: (point: MeetingPoint, mergeUp?: boolean) => void;
    onAdd: (
        text: string,
        parentId: string | null,
        position: number,
        siblingIndex?: number,
    ) => Promise<boolean | string>;
}) {
    const i18n = useExtracted();
    const format = useFormatter();
    const editor = useRef<HTMLDivElement>(null);
    const bindings = useRef<PointBindings>(new Map());
    const flushPoint = async (point: MeetingPoint) => {
        const fields = ["text", "note"]
            .map((field) => bindings.current.get(`${point.id}:${field}`))
            .filter((binding) => binding?.enabled);
        try {
            if (
                !(
                    await Promise.all(fields.map((field) => field?.flush()))
                ).every(Boolean)
            )
                return null;
            return {
                ...point,
                version: Math.max(
                    point.version,
                    ...fields.map((field) => field?.materializedVersion() ?? 0),
                ),
            };
        } catch {
            return null;
        }
    };
    const hasBindings = (point: MeetingPoint) =>
        ["text", "note"].some(
            (field) => bindings.current.get(`${point.id}:${field}`)?.enabled,
        );
    const patchPoint = (point: MeetingPoint, patch: PointPatch) => {
        if (!hasBindings(point)) return onPatch(point, patch);
        return flushPoint(point).then(async (latest) =>
            latest ? ((await onPatch(latest, patch)) ?? false) : false,
        );
    };
    const removePoint = (point: MeetingPoint, mergeUp?: boolean) => {
        const remove = (latest: MeetingPoint | null) => {
            if (!latest) return;
            if (mergeUp === undefined) onRemove(latest);
            else onRemove(latest, mergeUp);
        };
        if (!hasBindings(point)) return remove(point);
        return flushPoint(point).then(remove);
    };
    const [insertion, setInsertion] = useState<Insertion | null>(null);
    const [newText, setNewText] = useState("");
    const newDraft = useRef("");
    const newInput = useRef<HTMLTextAreaElement>(null);
    const exit = useRef<HTMLParagraphElement>(null);
    const draftReleased = useRef(false);
    useEffect(() => {
        if (insertion && !draftReleased.current) newInput.current?.focus();
    }, [insertion]);
    const rows = outlineRows(detail.points);
    const [announcement, announce] = useState("");
    const dragged = useRef<string | null>(null);
    const [lifted, setLifted] = useState<string | null>(null);
    const [drop, setDrop] = useState<{
        id: string;
        after: boolean;
        depth: number;
    } | null>(null);
    const movePoint = (point: MeetingPoint, move: PointPatch | null) => {
        if (!move) return;
        const next =
            move.siblingIndex !== undefined
                ? (moveAgendaPoint(
                      detail.points,
                      point.id,
                      move.parentId !== undefined
                          ? move.parentId
                          : point.parentId,
                      move.siblingIndex,
                  ) ?? detail.points)
                : detail.points;
        announce(
            i18n("Point {position, number} of {count, number}", {
                position:
                    outlineRows(next).findIndex(
                        (row) => row.point.id === point.id,
                    ) + 1,
                count: next.length,
            }),
        );
        return patchPoint(point, move);
    };
    const submitting = useRef(false);
    const addSequence = useRef(0);
    const [queued, setQueued] = useState<
        (Insertion & { id: string; text: string })[]
    >([]);
    const [failedAdds, setFailedAdds] = useState<
        (Insertion & { id: string; text: string })[]
    >([]);
    const aliases = new Map<string, string>();
    let displayPoints: TreePoint[] = [...detail.points];
    const resolveInsertion = (entry: Insertion): Insertion => ({
        ...entry,
        afterId: aliases.get(entry.afterId ?? "") ?? entry.afterId,
        parentId: aliases.get(entry.parentId ?? "") ?? entry.parentId,
    });
    for (const [index, entry] of queued.entries()) {
        const resolved = resolveInsertion(entry);
        const pending =
            index === 0 &&
            submitting.current &&
            detail.points.find(
                (point) =>
                    point.id.startsWith("pending-") &&
                    point.text === entry.text &&
                    point.parentId === resolved.parentId,
            );
        if (pending) {
            aliases.set(entry.id, pending.id);
            continue;
        }
        const target = insertionLocation(displayPoints, resolved);
        displayPoints =
            moveAgendaPoint(
                [
                    ...displayPoints,
                    {
                        id: entry.id,
                        parentId: target.parentId,
                        position: target.position,
                    },
                ],
                entry.id,
                target.parentId,
                target.siblingIndex,
            ) ?? displayPoints;
    }
    const localId = (id: string | null) =>
        [...aliases].find(([, pendingId]) => pendingId === id)?.[0] ?? id;
    const displayOutline = outlineRows(displayPoints);
    const location =
        insertion &&
        insertionLocation(displayPoints, resolveInsertion(insertion));
    const displayRows: { point: TreePoint; depth: number }[] = [
        ...displayOutline,
    ];
    if (location) {
        const siblings = pointSiblings(displayPoints, location.parentId);
        const next = siblings[location.siblingIndex];
        const parentIndex = displayOutline.findIndex(
            (row) => row.point.id === location.parentId,
        );
        const depth =
            parentIndex < 0 ? 0 : displayOutline[parentIndex].depth + 1;
        const following = displayOutline.findIndex(
            (row, index) => index > parentIndex && row.depth < depth,
        );
        const at = next
            ? displayOutline.findIndex((row) => row.point.id === next.id)
            : following < 0
              ? displayOutline.length
              : following;
        displayRows.splice(at, 0, {
            point: { id: "draft", ...location },
            depth,
        });
    }
    const adding = pendingPaths.includes("/points");
    const pointPaths = new Set(pendingPaths.map((path) => path.split("?")[0]));
    const canAdd = !readOnly && detail.permissions.edit;
    const insert = (point?: MeetingPoint) => {
        draftReleased.current = false;
        setInsertion({
            parentId: point?.parentId ?? null,
            afterId: point?.id ?? null,
            offset: 0,
            position: point
                ? point.position + 1
                : Math.max(
                      -1,
                      ...detail.points.map((entry) => entry.position),
                  ) + 1,
        });
        newDraft.current = "";
        setNewText("");
    };
    const focusPoint = (input: HTMLTextAreaElement, direction: -1 | 1) => {
        input.focus();
        const caret = direction === -1 ? input.value.length : 0;
        input.setSelectionRange(caret, caret);
    };
    const navigatePoint = (direction: -1 | 1, input: HTMLTextAreaElement) => {
        const fields = [
            ...(editor.current?.querySelectorAll<HTMLTextAreaElement>(
                "textarea[data-point-editor]",
            ) ?? []),
        ];
        const target = fields[fields.indexOf(input) + direction];
        if (target) focusPoint(target, direction);
        else if (direction === 1 && canAdd) {
            if (newInput.current) {
                newInput.current.focus();
                newInput.current.setSelectionRange(0, 0);
            } else insert();
        } else return false;
        return true;
    };
    const submit = () => {
        if (!newDraft.current.trim() || !insertion || !location) return;
        const text = newDraft.current.trim();
        newDraft.current = "";
        setNewText("");
        const id = `queued-${++addSequence.current}`;
        setQueued((value) => [
            ...value,
            {
                ...insertion,
                ...location,
                parentId: localId(location.parentId),
                id,
                text,
            },
        ]);
        setInsertion((value) =>
            value
                ? {
                      ...value,
                      afterId: id,
                      offset: 0,
                      position: location.position + 1,
                  }
                : value,
        );
    };
    useEffect(() => {
        if (!canAdd || adding || submitting.current || !queued.length) return;
        const next = queued[0];
        const target = insertionLocation(detail.points, next);
        submitting.current = true;
        const siblings = pointSiblings(detail.points, target.parentId);
        const tied =
            target.siblingIndex > 0 &&
            siblings[target.siblingIndex]?.position ===
                siblings[target.siblingIndex - 1]?.position;
        const operation = tied
            ? onAdd(
                  next.text,
                  target.parentId,
                  target.position,
                  target.siblingIndex,
              )
            : onAdd(next.text, target.parentId, target.position);
        void operation
            .then((saved) => {
                const rebase = (entry: Insertion) => ({
                    ...entry,
                    parentId:
                        entry.parentId === next.id
                            ? typeof saved === "string"
                                ? saved
                                : next.parentId
                            : entry.parentId,
                    ...(entry.afterId === next.id
                        ? {
                              afterId:
                                  typeof saved === "string"
                                      ? saved
                                      : next.afterId,
                              offset:
                                  typeof saved === "string"
                                      ? 0
                                      : next.offset + (saved ? 1 : 0),
                          }
                        : {}),
                });
                setInsertion((value) => value && rebase(value));
                if (!saved) {
                    if (newDraft.current)
                        setFailedAdds((value) => [...value, next]);
                    else {
                        newDraft.current = next.text;
                        setNewText(next.text);
                        setInsertion({
                            ...next,
                            parentId: next.parentId,
                            position: next.position,
                        });
                    }
                }
                setQueued((value) =>
                    value
                        .slice(1)
                        .map((entry) => ({ ...entry, ...rebase(entry) })),
                );
            })
            .finally(() => {
                submitting.current = false;
            });
    }, [canAdd, adding, queued, onAdd, detail.points]);
    const draftRow = insertion && location && canAdd && (
        <div
            className="flex items-start gap-2 py-1"
            style={{
                paddingLeft: `${(location.parentId ? (displayOutline.find((row) => row.point.id === location.parentId)?.depth ?? 0) + 1 : 0) * 20}px`,
            }}
        >
            <span
                className="border border-transparent py-1 leading-6"
                aria-hidden="true"
            >
                •
            </span>
            <Textarea
                autoGrow
                rows={1}
                ref={newInput}
                aria-label={i18n("New discussion point")}
                placeholder={i18n("Add a point…")}
                value={newText}
                maxLength={2000}
                className="min-h-8 min-w-0 flex-1 rounded border bg-background px-2 py-1 text-sm leading-6 md:text-sm"
                onFocus={() => {
                    draftReleased.current = false;
                }}
                onChange={(event) => {
                    const value = event.target.value.replace(/[\r\n]/gu, " ");
                    newDraft.current = value;
                    setNewText(value);
                }}
                onBlur={() => {
                    void submit();
                }}
                onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return;
                    if (
                        pointArrowDirection(
                            {
                                ...event,
                                isComposing: event.nativeEvent.isComposing,
                                selectionStart:
                                    event.currentTarget.selectionStart,
                                selectionEnd: event.currentTarget.selectionEnd,
                            },
                            measureCaretLines(event.currentTarget),
                        ) === -1
                    ) {
                        const fields =
                            editor.current?.querySelectorAll<HTMLTextAreaElement>(
                                "textarea[data-point-editor]",
                            );
                        const last = fields?.[fields.length - 1];
                        if (last) {
                            event.preventDefault();
                            focusPoint(last, -1);
                        }
                        return;
                    }
                    if (event.key === "Enter") {
                        event.preventDefault();
                        void submit();
                    }
                    if (event.key === "Escape") {
                        event.preventDefault();
                        draftReleased.current = true;
                        submit();
                        exit.current?.focus();
                    }
                    if (event.key === "Backspace" && !newText) {
                        event.preventDefault();
                        setInsertion(null);
                    }
                    if (event.key === "Tab" && !draftReleased.current) {
                        event.preventDefault();
                        const siblingPositions = new Map(
                            pointSiblings(displayPoints, location.parentId).map(
                                (point, index) => [
                                    point.id,
                                    index < location.siblingIndex
                                        ? index
                                        : index + 1,
                                ],
                            ),
                        );
                        const temporary = {
                            id: "draft",
                            parentId: location.parentId,
                            position: location.siblingIndex,
                        };
                        const move = outlineMove(
                            [
                                ...displayPoints.map((point) => ({
                                    ...point,
                                    position:
                                        siblingPositions.get(point.id) ??
                                        point.position,
                                })),
                                temporary,
                            ],
                            temporary.id,
                            event.shiftKey,
                        );
                        if (move) {
                            const siblings = pointSiblings(
                                displayPoints,
                                move.parentId,
                            );
                            setInsertion({
                                parentId: localId(move.parentId),
                                afterId: localId(
                                    siblings[move.siblingIndex - 1]?.id ?? null,
                                ),
                                offset: 0,
                                position: Math.min(
                                    100000,
                                    siblings[move.siblingIndex]?.position ??
                                        Math.max(
                                            -1,
                                            ...siblings.map(
                                                (point) => point.position,
                                            ),
                                        ) + 1,
                                ),
                            });
                        }
                    }
                }}
            />
            <Button
                size="sm"
                variant="ghost"
                disabled={!newText.trim() || adding}
                onClick={() => void submit()}
            >
                {i18n("Add")}
            </Button>
        </div>
    );
    return (
        <div ref={editor} className="space-y-1 text-sm">
            <span className="sr-only" aria-live="polite">
                {announcement}
            </span>
            {displayRows.map(({ point: treePoint, depth }, index) => {
                if (treePoint.id === "draft")
                    return <div key="draft">{draftRow}</div>;
                const point = detail.points.find(
                    (entry) => entry.id === treePoint.id,
                );
                if (!point) {
                    const entry = queued.find(
                        (entry) => entry.id === treePoint.id,
                    );
                    return entry ? (
                        <output
                            key={entry.id}
                            data-queued-point
                            className="block py-1 text-muted-foreground"
                            style={{ paddingLeft: `${depth * 20}px` }}
                        >
                            {entry.text}
                        </output>
                    ) : null;
                }
                const editable =
                    canAdd &&
                    !point.id.startsWith("pending-") &&
                    (detail.permissions.manage ||
                        point.authorUserId === userId);
                const author = detail.authors.find(
                    (entry) => entry.id === point.authorUserId,
                );
                const proposer = author?.name ?? i18n("Unknown author");
                const indent = outlineMove(detail.points, point.id, false);
                const outdent = outlineMove(detail.points, point.id, true);
                const up = outlineReorder(detail.points, point.id, -1);
                const down = outlineReorder(detail.points, point.id, 1);
                const after =
                    rows.findIndex((row) => row.point.id === point.id) + 1;
                const following = rows.slice(after);
                const sibling = following.findIndex(
                    (row) => row.depth <= depth,
                );
                const descendants = following.slice(
                    0,
                    sibling < 0 ? undefined : sibling,
                );
                const subtreePending = [
                    point,
                    ...descendants.map((row) => row.point),
                ].some(
                    (entry) =>
                        entry.id.startsWith("pending-") ||
                        pointPaths.has(
                            `/points/${encodeURIComponent(entry.id)}`,
                        ),
                );
                const canRemove =
                    detail.permissions.manage ||
                    descendants.every(
                        (row) => row.point.authorUserId === userId,
                    );
                const dragHandle = (
                    <ActionTooltip label={i18n("Drag")}>
                        <button
                            type="button"
                            draggable={!subtreePending}
                            aria-label={i18n("Drag point")}
                            className="flex h-6 items-center cursor-grab text-muted-foreground"
                            onDragStart={(event) => {
                                const row =
                                    event.currentTarget.closest("fieldset");
                                if (row)
                                    event.dataTransfer.setDragImage?.(
                                        row,
                                        20,
                                        20,
                                    );
                                event.dataTransfer.effectAllowed = "move";
                                event.dataTransfer.setData(
                                    "application/x-chatterbox-agenda-point",
                                    point.id,
                                );
                                dragged.current = point.id;
                                setLifted(point.id);
                            }}
                            onDragEnd={() => {
                                dragged.current = null;
                                setLifted(null);
                                setDrop(null);
                            }}
                        >
                            <span
                                className="agenda-point-bullet"
                                aria-hidden="true"
                            >
                                •
                            </span>
                            <GripVertical className="agenda-point-grip size-4" />
                        </button>
                    </ActionTooltip>
                );
                return (
                    <div key={point.id} id={`point-${point.id}`}>
                        <fieldset
                            aria-label={point.text}
                            tabIndex={editable ? 0 : undefined}
                            style={
                                {
                                    paddingLeft: `${depth * 20}px`,
                                    "--agenda-insert-offset": `${(drop?.id === point.id ? drop.depth : depth) * 20}px`,
                                } as CSSProperties
                            }
                            className={cn(
                                "agenda-point-row group relative min-w-0 rounded-md border-0 p-0",
                                lifted === point.id &&
                                    "border border-primary shadow-lg",
                                drop?.id === point.id &&
                                    (drop.after
                                        ? "agenda-insert-after"
                                        : "agenda-insert-before"),
                            )}
                            onKeyDown={(event) => {
                                if (
                                    event.nativeEvent.isComposing ||
                                    !editable ||
                                    subtreePending ||
                                    !event.altKey ||
                                    !["ArrowUp", "ArrowDown"].includes(
                                        event.key,
                                    )
                                )
                                    return;
                                event.preventDefault();
                                event.stopPropagation();
                                movePoint(
                                    point,
                                    event.key === "ArrowUp" ? up : down,
                                );
                            }}
                            onDragOver={(event) => {
                                const source = detail.points.find(
                                    (point) => point.id === dragged.current,
                                );
                                if (!source || subtreePending || !canAdd)
                                    return;
                                const rect =
                                    event.currentTarget.getBoundingClientRect();
                                const after =
                                    event.clientY > rect.top + rect.height / 2;
                                const depth = Math.max(
                                    0,
                                    Math.round(
                                        (event.clientX - rect.left) / 20,
                                    ),
                                );
                                const move = outlineDrop(
                                    detail.points,
                                    source.id,
                                    point.id,
                                    after,
                                    depth,
                                );
                                if (!move) {
                                    setDrop(null);
                                    return;
                                }
                                event.preventDefault();
                                event.dataTransfer.dropEffect = "move";
                                setDrop({
                                    id: point.id,
                                    after,
                                    depth: move.parentId
                                        ? (rows.find(
                                              (row) =>
                                                  row.point.id ===
                                                  move.parentId,
                                          )?.depth ?? 0) + 1
                                        : 0,
                                });
                            }}
                            onDragLeave={(event) => {
                                if (
                                    !(event.relatedTarget instanceof Node) ||
                                    !event.currentTarget.contains(
                                        event.relatedTarget,
                                    )
                                )
                                    setDrop(null);
                            }}
                            onDrop={(event) => {
                                const source = detail.points.find(
                                    (point) => point.id === dragged.current,
                                );
                                if (!source || !canAdd || subtreePending)
                                    return;
                                const rect =
                                    event.currentTarget.getBoundingClientRect();
                                const move = outlineDrop(
                                    detail.points,
                                    source.id,
                                    point.id,
                                    event.clientY > rect.top + rect.height / 2,
                                    Math.max(
                                        0,
                                        Math.round(
                                            (event.clientX - rect.left) / 20,
                                        ),
                                    ),
                                );
                                if (move) {
                                    event.preventDefault();
                                    movePoint(source, move);
                                }
                                dragged.current = null;
                                setLifted(null);
                                setDrop(null);
                            }}
                        >
                            <div className="flex items-start gap-2">
                                <span className="flex shrink-0 items-start border border-transparent py-1 leading-6">
                                    {editable && (
                                        <span className="mr-1">
                                            {dragHandle}
                                        </span>
                                    )}
                                    {!editable && !live && !readOnly && (
                                        <span aria-hidden="true">•</span>
                                    )}
                                    {(live || readOnly) && (
                                        <input
                                            type="checkbox"
                                            aria-label={i18n(
                                                "Discussed: {point}",
                                                {
                                                    point: point.text,
                                                },
                                            )}
                                            checked={Boolean(point.discussedAt)}
                                            disabled={
                                                !canAdd ||
                                                subtreePending ||
                                                point.id.startsWith("pending-")
                                            }
                                            onChange={(event) =>
                                                patchPoint(point, {
                                                    discussed:
                                                        event.target.checked,
                                                })
                                            }
                                            className="mt-1 size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                                        />
                                    )}
                                </span>
                                <PointField
                                    bindings={bindings.current}
                                    point={point}
                                    editable={editable}
                                    collaborative={detail.textProtocol === 1}
                                    pending={subtreePending}
                                    onSave={(edit) => {
                                        const move =
                                            edit.move !== undefined
                                                ? edit.move === -1
                                                    ? up
                                                    : down
                                                : edit.outdent === undefined
                                                  ? null
                                                  : edit.outdent
                                                    ? outdent
                                                    : indent;
                                        const patch = {
                                            ...(edit.text !== undefined
                                                ? { text: edit.text }
                                                : {}),
                                            ...(move ?? {}),
                                        };
                                        if (!Object.keys(patch).length) return;
                                        return (
                                            edit.move !== undefined
                                                ? movePoint
                                                : patchPoint
                                        )(
                                            { ...point, version: edit.version },
                                            patch,
                                        );
                                    }}
                                    onNavigate={navigatePoint}
                                    onEnter={() => insert(point)}
                                    onRelease={() => exit.current?.focus()}
                                    onEmpty={() => {
                                        if (canRemove && !subtreePending) {
                                            void removePoint(point, true);
                                            const previous = displayRows
                                                .slice(0, index)
                                                .reverse()
                                                .find(
                                                    (row) =>
                                                        row.point.id !==
                                                        "draft",
                                                );
                                            if (previous)
                                                document
                                                    .getElementById(
                                                        `point-${previous.point.id}`,
                                                    )
                                                    ?.querySelector("textarea")
                                                    ?.focus();
                                        }
                                    }}
                                />
                                {showProposers && !point.parentId && (
                                    <span
                                        title={i18n(
                                            "Changed by {name} at {time}",
                                            {
                                                name:
                                                    detail.authors.find(
                                                        (author) =>
                                                            author.id ===
                                                            (point.updatedByUserId ??
                                                                point.authorUserId),
                                                    )?.name ??
                                                    i18n("Unknown author"),
                                                time: format.dateTime(
                                                    new Date(point.updatedAt),
                                                    {
                                                        hour: "2-digit",
                                                        minute: "2-digit",
                                                    },
                                                ),
                                            },
                                        )}
                                        className="mt-[5px] h-6 min-w-0 max-w-1/4 truncate rounded-full bg-muted px-2 text-[10px] leading-6 text-muted-foreground"
                                    >
                                        {proposer}
                                    </span>
                                )}
                                {point.discussedAt && (
                                    <time
                                        className="text-xs text-muted-foreground"
                                        dateTime={point.discussedAt}
                                    >
                                        {format.dateTime(
                                            new Date(point.discussedAt),
                                            {
                                                hour: "2-digit",
                                                minute: "2-digit",
                                            },
                                        )}
                                    </time>
                                )}
                                {editable && (
                                    <div className="agenda-actions flex h-[34px] shrink-0 items-center gap-0.5">
                                        <ActionTooltip
                                            label={i18n("Move point up")}
                                        >
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                aria-label={i18n(
                                                    "Move point up",
                                                )}
                                                disabled={!up || subtreePending}
                                                onClick={() =>
                                                    movePoint(point, up)
                                                }
                                            >
                                                <ArrowUp className="size-3.5" />
                                            </Button>
                                        </ActionTooltip>
                                        <ActionTooltip
                                            label={i18n("Move point down")}
                                        >
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                aria-label={i18n(
                                                    "Move point down",
                                                )}
                                                disabled={
                                                    !down || subtreePending
                                                }
                                                onClick={() =>
                                                    movePoint(point, down)
                                                }
                                            >
                                                <ArrowDown className="size-3.5" />
                                            </Button>
                                        </ActionTooltip>
                                        <ActionTooltip
                                            label={i18n("Indent point")}
                                        >
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                aria-label={i18n(
                                                    "Indent point",
                                                )}
                                                disabled={
                                                    !indent || subtreePending
                                                }
                                                onClick={() => {
                                                    if (indent)
                                                        void patchPoint(
                                                            point,
                                                            indent,
                                                        );
                                                }}
                                            >
                                                <IndentIncrease className="size-3.5" />
                                            </Button>
                                        </ActionTooltip>
                                        <ActionTooltip
                                            label={i18n("Outdent point")}
                                        >
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                aria-label={i18n(
                                                    "Outdent point",
                                                )}
                                                disabled={
                                                    !outdent || subtreePending
                                                }
                                                onClick={() => {
                                                    if (outdent)
                                                        void patchPoint(
                                                            point,
                                                            outdent,
                                                        );
                                                }}
                                            >
                                                <IndentDecrease className="size-3.5" />
                                            </Button>
                                        </ActionTooltip>
                                        {canRemove && (
                                            <ActionTooltip
                                                label={i18n("Remove point")}
                                            >
                                                <Button
                                                    variant="ghost"
                                                    size="icon-sm"
                                                    aria-label={i18n(
                                                        "Remove point",
                                                    )}
                                                    disabled={subtreePending}
                                                    onClick={() =>
                                                        void removePoint(point)
                                                    }
                                                >
                                                    <Trash2 className="size-3.5" />
                                                </Button>
                                            </ActionTooltip>
                                        )}
                                    </div>
                                )}
                            </div>
                            {point.origin === "live" && (
                                <span className="ml-7 text-xs text-muted-foreground">
                                    {i18n("Added during the meeting")}
                                </span>
                            )}
                            {(live || point.note) && (
                                <PointNote
                                    bindings={bindings.current}
                                    point={point}
                                    collaborative={detail.textProtocol === 1}
                                    editable={
                                        canAdd &&
                                        !point.id.startsWith("pending-")
                                    }
                                    onSave={(note, version) =>
                                        onPatch({ ...point, version }, { note })
                                    }
                                />
                            )}
                        </fieldset>
                    </div>
                );
            })}
            {canAdd &&
                failedAdds.map((entry) => (
                    <div
                        key={`${entry.parentId}:${entry.position}:${entry.text}`}
                        className="flex items-center gap-2 rounded border p-2"
                    >
                        <span>{entry.text}</span>
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                                setFailedAdds((value) =>
                                    value.filter((value) => value !== entry),
                                );
                                setQueued((value) => [...value, entry]);
                            }}
                        >
                            {i18n("Try again")}
                        </Button>
                    </div>
                ))}
            {canAdd && (
                <>
                    <Button
                        variant="ghost"
                        size="sm"
                        className={cn(
                            "text-muted-foreground",
                            insertion && "hidden",
                        )}
                        onClick={() => insert()}
                    >
                        {i18n("Add a point…")}
                    </Button>
                    <p
                        ref={exit}
                        tabIndex={-1}
                        className="sr-only focus:outline-none"
                    ></p>
                </>
            )}
        </div>
    );
}
