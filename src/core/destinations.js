import { has } from "../props/cards/collection.js";

export const DESTINATIONS = [
    { id: "project", label: "Projects" },
    { id: "job", label: "Experience" },
    { id: "school", label: "Education" },
    { id: "odyssey", label: "Odyssey" },
];
const BY_ID = Object.fromEntries(DESTINATIONS.map((d) => [d.id, d]));

/** Reuses one target record; no objective objects are created in the frame loop. */
export class DestinationGuide {
    constructor(world) {
        this.world = world;
        this.selected = "odyssey";
        this.target = { x: 0, z: 0, label: "", hint: "", available: false };
    }
    select(id) {
        if (BY_ID[id]) this.selected = id;
    }
    _set(x, z, label, hint) {
        const t = this.target;
        t.x = x; t.z = z; t.label = label; t.hint = hint; t.available = true;
        return t;
    }
    _pasture(label, hint) {
        const { sheep, character } = this.world;
        let nearest = null;
        let best = Infinity;
        for (const s of sheep.sheep) {
            if (!s.alive) continue;
            const dx = s.x - character.position.x;
            const dz = s.z - character.position.z;
            const d2 = dx * dx + dz * dz;
            if (d2 < best) { best = d2; nearest = s; }
        }
        return nearest ? this._set(nearest.x, nearest.z, label, hint) : null;
    }
    update(gameTime) {
        const { avatar, eumaeus, argos, sheep, cyclops, antinous, giant } = this.world;
        if (this.selected !== "odyssey") {
            const d = BY_ID[this.selected];
            let nearest = null;
            let best = Infinity;
            const { character, pedestals } = this.world;
            for (const point of pedestals._points) {
                if (point.project.kind !== this.selected) continue;
                const dx = point.x - character.position.x, dz = point.z - character.position.z;
                const distance = dx * dx + dz * dz;
                if (distance < best) { best = distance; nearest = point; }
            }
            if (nearest) return this._set(nearest.x, nearest.z, d.label, "Approach a pillar to read. Press I to inspect.");
            this.target.available = false; this.target.label = d.label; this.target.hint = "Explore the dunes.";
            return this.target;
        }
        if (!avatar.hasBow) return this._set(eumaeus.x, eumaeus.z, "Eumaeus", "Find the swineherd west. Press I nearby to speak.");
        if (!has("argos") && argos.present) return this._set(argos.x, argos.z, "Argos", "Some discoveries ask only for kindness. Press I nearby.");
        if (!has("sheep") && sheep.canCollectCard) {
            const pasture = this._pasture("Pasture", gameTime < 30
                ? "Spend a moment exploring, then inspect the peaceful flock."
                : "Press I near a sheep before harming the flock.");
            if (pasture) return pasture;
        }
        if (cyclops._spawned && cyclops.alive && !has("polyphemus")) {
            return this._set(cyclops.x, cyclops.z, "Polyphemus", "The Cyclops guards the pasture.");
        }
        if (antinous._spawned && antinous.alive && !has("antinous")) {
            return this._set(antinous.x, antinous.z, "Antinoös", "A challenger waits among the dunes.");
        }
        if (!has("laestrygonians")) return this._set(giant.x, giant.z, "Giant", "Approach the colossus and press I to inspect.");
        if (!sheep.allDead && !has("polyphemus")) {
            const pasture = this._pasture("Pasture", "Explore the pasture; its keeper has yet to appear.");
            if (pasture) return pasture;
        }
        this.target.available = false;
        this.target.label = "Odyssey";
        this.target.hint = !has("antinous") && !antinous._spawned
            ? "There is still a secret in the sunlight. Discovery hints are in your card book."
            : "Explore freely. Your card book holds the remaining discovery hints.";
        return this.target;
    }
    discoveryHint(id) {
        const { argos, sheep, antinous } = this.world;
        switch (id) {
            case "eumaeus": return "Speak with the swineherd west of your arrival point.";
            case "argos": return argos.present ? "Inspect the dog who follows the swineherd." : "The dog has departed this visit. His card can be found on a fresh visit.";
            case "sheep": return sheep.canCollectCard
                ? "After 30 seconds of exploration, inspect a living sheep before harming the flock."
                : "The peaceful flock card is unavailable after a sheep is killed. Try a fresh visit; your collected cards stay saved.";
            case "laestrygonians": return "Inspect the giant south of your arrival point. Defeating him is not required.";
            case "polyphemus": return "The Cyclops appears after the flock falls. Five headshots within 15 seconds defeat him.";
            case "antinous": return antinous._spawned && !antinous.alive
                ? "Inspect the fallen challenger to revive him for another encounter."
                : "Fire five arrows toward the sun to summon a challenger.";
            default: return "Explore the dunes to discover this card.";
        }
    }
}
