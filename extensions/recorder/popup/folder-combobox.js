const LRM = "\u200E";

/** Bind the recorder folder autocomplete to popup controls. */
export function createFolderCombobox({
    input,
    listbox,
    panel,
    status,
    request,
    save,
    t,
}) {
    let readOnly = false;
    const optionPrefix = listbox.id === "folder-listbox" ? "folder-option" : `${listbox.id}-option`;
    let remembered = null;
    let results = [];
    let options = [];
    let active = -1;
    let query = "";
    let open = false;
    let loading = false;
    let error = false;
    let timer;
    let version = 0;
    let selectionVersion = 0;
    let pending = null;
    let inFlight = false;
    let saving = Promise.resolve();

    function persist() {
        const settings = {
            folderId: remembered?.id ?? null,
            folderLabel: remembered?.label ?? null,
        };
        saving = saving.catch(() => {}).then(() => save(settings));
        return saving;
    }

    function selectedLabel() {
        return remembered?.label || t("fileLater");
    }

    function showSelection() {
        input.value = `${selectedLabel()}${LRM}`;
        input.title = selectedLabel();
    }

    function render() {
        panel.hidden = !open;
        input.setAttribute("aria-expanded", String(open));
        input.setAttribute("aria-busy", String(loading));
        options = [
            { id: null, label: t("fileLater") },
            ...(query.length >= 2 ? results : remembered ? [remembered] : []),
        ];
        if (active >= options.length) active = -1;
        input.setAttribute(
            "aria-activedescendant",
            open && active >= 0 ? `${optionPrefix}-${active}` : "",
        );
        listbox.replaceChildren(
            ...options.map((option, index) => {
                const node = document.createElement("div");
                node.id = `${optionPrefix}-${index}`;
                node.className = "folder-option";
                node.setAttribute("role", "option");
                node.setAttribute(
                    "aria-selected",
                    String(option.id === (remembered?.id ?? null)),
                );
                node.setAttribute("data-active", String(index === active));
                node.textContent = option.label;
                node.title = option.label;
                node.addEventListener("mousedown", (event) =>
                    event.preventDefault(),
                );
                node.addEventListener("click", () => pick(option));
                return node;
            }),
        );
        listbox.children[active]?.scrollIntoView?.({ block: "nearest" });
        status.textContent = loading
            ? t("foldersLoading")
            : error
              ? t("folderSearchFailed")
              : query.length >= 2 && results.length === 0
                ? t("noFoldersFound")
                : "";
    }

    function cancelSearch() {
        clearTimeout(timer);
        pending = null;
        version += 1;
        loading = false;
        error = false;
    }

    function close() {
        cancelSearch();
        open = false;
        query = "";
        active = -1;
        showSelection();
        render();
    }

    function pick(option) {
        remembered = option.id ? option : null;
        selectionVersion += 1;
        void persist().catch(() => {});
        close();
    }

    async function pump() {
        if (inFlight || !pending) return;
        const job = pending;
        pending = null;
        inFlight = true;
        try {
            const response = await request(job.params);
            if (job.selection !== undefined) {
                if (job.selection !== selectionVersion) return;
                if (response?.ok && response.folders?.[0]) {
                    remembered = response.folders[0];
                    await persist().catch(() => {});
                } else if (response?.status === 404) {
                    remembered = null;
                    await persist().catch(() => {});
                }
                if (!open) showSelection();
            } else if (job.version === version) {
                results = response?.ok ? (response.folders ?? []) : [];
                error = !response?.ok;
                loading = false;
            }
        } catch {
            if (job.selection === undefined && job.version === version) {
                error = true;
                loading = false;
            }
        } finally {
            inFlight = false;
            render();
            void pump();
        }
    }

    input.addEventListener("focus", () => {
        if (readOnly) return;
        open = true;
        query = "";
        active = -1;
        input.value = selectedLabel();
        input.select();
        render();
    });
    input.addEventListener("click", () => {
        if (readOnly) return;
        if (!open) {
            open = true;
            input.select();
            render();
        }
    });
    input.addEventListener("blur", close);
    input.addEventListener("input", () => {
        if (readOnly) return;
        cancelSearch();
        open = true;
        query = input.value.replaceAll(LRM, "").trim();
        active = -1;
        results = [];
        if (query.length >= 2) {
            loading = true;
            const currentVersion = version;
            const q = query;
            timer = setTimeout(() => {
                pending = { params: { q }, version: currentVersion };
                void pump();
            }, 200);
        }
        render();
    });
    input.addEventListener("keydown", (event) => {
        if (readOnly) return;
        if (event.key === "Escape") {
            event.preventDefault();
            close();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            open = true;
            active =
                event.key === "ArrowDown"
                    ? (active + 1) % options.length
                    : (active <= 0 ? options.length : active) - 1;
            render();
        } else if (event.key === "Enter" && open && active >= 0) {
            event.preventDefault();
            pick(options[active]);
        }
    });

    return {
        reset(settings, options = {}) {
            readOnly = options.readOnly === true;
            input.readOnly = readOnly;
            input.setAttribute("aria-readonly", String(readOnly));
            cancelSearch();
            selectionVersion += 1;
            remembered = settings.folderId
                ? {
                      id: settings.folderId,
                      label: settings.folderLabel || t("savedFolder"),
                  }
                : null;
            close();
            if (remembered && !readOnly && options.refresh !== false) {
                pending = {
                    params: { id: remembered.id },
                    selection: selectionVersion,
                };
                void pump();
            }
        },
        saved: () => saving,
    };
}

