/**
 * Odyssey collectible card definitions — front art + back lore.
 */

/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   front: string,
 *   lore: string,
 * }} CardDef
 */

/** @type {CardDef[]} */
export const CARDS = [
    {
        id: "antinous",
        title: "Antinoös",
        front: "/assets/odyssey/antinous_card.png",
        lore:
            "Son of Eupeithes and the boldest of Penelope’s suitors in Ithaca. " +
            "While Odysseus wandered, Antinoös feasted in the palace, plotted " +
            "against Telemachus, and urged the hardest course against the household.\n\n" +
            "When Odysseus returned in beggar’s guise and strung his bow, Antinoös " +
            "was the first to fall — an arrow through the throat as he lifted his cup. " +
            "His death opened the slaughter of the suitors and sealed Odysseus’s reclaiming of home.",
    },
    {
        id: "polyphemus",
        title: "Polyphemus",
        front: "/assets/odyssey/polyphemus_card.png",
        lore:
            "A Cyclops, son of Poseidon, who kept sheep in a cave on a wild shore. " +
            "Odysseus and his men entered seeking guest-right; Polyphemus sealed them " +
            "in and ate several before the hero’s ruse.\n\n" +
            "Calling himself “Nobody,” Odysseus blinded the giant with a heated stake, " +
            "then fled tied beneath the rams. Polyphemus’s cry for revenge reached " +
            "Poseidon, whose wrath lengthened Odysseus’s voyage home.",
    },
];

/** @type {Map<string, CardDef>} */
const BY_ID = new Map(CARDS.map((c) => [c.id, c]));

/** @param {string} id */
export function getCard(id) {
    return BY_ID.get(id) || null;
}
