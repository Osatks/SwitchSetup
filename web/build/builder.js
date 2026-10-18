// SwitchSetup online builder. Based on Homebrew SD Setup by noahc3 (MPL-2.0).
// Everything runs in the browser; /api/* (src/worker.js) only relays GitHub release files.
import { readZip, writeZip } from "./zip.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const STORE_KEY = "switchsetup.web.v1";
const RECORD_FILE = "switchsetup.json";
const CAN_WRITE_FOLDER = "showDirectoryPicker" in window;

const state = {
  catalog: null,
  releases: {}, // repo -> release
  selected: new Set(),
  preset: null,
  query: "",
  category: "all",
  card: null, // { handle, name, info }
  building: false,
  zipUrl: null,
};

// ---------- helpers ----------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtBytes(n) {
  if (!n) return "–";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(n > 100 * 1024 * 1024 ? 0 : 1)} MB`;
}
function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
}
async function api(path) {
  // "no-cache" = always check with the server, so a newly added package never meets a stale version list.
  const r = await fetch(path, { cache: "no-cache" });
  const body = r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error(body?.error || r.statusText);
  return body;
}
function toast(text, ms = 4000) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ preset: state.preset, packages: [...state.selected] })); } catch { }
}
function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch { return null; }
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  return url;
}
const pkg = (id) => state.catalog.packages.find((p) => p.id === id);
const target = () => $("input[name=target]:checked").value;
const today = () => new Date().toISOString().slice(0, 10);

/** Forward slashes, no leading slash, no ".." so archives can't escape the SD root. */
function normalize(path) {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.some((p) => p === "..")) throw new Error(`Unsafe path in package: ${path}`);
  return parts.join("/");
}

function matchAsset(release, rule) {
  const re = new RegExp(rule.match, "i");
  return release?.assets?.find((a) => re.test(a.name)) ?? null;
}
function packageSize(p) {
  const rel = state.releases[p.repo];
  return (p.assets ?? []).reduce((s, r) => s + (matchAsset(rel, r)?.size ?? 0), 0);
}
function latestVersion(id) {
  const p = pkg(id);
  return p?.repo ? state.releases[p.repo]?.tag ?? null : "bundled";
}
function installedVersion(id) {
  return target() === "drive" ? state.card?.info?.installed?.[id] ?? null : null;
}
function hasUpdate(id) {
  const inst = installedVersion(id);
  const latest = latestVersion(id);
  return !!(inst && latest && inst !== latest && inst !== "bundled");
}

// ---------- selection ----------
function normalizeSelection() {
  for (const p of state.catalog.packages) if (p.required) state.selected.add(p.id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...state.selected]) {
      for (const d of pkg(id)?.dependencies ?? []) if (!state.selected.has(d)) { state.selected.add(d); changed = true; }
    }
  }
  for (const id of [...state.selected]) if (!pkg(id)) state.selected.delete(id);
}
function applyPreset(id) {
  if (id === "card") {
    state.selected = new Set(Object.keys(state.card?.info?.installed ?? {}));
  } else {
    const p = state.catalog.presets.find((x) => x.id === id);
    if (!p) return;
    // "*" means every package except opt-in ones (like sys-patch), which the user must turn on themselves.
    state.selected = new Set(p.packages.includes("*") ? state.catalog.packages.filter((x) => !x.optIn).map((x) => x.id) : p.packages);
  }
  state.preset = id;
  normalizeSelection();
  save();
  renderAll();
}
/** Shows a package's warning and resolves true only if the user explicitly accepts it. */
function askConfirm(p) {
  return new Promise((resolve) => {
    const dlg = $("#confirmDlg");
    if (!dlg) return resolve(window.confirm(p.confirm)); // page cached from before this dialog existed
    $("#confirmTitle").textContent = p.name;
    $("#confirmText").textContent = p.confirm;
    const done = (ok) => { dlg.close(); resolve(ok); };
    $("#confirmYes").onclick = () => done(true);
    $("#confirmNo").onclick = () => done(false);
    dlg.oncancel = () => resolve(false);
    dlg.showModal();
  });
}

async function toggle(id, on) {
  const p = pkg(id);
  if (on && p?.confirm && !(await askConfirm(p))) { renderPackages(); return; }
  if (on) state.selected.add(id);
  else {
    const needer = [...state.selected].map(pkg).find((p) => p?.dependencies?.includes(id));
    if (needer) { toast(`${pkg(id).name} is needed by ${needer.name}.`); renderPackages(); return; }
    state.selected.delete(id);
  }
  state.preset = null;
  normalizeSelection();
  save();
  renderAll();
}

// ---------- render ----------
function renderPresets() {
  const installed = state.card?.info?.installed ?? {};
  const extra = target() === "drive" && Object.keys(installed).length
    ? [{ id: "card", name: "Update my card", description: "Exactly what's on this SD card now, at the newest versions.", special: true }]
    : [];
  $("#presets").innerHTML = [...extra, ...state.catalog.presets].map((p) => `
    <button class="preset ${p.special ? "special" : ""}" role="radio" aria-checked="${state.preset === p.id}" data-id="${esc(p.id)}">
      <strong>${esc(p.name)}</strong><span>${esc(p.description)}</span>
    </button>`).join("");
  $$(".preset").forEach((b) => (b.onclick = () => applyPreset(b.dataset.id)));
}

function renderChips() {
  const cats = [{ id: "all", name: "All" }, ...state.catalog.categories];
  $("#chips").innerHTML = cats.map((c) =>
    `<button class="chip" aria-pressed="${state.category === c.id}" data-id="${esc(c.id)}">${esc(c.name.replace(/ &.*$/, ""))}</button>`).join("");
  $$(".chip").forEach((b) => (b.onclick = () => { state.category = b.dataset.id; renderChips(); renderPackages(); }));
}

function metaPills(p) {
  const pills = [];
  if (p.required) pills.push(`<span class="pill req">Required</span>`);
  if (!p.repo) pills.push(`<span class="pill">Included</span>`);
  else {
    const rel = state.releases[p.repo];
    if (!rel) pills.push(`<span class="pill"><span class="pulse"></span>Checking</span>`);
    else if (rel.error) pills.push(`<span class="pill err" title="${esc(rel.error)}">Unavailable</span>`);
    else {
      pills.push(`<span class="pill"><a href="${esc(rel.url)}" target="_blank" rel="noopener" title="Release notes">${esc(rel.tag)}</a></span>`);
      if (rel.publishedAt) pills.push(`<span class="pill">${esc(fmtDate(rel.publishedAt))}</span>`);
      const size = packageSize(p);
      if (size) pills.push(`<span class="pill">${esc(fmtBytes(size))}</span>`);
    }
  }
  const inst = installedVersion(p.id);
  if (inst) {
    pills.push(hasUpdate(p.id)
      ? `<span class="pill upd">Update: ${esc(inst)} → ${esc(latestVersion(p.id))}</span>`
      : `<span class="pill inst">On card</span>`);
  }
  return pills.join("");
}

function renderPackages() {
  const q = state.query.trim().toLowerCase();
  const match = (p) =>
    (state.category === "all" || p.category === state.category) &&
    (!q || [p.name, p.authors, p.description].some((s) => s?.toLowerCase().includes(q)));
  const html = state.catalog.categories.map((c) => {
    const items = state.catalog.packages.filter((p) => p.category === c.id && match(p));
    if (!items.length) return "";
    return `<div class="cat-title">${esc(c.name)}</div><div class="grid">${items.map((p) => {
      const on = state.selected.has(p.id);
      return `
      <label class="pkg ${on ? "on" : ""} ${p.required ? "locked" : ""}">
        <div>
          <div class="pkg-title">${esc(p.name)}</div>
          <div class="pkg-by">by ${esc(p.authors)}</div>
        </div>
        <span class="toggle"><input type="checkbox" data-id="${esc(p.id)}" ${on ? "checked" : ""} ${p.required ? "disabled" : ""} aria-label="Include ${esc(p.name)}"><span></span></span>
        <p class="pkg-desc">${esc(p.description)}${p.warning ? ` <strong>${esc(p.warning)}</strong>` : ""}</p>
        <div class="pkg-meta">${metaPills(p)}</div>
      </label>`;
    }).join("")}</div>`;
  }).join("");
  $("#packages").innerHTML = html || `<div class="empty">No packages match “${esc(state.query)}”.</div>`;
  $$("#packages input[type=checkbox]").forEach((cb) => (cb.onchange = () => toggle(cb.dataset.id, cb.checked)));
}

const SD_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M18 2h-8L4 8v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-6 6h-2V4h2v4zm3 0h-2V4h2v4zm3 0h-2V4h2v4z"/></svg>`;

