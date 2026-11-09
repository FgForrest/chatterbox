import {
    agendaChoices,
    agendaPanelKey,
    agendaRequest,
    canChooseRecordingAgenda,
    supportsAgendas,
} from "../lib/agendas.js";
import { bindAgendaTextInput } from "../generated/text.js";
import { subscribeAgenda } from "../lib/agenda-live.js";
import { mountRecordingControls } from "../lib/recording-controls.js";
import { agendaFolder } from "../lib/agendas.js";
import { localizeDocument, t } from "../lib/i18n.js";
import { getSettings } from "../lib/settings.js";
import { formatMeetingTime } from "../lib/meeting-time.js";

localizeDocument();
document.getElementById("open-app").textContent = t(
    "agendaOpenApp",
    t("appName"),
);
const el = (id) => document.getElementById(id === "retry" ? "agenda-retry" : id);
const panelTab = new URL(location.href).searchParams.get("tab");
const panelKey = agendaPanelKey(panelTab);
let detail;
let context = {};
let state = {};
let live = false;
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
let manualMode = false;
let revealRecording = false;
let wasRecording = false;
const bindings = new Map();
const fieldNodes = new Map();
let panelPort;
let closed = false;
let portRetry;
function connectPanel() {
    if (closed || !chrome.runtime.connect) return;
    panelPort = chrome.runtime.connect({ name: "agenda-panel" });
    panelPort.onDisconnect.addListener(() => { if (!closed) portRetry = setTimeout(connectPanel, 1000); });
}
connectPanel();

function clearLive() {
    stopStream?.(); stopStream = undefined; streamId = undefined;
    for (const binding of bindings.values()) binding.destroy();
    bindings.clear(); fieldNodes.clear();
}

async function flushText() {
    return (await Promise.all(Array.from(bindings.values(), (binding) => binding.flush()))).every(Boolean);
}

async function editedAgenda(id = detail?.id) {
    if (state.state !== "recording" || state.stopped || !id) return;
    const response = await chrome.runtime.sendMessage({ type: "edit-agenda", agendaId: id, sessionId: state.sessionId, tabId: context.tabId });
    if (!response?.ok) throw new Error(t("agendaFailed"));
}

function bindField(input, field, value) {
    input.dataset.field = field;
    input.autocomplete = "off";
    input.setAttribute("data-1p-ignore", "true");
    input.setAttribute("data-lpignore", "true");
    const previous = fieldNodes.get(field);
    const protocol = settings?.serverDefaults?.agendaText === 1 && detail.textProtocol === 1;
    if (previous && !input.disabled && (bindings.has(field) || document.activeElement === previous)) {
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
            editedSession = state.state === "recording" ? state.sessionId : null;
        });
        const binding = bindAgendaTextInput(input, field, {
            get: (key) => agendaRequest(`/${encodeURIComponent(id)}/text?field=${encodeURIComponent(key)}`),
            send: (body) => agendaRequest(`/${encodeURIComponent(id)}/text`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            }),
        }, {
            onValue: (value) => { input.value = value; },
            onSaved: () => {
                if (editedSession && editedSession === state.sessionId)
                    void editedAgenda(id).catch(showError);
            },
            onError: () => showError(),
        });
        bindings.set(field, binding);
    }
    return input;
}

