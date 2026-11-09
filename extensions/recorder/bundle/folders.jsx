import { FolderPlus } from "lucide-react";
import React, { createElement, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ItemFolderChipBody } from "../../../src/components/items/item-folder-chip-body";
import { FolderCombobox } from "../../../src/components/recordings/folder-combobox";

/** Mount the application's folder chooser with extension-owned storage and labels. */
export function createFolderField({
    container,
    request,
    save,
    saveOnRefresh = save,
    t,
    prefix = "folder",
    onPick,
    variant = "field",
}) {
    container.setAttribute("data-recorder-folder", "");
    const root = createRoot(container);
    let current = {};
    let options = {};
    let entries = [];
    let recent = [];
    let pending = Promise.resolve();
    let revision = 0;
    let refreshError = "";
    let open = false;
    const environment = () => ({
        labels: {
            folder: t("folder"),
            chooseFolder: t("fileLater"),
            recent: t("foldersRecent"),
            private: t("foldersPrivate"),
            organization: t("foldersOrganization"),
            shareOrganization: t("foldersOrganization"),
            assigned: t("foldersAssigned"),
            findFolder: t("foldersSearch"),
            searchFolders: t("foldersSearch"),
            empty: t("noFoldersFound"),
            newFolder: t("foldersNew"),
            createFolder: () => t("foldersNew"),
        },
        label: (folder) => folder.name,
        recentFolders: recent.map((id) => ({ id })),
        rememberFolder: (id) => {
            recent = [id, ...recent.filter((other) => other !== id)].slice(
                0,
                5,
            );
            void chrome.storage.local.set({ recorderRecentFolders: recent });
        },
    });
    function paint() {
        root.render(createElement(Field, { revision }));
    }
    function Field() {
        const [error, setError] = useState("");
        const selectRef = useRef(null);
        const focusAfterRemove = useRef(false);
        const selected = current.folderId ?? "";
        useLayoutEffect(() => {
            if (!focusAfterRemove.current) return;
            focusAfterRemove.current = false;
            container.querySelector(".recorder-folder-target button")?.focus();
        });
        const fullPath = current.folderLabel || t("savedFolder");
        const name = fullPath.split(/ › | \/ /).at(-1);
        const setOpen = (value) => {
            open = value && !options.readOnly;
            paint();
        };
        const choose = (id, removed = false) => {
            const folder = entries.find(
                (entry) => entry.folder.id === id,
            )?.folder;
            const previous = current;
            focusAfterRemove.current = removed;
            revision++;
            current = {
                folderId: id || null,
                folderLabel: folder?.fullPath ?? folder?.name ?? null,
                folderScope: folder?.scope ?? null,
            };
            paint();
            const choice = current;
            pending = pending
                .catch(() => {})
                .then(() => save(choice))
                .then(() => {
                    setError("");
                    onPick?.();
                })
                .catch((error) => {
                    current = previous;
                    focusAfterRemove.current = removed;
                    setError(error?.message || t("folderChangeFailed"));
                    paint();
                    throw error;
                });
            return pending;
        };
        const visible =
            entries.some((entry) => entry.folder.id === selected) || !selected
                ? entries
                : [
                      ...entries,
                      {
                          folder: {
                              id: selected,
                              name: current.folderLabel || t("savedFolder"),
                              scope: current.folderScope ?? "personal",
                              parentId: "remembered",
                              kind: "custom",
                          },
                          path: "",
                          depth: 0,
                          nameMatch: true,
                      },
                  ];
        return (
            <>
                {variant === "field" && (
                    <label id={`${prefix}-label`}>{t("folder")}</label>
                )}
                <div className="recorder-folder-target">
                    {selected && (
                        <ItemFolderChipBody
                            name={name}
                            title={fullPath}
                            organization={current.folderScope === "org"}
                            removeLabel={t("folderRemove", name)}
                            selectRef={selectRef}
                            selectDisabled={options.readOnly === true}
                            aria-label={
                                variant === "field" ? t("folder") : undefined
                            }
                            aria-expanded={open && !options.readOnly}
                            aria-haspopup="listbox"
                            onSelect={() => setOpen(!open)}
                            onRemove={
                                options.readOnly
                                    ? undefined
                                    : () => {
                                          setOpen(false);
                                          void choose("", true).catch(() => {});
                                      }
                            }
                        />
                    )}

                    <FolderCombobox
                        entries={visible}
                        value={selected}
                        open={open}
                        onOpenChange={setOpen}
                        anchorRef={selected ? selectRef : undefined}
                        actionTrigger={
                            <>
                                <FolderPlus className="size-3.5" />
                                {t("folderAdd")}
                            </>
                        }
                        className="h-7 rounded-full border-dashed px-2.5 text-xs text-muted-foreground"
                        environment={environment()}
                        variant="pill"
                        aria-label={
                            variant === "field" ? t("folder") : t("folderAdd")
                        }
                        disabled={options.readOnly}
                        emptyChoiceLabel={t("fileLater")}
                        onValueChange={choose}
                    />
                </div>
                <span className="hint">
                    {options.readOnly ? t("folderFixedAtStart") : ""}
                </span>
                <p className="error" role="status">
                    {error || refreshError}
                </p>
            </>
        );
    }
    async function refresh(version) {
        try {
            const [response, saved] = await Promise.all([
                request({}),
                chrome.storage.local.get("recorderRecentFolders"),
            ]);
            if (version !== revision) return;
            if (!response?.ok) throw new Error(t("folderSearchFailed"));
            recent = saved.recorderRecentFolders ?? [];
            entries = (response.folders ?? []).map((folder) => {
                const parts = folder.path.split(/ \/ | › /);
                return {
                    folder: {
                        ...folder,
                        fullPath: folder.path,
                        name: parts.at(-1),
                        scope: folder.scope ?? "personal",
                        parentId: folder.parentId ?? "recorder",
                        kind: folder.kind ?? "custom",
                    },
                    path: parts.slice(0, -1).join(" › "),
                    depth: Math.max(0, parts.length - 1),
                    nameMatch: true,
                };
            });
            if (current.folderId) {
                const selected = entries.find(
                    (entry) => entry.folder.id === current.folderId,
                );
                if (selected) {
                    current = {
                        folderId: selected.folder.id,
                        folderLabel: selected.folder.fullPath,
                        folderScope: selected.folder.scope,
                    };
                    const refreshed = current;
                    pending = pending
                        .catch(() => {})
                        .then(() => saveOnRefresh(refreshed));
                } else {
                    const lookup = await request({ id: current.folderId });
                    if (version !== revision) return;
                    const found =
                        lookup?.ok &&
                        lookup.folders?.find(
                            (folder) => folder.id === current.folderId,
                        );
                    if (found || lookup?.status === 404) {
                        current = {
                            folderId: found ? found.id : null,
                            folderLabel: found
                                ? (found.path ?? found.label ?? found.name)
                                : null,
                            folderScope: found?.scope ?? null,
                        };
                        const refreshed = current;
                        pending = pending
                            .catch(() => {})
                            .then(() => saveOnRefresh(refreshed));
                    }
                }
            }
            refreshError = "";
            void pending.catch((error) => {
                refreshError = error?.message || t("folderChangeFailed");
                paint();
            });
            paint();
        } catch {
            refreshError = t("folderSearchFailed");
            paint();
        }
    }
    return {
        reset(value, nextOptions = {}) {
            if (nextOptions.clear) {
                entries = [];
                refreshError = "";
            }
            const changed =
                nextOptions.clear ||
                current.folderId !== value.folderId ||
                current.folderLabel !== value.folderLabel ||
                current.folderScope !== value.folderScope ||
                options.readOnly !== nextOptions.readOnly;
            current = value;
            options = nextOptions;
            if (options.readOnly) open = false;
            if (!changed && entries.length) return;
            revision++;
            paint();
            if (nextOptions.refresh !== false && !nextOptions.readOnly)
                void refresh(revision);
        },
        saved: () => pending,
        close: () => {
            if (!open) return;
            open = false;
            paint();
        },
        destroy: () => {
            revision++;
            root.unmount();
        },
    };
}

/** Use the same chooser in the shared recording controls. */
export function createRecordingFolder({ container, prefix, request, send, t }) {
    let current;
    const field = createFolderField({
        container,
        prefix,
        request,
        t,
        variant: "pill",
        save: async (folder) => {
            const response = await send({
                type: "set-recording-folder",
                sessionId: current.sessionId,
                ...folder,
            });
            if (!response?.ok)
                throw new Error(response?.error || t("folderChangeFailed"));
        },
        saveOnRefresh: async (folder) => {
            const response = await send({
                type: "set-recording-folder",
                sessionId: current.sessionId,
                ...folder,
                remember: false,
            });
            if (!response?.ok)
                throw new Error(response?.error || t("folderChangeFailed"));
        },
    });
    return {
        render(state) {
            current = state;
            container.hidden = state.state !== "recording" || state.stopped;
            if (container.hidden) field.close();
            else
                field.reset(state, {
                    readOnly: state.recordingFolderOverride !== true,
                });
        },
        saved: () => field.saved().catch(() => {}),
        close: field.close,
        destroy: field.destroy,
    };
}