function renderCard() {
  const box = $("#cardStatus");
  if (!CAN_WRITE_FOLDER) {
    box.innerHTML = `<div class="card-row"><div class="card-icon">${SD_ICON}</div><div>
      <div class="card-name">Not available in this browser</div>
      <div class="card-sub">Writing straight to an SD card works in Chrome, Edge and Opera on a computer. Use <strong>ZIP file</strong> instead, or download the Windows app.</div></div></div>`;
    $("#cleanRow").hidden = true;
    return;
  }
  const c = state.card;
  $("#cleanRow").hidden = !(c && (c.info.hasAtmosphere || c.info.hasHekate));
  if (!c) {
    box.innerHTML = `
      <div class="card-row"><div class="card-icon">${SD_ICON}</div><div>
        <div class="card-name">Choose your SD card</div>
        <div class="card-sub">Insert it into your computer, then select the card itself (for example <code>E:\\</code>), not a folder on it.</div></div></div>
      <button class="btn btn-quiet pick-card" id="pickCard">Choose SD card…</button>
      <ol class="steps-mini"><li>Click the button and select your SD card.</li><li>Click <strong>View files</strong> / <strong>Allow</strong> when the browser asks.</li></ol>`;
    $("#pickCard").onclick = pickCard;
    return;
  }
  const i = c.info;
  const notes = [];
  const count = Object.keys(i.installed).length;
  if (count) {
    const upd = Object.keys(i.installed).filter(hasUpdate).length;
    notes.push(`<div class="note ${upd ? "warn" : "ok"}">Set up with SwitchSetup on ${esc(fmtDate(i.lastBuilt))}. ${upd ? `<strong>${upd} update${upd > 1 ? "s" : ""} available.</strong>` : "Everything is up to date."}</div>`);
  } else if (i.hasAtmosphere || i.hasHekate) {
    notes.push(`<div class="note warn">This card already has ${i.hasAtmosphere ? "Atmosphère" : "Hekate"}. Building updates it and replaces the old files.</div>`);
  } else if (i.usedInConsole) {
    notes.push(`<div class="note">This card has been used in a Switch. Your games and data are left alone.</div>`);
  } else if (!i.looksLikeRoot) {
    notes.push(`<div class="note warn">This looks like an empty folder. Make sure you selected the SD card itself, not a folder on it.</div>`);
  }
  if (i.hasEmummc) notes.push(`<div class="note ok">emuMMC found. It won't be touched.</div>`);
  box.innerHTML = `
    <div class="card-row"><div class="card-icon">${SD_ICON}</div>
      <div class="grow"><div class="card-name">${esc(c.name)}</div><div class="card-sub">Selected SD card</div></div></div>
    <button class="btn btn-quiet pick-card" id="pickCard">Choose a different card…</button>
    ${notes.join("")}`;
  $("#pickCard").onclick = pickCard;
}

