"use client";

import { IndentDecrease, IndentIncrease, Trash2 } from "lucide-react";
import { useExtracted, useFormatter } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { TreePoint } from "@/lib/meetings/model";
import { cn } from "@/lib/utils";
import { outlineMove, outlineRows } from "./outline";
import type { MeetingDetail, MeetingPoint } from "./types";

type PointPatch = {
    text?: string;
    parentId?: string | null;
    position?: number;
    discussed?: boolean;
    note?: string | null;
};
export type { PointPatch };

function PointField({
    point,
    editable,
    onSave,
    onEnter,
    onEmpty,
    pending,
    onRelease,
}: {
    point: MeetingPoint;
    editable: boolean;
    onSave: (edit: {
        text?: string;
        version: number;
        outdent?: boolean;
    }) => Promise<boolean> | undefined;
    onEnter: () => void;
    onEmpty: () => void;
    pending: boolean;
    onRelease: () => void;
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
    const save = (outdent?: boolean) => {
        if (saving.current) return;
        const text = draft.trim();
        if (!text && outdent === undefined) return;
        const changed =
            Boolean(text) && dirty.current && text !== editing.current.text;
        if (!changed && outdent === undefined) {
            dirty.current = false;
            if (!focused.current) setDraft(point.text);
            return;
        }
        const operation = onSave({
            version: editing.current.version,
            ...(changed ? { text } : {}),
            ...(outdent !== undefined ? { outdent } : {}),
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
            <span className="min-w-0 flex-1 py-1 whitespace-pre-wrap">
                {point.text}
            </span>
        );
    return (
        <>
            <textarea
                ref={input}
                rows={1}
                aria-label={i18n("Discussion point")}
                maxLength={2000}
                value={draft}
                className="min-w-0 flex-1 resize-none overflow-hidden rounded border border-transparent bg-transparent px-1 py-1 focus:border-input focus:outline-none focus:ring-1 focus:ring-ring"
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
                    if (!draft.trim()) setDraft(point.text);
                    else save();
                }}
                onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return;
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
}: {
    point: MeetingPoint;
    editable: boolean;
    onSave: (
        note: string | null,
        version: number,
    ) => Promise<boolean> | undefined;
}) {
    const i18n = useExtracted();
    const format = useFormatter();
    const [draft, setDraft] = useState(point.note ?? "");
    const focused = useRef(false);
    const dirty = useRef(false);
    const editing = useRef(point);
    const input = useRef<HTMLInputElement>(null);
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
                <input
                    ref={input}
                    aria-label={i18n("Point note")}
                    placeholder={i18n("Note")}
                    maxLength={2000}
                    value={draft}
                    className="min-w-0 flex-1 rounded border border-transparent bg-transparent p-1 focus:border-input focus:outline-none"
                    onFocus={() => {
                        focused.current = true;
                        editing.current = point;
                    }}
                    onChange={(event) => {
                        dirty.current = true;
                        setDraft(event.target.value);
                    }}
                    onBlur={() => {
                        focused.current = false;
                        if (!dirty.current) return;
                        const note = draft.trim() || null;
                        void Promise.resolve(
                            onSave(note, editing.current.version),
                        ).then((saved) => {
                            if (
                                saved !== false &&
                                (input.current?.value.trim() || null) === note
                            )
                                dirty.current = false;
                        });
                    }}
                    onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing) return;
                        if (event.key === "Enter") event.currentTarget.blur();
                    }}
                />
            ) : (
                point.note && <span>{point.note}</span>
            )}
        </div>
    );
}
export function OutlineEditor({
    detail,
    userId,
    readOnly = false,
    live = false,
    pending,
    onPatch,
    onRemove,
    onAdd,
}: {
    detail: MeetingDetail;
    userId?: string;
    readOnly?: boolean;
    live?: boolean;
    pending: boolean;
    onPatch: (
        point: MeetingPoint,
        patch: PointPatch,
    ) => Promise<boolean> | undefined;
    onRemove: (point: MeetingPoint, mergeUp?: boolean) => void;
    onAdd: (
        text: string,
        parentId: string | null,
        position: number,
    ) => Promise<boolean>;
}) {
    const i18n = useExtracted();
    const format = useFormatter();
    const [insertion, setInsertion] = useState<{
        parentId: string | null;
        position: number;
    } | null>(null);
    const [newText, setNewText] = useState("");
    const newDraft = useRef("");
    const newInput = useRef<HTMLInputElement>(null);
    const exit = useRef<HTMLParagraphElement>(null);
    const draftReleased = useRef(false);
    useEffect(() => {
        if (insertion && !draftReleased.current) newInput.current?.focus();
    }, [insertion]);
    const rows = outlineRows(detail.points);
    const displayRows = outlineRows<TreePoint>([
        ...detail.points,
        ...(insertion ? [{ id: "draft", ...insertion }] : []),
    ]);
    const submitting = useRef(false);
    const [queued, setQueued] = useState<
        { text: string; parentId: string | null; position: number }[]
    >([]);
    const [failedAdds, setFailedAdds] = useState<
        { text: string; parentId: string | null; position: number }[]
    >([]);
    const canAdd = !readOnly && detail.permissions.edit;
    const insert = (point?: MeetingPoint) => {
        draftReleased.current = false;
        setInsertion({
            parentId: point?.parentId ?? null,
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
    const submit = () => {
        if (!newDraft.current.trim() || !insertion) return;
        const text = newDraft.current.trim();
        newDraft.current = "";
        setNewText("");
        setQueued((value) => [...value, { text, ...insertion }]);
        setInsertion((value) =>
            value ? { ...value, position: value.position + 1 } : value,
        );
    };
    useEffect(() => {
        if (!canAdd || pending || submitting.current || !queued.length) return;
        const next = queued[0];
        submitting.current = true;
        void onAdd(next.text, next.parentId, next.position)
            .then((saved) => {
                if (!saved) {
                    if (newDraft.current)
                        setFailedAdds((value) => [...value, next]);
                    else {
                        newDraft.current = next.text;
                        setNewText(next.text);
                        setInsertion({
                            parentId: next.parentId,
                            position: next.position,
                        });
                    }
                }
                setQueued((value) => value.slice(1));
            })
            .finally(() => {
                submitting.current = false;
            });
    }, [canAdd, pending, queued, onAdd]);
    const draftRow = insertion && canAdd && (
        <div
            className="flex items-center gap-2 py-1"
            style={{
                paddingLeft: `${(insertion.parentId ? (rows.find((row) => row.point.id === insertion.parentId)?.depth ?? 0) + 1 : 0) * 20}px`,
            }}
        >
            <span aria-hidden="true">•</span>
            <input
                ref={newInput}
                aria-label={i18n("New discussion point")}
                placeholder={i18n("Add a point…")}
                value={newText}
                maxLength={2000}
                className="min-w-0 flex-1 rounded border bg-background px-2 py-1"
                onFocus={() => {
                    draftReleased.current = false;
                }}
                onChange={(event) => {
                    newDraft.current = event.target.value;
                    setNewText(event.target.value);
                }}
                onBlur={() => {
                    void submit();
                }}
                onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return;
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
                        const temporary = { id: "draft", ...insertion };
                        const move = outlineMove(
                            [...detail.points, temporary],
                            temporary.id,
                            event.shiftKey,
                        );
                        if (move) setInsertion({ ...insertion, ...move });
                    }
                }}
            />
            <Button
                size="sm"
                variant="ghost"
                disabled={!newText.trim() || pending}
                onClick={() => void submit()}
            >
                {i18n("Add")}
            </Button>
        </div>
    );
    return (
        <div className="space-y-1 text-sm">
            {displayRows.map(({ point: treePoint, depth }, index) => {
                if (treePoint.id === "draft")
                    return <div key="draft">{draftRow}</div>;
                const point = detail.points.find(
                    (entry) => entry.id === treePoint.id,
                );
                if (!point) return null;
                const editable =
                    canAdd &&
                    !point.id.startsWith("pending-") &&
                    (detail.permissions.manage ||
                        point.authorUserId === userId);
                const author = detail.authors.find(
                    (entry) => entry.id === point.authorUserId,
                );
                const indent = outlineMove(detail.points, point.id, false);
                const outdent = outlineMove(detail.points, point.id, true);
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
                const canRemove =
                    detail.permissions.manage ||
                    descendants.every(
                        (row) => row.point.authorUserId === userId,
                    );
                return (
                    <div key={point.id} id={`point-${point.id}`}>
                        <div
                            style={{ paddingLeft: `${depth * 20}px` }}
                            className="group rounded-md"
                        >
                            <div className="flex items-start gap-2">
                                {live || readOnly ? (
                                    <input
                                        type="checkbox"
                                        aria-label={i18n("Discussed: {point}", {
                                            point: point.text,
                                        })}
                                        checked={Boolean(point.discussedAt)}
                                        disabled={
                                            !canAdd ||
                                            pending ||
                                            point.id.startsWith("pending-")
                                        }
                                        onChange={(event) =>
                                            onPatch(point, {
                                                discussed: event.target.checked,
                                            })
                                        }
                                        className="size-4 shrink-0 accent-primary"
                                    />
                                ) : (
                                    <span aria-hidden="true">•</span>
                                )}
                                <PointField
                                    point={point}
                                    editable={editable}
                                    pending={pending}
                                    onSave={(edit) => {
                                        const move =
                                            edit.outdent === undefined
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
                                        return onPatch(
                                            { ...point, version: edit.version },
                                            patch,
                                        );
                                    }}
                                    onEnter={() => insert(point)}
                                    onRelease={() => exit.current?.focus()}
                                    onEmpty={() => {
                                        if (canRemove && !pending) {
                                            onRemove(point, true);
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
                                    <div className="flex shrink-0 items-center gap-0.5">
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            aria-label={i18n("Indent point")}
                                            disabled={!indent || pending}
                                            onClick={() => {
                                                if (indent)
                                                    onPatch(point, indent);
                                            }}
                                        >
                                            <IndentIncrease className="size-3.5" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            aria-label={i18n("Outdent point")}
                                            disabled={!outdent || pending}
                                            onClick={() => {
                                                if (outdent)
                                                    onPatch(point, outdent);
                                            }}
                                        >
                                            <IndentDecrease className="size-3.5" />
                                        </Button>
                                        {canRemove && (
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                aria-label={i18n(
                                                    "Remove point",
                                                )}
                                                disabled={pending}
                                                onClick={() => onRemove(point)}
                                            >
                                                <Trash2 className="size-3.5" />
                                            </Button>
                                        )}
                                    </div>
                                )}
                            </div>
                            {author && point.authorUserId !== userId && (
                                <span className="ml-7 inline-flex rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">
                                    {author.name ?? i18n("Unknown author")}
                                </span>
                            )}
                            {point.origin === "live" && (
                                <span className="ml-7 text-xs text-muted-foreground">
                                    {i18n("Added during the meeting")}
                                </span>
                            )}
                            {(live || point.note) && (
                                <PointNote
                                    point={point}
                                    editable={
                                        canAdd &&
                                        !point.id.startsWith("pending-")
                                    }
                                    onSave={(note, version) =>
                                        onPatch({ ...point, version }, { note })
                                    }
                                />
                            )}
                        </div>
                    </div>
                );
            })}
            {canAdd &&
                queued
                    .filter(
                        (entry) =>
                            !detail.points.some(
                                (point) =>
                                    point.id.startsWith("pending-") &&
                                    point.text === entry.text &&
                                    point.parentId === entry.parentId &&
                                    point.position === entry.position,
                            ),
                    )
                    .map((entry) => (
                        <output
                            key={`${entry.parentId}:${entry.position}:${entry.text}`}
                            className="block py-1 text-muted-foreground"
                        >
                            {entry.text}
                        </output>
                    ))}
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
                        className="pt-2 text-xs text-muted-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                        {i18n(
                            "Enter: new point · Tab: indent · Shift+Tab: outdent · Escape, then Tab: leave editor · up to 3 levels",
                        )}
                    </p>
                </>
            )}
        </div>
    );
}
