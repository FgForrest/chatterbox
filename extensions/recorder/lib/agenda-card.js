import { canChooseRecordingAgenda, supportsAgendas } from "./agendas.js";
import { t } from "./i18n.js";

/** Bind the popup's optional agenda card without delaying recording controls. */
export function createAgendaCard(container, { tab, onFolder }) {
    let state;
    let current;
    let initialized = false;
    let loading;
    let explicitNone = false;
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
                windowId: tab()?.windowId,
                choose: pick,
            })
            .catch(() => {
                error.textContent = t("agendaFailed");
            });
    }
    show.addEventListener("click", () => open(!current));
    choose.addEventListener("click", () => open(true));
    async function render(settings, next) {
        if (next.state === "idle" && state?.state !== "idle") {
            initialized = false;
            loading = undefined;
        }
        state = next;
        if (
            !supportsAgendas(settings) ||
            (state.state !== "idle" && !canChooseRecordingAgenda(state))
        ) {
            container.hidden = true;
            return;
        }
        if (canChooseRecordingAgenda(state)) {
            current = state.agendaId
                ? { id: state.agendaId, title: state.agendaTitle }
                : null;
            hint.textContent = t(current ? "agendaRecording" : "agendaNone");
            title.textContent = current?.title ?? "";
            show.textContent = t("agendaTitle");
            choose.hidden = false;
            container.hidden = false;
            return;
        }
        if (!initialized) {
            loading ??= chrome.runtime
                .sendMessage({ type: "match-agendas", tabId: tab()?.id })
                .then(async (response) => {
                    const rows = response?.agendas ?? [];
                    current =
                        "selectedAgenda" in (response ?? {})
                            ? response.selectedAgenda
                            : rows.length === 1
                              ? rows[0]
                              : null;
                    explicitNone =
                        "selectedAgenda" in (response ?? {}) && !current;
                    return rows;
                })
                .catch(() => []);
            const rows = await loading;
            if (state.state !== "idle") return;
            initialized = true;
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
            if (current) onFolder(current);
        }
        show.textContent = t("agendaShow");
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