function renderTotals() {
  const ids = [...state.selected];
  const size = ids.map(pkg).reduce((s, p) => s + (p ? packageSize(p) : 0), 0);
  $("#totCount").textContent = ids.length;
  $("#totSize").textContent = fmtBytes(size);
  const upd = ids.filter(hasUpdate).length;
  $("#totUpdRow").hidden = !upd;
  $("#totUpd").textContent = upd;

  const t = target();
  $("#drivePane").hidden = t !== "drive";
  $("#zipPane").hidden = t !== "zip";
  const ready = Object.keys(state.releases).length > 0;
  const btn = $("#build");
  if (t === "zip") {
    btn.textContent = "Build ZIP";
    btn.disabled = state.building || !ready;
    $("#buildHint").textContent = ready ? "" : "Loading the latest versions…";
  } else {
    btn.textContent = state.card && Object.keys(state.card.info.installed).length ? "Update SD card" : "Write to SD card";
    btn.disabled = state.building || !ready || !state.card;
    $("#buildHint").textContent = !CAN_WRITE_FOLDER ? "" : !state.card ? "Choose your SD card first." : "";
  }
}

function renderAll() {
  renderPresets();
  renderChips();
  renderPackages();
  renderCard();
  renderTotals();
}

// ---------- SD card folder (File System Access API) ----------
async function getDir(root, parts, create) {
  let dir = root;
  for (const part of parts) {
    try {
      dir = await dir.getDirectoryHandle(part, { create });
    } catch (e) {
      // A *file* with this name is in the way of a folder: replace it.
      if (create && e.name === "TypeMismatchError") {
        await dir.removeEntry(part);
        dir = await dir.getDirectoryHandle(part, { create: true });
      } else throw e;
    }
  }
  return dir;
}

