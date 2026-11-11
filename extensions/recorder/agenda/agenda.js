import { bindAgendaTextInput } from "../generated/text.js";
import { subscribeAgenda } from "../lib/agenda-live.js";
import {
    agendaChoices,
    agendaFolder,
    agendaPanelKey,
    agendaRequest,
    canChooseRecordingAgenda,
    supportsAgendas,
} from "../lib/agendas.js";
import { localizeDocument, t } from "../lib/i18n.js";
import { renderLinkedText } from "../lib/linkify.js";
import { meetCode } from "../lib/meet-code.js";
import { formatMeetingTime } from "../lib/meeting-time.js";

import { detectMeetingPlatform } from "../lib/platforms.js";
import { mountRecordingControls } from "../lib/recording-controls.js";
import { getSettings } from "../lib/settings.js";

localizeDocument();
const el = (id) =>
    document.getElementById(id === "retry" ? "agenda-retry" : id);
const panelTab = new URL(location.href).searchParams.get("tab");
const panelKey = agendaPanelKey(panelTab);
let detail;
let context = {};
let state = {};
let currentTab;
let choosing = false;
let restoredContext = false;
let loading = false;
let reloadPending = false;
let saving = false;
let generation = 0;
let settings;
let controls;
let stopStream;
let streamId;
let streamConnected = false;
let reconciledAt = 0;
let revealRecording = false;
let lastEditable = false;
const bindings = new Map();
const fieldNodes = new Map();
const openNotes = new Set();
let panelPort;
let closed = false;
let portRetry;
function connectPanel() {
    if (closed || !chrome.runtime.connect) return;
    panelPort = chrome.runtime.connect({ name: "agenda-panel" });
    panelPort.onDisconnect.addListener(() => {
        if (!closed) portRetry = setTimeout(connectPanel, 1000);
    });
}
connectPanel();

function clearLive() {
    stopStream?.();
    stopStream = undefined;
    streamId = undefined;
    streamConnected = false;
    for (const binding of bindings.values()) binding.destroy();
    bindings.clear();
    fieldNodes.clear();
}

async function flushText() {
    return (
        await Promise.all(
            Array.from(bindings.values(), (binding) => binding.flush()),
        )
    ).every(Boolean);
}

async function editedAgenda(id = detail?.id) {
    if (state.state !== "recording" || state.stopped || !id) return;
    const response = await chrome.runtime.sendMessage({
        type: "edit-agenda",
        agendaId: id,
        sessionId: state.sessionId,
        tabId: context.tabId,
    });
    if (!response?.ok) throw new Error(t("agendaFailed"));
}

function bindField(input, field, value) {
    input.dataset.field = field;
    input.autocomplete = "off";
    input.setAttribute("data-1p-ignore", "true");
    input.setAttribute("data-lpignore", "true");
    const previous = fieldNodes.get(field);
    const protocol =
        settings?.serverDefaults?.agendaText === 1 && detail.textProtocol === 1;
    if (
        previous &&
        !input.disabled &&
        (bindings.has(field) || document.activeElement === previous)
    ) {
        previous.hidden = input.hidden;
        previous.disabled = input.disabled;
        return previous;
    }
    if (previous) {
        bindings.get(field)?.destroy();
        bindings.delete(field);
    }
    fieldNodes.set(field, input);
    input.value = value ?? "";
    if (protocol && !input.disabled) {
        const id = detail.id;
        let editedSession;
        input.addEventListener("input", () => {
            editedSession =
                state.state === "recording" ? state.sessionId : null;
        });
        const binding = bindAgendaTextInput(
            input,
            field,
            {
                get: (key) =>
                    agendaRequest(
                        `/${encodeURIComponent(id)}/text?field=${encodeURIComponent(key)}`,
                    ),
                send: (body) =>
                    agendaRequest(`/${encodeURIComponent(id)}/text`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(body),
                    }),
            },
            {
                onValue: (value) => {
                    input.value = value;
                    updateNote(input);
                },
                onSaved: () => {
                    if (editedSession && editedSession === state.sessionId)
                        void editedAgenda(id).catch(showError);
                },
                onError: () => showError(),
            },
        );
        bindings.set(field, binding);
    }
    return input;
}

function text(tag, value, className) {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    return node;
}

function button(key, action, disabled = false) {
    const node = text("button", t(key));
    node.type = "button";
    node.disabled = disabled;
    node.addEventListener("click", action);
    return node;
}

