/**
 * Pull portfolio content out of the iCloud HTML portfolio and into this repo.
 *
 *   node scripts/syncPortfolio.mjs
 *
 * Syncs:
 *   - projects  → src/portfolio/projects.json  + public/assets/portfolio/{id}.*
 *   - jobs      → src/portfolio/experience.json + public/assets/portfolio/org/*
 *   - schools   → src/portfolio/education.json  + public/assets/portfolio/org/*
 *
 * Projects come from an exported TS module. Jobs/schools live as inline arrays
 * inside section components — those blocks are lifted into temp modules and
 * imported with Node's type stripping. Re-run after editing the portfolio.
 */

import {
    copyFileSync, existsSync, mkdirSync, mkdtempSync,
    readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "../..");
const PORTFOLIO = join(
    homedir(),
    "Library/Mobile Documents/com~apple~CloudDocs/PROJECTS/htmlportfolio"
);
const OUT_IMAGES = join(ROOT, "public/assets/portfolio");
const OUT_ORG = join(OUT_IMAGES, "org");
const OUT_PROJECTS = join(ROOT, "src/portfolio/projects.json");
const OUT_EXPERIENCE = join(ROOT, "src/portfolio/experience.json");
const OUT_EDUCATION = join(ROOT, "src/portfolio/education.json");

// ----------------------------------------------------------------- helpers

/** Resolve a `/assets/x` path against the portfolio's two asset roots. */
function findAsset(urlPath) {
    const rel = decodeURIComponent(urlPath.replace(/^\/assets\//, ""));
    for (const base of ["public/assets", "assets"]) {
        const p = join(PORTFOLIO, base, rel);
        if (existsSync(p)) return p;
    }
    return null;
}

/** Some files are AVIF bytes with a .jpg name; serve them as what they are. */
function sniffExt(file) {
    const head = readFileSync(file).subarray(0, 12).toString("latin1");
    if (head.slice(4, 8) === "ftyp" && /^(avif|avis)/.test(head.slice(8, 12))) return ".avif";
    return extname(file).toLowerCase();
}

function slug(title) {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Copy an org logo; return the public URL or null. */
function copyOrgLogo(logoPath, id) {
    if (!logoPath) return null;
    const src = findAsset(logoPath);
    if (!src) {
        console.warn(`! org logo missing: ${logoPath}`);
        return null;
    }
    const ext = sniffExt(src);
    const name = id + ext;
    copyFileSync(src, join(OUT_ORG, name));
    return "/assets/portfolio/org/" + name;
}

/**
 * Lift `const name = [ ... ]` out of a TSX section into a temp ES module and
 * import it. The arrays are plain data — no JSX inside the literal.
 */
async function importInlineArray(tsxRel, constName) {
    const srcPath = join(PORTFOLIO, tsxRel);
    const src = readFileSync(srcPath, "utf8");
    const m = src.match(new RegExp(`const ${constName}\\s*=\\s*(\\[[\\s\\S]*?\\n\\])`));
    if (!m) throw new Error(`could not find const ${constName} in ${tsxRel}`);
    const dir = mkdtempSync(join(tmpdir(), "dunes-sync-"));
    const tmp = join(dir, constName + ".ts");
    writeFileSync(tmp, `export const ${constName} = ${m[1]};\n`);
    try {
        const mod = await import(pathToFileURL(tmp).href + "?t=" + Date.now());
        return mod[constName];
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------- projects

const { projects } = await import(
    pathToFileURL(join(PORTFOLIO, "src/data/projects.ts")).href
);

function stillPath(p) {
    const m = p.media;
    switch (m.type) {
        case "image": return m.src;
        case "video": return m.gif;
        case "dissolve": return m.dark || m.light;
        default: return null;
    }
}

mkdirSync(OUT_IMAGES, { recursive: true });
mkdirSync(OUT_ORG, { recursive: true });

const projectOut = [];
for (const p of projects) {
    const still = stillPath(p);
    const src = still && findAsset(still);
    let image = null;
    if (src) {
        const ext = sniffExt(src);
        const name = p.id + ext;
        copyFileSync(src, join(OUT_IMAGES, name));
        image = "/assets/portfolio/" + name;
    } else {
        console.warn(`! ${p.id}: no usable still (${still ? basename(still) + " not found" : p.media.type})`);
    }
    const href = p.links?.[0]?.href;
    projectOut.push({
        id: p.id,
        kind: "project",
        title: p.title,
        description: p.description,
        link: href && href.startsWith("http") ? href : null,
        image,
        isNew: !!p.isNew,
        period: null,
    });
}
writeFileSync(OUT_PROJECTS, JSON.stringify(projectOut, null, 2) + "\n");
console.log(`synced ${projectOut.length} projects`);

// ------------------------------------------------------------- experience

const jobs = await importInlineArray(
    "src/components/portfolio/sections/WorkExperienceSection.tsx",
    "jobs"
);
const experienceOut = [
    {
        id: "secret",
        kind: "job",
        title: "Redacted",
        period: "2026 - Pending",
        description: "Role details are classified for now. Enter a clearance code if you have one.",
        link: null,
        image: null,
        isNew: true,
    },
    ...jobs.map((j) => {
        const id = slug(j.title);
        const desc = [j.description, j.details].filter(Boolean).join(" ");
        return {
            id,
            kind: "job",
            title: j.title,
            period: j.period || null,
            description: desc,
            link: j.site && String(j.site).startsWith("http") ? j.site : null,
            image: copyOrgLogo(j.logo, id),
            isNew: false,
        };
    }),
];
writeFileSync(OUT_EXPERIENCE, JSON.stringify(experienceOut, null, 2) + "\n");
console.log(`synced ${experienceOut.length} jobs`);

// -------------------------------------------------------------- education

const schools = await importInlineArray(
    "src/components/portfolio/sections/EducationSection.tsx",
    "schools"
);
const educationOut = schools.map((s) => {
    const id = slug(s.title);
    return {
        id,
        kind: "school",
        title: s.title,
        period: s.period || null,
        description: s.description,
        link: null,
        image: copyOrgLogo(s.logo, id),
        isNew: false,
    };
});
writeFileSync(OUT_EDUCATION, JSON.stringify(educationOut, null, 2) + "\n");
console.log(`synced ${educationOut.length} schools`);