function attribution(id, at) {
    const name = detail.authors?.find((author) => author.id === id)?.name;
    return text("small", name && at ? t("agendaChangedBy", [name, new Date(at).toLocaleTimeString(document.documentElement.lang || undefined, { hour: "2-digit", minute: "2-digit" })]) : "", "attribution hint");
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

function showError(error) {
    el("status").textContent =
        error?.status === 409 ? t("agendaConflict") : t("agendaFailed");
    el("retry").hidden = false;
}

async function mutate(path, method, body, optimistic) {
    if (saving) return;
    if (!(await flushText())) { showError(); return; }
    const pointId = /^\/points\/([^/]+)$/.exec(path)?.[1];
    if (pointId) {
        const versions = ["text", "note"].map((key) => bindings.get(`point:${decodeURIComponent(pointId)}:${key}`)?.materializedVersion()).filter((value) => value !== undefined);
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
        el("retry").hidden = true;
    } catch (error) {
        if (version !== generation) return;
        detail = previous;
        if (method === "POST" && path === "/points")
            el("point-text").value = body.text;
        showError(error);
    } finally {
        saving = false;
        if (version === generation) await loadDetail(agendaId);
        else void restore();
    }
}

function renderPoint(point, depth = 0) {
    const row = document.createElement("div");
    row.className = `point${point.discussedAt ? " discussed" : ""}`;
    row.style.marginInlineStart = `${depth * 16}px`;
    const label = document.createElement("label");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = Boolean(point.discussedAt);
    check.disabled = saving || !detail.permissions.edit;
    check.hidden = !live || !detail.permissions.edit;
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
    let pointLabel = text("span", point.text);
    if (settings?.serverDefaults?.agendaText === 1 && detail.textProtocol === 1 && detail.permissions.edit && point.canEditText) {
        const input = document.createElement("input"); input.type = "text"; input.className = "point-title"; input.maxLength = 2000;
        input.setAttribute("aria-label", t("agendaPointText"));
        pointLabel = bindField(input, `point:${point.id}:text`, point.text);
    }
    label.append(check, pointLabel);
    row.append(label);
    if (point.discussedAt)
        row.append(
            text(
                "small",
                new Date(point.discussedAt).toLocaleTimeString(document.documentElement.lang || undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                }),
                "hint",
            ),
        );
    const note = document.createElement("input");
    note.type = "text";
    note.value = point.note ?? "";
    note.maxLength = 2000;
    note.placeholder = t("agendaNote");
    note.setAttribute("aria-label", t("agendaNoteFor", point.text));
    note.hidden = !live || !detail.permissions.edit;
    note.disabled = saving || !detail.permissions.edit;
    if (settings?.serverDefaults?.agendaText !== 1 || detail.textProtocol !== 1) note.addEventListener("change", () => {
        if (note.value === (point.note ?? "")) return;
        void mutate(
            `/points/${encodeURIComponent(point.id)}`,
            "PATCH",
            { version: point.version, note: note.value || null },
            () => {
                point.note = note.value;
            },
        );
    });
    row.append(bindField(note, `point:${point.id}:note`, point.note), attribution(point.updatedByUserId ?? point.authorUserId, point.updatedAt ?? point.createdAt));
    el("points").append(row);
    for (const child of detail.points.filter(
        (entry) => entry.parentId === point.id,
    ))
        renderPoint(child, depth + 1);
}

function render() {
    if (!detail) return;
    el("agenda").hidden = false;
    el("agenda").classList.toggle("live-agenda", live);
    el("choices").hidden = true;
    el("title").textContent = detail.title;
    el("time").textContent = detail.plannedStart
        ? formatMeetingTime(detail.plannedStart, detail.plannedEnd)
        : "";
    el("open-app").hidden = false;
    el("prep").setAttribute("aria-pressed", String(!live));
    el("live").setAttribute("aria-pressed", String(live));
    const scroll = { top: document.scrollingElement?.scrollTop ?? 0, left: document.scrollingElement?.scrollLeft ?? 0 };
    const active = document.activeElement;
    const selection = active?.matches("input[type=text],textarea") ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
    el("points").replaceChildren();
    const topLevelPoints = detail.points.filter((point) => !point.parentId);
    el("point-count").textContent = t("agendaProgress", [
        String(topLevelPoints.filter((point) => point.discussedAt).length),
        String(topLevelPoints.length),
    ]);
    for (const point of topLevelPoints)
        renderPoint(point);
    el("quick-add").hidden = !detail.permissions.edit;
    el("point-text").disabled = saving;
    el("quick-add").querySelector("button").disabled = saving;
    el("tasks").replaceChildren();
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
            const row = document.createElement("div");
            row.className = "task";
            row.append(
                text("p", task.text),
                text(
                    "p",
                    t(
                        task.status === "done"
                            ? "agendaDone"
                            : task.status === "dropped"
                              ? "agendaDropped"
                              : "agendaOpen",
                    ),
                    "hint",
                ),
            );
            if (!live && task.note) row.append(text("p", task.note, "hint"));
            if (settings?.serverDefaults?.agendaText === 1 && detail.textProtocol === 1 && detail.permissions.edit) {
                const note = document.createElement("input"); note.type = "text"; note.hidden = !live; note.maxLength = 2000; note.placeholder = t("agendaNote"); note.setAttribute("aria-label", t("agendaNoteFor", task.text));
                row.append(bindField(note, `task:${task.id}:note`, task.agendaNote));
            } else if (task.agendaNote) row.append(text("p", task.agendaNote, "hint"));
            row.append(attribution(task.agendaUpdatedByUserId ?? task.statusChangedByUserId, task.agendaUpdatedAt ?? task.updatedAt));
            if (
                live &&
                detail.permissions.edit &&
                !["done", "dropped"].includes(task.status)
            ) {
                const actions = document.createElement("div");
                actions.className = "row";
                for (const [status, key, allowed] of [
                    ["done", "agendaDone", task.canClose],
                    ["dropped", "agendaDrop", task.canEdit],
                ]) {
                    actions.append(
                        button(
                            key,
                            () =>
                                void mutate(
                                    `/tasks/${encodeURIComponent(task.id)}`,
                                    "PATCH",
                                    { version: task.version, status },
                                    () => {
                                        task.status = status;
                                    },
                                ),
                            saving || !allowed,
                        ),
                    );
                }
                row.append(actions);
            }
            el("tasks").append(row);
        }
    }
    for (const [field, node] of fieldNodes) if (!el("agenda").contains(node)) { bindings.get(field)?.destroy(); bindings.delete(field); fieldNodes.delete(field); }
    if (active && el("agenda").contains(active)) { active.focus({ preventScroll: true }); if (selection) active.setSelectionRange(...selection); }
    if (document.scrollingElement) { document.scrollingElement.scrollTop = scroll.top; document.scrollingElement.scrollLeft = scroll.left; }
    controls?.folder(agendaFolder(detail));
    renderRecording();
}