async function exists(root, path) {
  const parts = path.split("/");
  try {
    const dir = await getDir(root, parts.slice(0, -1), false);
    await dir.getFileHandle(parts.at(-1));
    return true;
  } catch { return false; }
}

async function dirExists(root, path) {
  try { await getDir(root, path.split("/"), false); return true; } catch { return false; }
}

/** Writes a file, always replacing whatever is there (including read-only files). */
async function writeFile(root, path, data) {
  const parts = path.split("/");
  const name = parts.pop();
  const dir = await getDir(root, parts, true);
  let fh;
  try {
    fh = await dir.getFileHandle(name, { create: true });
  } catch (e) {
    if (e.name === "TypeMismatchError") {
      throw new Error(`There is a folder named "${path}" on the card where a file needs to go. Rename or delete that folder and try again.`);
    }
    throw e;
  }
  try {
    const w = await fh.createWritable({ keepExistingData: false });
    await w.write(data);
    await w.close();
  } catch (e) {
    // e.g. a read-only file: delete it and write a fresh copy.
    await dir.removeEntry(name);
    const fresh = await dir.getFileHandle(name, { create: true });
    const w = await fresh.createWritable();
    await w.write(data);
    await w.close();
  }
}

async function inspectCard(root) {
  const info = { installed: {}, lastBuilt: null, hasAtmosphere: false, hasHekate: false, hasEmummc: false, usedInConsole: false, looksLikeRoot: false };
  try {
    const fh = await root.getFileHandle(RECORD_FILE);
    const rec = JSON.parse(await (await fh.getFile()).text());
    info.installed = rec.Packages ?? rec.packages ?? {};
    info.lastBuilt = rec.Built ?? rec.built ?? null;
  } catch { }
  info.hasAtmosphere = await exists(root, "atmosphere/package3");
  info.hasHekate = await exists(root, "bootloader/sys/nyx.bin");
  info.hasEmummc = await dirExists(root, "emuMMC");
  info.usedInConsole = await dirExists(root, "Nintendo");
  for await (const _ of root.keys()) { info.looksLikeRoot = true; break; }
  return info;
}

async function pickCard() {
  try {
    const handle = await window.showDirectoryPicker({ id: "sdcard", mode: "readwrite", startIn: "desktop" });
    if ((await handle.requestPermission({ mode: "readwrite" })) !== "granted") {
      toast("SwitchSetup needs permission to write to the SD card.");
      return;
    }
    state.card = { handle, name: handle.name || "SD card", info: await inspectCard(handle) };
    renderAll();
  } catch (e) {
    if (e.name !== "AbortError") toast(e.message, 6000);
  }
}

async function collectFiles(dir, prefix, out) {
  for await (const [name, h] of dir.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (h.kind === "file") out.set(path, new Uint8Array(await (await h.getFile()).arrayBuffer()));
    else await collectFiles(h, path, out);
  }
}

/** Kept on clean update: mods/sysmodules, user settings and patches. */
const KEEP_IN_ATMOSPHERE = new Set(["contents", "config", "hosts", "exefs_patches", "kip_patches"]);

