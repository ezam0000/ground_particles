/** Keep keyboard focus within an open reading dialog. */
export function trapDialogFocus(root) {
    root.addEventListener("keydown", (event) => {
        if (event.key !== "Tab") return;
        const controls = root.querySelectorAll("button:not([disabled]), summary, a[href], input");
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
}
