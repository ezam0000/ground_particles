import { clearInput } from "./input.js";

/** Owns transitions and consumes modal actions before gameplay sees them. */
export class InteractionModes {
    constructor({ canvas, scene, rig, input, ui, cardBook, dropCard, zeusDeath, pedestals, onDropClose, onRespawn }) {
        Object.assign(this, { canvas, scene, rig, input, ui, cardBook, dropCard, zeusDeath, pedestals, onDropClose, onRespawn });
        this.mode = "explore";
        this.ready = false;
        this.suspended = false;
        this.returnMode = "explore";
        this.menuPaused = false;
        this.dialogs = [["book", cardBook], ["drop", dropCard], ["dead", zeusDeath]];
        this.ui.onAction = (action, value) => this.handleAction(action, value);
        this.cardBook.onClose = () => this.close();
        this.dropCard.onContinue = () => this.close();
        this.zeusDeath.onContinue = () => this.close();
        this.pedestals.card.onInspect = () => {
            if (this.mode === "inspect" && !this.suspended) { this.close(); return; }
            if (!this.playing || !this.pedestals.card.active) return;
            this.input.inspectPressed = true;
            this.pedestals.pollInspect(this.rig, this.ui.guide.world.character.position);
            if (this.input.inspecting) this.set("inspect");
            else this.input.inspectPressed = false;
        };
        window.addEventListener("blur", () => this.pause());
        document.addEventListener("visibilitychange", () => { if (document.hidden) this.pause(); });
        document.addEventListener("pointerlockchange", () => {
            if (!this.input.locked && this.mode === "explore") this.pause();
            else if (this.input.locked && this.suspended) this.resume(false);
            else if (!this.input.locked) this._focus();
        });
        this._apply();
    }
    get playing() { return this.ready && this.mode === "explore" && !this.suspended; }
    get cameraActive() { return !this.suspended && (this.mode === "explore" || this.mode === "inspect"); }
    _apply() {
        this.input.enabled = this.playing;
        this.scene.animationTimeScale = this.playing ? 1 : 0;
        this.scene.resetLastAnimationTimeFrame();
        document.body.dataset.mode = this.suspended ? "paused" : this.mode;
        for (const [mode, dialog] of this.dialogs) {
            const active = !this.suspended && this.mode === mode;
            dialog.el.inert = !active;
            dialog.el.setAttribute("aria-hidden", String(!active || !dialog.visible));
        }
    }
    activate() {
        this.ready = true;
        clearInput();
        this._apply();
        if (document.hidden) this.pause();
    }
    _focus() {
        if (this.suspended || ["help", "destinations", "preferences"].includes(this.mode)) this.ui.panel.querySelector("button, input")?.focus();
        else if (this.mode === "book") this.cardBook.el.querySelector('[data-book="close"]')?.focus();
        else if (this.mode === "drop") this.dropCard.el.querySelector('[data-drop="continue"]')?.focus();
        else if (this.mode === "dead") this.zeusDeath.el.querySelector("button")?.focus();
        else this.canvas.focus({ preventScroll: true });
    }
    set(mode) {
        this.mode = mode;
        clearInput();
        this._apply();
    }
    pause() {
        if (!this.ready || this.suspended) return;
        this.suspended = true;
        clearInput();
        this._apply();
        this.ui.showMenu("paused");
    }
    resume(capturePointer = true) {
        if (document.hidden) return;
        this.suspended = false;
        clearInput();
        if (["help", "destinations", "preferences"].includes(this.mode)) this.ui.showMenu(this.mode);
        else this.ui.hideMenu();
        this._apply();
        this._focus();
        if (capturePointer && this.cameraActive && !this.input.locked) void this.canvas.requestPointerLock()?.catch(() => {});
    }
    openMenu(mode) {
        if (["help", "destinations", "preferences"].includes(this.mode)) {
            this.mode = mode;
        } else {
            this.returnMode = this.mode;
            this.menuPaused = this.suspended;
            this.set(mode);
        }
        this.suspended = false;
        this._apply();
        this.ui.showMenu(mode);
        if (this.input.locked) document.exitPointerLock();
    }
    openBook() {
        if (this.mode !== "explore") return;
        this.set("book");
        this.cardBook.open();
        if (this.input.locked) document.exitPointerLock();
    }
    showDrop(id, x, z, y) {
        this.set("drop");
        this.rig.beginInspect(x, y, z);
        this.dropCard.show(id);
        // Settle the camera once; the world and its animations are already paused.
        this.input.lookX = this.input.lookY = this.input.zoomDelta = 0;
        if (this.input.locked) document.exitPointerLock();
    }
    showDeath() {
        this.cardBook.close(); this.dropCard.hide();
        this.rig.endInspect(); this.input.inspecting = false;
        this.set("dead");
        this.ui.hideMenu(); this.zeusDeath.show();
        if (this.input.locked) document.exitPointerLock();
    }
    close() {
        if (this.suspended) return;
        const mode = this.mode;
        if (mode === "book") this.cardBook.close();
        else if (mode === "drop") {
            const id = this.dropCard.activeId;
            this.dropCard.hide(); this.rig.endInspect();
            this.onDropClose(id);
        } else if (mode === "dead") this.onRespawn();
        else if (mode === "inspect") {
            this.rig.endInspect(); this.input.inspecting = false;
            this.pedestals.endInspect();
        } else if (["help", "destinations", "preferences"].includes(mode)) {
            this.ui.hideMenu();
            this.set(this.returnMode);
            if (this.menuPaused) {
                this.suspended = true;
                this.menuPaused = false;
                this._apply();
                this.ui.showMenu("paused");
            } else this._focus();
            return;
        } else return;
        this.set("explore");
        this.canvas.focus({ preventScroll: true });
    }
    handleAction(action, value) {
        if (action === "resume") this.resume();
        else if (action === "close") this.close();
        else if (action === "destination") {
            this.ui.guide.select(value); this.close();
        } else this.openMenu(action);
    }
    routeInput() {
        const i = this.input;
        if (!this.ready) { clearInput(); return; }
        if (this.suspended) { clearInput(); return; }
        if (i.escapePressed) { this.mode === "explore" ? this.pause() : this.close(); return; }
        if (i.helpPressed) { this.openMenu("help"); return; }
        if (i.destinationsPressed) { this.openMenu("destinations"); return; }
        if (i.preferencesPressed) { this.openMenu("preferences"); return; }
        if (this.mode === "book") {
            if (i.flipPressed) this.cardBook.toggleFlip();
            if (i.navLeftPressed) this.cardBook.browse(-1);
            if (i.navRightPressed) this.cardBook.browse(1);
            if (i.bookPressed) this.close();
            clearInput();
        } else if (this.mode === "drop") {
            if (i.flipPressed) this.dropCard.toggleFlip();
            if (i.openPressed) this.close();
            clearInput();
        } else if (this.mode === "dead") {
            if (i.openPressed) this.close();
            clearInput();
        } else if (this.mode === "inspect") {
            if (i.inspectPressed) this.close();
            i.jumpPressed = i.drawPressed = i.emotePressed = i.bookPressed = false;
        } else if (this.mode === "explore" && i.bookPressed) this.openBook();
        else if (!this.playing) clearInput();
    }
}