function showError(error, load = false) {
    el("status").textContent =
        error?.status === 409
            ? t("agendaConflict")
            : t(load ? "agendaLoadError" : "agendaFailed");
    el("agenda-error").hidden = false;
    renderRecording();
}

function recording() {
    return state.state === "recording" && !state.stopped;
}
function afterStop() {
    return Boolean(
        state.stopped || ["finalizing", "completed"].includes(state.state),
    );
}
function onMeeting() {
    return (
        Boolean(detectMeetingPlatform(currentTab?.url)) &&
        (!context.roomCode || meetCode(currentTab?.url) === context.roomCode)
    );
}
function editable() {
    return Boolean(
        detail?.permissions.edit &&
            !afterStop() &&
            (recording() || onMeeting()),
    );
}

async function mutate(path, method, body, optimistic) {
    if (saving) return;
    if (!(await flushText())) {
        showError();
        return;
    }
    const pointId = /^\/points\/([^/]+)$/.exec(path)?.[1];
    if (pointId) {
        const versions = ["text", "note"]
            .map((key) =>
                bindings
                    .get(`point:${decodeURIComponent(pointId)}:${key}`)
                    ?.materializedVersion(),
            )
            .filter((value) => value !== undefined);
        if (versions.length) body.version = Math.max(body.version, ...versions);
    }
    saving = true;
    const agendaId = detail.id;
    const version = generation;
    const previous = structuredClone(detail);
    optimistic();
    render();
    try {
        await agendaRequest(`/${encodeURIComponent(agendaId)}${path}`, {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        await editedAgenda(agendaId);
        el("status").textContent = "";
        el("agenda-error").hidden = true;
    } catch (error) {
        if (version !== generation) return;
        detail = previous;
        showError(error);
    } finally {
        saving = false;
        if (version === generation) await loadDetail(agendaId);
        else void restore();
    }
}

function statusIcon(status) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", `status-icon ${status}`);
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("role", "img");
    svg.setAttribute(
        "aria-label",
        t(
            status === "discussed"
                ? "agendaDiscussed"
                : status === "done"
                  ? "agendaDone"
                  : status === "dropped"
                    ? "agendaDropped"
                    : "agendaOpen",
        ),
    );
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute(
        "d",
        status === "discussed"
            ? "M20 6 9 17l-5-5"
            : "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
    );
    svg.append(path);
    if (["done", "dropped"].includes(status)) {
        const mark = document.createElementNS(svg.namespaceURI, "path");
        mark.setAttribute(
            "d",
            status === "done" ? "m8 12 3 3 5-6" : "m8 8 8 8M16 8l-8 8",
        );
        svg.append(mark);
    }
    return svg;
}

function growNote(note) {
    if (note.hidden) return;
    note.style.height = "auto";
    note.style.height = `${note.scrollHeight + note.offsetHeight - note.clientHeight}px`;
}

function updateNote(note) {
    const preview = note.nextElementSibling;
    if (!preview) return;
    const focused = document.activeElement === note;
    note.hidden = !focused && !openNotes.has(note.dataset.field);
    preview.hidden = !note.hidden;
    renderLinkedText(preview, note.value);
    growNote(note);
}

function appendNote(row, meta, field, value, label, canEdit, legacySave) {
    if (!canEdit) {
        if (value)
            row.append(
                renderLinkedText(text("p", "", "hint note-readonly"), value),
            );
        return;
    }
    const previous = fieldNodes.get(field);
    if (
        !value &&
        !openNotes.has(field) &&
        !(previous && (previous.value || document.activeElement === previous))
    ) {
        const link = button("agendaNoteLink", () => {
            openNotes.add(field);
            render();
            fieldNodes.get(field)?.focus();
        });
        link.className = "link";
        meta.append(link);
        return;
    }
    const input = document.createElement("textarea");
    input.rows = 1;
    input.wrap = "soft";
    input.className = "agenda-note";
    input.maxLength = 2000;
    input.placeholder = t("agendaNote");
    input.setAttribute("aria-label", t("agendaNoteFor", label));
    input.addEventListener("input", () => {
        const start = input.selectionStart;
        const end = input.selectionEnd;
        const direction = input.selectionDirection;
        const normalized = input.value.replace(/[\r\n]/gu, " ");
        if (input.value !== normalized) {
            input.value = normalized;
            input.setSelectionRange(start, end, direction);
        }
        growNote(input);
    });
    const note = bindField(input, field, value);
    if (note === input) {
        note.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && !event.isComposing) {
                event.preventDefault();
                note.blur();
            }
        });
        note.addEventListener("focus", () => {
            openNotes.add(field);
            updateNote(note);
        });
        note.addEventListener("blur", () =>
            queueMicrotask(() => {
                if (!note.isConnected || document.activeElement === note)
                    return;
                openNotes.delete(field);
                if (!note.value) render();
                else updateNote(note);
            }),
        );
        if (!bindings.has(field) && legacySave)
            note.addEventListener("change", () => {
                if (note.value !== (value ?? ""))
                    legacySave(note.value.replace(/[\r\n]/gu, " "));
            });
    }
    const preview = text("p", "", "hint note-readonly note-editable");
    preview.tabIndex = 0;
    preview.setAttribute("role", "group");
    preview.setAttribute("aria-label", t("agendaNoteFor", label));
    function edit() {
        openNotes.add(field);
        note.hidden = false;
        preview.hidden = true;
        note.focus();
        growNote(note);
    }
    preview.addEventListener("click", (event) => {
        if (!event.target.closest("a")) edit();
    });
    preview.addEventListener("keydown", (event) => {
        if (event.target === preview && ["Enter", " "].includes(event.key)) {
            event.preventDefault();
            edit();
        }
    });
    row.append(note, preview);
    updateNote(note);
}