/**
 * Clean update (as recommended by switch.hacks.guide): download a backup of atmosphere/
 * and bootloader/, then remove old system files. Keeps atmosphere/contents (mods),
 * bootloader/ini and bootloader/payloads. emuMMC, Nintendo and saves are never touched.
 */
async function cleanCard(root, log) {
  const backup = new Map();
  for (const top of ["atmosphere", "bootloader"]) {
    if (await dirExists(root, top)) await collectFiles(await getDir(root, [top], false), top, backup);
  }
  if (!backup.size) { log("  nothing to clean (fresh card)"); return null; }
  log(`  backing up ${backup.size} files`);
  const name = `switchsetup-backup-${today()}.zip`;
  downloadBlob(await writeZip(backup), name);

  if (await dirExists(root, "atmosphere")) {
    const atmo = await getDir(root, ["atmosphere"], false);
    for await (const n of atmo.keys()) {
      if (!KEEP_IN_ATMOSPHERE.has(n.toLowerCase())) await atmo.removeEntry(n, { recursive: true });
    }
    log("  removed old Atmosphère system files (kept contents, config, hosts and patches)");
  }
  if (await dirExists(root, "bootloader")) {
    const boot = await getDir(root, ["bootloader"], false);
    for (const n of ["sys", "res"]) { try { await boot.removeEntry(n, { recursive: true }); } catch { } }
    log("  removed old Hekate system files (kept ini/ and payloads/)");
  }
  return name;
}

// ---------- build ----------
async function fetchAsset(repo, name, size, onBytes) {
  const r = await fetch(`/api/asset?repo=${encodeURIComponent(repo)}&name=${encodeURIComponent(name)}`);
  if (!r.ok) {
    let msg = `Download of ${name} failed (${r.status})`;
    try { msg = (await r.json()).error || msg; } catch { }
    throw new Error(msg);
  }
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onBytes(value.length);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  if (size && got !== size) throw new Error(`${name} downloaded incompletely. Please try again.`);
  return out;
}

/**
 * Turns the selected packages into the final SD card file list.
 * Later packages overwrite earlier ones, and paths are compared case-insensitively
 * (the SD card is FAT32/exFAT), so the result never contains duplicates.
 */
class FileSet {
  constructor() { this.map = new Map(); }
  /** keep = a user settings file that is only written if the card doesn't have it yet. */
  set(path, data, keep = false) { this.map.set(path.toLowerCase(), { path, data, keep }); }
  get size() { return this.map.size; }
  *[Symbol.iterator]() { for (const { path, data, keep } of this.map.values()) yield [path, data, keep]; }
}

async function buildFiles(packages, log, progress) {
  const total = packages.reduce((s, p) => s + packageSize(p), 0) || 1;
  let done = 0;
  const files = new FileSet();
  const enc = new TextEncoder();
  const record = {};

  for (let i = 0; i < packages.length; i++) {
    const p = packages[i];
    log(`[${i + 1}/${packages.length}] ${p.name}`);
    // Same-name files are always replaced, except settings files the user may have edited.
    const keep = (p.keepExisting ?? []).map((k) => new RegExp(k, "i"));
    const put = (path, data) => {
      path = normalize(path);
      files.set(path, data, keep.some((k) => k.test(path)));
    };
    if (p.repo && p.assets?.length) {
      const rel = state.releases[p.repo];
      if (!rel || rel.error) throw new Error(`${p.name}: ${rel?.error ?? "release information unavailable"}`);
      log(`  version ${rel.tag}`);
      for (const rule of p.assets) {
        const a = matchAsset(rel, rule);
        if (!a) throw new Error(`${p.name} ${rel.tag}: no release file matches '${rule.match}'. The project may have renamed its files.`);
        log(`  downloading ${a.name} (${fmtBytes(a.size)})`);
        const data = await fetchAsset(p.repo, a.name, a.size, (n) => { done += n; progress(0.75 * done / total); });
        if (rule.action === "extract") {
          const prefix = rule.to?.[0] ?? "";
          const ex = rule.exclude ? new RegExp(rule.exclude, "i") : null;
          const strip = rule.strip?.toLowerCase();
          for (const entry of readZip(data)) {
            let name = entry.name.replace(/\\/g, "/");
            if (strip) {
              if (!name.toLowerCase().startsWith(strip)) continue;
              name = name.slice(strip.length);
            }
            if (ex && ex.test(name)) continue;
            put(`${prefix}/${name}`, await entry.read());
          }
        } else if (rule.action === "copy") {
          for (const dest of rule.to ?? [a.name]) put(dest, data);
        } else {
          throw new Error(`Unknown action '${rule.action}' in ${p.id}`);
        }
      }
      record[p.id] = rel.tag;
    } else {
      record[p.id] = "bundled";
    }
    for (const f of p.files ?? []) put(f.path, enc.encode(f.content.replace(/\r\n/g, "\n")));
  }

  // Same record format as the Windows app, so both can read cards made by the other.
  files.set(RECORD_FILE, enc.encode(JSON.stringify({ Built: new Date().toISOString(), Packages: record }, null, 2)));
  const txt = [`Created with SwitchSetup (switchsetup.app) on ${new Date().toLocaleString()}`, "Based on Homebrew SD Setup by noahc3.", "",
    ...packages.map((p) => `${p.name}: ${record[p.id]}`)].join("\n");
  files.set("switchsetup.txt", enc.encode(txt + "\n"));
  return { files, record };
}

