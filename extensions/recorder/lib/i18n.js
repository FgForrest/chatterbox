export function t(key, substitutions) {
    return globalThis.chrome?.i18n?.getMessage?.(key, substitutions) || key;
}

export function localizeDocument() {
    document.documentElement.lang = chrome.i18n.getUILanguage();
    for (const node of document.querySelectorAll("[data-i18n]")) {
        node.textContent = t(node.dataset.i18n);
    }
    for (const node of document.querySelectorAll("[data-i18n-placeholder]")) {
        node.setAttribute("placeholder", t(node.dataset.i18nPlaceholder));
    }
    document.title = t("extensionName");
}
