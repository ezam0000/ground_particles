import { DESTINATIONS } from "../core/destinations.js";
import { preferences, setPreference } from "../core/preferences.js";

const CONTROLS = [
    ["Click", "Look and aim"], ["WASD", "Move"], ["Shift", "Sprint"],
    ["Space", "Jump"], ["I", "Speak or inspect"], ["E", "Open project or continue"],
    ["R", "Draw and shoot the bow"], ["B", "Card book"], ["F", "Flip card"],
    ["Left / Right", "Browse collected cards"], ["C", "Emote"], ["Scroll", "Zoom"],
    ["H", "Help"], ["G", "Destinations"], ["P", "Preferences"], ["Esc", "Close or pause"],
];

export class ExperienceUI {
    constructor(guide) {
        this.guide = guide;
        this.onAction = () => {};
        this.toolbar = document.createElement("nav");
        this.toolbar.id = "experience-toolbar";
        this.toolbar.setAttribute("aria-label", "Experience controls");
        this.toolbar.innerHTML = '<button data-action="help">Help <kbd>H</kbd></button><button data-action="destinations">Destinations <kbd>G</kbd></button><button data-action="preferences">Preferences <kbd>P</kbd></button>';
        this.panel = document.createElement("section");
        this.panel.id = "experience-panel";
        this.panel.hidden = true;
        this.panel.setAttribute("role", "dialog");
        this.panel.setAttribute("aria-modal", "true");
        this.panel.setAttribute("aria-labelledby", "experience-title");
        this.panel.innerHTML = '<div class="experience-sheet"><header><p class="eyebrow">Portfolio dunes</p><h1 id="experience-title"></h1></header><div class="experience-content"></div><footer><button data-action="close">Close <kbd>Esc</kbd></button></footer></div>';
        this.content = this.panel.querySelector(".experience-content");
        this.title = this.panel.querySelector("h1");
        this.footer = this.panel.querySelector("footer");
        this.guidance = document.createElement("div");
        this.guidance.id = "context-guidance";
        this.guidance.setAttribute("aria-live", "polite");
        document.body.append(this.toolbar, this.panel, this.guidance);
        this._lastGuidance = "";
        this._startedAt = performance.now();
        this._mode = "";
        this._projectShown = false;
        const actions = (event) => {
            const button = event.target.closest("button[data-action]");
            if (button) this.onAction(button.dataset.action, button.dataset.value);
        };
        this.toolbar.addEventListener("click", actions);
        this.panel.addEventListener("click", actions);
        this.panel.addEventListener("input", (event) => {
            const el = event.target;
            if (!el.dataset.preference) return;
            setPreference(el.dataset.preference, el.type === "checkbox" ? el.checked : Number(el.value));
            const output = el.parentElement.querySelector("output");
            if (output) output.textContent = el.dataset.preference === "volume" ? Math.round(preferences.volume * 100) + "%" : preferences.sensitivity.toFixed(2) + "×";
        });
        this.panel.addEventListener("keydown", (event) => {
            if (event.key !== "Tab") return;
            const controls = [...this.panel.querySelectorAll("button:not([disabled]), input")];
            const first = controls[0]; const last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        });
    }
    showMenu(mode) {
        this._mode = mode;
        this.title.textContent = { help: "Make yourself at home", destinations: "Where would you like to go?", preferences: "Your preferences", paused: "Paused" }[mode];
        if (mode === "help") {
            this.content.innerHTML = '<p class="menu-intro">Walk among the pillars to discover projects, experience, and education. Speak with the island’s characters to begin the Odyssey.</p><dl class="controls-grid">' + CONTROLS.map(([key, action]) => `<div><dt><kbd>${key}</kbd></dt><dd>${action}</dd></div>`).join("") + '</dl>';
        } else if (mode === "destinations") {
            this.content.innerHTML = '<p class="menu-intro">Choose what the compass guides you toward. You are free to explore along the way.</p><div class="destination-options">' + DESTINATIONS.map((d) => `<button data-action="destination" data-value="${d.id}" aria-pressed="${this.guide.selected === d.id}">${d.label}<span>${d.id === "odyssey" ? "Characters and discoveries" : "Portfolio pillars"}</span></button>`).join("") + '</div>';
        } else if (mode === "preferences") {
            this.content.innerHTML = `<div class="preference-fields"><label>Sound volume <output>${Math.round(preferences.volume * 100)}%</output><input type="range" min="0" max="1" step="0.05" value="${preferences.volume}" data-preference="volume" /></label><label>Mouse sensitivity <output>${preferences.sensitivity.toFixed(2)}×</output><input type="range" min="0.25" max="2" step="0.05" value="${preferences.sensitivity}" data-preference="sensitivity" /></label><label class="preference-toggle"><input type="checkbox" data-preference="reducedMotion" ${preferences.reducedMotion ? "checked" : ""} /> Reduced motion<span>Steady camera and instant card flips.</span></label></div><p class="menu-note">Preferences are saved on this browser.</p>`;
        } else {
            this.content.innerHTML = '<p class="menu-intro">Your place is safe. Click Resume when you’re ready to continue.</p>';
        }
        this.footer.innerHTML = mode === "paused" ? '<button class="primary-button" data-action="resume">Resume</button><button data-action="help">Help</button>' : '<button data-action="close">Close <kbd>Esc</kbd></button>';
        this.panel.hidden = false;
        this.panel.querySelector("button, input")?.focus();
    }
    hideMenu() {
        this.panel.hidden = true;
        this._mode = "";
    }
    update(mode, suspended, target, hasBow, activeProject, locked) {
        const projectShown = !!activeProject;
        if (projectShown !== this._projectShown) {
            this._projectShown = projectShown;
            document.body.dataset.projectActive = String(projectShown);
        }
        let text = "";
        if (mode === "explore" && !suspended) {
            if (activeProject) text = "";
            else if (document.getElementById("eumaeus-talk")?.hidden === false || document.getElementById("argos-inspect")?.hidden === false || document.getElementById("antinous-revive")?.hidden === false) text = "";
            else if (performance.now() - this._startedAt < 14000) text = "Click · look    WASD · move    Shift · sprint";
            else text = (!locked ? "Click · look    " : "") + (target?.hint || "Explore the dunes.") + (hasBow ? "    B · card book" : "");
        }
        if (text !== this._lastGuidance) {
            this._lastGuidance = text;
            this.guidance.textContent = text;
            this.guidance.hidden = !text;
        }
    }
}