function renderRecording() {
    const recording = state.state === "recording" && !state.stopped;
    const recordingState = el("recording-state");
    if (recording)
        recordingState.textContent = t("agendaRecordingElapsed", elapsed(state.startedAt));
    else if (state.state === "completed")
        recordingState.textContent = t(state.agendaUnavailable ? "agendaUnavailable" : "recordingStored");
    else if (state.state === "error")
        recordingState.textContent = t("finalizeFailed");
    else if (state.state === "finalizing" || state.stopped)
        recordingState.textContent = t("uploadingRecording");
    else recordingState.textContent = "";
    const carries = state.agendaId === detail?.id;
    const other = state.agendaId && !carries;
    el("attachment").hidden = !canChooseRecordingAgenda(state) || (!carries && !other);
    el("attachment").classList.toggle("linked", carries);
    el("attachment-text").textContent = carries ? t("agendaRecording") : other ? t("agendaRecordingOther", state.agendaTitle ?? "") : "";
    el("unlink").hidden = !carries;
    el("switch-here").hidden = !other || !detail?.permissions.edit;
    const colleagues = (detail?.recordingBy ?? []).filter((person) => !person.self);
    el("colleague-recording").hidden = !colleagues.length || recording;
    el("recording-by").textContent = t("meetingRecordingBy", colleagues.map((person) => person.name || t("unknown")).join(", "));
    el("record-also").hidden = revealRecording;
    el("recorder-controls").hidden = !recording && colleagues.length > 0 && !revealRecording;

}

function elapsed(start) {
    const seconds =
        Math.max(0, Math.floor((Date.now() - Date.parse(start)) / 1000)) || 0;
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

async function loadDetail(id, poll = false) {
    const version = ++generation;
    try {
        const since = poll && detail?.id === id ? detail.cursor ?? detail.version : undefined;
        const next = await agendaRequest(`/${encodeURIComponent(id)}${since !== undefined ? `?since=${encodeURIComponent(since)}` : ""}`);
        reconciledAt = Date.now();
        if (version !== generation) return;
        if (detail?.id && detail.id !== id) clearLive();
        if (!next.unchanged) { detail = next; render(); }
        await Promise.all(Array.from(bindings.values(), (binding) => binding.resync().catch(showError)));
        if (settings?.serverDefaults?.agendaLive === true && streamId !== id) {
            stopStream?.(); streamId = id;
            stopStream = subscribeAgenda(id, { invalidate: () => restore(true), onConnection: (connected) => { streamConnected = connected; } });
        }
    } catch (error) {
        if (version !== generation) return;
        if ([401, 403, 404].includes(error?.status)) { clearLive(); detail = null; }
        el("agenda").hidden = true;
        el("open-app").hidden = true;
        el("attachment").hidden = true;
        showError(error);
    }
}

async function select(agendaId) {
    if (!(await flushText())) { showError(); return; }
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
    await chrome.storage.session.set({
        [panelKey]: {
            ...context,
            agendaIds: agendaId ? [agendaId] : [],
            choose: !agendaId,
        },
    });
}

async function choices() {
    const version = ++generation;
    clearLive(); detail = null;
    el("agenda").hidden = true;
    el("choices").hidden = false;
    el("open-app").hidden = true;
    el("choice-list").replaceChildren();
    const now = Date.now();
    const rows = await agendaChoices(now, context.agendaIds ?? []);
    if (version !== generation) return;
    for (const agenda of rows) {
        const choice = button(
            "agendaShow",
            () => void select(agenda.id).catch(showError),
        );
        choice.textContent = agenda.title;
        if (agenda.start)
            choice.append(" · ", text("span", formatMeetingTime(agenda.start, agenda.end, now), "hint"));
        el("choice-list").append(choice);
    }
    if (!rows.length)
        el("choice-list").append(text("p", t("agendaEmpty"), "hint"));
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
            clearLive(); detail = null;
            for (const id of ["agenda", "choices", "attachment", "open-app"])
                el(id).hidden = true;
            el("status").textContent = t("agendaUnsupported");
            return;
        }
        const stored = await chrome.storage.session.get([
            panelKey,
            "recordingState",
        ]);
        context = stored[panelKey] ?? {};
        state = stored.recordingState ?? {};
        const recording = state.state === "recording" && !state.stopped;
        if (recording && !wasRecording && !manualMode) live = true;
        wasRecording = recording;
        if (!context.choose && context.agendaIds?.length === 1)
            await loadDetail(context.agendaIds[0], poll);
        else await choices();
    } catch (error) {
        showError(error);
    } finally {
        loading = false;
        if (reloadPending && !saving) {
            reloadPending = false;
            void restore(true);
        }
    }
}