function renderPoint(point, depth = 0) {
    const row = document.createElement("div");
    row.className = `point${point.discussedAt ? " discussed" : ""}`;
    row.style.marginInlineStart = `${depth * 26}px`;
    const label = text(editable() ? "label" : "div", "", "check-row");
    if (editable()) {
        const check = document.createElement("input");
        check.type = "checkbox";
        check.checked = Boolean(point.discussedAt);
        check.disabled = saving;
        check.setAttribute("aria-label", t("agendaDiscussed"));
        check.addEventListener(
            "change",
            () =>
                void mutate(
                    `/points/${encodeURIComponent(point.id)}`,
                    "PATCH",
                    { version: point.version, discussed: check.checked },
                    () => {
                        point.discussedAt = check.checked
                            ? new Date().toISOString()
                            : null;
                    },
                ),
        );
        label.append(check);
    } else if (afterStop())
        label.append(statusIcon(point.discussedAt ? "discussed" : "open"));
    else label.append(text("span", "", "point-bullet"));
    label.append(renderLinkedText(text("span", ""), point.text));
    row.append(label);
    const meta = text("div", "", "point-meta");
    row.append(meta);
    if (point.discussedAt && (editable() || afterStop()))
        meta.append(
            text(
                "span",
                t(
                    "agendaDiscussedAt",
                    new Date(point.discussedAt).toLocaleTimeString(
                        document.documentElement.lang || undefined,
                        { hour: "2-digit", minute: "2-digit" },
                    ),
                ),
            ),
        );
    appendNote(
        row,
        meta,
        `point:${point.id}:note`,
        point.note,
        point.text,
        editable() && !saving,
        (value) =>
            void mutate(
                `/points/${encodeURIComponent(point.id)}`,
                "PATCH",
                { version: point.version, note: value || null },
                () => {
                    point.note = value;
                },
            ),
    );
    el("points").append(row);
    for (const child of detail.points.filter(
        (entry) => entry.parentId === point.id,
    ))
        renderPoint(child, depth + 1);
}

