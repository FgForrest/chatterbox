import React, { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
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
    const root = createRoot(container);
    let current = {};
    let options = {};
    let entries = [];
    let recent = [];
    let pending = Promise.resolve();
    let revision = 0;
    let refreshError = "";
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
        const selected = current.folderId ?? "";
        const visible =
            entries.some((entry) => entry.folder.id === selected) || !selected
                ? entries
                : [
                      ...entries,
                      {
                          folder: {
                              id: selected,
                              name: current.folderLabel || t("savedFolder"),
                              scope: "personal",
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
                <label id={`${prefix}-label`}>{t("folder")}</label>
                <FolderCombobox
                    entries={visible}
                    value={selected}
                    environment={environment()}
                    variant={variant}
                    aria-label={t("folder")}
                    disabled={options.readOnly}
                    emptyChoiceLabel={t("fileLater")}
                    onValueChange={(id) => {
                        const folder = entries.find(
                            (entry) => entry.folder.id === id,
                        )?.folder;
                        const previous = current;
                        revision++;
                        current = {
                            folderId: id || null,
                            folderLabel:
                                folder?.fullPath ?? folder?.name ?? null,
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
                                setError(
                                    error?.message || t("folderChangeFailed"),
                                );
                                paint();
                                throw error;
                            });
                        return pending;
                    }}
                />
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
                    };
                    pending = pending
                        .catch(() => {})
                        .then(() => saveOnRefresh(current));
                } else {
                    const lookup = await request({ id: current.folderId });
                    if (version !== revision) return;
                    if (lookup?.status === 404) {
                        current = { folderId: null, folderLabel: null };
                        pending = pending
                            .catch(() => {})
                            .then(() => saveOnRefresh(current));
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
                options.readOnly !== nextOptions.readOnly;
            current = value;
            options = nextOptions;
            if (!changed && entries.length) return;
            revision++;
            paint();
            if (nextOptions.refresh !== false && !nextOptions.readOnly)
                void refresh(revision);
        },
        saved: () => pending,
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
            if (!container.hidden)
                field.reset(state, {
                    readOnly: state.recordingFolderOverride !== true,
                });
        },
        saved: field.saved,
        destroy: field.destroy,
    };
}