el("open-app").addEventListener("click", async () => {
    if (!detail) return;
    const settings = await getSettings();
    await chrome.tabs.create({
        url: new URL(
            `/meetings/${encodeURIComponent(detail.meetingItemId ?? detail.id)}`,
            settings.serverUrl,
        ).href,
    });
});
el("prep").addEventListener("click", () => {
    manualMode = true; live = false;
    render();
});
el("live").addEventListener("click", () => {
    manualMode = true; live = true;
    render();
});
el("other").addEventListener("click", async () => {
    if (!(await flushText())) { showError(); return; }
    context = { ...context, choose: true, agendaIds: [] };
    void choices().catch(showError);
});
el("none").addEventListener("click", () => void select(null).catch(showError));
el("retry").addEventListener("click", () => void restore());
el("quick-add").addEventListener("submit", (event) => {
    event.preventDefault();
    const value = el("point-text").value.trim();
    if (!value || saving) return;
    void mutate("/points", "POST", { text: value }, () => {
        detail.points.push({
            id: "pending",
            text: value,
            parentId: null,
            version: 0,
        });
        el("point-text").value = "";
    });
});
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.serverDefaults &&
        (changes.serverDefaults.oldValue?.agendaText !== changes.serverDefaults.newValue?.agendaText ||
         changes.serverDefaults.oldValue?.agendaLive !== changes.serverDefaults.newValue?.agendaLive)) clearLive();
    if (area === "session" && changes.recordingState) {
        state = changes.recordingState.newValue ?? {};
        const recording = state.state === "recording" && !state.stopped;
        if (recording && !wasRecording) { live = true; manualMode = false; render(); }
        wasRecording = recording;
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
        clearLive(); detail = null;
        for (const id of ["agenda", "choices", "attachment", "open-app"])
            el(id).hidden = true;
    }
    if (
        (area === "session" && changes[panelKey]) ||
        (area === "local" &&
            (changes.serverDefaults ||
                changes.serverUrl ||
                changes.encryptedApiKey ||
                changes.dataUseAcknowledgedAt))
    )
        void restore();
});
setInterval(() => {
    if (
        saving ||
        loading ||
        (detail?.recordingItemId && settings?.serverDefaults?.agendaLive !== true) ||
        (streamConnected && Date.now() - reconciledAt < 60000) ||
        (settings?.serverDefaults?.agendaText !== 1 && document.activeElement?.matches('input[type="text"]'))
    )
        return;
    void restore(true);
}, 15000);
setInterval(renderRecording, 1000);
el("unlink").addEventListener("click", () => void select(null).catch(showError));
el("switch-here").addEventListener("click", () => void select(detail.id).catch(showError));
el("record-also").addEventListener("click", () => { revealRecording = true; renderRecording(); });
el("close-panel").addEventListener("click", () => { if (panelTab !== null) void chrome.runtime.sendMessage({ type: "close-agenda", tabId: Number(panelTab) }); else window.close(); });
await restore();
controls = await mountRecordingControls(el("recorder-controls"), { variant: "panel", tabId: context.tabId, agendaChoice: () => detail?.permissions.edit ? { agendaId: detail.id } : {}, beforeAction: async () => { if (!(await flushText())) showError(); } });
if (detail) controls.folder(agendaFolder(detail));
el("open-app").textContent = t("agendaOpenApp", t("appName"));
renderRecording();
window.addEventListener("pagehide", () => { closed = true; clearTimeout(portRetry); clearLive(); controls?.destroy(); panelPort?.disconnect(); });
