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
    {
        id: "laestrygonians",
        title: "Laestrygonians",
        front: "/assets/odyssey/laestrygonians_card.png",
        lore:
            "A race of man-eating giants who dwelt in a cliff-walled harbor. " +
            "When Odysseus’s fleet put in for rest, the Laestrygonians hurled " +
            "boulders from the heights and speared the crews like fish.\n\n" +
            "Every ship but Odysseus’s own was smashed in the narrow cove. " +
            "He cut the cable and fled to open sea — the costliest loss of the voyage, " +
            "and a warning that not every shore offers guest-right.",
    },
    {
        id: "sheep",
        title: "Sheep",
        front: "/assets/odyssey/sheep_card.png",
        lore:
            "The flock of Polyphemus — thick-wooled rams and ewes that left the cave " +
            "each morning for pasture and returned at dusk to be milked by the Cyclops.\n\n" +
            "After blinding their master, Odysseus and his men clung beneath the bellies " +
            "of the largest rams and rode out past the groping giant. Mercy toward the " +
            "flock was the price of escape; slaughter would have left them trapped.",
    },
];

/** @type {Map<string, CardDef>} */
const BY_ID = new Map(CARDS.map((c) => [c.id, c]));

/** @param {string} id */
export function getCard(id) {
    return BY_ID.get(id) || null;
}
