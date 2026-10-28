import { canChooseRecordingAgenda, supportsAgendas } from "./agendas.js";
import { t } from "./i18n.js";

/** Bind the popup's optional agenda card without delaying recording controls. */
export function createAgendaCard(container, { tab, onFolder }) {
    let state;
    let current;
    let initialized = false;
    let loading;
    let matchContext;
    let explicitNone = false;
    let matchedAt = 0;
    let retryAt = 0;
    let retryAttempt = 0;
    let timer;
    const title = document.createElement("strong");
    const hint = document.createElement("p");
    hint.className = "hint";
    const show = document.createElement("button");
    show.type = "button";
    const choose = document.createElement("button");
    choose.type = "button";
    choose.textContent = t("agendaOther");
    const error = document.createElement("p");
    error.className = "error";
    error.setAttribute("role", "status");
    container.append(hint, title, show, choose, error);
    function open(pick = false) {
        void chrome.runtime
            .sendMessage({
                type: "open-agenda",
                agendaId: current?.id,
                tabId: tab()?.id,
                matchTabId: canChooseRecordingAgenda(state)
                    ? state.tabId ?? tab()?.id
                    : tab()?.id,
                windowId: tab()?.windowId,
                choose: pick,
            })
            .catch(() => {
                error.textContent = t("agendaFailed");
            });
    }
    show.addEventListener("click", () => open(!current));
    choose.addEventListener("click", () => open(true));
    function resetMatch() {
        clearTimeout(timer);
        timer = undefined;
        initialized = false;
        loading = undefined;
        retryAt = 0;
        retryAttempt = 0;
    }
    function schedule(settings, delay) {
        clearTimeout(timer);
        timer = setTimeout(() => {
            timer = undefined;
            void render(settings, state);
        }, delay);
    }
    async function render(settings, next) {
        state = next;
        if (
            !supportsAgendas(settings) ||
            (state.state !== "idle" && !canChooseRecordingAgenda(state))
        ) {
            container.hidden = true;
            matchContext = undefined;
            resetMatch();
            return;
        }
        const recording = canChooseRecordingAgenda(state);
        const tabId = recording ? state.tabId ?? tab()?.id : tab()?.id;
        const nextContext = `${recording ? state.sessionId : "idle"}:${tabId}`;
        if (matchContext !== nextContext) {
            matchContext = nextContext;
            resetMatch();
        }
        if (recording && state.agendaId) {
            resetMatch();
            current = { id: state.agendaId, title: state.agendaTitle };
            hint.textContent = t("agendaRecording");
            title.textContent = current.title ?? "";
            show.textContent = t("agendaShow");
            choose.hidden = false;
            container.hidden = false;
            return;
        }
        if (initialized && Date.now() - matchedAt >= 60000) initialized = false;
        if (!initialized) {
            container.hidden = true;
            if (Date.now() < retryAt) return;
            loading ??= chrome.runtime
                .sendMessage({ type: "match-agendas", tabId })
                .catch(() => null);
            const response = await loading;
            if (state !== next || matchContext !== nextContext || initialized) return;
            loading = undefined;
            if (!response?.ok || !Array.isArray(response.agendas)) {
                const delay = Math.min(1000 * 2 ** Math.min(retryAttempt++, 4), 10000);
                retryAt = Date.now() + delay;
                schedule(settings, delay);
                return;
            }
            const rows = response?.agendas ?? [];
            current = recording
                ? null
                : "selectedAgenda" in (response ?? {})
                  ? response.selectedAgenda
                  : rows.length === 1
                    ? rows[0]
                    : null;
            explicitNone = !recording &&
                "selectedAgenda" in (response ?? {}) && !current;
            initialized = true;
            matchedAt = Date.now();
            retryAt = 0;
            retryAttempt = 0;
            schedule(settings, 60000);
            container.hidden = rows.length === 0 && !current && !explicitNone;
            title.textContent =
                current?.title ??
                t(
                    explicitNone ? "agendaNone" : "agendaMultiple",
                    String(rows.length),
                );
            hint.textContent = current?.start
                ? new Date(current.start).toLocaleString([], {
                      dateStyle: "short",
                      timeStyle: "short",
                  })
                : t("agendaTitle");
            if (current && !recording) onFolder(current);
        }
        show.textContent = t(current ? "agendaShow" : "agendaChoose");
        choose.hidden = true;
    }
    render.choice = () =>
        state?.state === "idle" && !container.hidden && initialized
            ? current
                ? { agendaId: current.id }
                : explicitNone
                  ? { agendaId: null }
                  : {}
            : {};
    return render;
}