function resolveSelected() {
  const want = new Set(state.selected);
  normalizeSelection();
  return state.catalog.packages.filter((p) => want.has(p.id) || p.required);
}

const dlg = $("#buildDlg");
dlg.addEventListener("cancel", (e) => { if (state.building) e.preventDefault(); });

function confirmCard() {
  return new Promise((resolve) => {
    $("#buildRunning").hidden = true;
    const box = $("#buildDone");
    box.hidden = false;
    const clean = $("#clean").checked && !$("#cleanRow").hidden;
    box.innerHTML = `
      <h3>Write to ${esc(state.card.name)}?</h3>
      <p>${state.selected.size} packages will be written. <strong>Files with the same names are replaced</strong> with the new versions.
      ${clean ? "A backup of your old Atmosphère and Hekate files is downloaded first, then they're removed." : ""}</p>
      <p class="muted small">Your games, saves, emuMMC, Nintendo folder and mods in <code>atmosphere/contents</code> are not touched. Keep this tab open until it finishes.</p>
      <div class="dlg-actions">
        <button class="btn btn-quiet" data-a="no">Cancel</button>
        <button class="btn btn-primary" data-a="yes">Write to card</button>
      </div>`;
    dlg.showModal();
    $$("[data-a]", box).forEach((b) => (b.onclick = () => { if (b.dataset.a === "no") dlg.close(); resolve(b.dataset.a === "yes"); }));
    dlg.addEventListener("close", () => resolve(false), { once: true });
  });
}

