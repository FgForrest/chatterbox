import { createFolderField } from "../generated/folders.js";
import { agendaRequest } from "./agendas.js";
import { t } from "./i18n.js";
import { formatMeetingTime } from "./meeting-time.js";

function node(tag, value = "", className = "") {
    const el = document.createElement(tag);
    el.textContent = value;
    el.className = className;
    return el;
}

function action(label, run) {
    const button = node("button", label);
    button.type = "button";
    button.addEventListener("click", () => void run());
    return button;
}

/** Render owner sharing and receiver invitations without replacing the recording controls. */
export function mountRoomCards(root, { defaultFolder, onAccepted, onRefresh, onError }) {
    const fields = new Map();
    const invitations = new Map();
    let signature;
    let busy = false;
    let current;
    function clear() {
        for (const field of fields.values()) field.destroy();
        fields.clear();
        invitations.clear();
        root.replaceChildren();
        signature = undefined;
    }
    async function invite(ids, buttons) {
        if (busy) return;
        const agendaId = current.agendaId;
        const recipients = [...ids];
        busy = true;
        for (const button of buttons) button.disabled = true;
        try {
            for (let i = 0; i < recipients.length; i += 20)
                await agendaRequest(`/${encodeURIComponent(agendaId)}/people`, {
                    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ receiverIds: recipients.slice(i, i + 20) }),
                });
            if (current.agendaId !== agendaId) { await onRefresh?.(); return; }
            for (const person of current.people) if (recipients.includes(person.id)) person.pending = true;
            const next = current;
            signature = undefined;
            render(next);
        } catch (error) { onError(error); for (const button of buttons) button.disabled = false; }
        finally { busy = false; }
    }
    async function respond(invitation, response) {
        if (busy) return;
        busy = true;
        const card = invitations.get(invitation.id);
        const buttons = [...card.root.querySelectorAll("button")];
        for (const button of buttons) button.disabled = true;
        try {
            await fields.get(invitation.id)?.saved();
            await agendaRequest(`/invitations/${encodeURIComponent(invitation.id)}`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: response, version: invitation.version,
                    ...(response === "accept" && card.folder.folderId ? { folderId: card.folder.folderId } : {}) }),
            });
            await onAccepted(response === "accept" ? invitation.agendaId : null);
        } catch (error) { onError(error); for (const button of buttons) button.disabled = false; }
        finally { busy = false; }
    }
    function render(value) {
        const key = JSON.stringify(value);
        current = value;
        if (signature === key) return;
        clear();
        signature = key;
        root.hidden = !value.restricted && !value.invitations?.length && !value.people?.length;
        if (value.restricted && !value.invitations?.length) {
            root.append(node("p", t("agendaRoomLocked"), "room-locked"), node("p", t("agendaRoomWithout"), "hint"));
        }
        for (const invitation of value.invitations ?? []) {
            const card = node("section", "", "room-share room-invitation");
            card.setAttribute("aria-label", t("agendaRoomInvitation"));
            card.append(node("strong", t("agendaRoomSharedBy", invitation.sharerName || t("unknown"))), node("h3", invitation.title));
            card.append(node("p", invitation.start ? formatMeetingTime(invitation.start, invitation.end) : "", "hint"));
            const save = node("div", "", "room-save");
            save.append(node("span", t("agendaRoomSaveTo")));
            const chip = node("div");
            save.append(chip);
            card.append(save);
            const initial = defaultFolder();
            const state = { root: card, folder: initial.folderScope === "org" ? {} : initial };
            invitations.set(invitation.id, state);
            const field = createFolderField({ container: chip, prefix: `invite-${invitation.id}`, variant: "pill", t,
                request: async params => {
                    const result = await chrome.runtime.sendMessage({ type: "get-folders", ...params });
                    return { ...result, folders: result?.folders?.filter(folder => folder.scope !== "org" && !folder.sharedWithPeople) };
                },
                save: async folder => { state.folder = folder; },
            });
            fields.set(invitation.id, field);
            const actions = node("div", "", "room-actions");
            const decline = action(t("agendaRoomDecline"), () => respond(invitation, "decline"));
            const accept = action(t("agendaRoomAccept"), () => respond(invitation, "accept"));
            accept.className = "room-primary";
            actions.append(decline, accept);
            card.append(actions);
            root.append(card);
            field.reset(state.folder);
        }
        if (value.invitations?.length) root.append(node("p", t("agendaRoomAcceptHint"), "hint"));
        if (value.people?.length) {
            const card = node("section", "", "room-share room-owner");
            card.append(node("strong", t("agendaRoomPeople", t("appName"))));
            const buttons = [];
            for (const person of value.people) {
                const row = node("div", "", "room-person");
                const name = person.name || t("unknown");
                const initials = name.split(/\s+/).slice(0, 2).map(word => word[0]).join("").toUpperCase();
                row.append(node("span", initials, "room-avatar"), node("span", name, "room-name"));
                if (person.pending) row.append(node("span", t("agendaRoomSent"), "room-sent"));
                else {
                    const share = action(t("agendaRoomShare"), () => invite([person.id], buttons));
                    share.setAttribute("aria-label", t("agendaRoomSharePerson", name));
                    share.className = "room-primary";
                    buttons.push(share);
                    row.append(share);
                }
                card.append(row);
            }
            const pending = value.people.filter(person => !person.pending);
            if (pending.length > 1) {
                const all = action(t("agendaRoomShareAll", String(pending.length)), () => invite(pending.map(person => person.id), buttons));
                all.className = "room-share-all";
                buttons.push(all);
                card.append(all);
            }
            card.append(node("p", t("agendaRoomPeopleHint", t("appName")), "hint"));
            root.append(card);
        }
    }
    return { render, destroy: clear };
}
