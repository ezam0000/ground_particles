/**
 * Collected Odyssey cards — unlock order, persisted in localStorage.
 */

import { CARDS, getCard } from "./catalog.js";

const KEY = "dunes.cards.v1";

/** @type {string[]} */
const _owned = load();

function load() {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        /** @type {string[]} */
        const out = [];
        for (let i = 0; i < arr.length; i++) {
            const id = arr[i];
            if (typeof id === "string" && getCard(id) && !out.includes(id)) out.push(id);
        }
        return out;
    } catch {
        return [];
    }
}

function save() {
    try {
        localStorage.setItem(KEY, JSON.stringify(_owned));
    } catch {
        /* private mode / quota — ignore */
    }
}

/** @param {string} id */
export function has(id) {
    return _owned.includes(id);
}

/**
 * Unlock a card. Idempotent.
 * @param {string} id
 * @returns {boolean} true if newly added
 */
export function add(id) {
    if (!getCard(id) || _owned.includes(id)) return false;
    _owned.push(id);
    save();
    return true;
}

/** Owned catalog entries in unlock order. */
export function list() {
    /** @type {import("./catalog.js").CardDef[]} */
    const out = [];
    for (let i = 0; i < _owned.length; i++) {
        const c = getCard(_owned[i]);
        if (c) out.push(c);
    }
    return out;
}

/** All catalog ids (for debugging). */
export function catalogIds() {
    return CARDS.map((c) => c.id);
}