$("#build").onclick = async () => {
  const t = target();
  const clean = t === "drive" && $("#clean").checked && !$("#cleanRow").hidden;
  if (t === "drive") {
    if (!state.card) return;
    if ((await state.card.handle.queryPermission({ mode: "readwrite" })) !== "granted" &&
        (await state.card.handle.requestPermission({ mode: "readwrite" })) !== "granted") {
      return toast("SwitchSetup needs permission to write to the SD card.");
    }
    if (!(await confirmCard())) return;
  }

  const phases = t === "zip"
    ? ["Downloading", "Building ZIP", "Done"]
    : ["Downloading", ...(clean ? ["Cleaning old files"] : []), "Writing to SD card", "Done"];
  $("#phases").innerHTML = phases.map((p) => `<li>${esc(p)}</li>`).join("");
  const setPhase = (name) => {
    $("#phase").textContent = name === "Done" ? "Done" : `${name}…`;
    const idx = phases.indexOf(name);
    $$("#phases li").forEach((li, i) => (li.className = i < idx || name === "Done" ? "done" : i === idx ? "active" : ""));
  };
  const logEl = $("#log");
  const log = (line) => { logEl.textContent += line + "\n"; logEl.scrollTop = logEl.scrollHeight; };
  const progress = (f) => ($("#bar").style.width = `${Math.round(f * 100)}%`);

  state.building = true;
  renderTotals();
  logEl.textContent = "";
  progress(0);
  $("#buildRunning").hidden = false;
  $("#buildDone").hidden = true;
  if (!dlg.open) dlg.showModal();

  try {
    const packages = resolveSelected();
    // A package without version info (e.g. the list was loaded before it was added): fetch the versions again.
    if (packages.some((p) => p.repo && (!state.releases[p.repo] || state.releases[p.repo].error))) {
      log("Refreshing package versions");
      for (const r of await api("/api/releases")) state.releases[r.repo] = r;
    }
    setPhase("Downloading");
    log(`Downloading ${packages.length} packages`);
    const { files, record } = await buildFiles(packages, log, progress);
    let backupName = null;

    if (t === "zip") {
      setPhase("Building ZIP");
      log(`Building ZIP with ${files.size} files`);
      const blob = await writeZip(files, (f) => progress(0.75 + 0.25 * f));
      if (state.zipUrl) URL.revokeObjectURL(state.zipUrl);
      const name = `SwitchSetup-${today()}.zip`;
      state.zipUrl = downloadBlob(blob, name);
      progress(1);
      setPhase("Done");
      showResult({ ok: true, zip: true, size: blob.size, name, count: packages.length });
    } else {
      const root = state.card.handle;
      if (clean) {
        setPhase("Cleaning old files");
        backupName = await cleanCard(root, log);
      }
      setPhase("Writing to SD card");
      let i = 0;
      let kept = 0;
      for (const [path, data, keep] of files) {
        if (keep && await exists(root, path)) { kept++; continue; } // keep the user's settings
        await writeFile(root, path, data);
        progress(0.75 + 0.25 * (++i / files.size));
      }
      log(`Wrote ${files.size - kept} files${kept ? ` (kept ${kept} existing settings file${kept > 1 ? "s" : ""})` : ""}`);
      state.card.info = await inspectCard(root);
      setPhase("Done");
      showResult({ ok: true, zip: false, backupName, count: packages.length, record });
    }
  } catch (e) {
    log("ERROR: " + e.message);
    showResult({ ok: false, error: e.message });
  } finally {
    state.building = false;
    renderAll();
  }
};

const ICON_OK = `<svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
const ICON_BAD = `<svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>`;
const NEXT_STEPS = `
  <li>Put the card in your Switch and boot Hekate (inject <code>bootloader/update.bin</code> as the RCM payload, or use your modchip).</li>
  <li>Choose <strong>Launch → CFW (emuMMC)</strong>. First time? Follow <a href="https://switch.hacks.guide" target="_blank" rel="noopener">switch.hacks.guide</a> to create an emuMMC first.</li>`;
const SUPPORT_NUDGE = `<div class="support-nudge">Did SwitchSetup save you time? It's free and ad-free, and kept running by donations. <button class="linkbtn" data-support>Support the project ♥</button></div>`;

