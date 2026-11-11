(() => {
    if (typeof globalThis.recorderMeetingBanner?.refresh === "function") {
        globalThis.recorderMeetingBanner.refresh();
        return;
    }
    const t = (key, substitutions) =>
        chrome.i18n.getMessage(key, substitutions) || key;
    const send = (message) => {
        if (!chrome.runtime?.id) {
            hide();
            return Promise.resolve({ ok: false });
        }
        return chrome.runtime.sendMessage(message);
    };
    const host = document.createElement("div");
    host.id = "recorder-meeting-banner";
    host.style.cssText =
        "all:initial!important;position:fixed!important;inset:16px 16px auto!important;z-index:2147483647!important;display:flex!important;justify-content:center!important;pointer-events:none!important;";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
        :host { color-scheme:light dark; --background:#faf9f5; --foreground:#243348; --surface:#fff; --muted:#f1eee8; --muted-foreground:#626b73; --border:#dad9d4; --primary:#c63b50; --primary-foreground:#fff; --error:#b42332; --meeting:#23766e; --organization:#356cac; --restricted:#647119; }
        @media(prefers-color-scheme:dark) { :host { --background:#3b3a38; --foreground:#d4d0c9; --surface:#444340; --muted:#302f2d; --muted-foreground:#c3bdb3; --border:#62605b; --primary:#f35f6d; --primary-foreground:#14263c; --error:#ff8b94; --meeting:#7bd4c8; --organization:#8ebaf1; --restricted:#b7c86b; } }
        * { box-sizing:border-box; }
        [hidden] { display:none!important; }
        .surface { pointer-events:auto; position:relative; max-width:600px; width:100%; background:var(--surface); color:var(--foreground); border:1px solid var(--border); border-radius:12px; box-shadow:0 12px 32px -12px rgb(20 30 45 / .35),0 2px 6px rgb(20 30 45 / .12); font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; text-align:left; overflow-wrap:anywhere; }
        .prompt { display:grid; grid-template-columns:32px minmax(0,1fr) 26px; gap:14px; padding:14px 14px 14px 16px; }
        .logo { width:32px; height:32px; border-radius:8px; }
        #how strong { color:var(--primary); font-weight:650; }
        .body { display:grid; gap:6px; }
        h2,p { margin:0; }
        h2 { font-size:15px; font-weight:650; }
        .notice { border-left:2px solid var(--border); padding-left:8px; color:var(--muted-foreground); font-size:12.5px; }
        .links { display:flex; flex-wrap:wrap; gap:4px 16px; padding-top:2px; }
        button,input { font:inherit; color:inherit; }
        button { cursor:pointer; border:1px solid var(--border); border-radius:999px; background:var(--surface); padding:6px 12px; }
        button:hover { border-color:var(--primary); }
        button:disabled { cursor:wait; opacity:.65; }
        button:focus-visible,input:focus-visible { outline:2px solid var(--primary); outline-offset:2px; }
        button.link { background:none; border:0; padding:0; color:var(--muted-foreground); text-decoration:underline; text-underline-offset:2px; font-size:13px; }
        button.close { border:0; padding:0; border-radius:6px; width:26px; height:26px; font-size:20px; color:var(--muted-foreground); }
        kbd { font:500 12px/1.5 ui-monospace,monospace; border:1px solid var(--border); border-bottom-width:2px; border-radius:5px; background:var(--muted); padding:2px 6px; white-space:nowrap; }
        .pill { display:flex; align-items:center; justify-content:center; flex-wrap:nowrap; gap:8px; border-radius:24px; padding:6px; width:fit-content; max-width:100%; min-width:0; font-size:13px; }
        .dot { display:inline-block; width:9px; height:9px; border-radius:50%; background:var(--primary); animation:pulse 1.8s ease-in-out infinite; }
        @keyframes pulse { 50% { opacity:.4; } }
        @media(prefers-reduced-motion:reduce) { .dot { animation:none; } }
        .dot-button { display:grid; place-items:center; width:28px; height:28px; padding:0; border:0; }
        .elapsed { font-variant-numeric:tabular-nums; font-weight:650; }
        .dot-button,.label,.elapsed,#pill-agenda,.stop { flex:none; white-space:nowrap; }
        .pill > .error:empty { display:none; }
        .folder-target { display:inline-flex; flex:0 1 auto; min-width:0; max-width:180px; height:28px; align-items:center; border:1px solid var(--border); border-radius:calc(infinity * 1px); overflow:hidden; font-size:12px; line-height:16px; }
        .folder-chip { min-width:69px; --folder-color:var(--primary); border-color:color-mix(in oklab,var(--folder-color) 20%,transparent); background:color-mix(in oklab,var(--folder-color) 5%,transparent); }
        .folder-chip.organization { --folder-color:var(--organization); }
        .folder-chip.restricted { --folder-color:var(--restricted); }
        .folder-target button { display:inline-flex; align-items:center; height:100%; border:0; border-radius:0; background:transparent; font-size:inherit; line-height:inherit; padding:0; }
        .folder-target .folder-button { gap:6px; padding:0 10px; min-width:0; color:var(--foreground); }
        .folder-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .folder-target svg { width:14px; height:14px; flex:none; }
        .folder-chip .folder-button svg { color:var(--folder-color); }
        .folder-chip .folder-button:hover:not(:disabled) { background:color-mix(in oklab,var(--folder-color) 10%,transparent); }
        .folder-target .folder-remove { flex:none; padding:0 6px; color:var(--muted-foreground); border-left:1px solid color-mix(in oklab,var(--folder-color) 15%,transparent); }
        .folder-target .folder-remove:hover { background:color-mix(in oklab,var(--error) 10%,transparent); color:var(--error); }
        .folder-add { border-style:dashed; }
        .folder-add .folder-button { gap:4px; color:var(--muted-foreground); }
        .folder-add .folder-button:hover { color:var(--foreground); }
        .folder-target button:disabled { cursor:default; opacity:1; }
        .folder-readonly { flex-wrap:wrap; }
        .folder-fixed { flex:0 0 100%; order:1; max-width:100%; padding:0 8px 4px; text-align:center; font-size:11px; }
        .stop { background:var(--primary); border-color:var(--primary); color:var(--primary-foreground); font-weight:600; }
        .field { position:absolute; top:calc(100% + 8px); right:0; width:min(360px,calc(100vw - 32px)); background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:12px; box-shadow:0 8px 24px rgb(20 30 45 / .2); display:grid; gap:6px; }
        .field label,.hint { font-size:12px; }
        .hint { color:var(--muted-foreground); }
        .error { color:var(--error); }
        .folder-picker { width:100%; border:1px solid var(--border); border-radius:7px; padding:7px 8px; background:var(--surface); }
        .folder-picker,.folder-option { min-width:0; overflow:hidden; text-overflow:ellipsis; direction:rtl; text-align:left; }
        .folder-picker:focus { direction:ltr; }
        .folder-option::after { content:"\u200E"; }
        .folder-results { border:1px solid var(--border); border-radius:7px; overflow:hidden; }
        .folder-listbox { max-height:min(150px,40vh); overflow-y:auto; }
        .folder-option { padding:7px 8px; cursor:pointer; white-space:nowrap; }
        .folder-option:hover,.folder-option[data-active="true"] { background:var(--muted); outline:1px solid var(--primary); outline-offset:-1px; }
        .folder-status { padding:7px 8px; }
        .folder-status:empty { display:none; }
        .agenda-line { display:flex; flex-wrap:wrap; align-items:center; gap:8px; border-top:1px solid var(--border); padding-top:8px; color:var(--meeting); }
        .confirmation { padding:10px 16px; width:fit-content; }
        @media(max-width:440px) { .prompt { grid-template-columns:minmax(0,1fr) 26px; gap:8px; padding:12px; } .logo { display:none; } .pill { flex-wrap:wrap; } .folder-target { max-width:130px; } .label { font-size:12px; } }
    `;
    const surface = document.createElement("section");
    surface.setAttribute("role", "dialog");
    surface.setAttribute("aria-label", t("meetingPromptTitle", t("appName")));
    surface.lang = chrome.i18n.getUILanguage();
    root.append(style, surface);
    let currentView = "hidden";
    let renderVersion = 0;
    let currentState = null;
    let timer;
    let hideTimer;
    let stoppedSession = null;
    let collapsed = false;
    let folderOpen = false;
    let recordingFolder;
    const folderMetadata = new Map();
    const el = (id) => root.getElementById(id);

    function text(id, message) {
        el(id).textContent = message;
    }

    function hide() {
        clearInterval(timer);
        clearTimeout(hideTimer);
        host.remove();
        currentView = "hidden";
    }

    function showError(error) {
        const status = el("action-error");
        if (status) status.textContent = error?.message || t("somethingWrong");
    }

    async function dismiss() {
        try {
            const response = await send({ type: "meeting-banner-dismiss" });
            if (!response?.ok)
                throw new Error(response?.error || t("somethingWrong"));
            hide();
        } catch (error) {
            showError(error);
        }
    }

    function node(tag, attributes = {}, children = []) {
        const element = document.createElement(tag);
        for (const [key, value] of Object.entries(attributes)) {
            element.setAttribute(key, value);
        }
        element.append(...children);
        return element;
    }

    function button(id, className, children = [], attributes = {}) {
        return node("button", { id, class: className, type: "button", ...attributes }, children);
    }

    function folderIcon(kind) {
        const paths = {
            folder: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"],
            users: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M16 3.128a4 4 0 0 1 0 7.744", "M22 21v-2a4 4 0 0 0-3-3.87"],
            "folder-lock": ["M10 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v2.5", "M20 17v-2a2 2 0 1 0-4 0v2"],
            plus: ["M12 10v6", "M9 13h6", "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"],
            x: ["M18 6 6 18", "m6 6 12 12"],
        };
        const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", width: "14", height: "14", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: `lucide lucide-${kind === "plus" ? "folder-plus" : kind}` })) icon.setAttribute(key, value);
        for (const d of paths[kind]) {
            const path = document.createElementNS(icon.namespaceURI, "path");
            path.setAttribute("d", d);
            icon.append(path);
        }
        if (kind === "users") {
            const circle = document.createElementNS(icon.namespaceURI, "circle");
            for (const [key, value] of Object.entries({ cx: "9", cy: "7", r: "4" })) circle.setAttribute(key, value);
            icon.append(circle);
        } else if (kind === "folder-lock") {
            const lock = document.createElementNS(icon.namespaceURI, "rect");
            for (const [key, value] of Object.entries({ width: "8", height: "5", x: "14", y: "17", rx: "1" })) lock.setAttribute(key, value);
            icon.append(lock);
        }
        return icon;
    }

    function renderFolderTarget(state) {
        const selected = Boolean(state.folderId);
        const path = state.folderLabel || t("savedFolder");
        const name = path.split(/ › | \/ /).at(-1);
        const readOnly = state.recordingFolderOverride !== true;
        const organization = state.folderScope === "org";
        const restricted = folderMetadata.get(state.folderId)?.restricted === true;
        surface.classList.toggle("folder-readonly", readOnly);
        el("folder-target").className = `folder-target ${selected ? `folder-chip${restricted ? " restricted" : organization ? " organization" : ""}` : "folder-add"}`;
        const icon = folderIcon(selected ? restricted ? "folder-lock" : organization ? "users" : "folder" : "plus");
        if (selected) icon.classList.add(restricted ? "text-restricted" : organization ? "text-organization" : "text-primary");
        el("folder-toggle").replaceChildren(icon, node("span", { class: "folder-name" }, [selected ? name : t("folderAdd")]));
        el("folder-toggle").title = selected ? path : t("folderAdd");
        el("folder-toggle").disabled = readOnly;
        el("folder-remove").hidden = readOnly || !selected;
        el("folder-remove").setAttribute("aria-label", t("folderRemove", name));
        el("folder-fixed").textContent = t("folderFixedAtStart");
        el("folder-fixed").hidden = !readOnly;
        if (readOnly) folderOpen = false;
    }

    function logo() {
        return node("img", { class: "logo", src: "data:image/png;base64,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", alt: "" });
    }

    function unpinnedHowKey(message) {
        if (!message.policyRequired) return "meetingPromptHowUnpinned";
        return message.pinned
            ? "meetingPromptPolicyPinned"
            : "meetingPromptPolicyUnpinned";
    }

    function viewLabel(view) {
        switch (view) {
            case "prompt":
                return t("meetingPromptTitle", t("appName"));
            case "recording":
                return t("meetingPromptRecording", t("appName"));
            case "error":
                return t("meetingPromptErrorTitle", t("appName"));
            case "waiting":
                return t("startingCapture");
            default:
                return t("recordingStopped");
        }
    }

    function renderPrompt(message) {
        surface.className = "surface prompt";
        surface.replaceChildren(
            logo(),
            node("div", { class: "body" }, [
                node("h2", { id: "title" }),
                node("p", { id: "how" }),
                node("p", { class: "notice" }, [
                    node("span", { id: "notice-label" }), " ",
                    node("span", { id: "notice" }), " ", node("span", { id: "consent" }),
                ]),
                node("div", { class: "links" }, [button("dialog", "link"), button("not-now", "link")]),
                node("p", { id: "action-error", class: "error", role: "status" }),
            ]),
            button("close", "close", ["×"]),
        );
        if (message.agendas?.length) {
            const line = node("div", { class: "agenda-line" }, [
                node("span", {}, [t("agendaTitle"), ": ", message.agendas.length === 1 ? message.agendas[0].title : t("agendaMultiple", String(message.agendas.length))]),
                button("agenda-show", "", [t("agendaShow")]),
            ]);
            el("how").parentElement.append(line);
            el("agenda-show").addEventListener("click", () => {
                void send({ type: "open-agenda" }).catch(showError);
            });
        }
        text("title", t("meetingPromptTitle", t("appName")));
        if (message.agendaPanel) {
            text("how", t("agendaPanelIcon", t("appName")));
        } else if (message.pinned && !message.policyRequired) {
            const icon = node("strong", {}, [t("meetingPromptIcon", t("appName"))]);
            const shortcut = message.shortcut
                ? [t("meetingPromptPinnedShortcut"), " ", node("kbd", {}, [message.shortcut])]
                : [];
            for (const part of t("meetingPromptHowPinned", ["\uFFF0", "\uFFF1"]).split(/([\uFFF0\uFFF1])/)) {
                if (part === "\uFFF0") el("how").append(icon);
                else if (part === "\uFFF1") el("how").append(...shortcut);
                else el("how").append(part);
            }
        } else {
            text("how", t(unpinnedHowKey(message), t("appName")));
            if (message.shortcut && !message.policyRequired) {
                el("how").append(` ${t("meetingPromptOrShortcut")} `, node("kbd", {}, [message.shortcut]), ".");
            }
        }
        text("notice-label", t("meetingPromptNoticeLabel"));
        text("notice", message.notice);
        text("consent", message.agendaPanel ? "" : t(message.policyRequired ? "meetingPromptPolicyConsent" : "meetingPromptConsent"));
        text("dialog", t("meetingPromptDialog"));
        text("not-now", t("notNow"));
        el("close").setAttribute("aria-label", t("meetingPromptDismiss"));
        el("not-now").addEventListener("click", dismiss);
        el("close").addEventListener("click", dismiss);
        el("dialog").addEventListener("click", async () => {
            el("dialog").disabled = true;
            try {
                const response = await send({ type: "meeting-banner-dialog" });
                if (!response?.ok)
                    throw new Error(response?.error || t("couldNotStart"));
            } catch (error) {
                if (currentView === "prompt") {
                    showError(error);
                    el("dialog").disabled = false;
                }
            }
        });
    }

    function updateCollapsed() {
        el("pill-details").hidden = collapsed;
        el("dot-toggle").setAttribute(
            "aria-label",
            t(collapsed ? "meetingPromptExpand" : "meetingPromptCollapse"),
        );
        el("dot-toggle").setAttribute("aria-expanded", String(!collapsed));
        el("pill-folder").hidden = collapsed || !folderOpen;
        el("folder-toggle").setAttribute("aria-expanded", String(!collapsed && folderOpen));
    }

    function renderRecording(state) {
        if (currentView !== "recording") {
            folderMetadata.clear();
            collapsed = false;
            folderOpen = false;
            surface.className = "surface pill";
            surface.replaceChildren(
                button("dot-toggle", "dot-button", [node("span", { class: "dot", "aria-hidden": "true" })]),
                node("span", { id: "pill-details", style: "display:contents" }, [
                    node("span", { id: "recording-label", class: "label" }),
                    node("span", { id: "elapsed", class: "elapsed" }),
                    node("span", { id: "folder-target", class: "folder-target" }, [
                        button("folder-toggle", "folder-button", [], { "aria-controls": "pill-folder", "aria-expanded": "false", "aria-haspopup": "listbox" }),
                        button("folder-remove", "folder-remove", [folderIcon("x")]),
                    ]),
                    node("span", { id: "folder-fixed", class: "hint folder-fixed", hidden: "" }),
                    button("pill-agenda", "", [t("agendaTitle")], { hidden: "" }),
                    button("stop", "stop"),
                ]),
                node("div", { id: "pill-folder", class: "field", hidden: "" }),
                node("p", { id: "action-error", class: "error", role: "status" }),
            );
            text("recording-label", t("meetingPromptRecording", t("appName")));
            text("stop", t("meetingPromptStop"));
            recordingFolder = globalThis.recorderFolders.createRecordingFolder({
                container: el("pill-folder"),
                prefix: "meeting-folder",
                t,
                request: async (params) => {
                    const response = await send({ type: "get-folders", ...params });
                    if (response?.ok) {
                        for (const folder of response.folders ?? []) folderMetadata.set(folder.id, folder);
                        if (currentView === "recording") renderFolderTarget(currentState);
                    }
                    return response;
                },
                send,
                onPick: () => {
                    if (currentView !== "recording") return;
                    folderOpen = false;
                    updateCollapsed();
                    el("folder-toggle").focus();
                },
            });
            el("dot-toggle").addEventListener("click", () => {
                collapsed = !collapsed;
                updateCollapsed();
            });
            el("folder-remove").addEventListener("click", async () => {
                if (currentState.recordingFolderOverride !== true) return;
                folderOpen = false;
                updateCollapsed();
                el("folder-toggle").focus();
                try {
                    await recordingFolder.clear();
                } catch (error) {
                    showError(error);
                }
            });
            el("folder-toggle").addEventListener("click", () => {
                if (currentState.recordingFolderOverride !== true) return;
                folderOpen = !folderOpen;
                updateCollapsed();
                if (folderOpen) el("meeting-folder-picker").focus();
            });
            el("pill-agenda").addEventListener("click", () => {
                void send({ type: "open-agenda" }).catch(showError);
            });
            el("stop").addEventListener("click", async () => {
                el("stop").disabled = true;
                try {
                    await recordingFolder.saved();
                    const response = await send({
                        type: "stop-recording",
                        sessionId: currentState.sessionId,
                    });
                    if (!response?.ok)
                        throw new Error(response?.error || t("somethingWrong"));
                } catch (error) {
                    if (currentView === "recording") {
                        showError(error);
                        el("stop").disabled = false;
                    }
                }
            });
        }
        el("pill-agenda").hidden = !state.agendas?.length;
        renderFolderTarget(state);
        recordingFolder.render(state);
        updateCollapsed();
        const tick = () => {
            if (!chrome.runtime?.id) {
                hide();
                return;
            }
            const seconds =
                Math.max(
                    0,
                    Math.floor(
                        (Date.now() - Date.parse(state.startedAt)) / 1000,
                    ),
                ) || 0;
            const hours = Math.floor(seconds / 3600);
            const minutes = String(Math.floor(seconds / 60) % 60).padStart(2, "0");
            const remainder = String(seconds % 60).padStart(2, "0");
            text("elapsed", `${hours ? `${hours}:` : ""}${minutes}:${remainder}`);
        };
        tick();
        clearInterval(timer);
        timer = setInterval(tick, 1000);
    }

    function render(message) {
        renderVersion += 1;
        if (message.view === "hidden") {
            hide();
            return;
        }
        if (
            message.view === "stopped" &&
            stoppedSession === message.state?.sessionId
        )
            return;
        clearTimeout(hideTimer);
        host.style.setProperty("top", `${message.topOffset ?? 16}px`, "important");
        const label = viewLabel(message.view);
        surface.setAttribute("aria-label", label);
        currentState = message.state ?? null;
        if (message.view !== "recording") clearInterval(timer);
        if (message.view === "prompt") renderPrompt(message);
        else if (message.view === "recording") renderRecording(message.state);
        else {
            surface.className = "surface confirmation";
            surface.replaceChildren();
            const status = document.createElement("p");
            status.setAttribute("role", "status");
            const isError = message.view === "error";
            if (isError) {
                status.textContent = message.state.error || t("somethingWrong");
                status.className = "error";
                surface.append(node("h2", {}, [label]));
            } else {
                status.textContent = t(
                    message.view === "waiting"
                        ? "startingCapture"
                        : "meetingPromptStopped",
                );
            }
            surface.append(status);
            if (isError) {
                const close = document.createElement("button");
                close.type = "button";
                close.textContent = t("meetingPromptDismiss");
                close.addEventListener("click", dismiss);
                surface.append(close);
            }
            if (message.view === "stopped") {
                stoppedSession = message.state?.sessionId;
                hideTimer = setTimeout(hide, 3500);
            }
        }
        currentView = message.view;
        if (!host.isConnected) {
            document.getElementById("recorder-meeting-banner")?.remove();
            document.documentElement.append(host);
        }
    }

    for (const type of ["keyup", "keypress", "beforeinput", "input"]) {
        surface.addEventListener(type, (event) => event.stopPropagation());
    }
    surface.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key !== "Escape") return;
        if (currentView === "prompt") void dismiss();
        else if (currentView === "recording") {
            folderOpen = false;
            collapsed = true;
            updateCollapsed();
            el("dot-toggle").focus();
        } else if (currentView === "error") void dismiss();
        else hide();
    });

    chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (
            message?.type !== "meeting-banner" ||
            sender.id !== chrome.runtime.id ||
            sender.tab
        )
            return false;
        render(message);
        respond({ visible: host.isConnected && currentView === "prompt" });
        return false;
    });
    function refresh() {
        if (!chrome.runtime?.id) {
            hide();
            return;
        }
        const version = renderVersion;
        const hideIfCurrent = () => { if (version === renderVersion) hide(); };
        void send({ type: "meeting-banner-ready" })
            .then((response) => { if (!response?.ok) hideIfCurrent(); })
            .catch(hideIfCurrent);
    }
    globalThis.recorderMeetingBanner = { refresh };
    window.addEventListener("pageshow", (event) => {
        if (event.isTrusted === false) return;
        refresh();
    });
    refresh();
})();