function render() {
    if (choosing || !detail) return;
    const canEdit = editable();
    lastEditable = canEdit;
    el("agenda").hidden = false;
    el("choices").hidden = true;
    el("title").textContent = detail.title;
    el("time").textContent = detail.plannedStart
        ? formatMeetingTime(detail.plannedStart, detail.plannedEnd)
        : "";
    el("away-hint").hidden = recording() || onMeeting() || afterStop();
    const scroll = {
        top: document.scrollingElement?.scrollTop ?? 0,
        left: document.scrollingElement?.scrollLeft ?? 0,
    };
    const active = document.activeElement;
    const selection = active?.matches("input[type=text],textarea")
        ? [
              active.selectionStart,
              active.selectionEnd,
              active.selectionDirection,
          ]
        : null;
    el("points").replaceChildren();
    const top = detail.points.filter((point) => !point.parentId);
    const done = top.filter((point) => point.discussedAt).length;
    el("point-count").textContent = t("agendaProgress", [
        String(done),
        String(top.length),
    ]);
    const percent = top.length ? Math.round((done / top.length) * 100) : 0;
    el("point-progress").hidden = !canEdit;
    el("point-progress").setAttribute("aria-valuenow", String(percent));
    el("point-progress").setAttribute("aria-label", t("agendaPoints"));
    el("point-progress").firstElementChild.style.width = `${percent}%`;
    for (const point of top) renderPoint(point);
    el("tasks").hidden = afterStop();
    el("tasks").replaceChildren();
    const tasks = (detail.taskGroups ?? []).flatMap((group) => group.tasks);
    el("task-count").textContent = t("agendaTaskProgress", [
        String(tasks.filter((task) => task.status === "done").length),
        String(tasks.length),
    ]);
    for (const group of detail.taskGroups ?? []) {
        el("tasks").append(
            text(
                "p",
                (group.name || t("agendaUnassigned")) +
                    (group.name && !group.invited
                        ? ` · ${t("agendaNotInvited")}`
                        : ""),
                "group",
            ),
        );
        if (!group.tasks.length)
            el("tasks").append(text("p", t("agendaNoTasks"), "hint"));
        for (const task of group.tasks) {
            const row = text("div", "", `task ${task.status}`);
            const label = text(
                canEdit && task.status !== "dropped" ? "label" : "div",
                "",
                "check-row",
            );
            if (canEdit && task.status !== "dropped") {
                const check = document.createElement("input");
                check.type = "checkbox";
                check.checked = task.status === "done";
                check.disabled = saving || !task.canClose;
                check.setAttribute("aria-label", t("agendaDone"));
                check.addEventListener("change", () => {
                    const status = check.checked ? "done" : "open";
                    void mutate(
                        `/tasks/${encodeURIComponent(task.id)}`,
                        "PATCH",
                        { version: task.version, status },
                        () => {
                            task.status = status;
                        },
                    );
                });
                label.append(check);
            } else label.append(statusIcon(task.status));
            label.append(renderLinkedText(text("span", ""), task.text));
            row.append(label);
            const meta = text("div", "", "task-meta");
            meta.append(
                text(
                    "span",
                    t(
                        task.status === "done"
                            ? "agendaDone"
                            : task.status === "dropped"
                              ? "agendaDropped"
                              : "agendaOpen",
                    ),
                ),
            );
            row.append(meta);
            appendNote(
                row,
                meta,
                `task:${task.id}:note`,
                task.agendaNote,
                task.text,
                canEdit &&
                    !saving &&
                    settings?.serverDefaults?.agendaText === 1 &&
                    detail.textProtocol === 1,
            );
            el("tasks").append(row);
        }
    }
    for (const [field, node] of fieldNodes)
        if (!el("agenda").contains(node)) {
            bindings.get(field)?.destroy();
            bindings.delete(field);
            fieldNodes.delete(field);
        }
    if (active && el("agenda").contains(active)) {
        active.focus({ preventScroll: true });
        if (selection) active.setSelectionRange(...selection);
    }
    for (const note of fieldNodes.values()) growNote(note);
    if (document.scrollingElement) {
        document.scrollingElement.scrollTop = scroll.top;
        document.scrollingElement.scrollLeft = scroll.left;
    }
    controls?.folder(agendaFolder(detail));
    void controls?.refreshMeeting();
    renderRecording();
}

function renderRecording() {
    el("recording-state").textContent =
        state.state === "completed" && state.agendaUnavailable
            ? t("agendaUnavailable")
            : "";
    const colleagues = (detail?.recordingBy ?? []).filter(
        (person) => !person.self,
    );
    el("colleague-recording").hidden =
        !colleagues.length || recording() || afterStop() || choosing;
    el("recording-by").textContent = t(
        "meetingRecordingBy",
        colleagues.map((person) => person.name || t("unknown")).join(", "),
    );
    el("record-also").hidden = revealRecording;
    el("recorder-controls").hidden =
        !choosing &&
        el("agenda-error").hidden &&
        !recording() &&
        !afterStop() &&
        colleagues.length > 0 &&
        !revealRecording;
    el("change-agenda").hidden =
        choosing || (afterStop() && !canChooseRecordingAgenda(state));
    el("back").hidden = !choosing;
}

