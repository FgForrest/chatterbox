import {
    AGENDA_PANEL_KEY,
    agendaRequest,
    canChooseRecordingAgenda,
    matchAgendas,
    supportsAgendas,
} from "../lib/agendas.js";
import { localizeDocument, t } from "../lib/i18n.js";
import { getSettings } from "../lib/settings.js";

localizeDocument();
document.getElementById("open-app").textContent = t(
    "agendaOpenApp",
    t("appName"),
);
const el = (id) => document.getElementById(id);
let detail;
let context = {};
let state = {};
let live = false;
let loading = false;
let reloadPending = false;
let saving = false;
let generation = 0;

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
    check.hidden = !live;
    check.disabled = saving || !detail.permissions.edit;
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
    label.append(check, text("span", point.text));
    row.append(label);
    if (point.discussedAt)
        row.append(
            text(
                "small",
                new Date(point.discussedAt).toLocaleTimeString([], {
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
    note.hidden = !live;
    note.disabled = saving || !detail.permissions.edit;
    note.addEventListener("change", () => {
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
    row.append(note);
    el("points").append(row);
    for (const child of detail.points.filter(
        (entry) => entry.parentId === point.id,
    ))
        renderPoint(child, depth + 1);
}

function render() {
    if (!detail) return;
    el("agenda").hidden = false;
    el("choices").hidden = true;
    el("title").textContent = detail.title;
    el("time").textContent = detail.plannedStart
        ? new Date(detail.plannedStart).toLocaleString([], {
              dateStyle: "medium",
              timeStyle: "short",
          }) +
          (detail.plannedEnd
              ? `–${new Date(detail.plannedEnd).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
              : "")
        : "";
    el("open-app").hidden = false;
    el("prep").setAttribute("aria-pressed", String(!live));
    el("live").setAttribute("aria-pressed", String(live));
    el("points").replaceChildren();
    el("point-count").textContent = t("agendaProgress", [
        String(detail.points.filter((point) => point.discussedAt).length),
        String(detail.points.length),
    ]);
    for (const point of detail.points.filter((entry) => !entry.parentId))
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
            if (task.agendaNote) row.append(text("p", task.agendaNote, "hint"));
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
    renderRecording();
}

function renderRecording() {
    const recording = state.state === "recording" && !state.stopped;
    el("recording-state").textContent = recording
        ? t("agendaRecordingElapsed", elapsed(state.startedAt))
        : state.state === "completed"
          ? t(state.agendaUnavailable ? "agendaUnavailable" : "recordingStored")
          : state.state === "error"
            ? t("finalizeFailed")
            : state.state === "finalizing" || state.stopped
              ? t("uploadingRecording")
              : "";
    el("attachment").hidden = !canChooseRecordingAgenda(state);
    el("attachment-text").textContent = t(
        state.agendaId === detail?.id ? "agendaRecording" : "agendaNotSelected",
    );
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
        if (version !== generation) return;
        if (!next.unchanged) { detail = next; render(); }
    } catch (error) {
        if (version !== generation) return;
        detail = null;
        el("agenda").hidden = true;
        el("open-app").hidden = true;
        el("attachment").hidden = true;
        showError(error);
    }
}

async function select(agendaId) {
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
        [AGENDA_PANEL_KEY]: {
            ...context,
            agendaIds: agendaId ? [agendaId] : [],
            choose: !agendaId,
        },
    });
}

async function choices() {
    const version = ++generation;
    detail = null;
    el("agenda").hidden = true;
    el("choices").hidden = false;
    el("open-app").hidden = true;
    el("choice-list").replaceChildren();
    const rows = await matchAgendas();
    if (version !== generation) return;
    const ids = new Set(context.agendaIds ?? []);
    for (const agenda of rows.filter((row) => !ids.size || ids.has(row.id))) {
        const choice = button(
            "agendaShow",
            () => void select(agenda.id).catch(showError),
        );
        choice.textContent = agenda.title;
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
        const settings = await getSettings();
        if (!supportsAgendas(settings)) {
            generation += 1;
            detail = null;
            for (const id of ["agenda", "choices", "attachment", "open-app"])
                el(id).hidden = true;
            el("status").textContent = t("agendaUnsupported");
            return;
        }
        const stored = await chrome.storage.session.get([
            AGENDA_PANEL_KEY,
            "recordingState",
        ]);
        context = stored[AGENDA_PANEL_KEY] ?? {};
        state = stored.recordingState ?? {};
        live = live || (state.state === "recording" && !state.stopped);
        if (!context.choose && context.agendaIds?.length === 1)
            await loadDetail(context.agendaIds[0], poll);
        else await choices();
    } catch (error) {
        showError(error);
    } finally {
        loading = false;
        if (reloadPending && !saving) {
            reloadPending = false;
            void restore();
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
    live = false;
    render();
});
el("live").addEventListener("click", () => {
    live = true;
    render();
});
el("other").addEventListener("click", () => {
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
    if (area === "session" && changes.recordingState) {
        state = changes.recordingState.newValue ?? {};
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
        detail = null;
        for (const id of ["agenda", "choices", "attachment", "open-app"])
            el(id).hidden = true;
    }
    if (
        (area === "session" && changes[AGENDA_PANEL_KEY]) ||
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
        detail?.recordingItemId ||
        document.activeElement?.matches('input[type="text"]')
    )
        return;
    void restore(true);
}, 15000);
setInterval(renderRecording, 1000);
await restore();