function showResult(r) {
  $("#buildRunning").hidden = true;
  const box = $("#buildDone");
  box.hidden = false;
  if (!r.ok) {
    box.innerHTML = `
      <div class="result-icon bad">${ICON_BAD}</div>
      <h3>Something went wrong</h3>
      <p>${esc(r.error)}</p>
      <p class="muted small">Check your internet connection and try again. If a package keeps failing, turn it off and build without it.</p>
      <div class="dlg-actions"><button class="btn btn-primary" data-close>Close</button></div>`;
    return;
  }
  if (r.zip) {
    box.innerHTML = `
      <div class="result-icon ok">${ICON_OK}</div>
      <h3>Your ZIP is downloading</h3>
      <p class="muted">${esc(r.name)} · ${fmtBytes(r.size)} · ${r.count} packages</p>
      <ol class="next">
        <li>Extract <strong>everything inside the ZIP</strong> to the root of your SD card. If asked, choose <strong>Replace the files in the destination</strong>.</li>
        ${NEXT_STEPS}
      </ol>
      <div class="dlg-actions">
        <button class="btn btn-quiet" data-close>Close</button>
        <a class="btn btn-primary" href="${state.zipUrl}" download="${esc(r.name)}">Download again</a>
      </div>${SUPPORT_NUDGE}`;
  } else {
    box.innerHTML = `
      <div class="result-icon ok">${ICON_OK}</div>
      <h3>Your SD card is ready</h3>
      <p class="muted">${r.count} packages written to ${esc(state.card.name)}.</p>
      ${r.backupName ? `<p class="small">A backup of your old files was downloaded as <code>${esc(r.backupName)}</code>. Keep it until you're sure everything works.</p>` : ""}
      <ol class="next">
        <li>Safely eject the SD card (in File Explorer, right-click it → <strong>Eject</strong>).</li>
        ${NEXT_STEPS}
      </ol>
      <div class="dlg-actions"><button class="btn btn-primary" data-close>Done</button></div>${SUPPORT_NUDGE}`;
  }
}

// ---------- dialogs ----------
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) e.target.closest("dialog")?.close();
  if (e.target.closest("[data-support]")) { e.target.closest("dialog")?.close(); openSupport(); }
});
function openSupport() {
  const sup = state.catalog?.support;
  $("#supportMsg").textContent = sup?.message ?? "";
  $("#supportLinks").innerHTML = (sup?.links ?? []).filter((l) => l.url).map((l) => `
    <a class="support-link" href="${esc(l.url)}" target="_blank" rel="noopener">
      <span><strong>${esc(l.name)}</strong><small>${esc(l.description)}</small></span><span class="go">Donate →</span></a>`).join("");
  $("#supportDlg").showModal();
}
$("#supportToCredits").onclick = () => { $("#supportDlg").close(); $("#openCredits").click(); };
$("#openCredits").onclick = () => {
  $("#creditList").innerHTML = (state.catalog?.packages ?? [])
    .map((p) => `<li><strong>${esc(p.name)}</strong>: ${p.repo ? `<a href="https://github.com/${esc(p.repo)}" target="_blank" rel="noopener">${esc(p.authors)}</a>` : esc(p.authors)}</li>`).join("");
  $("#creditsDlg").showModal();
};

// ---------- save / load ----------
$("#export").onclick = () => {
  downloadBlob(new Blob([JSON.stringify({ switchsetup: 1, packages: [...state.selected] }, null, 2)], { type: "application/json" }), "my-switchsetup.json");
};
$("#import").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.packages)) throw new Error("this isn't a saved selection");
    state.selected = new Set(data.packages);
    state.preset = null;
    normalizeSelection();
    save();
    renderAll();
    toast(`Loaded ${state.selected.size} packages from ${file.name}.`);
  } catch (err) {
    toast("Could not load that file: " + err.message, 6000);
  }
  e.target.value = "";
};

// Local development only: expose internals for automated tests.
if (["127.0.0.1", "localhost"].includes(location.hostname)) {
  window.__switchsetup = { state, writeFile, cleanCard, inspectCard, buildFiles, renderAll };
}

// ---------- startup ----------
async function loadReleases(manual) {
  state.releases = {};
  renderAll();
  try {
    const list = await api("/api/releases");
    for (const r of list) state.releases[r.repo] = r;
    const failed = list.find((r) => r.error);
    if (failed) toast(failed.error, 7000);
    else if (manual) toast("All packages are at their latest versions.");
  } catch (e) {
    toast("Could not load package versions: " + e.message, 7000);
  }
  renderAll();
}

$("#search").oninput = (e) => { state.query = e.target.value; renderPackages(); };
$("#refresh").onclick = () => loadReleases(true);
$$("input[name=target]").forEach((r) => (r.onchange = renderAll));

(async function init() {
  try {
    state.catalog = await api("/api/catalog");
  } catch (e) {
    $("#packages").innerHTML = `<div class="empty">SwitchSetup couldn't load the package list: ${esc(e.message)}. Please refresh the page.</div>`;
    return;
  }
  const saved = load();
  if (saved?.packages) {
    state.selected = new Set(saved.packages);
    state.preset = saved.preset ?? null;
    normalizeSelection();
  } else {
    const first = state.catalog.presets[0];
    state.selected = new Set(first.packages);
    state.preset = first.id;
    normalizeSelection();
  }
  renderAll();
  loadReleases(false);
})();
