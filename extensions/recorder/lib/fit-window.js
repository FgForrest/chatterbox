const MIN_HEIGHT = 160;

/**
 * Keep the popup window this page runs in exactly as tall as the page.
 * Chrome opens it at a fixed size, while the page's views (picking,
 * recording, saving, done) and Chrome's own sharing bar change the height.
 */
export function fitWindowToContent() {
    let scheduled = false;
    const fit = async () => {
        scheduled = false;
        const delta =
            Math.ceil(document.documentElement.getBoundingClientRect().height) -
            window.innerHeight;
        if (Math.abs(delta) < 2) return;
        const current = await chrome.windows.getCurrent();
        if (current.state !== "normal") return;
        await chrome.windows.update(current.id, {
            height: Math.max(
                MIN_HEIGHT,
                Math.min(current.height + delta, screen.availHeight),
            ),
        });
    };
    const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            fit().catch(() => {});
        });
    };
    new ResizeObserver(schedule).observe(document.body);
    window.addEventListener("resize", schedule);
}