/** Mount the shared folder field in an idle or recording view. */
export function createFolderField({ container, prefix = "folder", request, save, t }) {
    container.innerHTML = `
        <label id="${prefix}-label" for="${prefix}-picker"></label>
        <input id="${prefix}-picker" class="folder-picker" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${prefix}-listbox" aria-activedescendant="" aria-describedby="${prefix}-hint" autocomplete="off" />
        <span id="${prefix}-hint" class="hint"></span>
        <div id="${prefix}-results" class="folder-results" hidden>
            <div id="${prefix}-listbox" class="folder-listbox" role="listbox" aria-labelledby="${prefix}-label"></div>
            <p id="${prefix}-status" class="folder-status hint" role="status" aria-live="polite"></p>
        </div>
        <p id="${prefix}-error" class="error hint" role="status" hidden></p>`;
    const el = (suffix) => document.getElementById(`${prefix}-${suffix}`);
    el("label").textContent = t("folder");
    const combobox = createFolderCombobox({
        input: el("picker"), listbox: el("listbox"), panel: el("results"),
        status: el("status"), request,
        save: async (settings) => {
            try {
                await save(settings);
                el("error").hidden = true;
            } catch (error) {
                el("error").textContent = error?.message || t("folderChangeFailed");
                el("error").hidden = false;
                throw error;
            }
        },
        t,
    });
    return {
        reset(settings, options = {}) {
            el("hint").textContent = t(options.readOnly ? "folderFixedAtStart" : "folderSearchHint");
            combobox.reset(settings, options);
        },
        saved: combobox.saved,
    };
}

/** Bind a shared folder field to the current recording's target. */
export function createRecordingFolder({ container, prefix, request, send, t }) {
    let current = null;
    let signature = "";
    let field;
    return {
        render(state) {
            container.hidden = state.state !== "recording" || state.stopped;
            if (container.hidden) return;
            field ??= createFolderField({
                container, prefix, request, t,
                save: async (folder) => {
                    try {
                        const response = await send({ type: "set-recording-folder", sessionId: current.sessionId, ...folder });
                        if (!response?.ok) throw new Error(response?.error || t("folderChangeFailed"));
                    } catch (error) {
                        field.reset(current, { readOnly: current.recordingFolderOverride !== true, refresh: false });
                        throw error;
                    }
                },
            });
            current = state;
            const next = JSON.stringify([state.sessionId, state.folderId, state.folderLabel, state.recordingFolderOverride]);
            if (signature === next) return;
            signature = next;
            field.reset(state, { readOnly: state.recordingFolderOverride !== true });
        },
        saved: () => field?.saved().catch(() => {}) ?? Promise.resolve(),
    };
}
