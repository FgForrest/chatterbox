(() => {
    const LRM = "\u200E";

    function createFolderCombobox({
        input,
        listbox,
        panel,
        status,
        hint,
        onPick,
        request,
        save,
        saveOnRefresh = save,
        t,
    }) {
        let readOnly = false;
        const optionPrefix =
            listbox.id === "folder-listbox"
                ? "folder-option"
                : `${listbox.id}-option`;
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

        function persist(refresh = false) {
            const settings = {
                folderId: remembered?.id ?? null,
                folderLabel: remembered?.label ?? null,
            };
            saving = saving.catch(() => {}).then(() =>
                (refresh ? saveOnRefresh : save)(settings),
            );
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
            if (hint) hint.hidden = !readOnly && query.length >= 2;
            panel.hidden = !open;
            input.setAttribute("aria-expanded", String(open));
            input.setAttribute("aria-busy", String(loading));
            options = [
                { id: null, label: t("fileLater") },
                ...visibleChoices(),
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
            status.textContent = statusMessage();
        }

        function visibleChoices() {
            if (query.length >= 2) return results;
            return remembered ? [remembered] : [];
        }

        function statusMessage() {
            if (loading) return t("foldersLoading");
            if (error) return t("folderSearchFailed");
            if (query.length >= 2 && results.length === 0) {
                return t("noFoldersFound");
            }
            return "";
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
            void persist().then(() => onPick?.()).catch(() => {});
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
                        await persist(true).catch(() => {});
                    } else if (response?.status === 404) {
                        remembered = null;
                        await persist(true).catch(() => {});
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

    function createFolderField({
        container,
        prefix = "folder",
        onPick,
        request,
        save,
        saveOnRefresh = save,
        t,
    }) {
        const node = (tag, suffix, className, attributes = {}) => {
            const element = document.createElement(tag);
            element.id = `${prefix}-${suffix}`;
            if (className) element.className = className;
            for (const [key, value] of Object.entries(attributes)) {
                element.setAttribute(key, value);
            }
            return element;
        };
        const results = node("div", "results", "folder-results", { hidden: "" });
        results.append(
            node("div", "listbox", "folder-listbox", { role: "listbox", "aria-labelledby": `${prefix}-label` }),
            node("p", "status", "folder-status hint", { role: "status", "aria-live": "polite" }),
        );
        container.replaceChildren(
            node("label", "label", "", { for: `${prefix}-picker` }),
            node("input", "picker", "folder-picker", {
                type: "text", role: "combobox", "aria-autocomplete": "list",
                "aria-expanded": "false", "aria-controls": `${prefix}-listbox`,
                "aria-activedescendant": "", "aria-describedby": `${prefix}-hint`, autocomplete: "off",
            }),
            node("span", "hint", "hint"),
            results,
            node("p", "error", "error hint", { role: "status", hidden: "" }),
        );
        const root = container.getRootNode?.() ?? document;
        const el = (suffix) => root.getElementById(`${prefix}-${suffix}`);
        el("label").textContent = t("folder");
        const combobox = createFolderCombobox({
            input: el("picker"),
            listbox: el("listbox"),
            panel: el("results"),
            status: el("status"),
            hint: el("hint"),
            onPick,
            request,
            save: (settings) => persistFolder(settings, save),
            saveOnRefresh: (settings) => persistFolder(settings, saveOnRefresh),
            t,
        });
        async function persistFolder(settings, saver) {
            try {
                await saver(settings);
                el("error").hidden = true;
            } catch (error) {
                el("error").textContent =
                    error?.message || t("folderChangeFailed");
                el("error").hidden = false;
                throw error;
            }
        }
        return {
            reset(settings, options = {}) {
                el("hint").textContent = t(
                    options.readOnly
                        ? "folderFixedAtStart"
                        : "folderSearchHint",
                );
                combobox.reset(settings, options);
            },
            saved: combobox.saved,
        };
    }

    function createRecordingFolder({ container, prefix, request, send, t, onPick }) {
        let current = null;
        let signature = "";
        let field;
        async function saveFolder(folder, remember = true) {
            try {
                const response = await send({
                    type: "set-recording-folder",
                    sessionId: current.sessionId,
                    ...folder,
                    ...(!remember ? { remember: false } : {}),
                });
                if (!response?.ok)
                    throw new Error(response?.error || t("folderChangeFailed"));
            } catch (error) {
                field.reset(current, {
                    readOnly: current.recordingFolderOverride !== true,
                    refresh: false,
                });
                throw error;
            }
        }
        return {
            render(state) {
                container.hidden = state.state !== "recording" || state.stopped;
                if (container.hidden) return;
                field ??= createFolderField({
                    container,
                    prefix,
                    onPick,
                    request,
                    t,
                    save: (folder) => saveFolder(folder),
                    saveOnRefresh: (folder) => saveFolder(folder, false),
                });
                current = state;
                const next = JSON.stringify([
                    state.sessionId,
                    state.folderId,
                    state.folderLabel,
                    state.recordingFolderOverride,
                ]);
                if (signature === next) return;
                signature = next;
                field.reset(state, {
                    readOnly: state.recordingFolderOverride !== true,
                });
            },
            saved: () => field?.saved().catch(() => {}) ?? Promise.resolve(),
        };
    }

    Object.defineProperty(globalThis, "recorderFolders", {
        value: {
            createFolderCombobox,
            createFolderField,
            createRecordingFolder,
        },
        configurable: true,
    });
})();