async function loadDetail(id, poll = false) {
    const version = ++generation;
    try {
        const since =
            poll && detail?.id === id
                ? (detail.cursor ?? detail.version)
                : undefined;
        const next = await agendaRequest(
            `/${encodeURIComponent(id)}${since !== undefined ? `?since=${encodeURIComponent(since)}` : ""}`,
        );
        reconciledAt = Date.now();
        if (version !== generation) return;
        if (detail?.id && detail.id !== id) {
            clearLive();
            openNotes.clear();
        }
        if (!next.unchanged) detail = next;
        if (el("status").textContent === t("agendaLoadError"))
            el("agenda-error").hidden = true;
        render();
        await Promise.all(
            Array.from(bindings.values(), (binding) =>
                binding.resync().catch(showError),
            ),
        );
        if (settings?.serverDefaults?.agendaLive === true && streamId !== id) {
            stopStream?.();
            streamId = id;
            stopStream = subscribeAgenda(id, {
                invalidate: () => restore(true),
                onConnection: (connected) => {
                    streamConnected = connected;
                },
            });
        }
    } catch (error) {
        if (version !== generation) return;
        if ([401, 403, 404].includes(error?.status)) {
            clearLive();
            detail = null;
        }
        el("agenda").hidden = true;
        showError(error, true);
    }
}

async function select(agendaId) {
    if (!(await flushText())) {
        showError();
        return;
    }
    const response = await chrome.runtime.sendMessage({
        type: "select-agenda",
        agendaId,
        sessionId: canChooseRecordingAgenda(state)
            ? state.sessionId
            : undefined,
        tabId: context.tabId,
    });
    if (!response?.ok) {
        showError();
        return;
    }
    choosing = false;
    await chrome.storage.session.set({
        [panelKey]: {
            ...context,
            agendaIds: agendaId ? [agendaId] : [],
            choose: false,
            explicitNone: !agendaId,
            error: false,
        },
    });
}

async function choices() {
    const version = ++generation;
    choosing = true;
    el("agenda").hidden = true;
    el("choices").hidden = false;
    el("title").textContent = t("agendaChange");
    el("time").textContent = "";
    el("choice-list").replaceChildren();
    renderRecording();
    const now = Date.now();
    let incomplete = false;
    const rows = await agendaChoices(
        now,
        context.choose || context.agendaIds?.length > 1
            ? (context.agendaIds ?? [])
            : [],
        {
            onError: () => {
                incomplete = true;
                if (version === generation) showError(undefined, true);
            },
        },
    );
    if (version !== generation) return;
    if (detail && !rows.some((row) => row.id === detail.id))
        rows.unshift({
            id: detail.id,
            title: detail.title,
            start: detail.plannedStart,
            end: detail.plannedEnd,
        });
    for (const agenda of rows) {
        const choice = button(
            "agendaShow",
            () => void select(agenda.id).catch(showError),
        );
        choice.className = "agenda-option";
        const label = text("span", "");
        label.append(text("strong", agenda.title));
        if (agenda.start)
            label.append(
                text(
                    "span",
                    formatMeetingTime(agenda.start, agenda.end, now),
                    "hint",
                ),
            );
        choice.replaceChildren(label);
        if (
            agenda.id === detail?.id ||
            (context.agendaIds?.length === 1 &&
                agenda.id === context.agendaIds[0])
        ) {
            choice.classList.add("selected");
            choice.append(text("span", t("agendaSelected"), "selected-label"));
        }
        el("choice-list").append(choice);
    }
    if (!rows.length && !incomplete)
        el("choice-list").append(text("p", t("agendaEmpty"), "hint"));
    el("none").classList.toggle("selected", context.explicitNone === true);
}

async function restore(poll = false) {
    if (loading || saving) {
        reloadPending = true;
        return;
    }
    loading = true;
    try {
        settings = await getSettings();
        if (!supportsAgendas(settings)) {
            generation += 1;
            clearLive();
            detail = null;
            el("agenda").hidden = el("choices").hidden = true;
            el("status").textContent = t("agendaUnsupported");
            el("agenda-error").hidden = false;
            return;
        }
        const stored = await chrome.storage.session.get([
            panelKey,
            "recordingState",
        ]);
        context = stored[panelKey] ?? {};
        state = stored.recordingState ?? {};
        if (context.error) {
            showError(undefined, true);
            return;
        }
        if (!restoredContext) {
            choosing =
                context.choose === true ||
                (context.agendaIds?.length !== 1 && !context.explicitNone);
            restoredContext = true;
        }
        if (choosing) await choices();
        else if (context.agendaIds?.length === 1)
            await loadDetail(context.agendaIds[0], poll);
        else {
            clearLive();
            detail = null;
            controls?.folder(settings);
            el("agenda").hidden = el("choices").hidden = true;
            el("title").textContent = t(
                context.explicitNone ? "agendaNone" : "agendaMeetingTitle",
            );
            el("time").textContent = "";
            renderRecording();
        }
    } catch (error) {
        showError(error, true);
    } finally {
        loading = false;
        if (reloadPending && !saving) {
            reloadPending = false;
            void restore(true);
        }
    }
}

el("change-agenda").addEventListener("click", async () => {
    if (!(await flushText())) {
        showError();
        return;
    }
    void choices().catch((error) => showError(error, true));
});
el("back").addEventListener("click", () => {
    generation += 1;
    choosing = false;
    context.choose = false;
    el("choices").hidden = true;
    el("agenda-error").hidden = true;
    if (detail) render();
    else {
        el("title").textContent = t("agendaMeetingTitle");
        renderRecording();
    }
});
el("none").addEventListener("click", () => void select(null).catch(showError));
el("retry").addEventListener("click", async () => {
    try {
        el("agenda-error").hidden = true;
        if (context.error) {
            const result = await chrome.runtime.sendMessage({
                type: "match-agendas",
                tabId: context.tabId,
            });
            if (!result?.ok) {
                showError(undefined, true);
                return;
            }
            const selected =
                result.selectedAgenda ??
                (result.agendas?.length === 1 ? result.agendas[0] : null);
            await chrome.storage.session.set({
                [panelKey]: {
                    ...context,
                    error: false,
                    agendaIds: selected ? [selected.id] : [],
                    choose: !selected,
                },
            });
        } else await restore();
    } catch (error) {
        showError(error, true);
    }
});
chrome.storage.onChanged.addListener((changes, area) => {
    if (
        area === "local" &&
        changes.serverDefaults &&
        (changes.serverDefaults.oldValue?.agendaText !==
            changes.serverDefaults.newValue?.agendaText ||
            changes.serverDefaults.oldValue?.agendaLive !==
                changes.serverDefaults.newValue?.agendaLive)
    )
        clearLive();
    if (area === "session" && changes.recordingState) {
        state = changes.recordingState.newValue ?? {};
        if (editable() !== lastEditable) render();
        renderRecording();
    }
    if (
        area === "local" &&
        (changes.serverUrl ||
            changes.encryptedApiKey ||
            changes.dataUseAcknowledgedAt ||
            (changes.serverDefaults &&
                changes.serverDefaults.newValue?.agendas !== true))
    ) {
        generation += 1;
        clearLive();
        detail = null;
        el("agenda").hidden = el("choices").hidden = true;
    }
    if (
        (area === "session" && changes[panelKey]) ||
        (area === "local" &&
            (changes.serverDefaults ||
                changes.serverUrl ||
                changes.encryptedApiKey ||
                changes.dataUseAcknowledgedAt))
    ) {
        if (area === "session")
            choosing = changes[panelKey].newValue?.choose === true;
        void restore().then(() => controls?.refreshTab());
    }
});
setInterval(() => {
    if (
        saving ||
        loading ||
        choosing ||
        (detail?.recordingItemId &&
            settings?.serverDefaults?.agendaLive !== true) ||
        (streamConnected && Date.now() - reconciledAt < 60000) ||
        (settings?.serverDefaults?.agendaText !== 1 &&
            document.activeElement?.matches('input[type="text"],textarea'))
    )
        return;
    void restore(true);
}, 15000);
el("record-also").addEventListener("click", () => {
    revealRecording = true;
    renderRecording();
});
controls = await mountRecordingControls(el("recorder-controls"), {
    variant: "panel",
    tabId: () =>
        context.tabId ?? (panelTab === null ? undefined : Number(panelTab)),
    selectedAgenda: () => detail?.id,
    agendaChoice: () =>
        context.explicitNone
            ? { agendaId: null }
            : detail?.permissions.edit
              ? { agendaId: detail.id }
              : {},
    onTab: (tab) => {
        currentTab = tab;
        render();
    },
    onState: (next) => {
        state = next;
        if (editable() !== lastEditable) render();
        renderRecording();
    },
    beforeAction: async () => {
        if (!(await flushText())) showError();
    },
});
await restore();
if (detail) controls.folder(agendaFolder(detail));
renderRecording();
function resizeNotes() {
    for (const note of fieldNodes.values()) growNote(note);
}
window.addEventListener("resize", resizeNotes);
window.addEventListener("pagehide", () => {
    closed = true;
    clearTimeout(portRetry);
    window.removeEventListener("resize", resizeNotes);
    clearLive();
    controls?.destroy();
    panelPort?.disconnect();
});
