// SwitchSetup. Based on Homebrew SD Setup by noahc3 (MPL-2.0).
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const STORE_KEY = "switchsetup.state.v2";

const state = {
  catalog: null,
  versions: {},
  selected: new Set(),
  preset: null,
  query: "",
  category: "all",
  drives: [],
  drive: null,
  building: false,
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
async function api(path, opts) {
  const r = await fetch(path, opts);
  const isJson = r.headers.get("content-type")?.includes("json");
  const body = isJson ? await r.json() : await r.text();
  if (!r.ok) throw new Error(body?.error || body || r.statusText);
  return body;
}
function toast(text, ms = 4000) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}
const store = {
  load() { try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch { return null; } },
  save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ preset: state.preset, packages: [...state.selected], target: target() }));
    } catch { }
  },
};
const pkg = (id) => state.catalog.packages.find((p) => p.id === id);
const target = () => $("input[name=target]:checked").value;
const currentDrive = () => state.drives.find((d) => d.root === state.drive) ?? null;

/** Version installed on the selected card for a package, if the card was built by SwitchSetup. */
function installedVersion(id) {
  if (target() !== "drive") return null;
  return currentDrive()?.card?.installed?.[id] ?? null;
}
function hasUpdate(id) {
  const inst = installedVersion(id);
  const latest = state.versions[id]?.version;
  return !!(inst && latest && inst !== latest && inst !== "bundled");
}

// ---------- selection ----------
function normalize() {
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
  const p = state.catalog.presets.find((x) => x.id === id);
  if (id === "card") {
    state.selected = new Set(Object.keys(currentDrive()?.card?.installed ?? {}));
  } else if (p) {
    // "*" means every package except opt-in ones (like sys-patch), which the user must turn on themselves.
    state.selected = new Set(p.packages.includes("*") ? state.catalog.packages.filter((x) => !x.optIn).map((x) => x.id) : p.packages);
  }
  state.preset = id;
  normalize();
  store.save();
  renderAll();
}
/** Shows a package's warning and resolves true only if the user explicitly accepts it. */
function askConfirm(p) {
  return new Promise((resolve) => {
    const dlg = $("#confirmDlg");
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
  normalize();
  store.save();
  renderAll();
}

// ---------- render ----------
function renderPresets() {
  const card = currentDrive()?.card;
  const presets = [...state.catalog.presets];
  const cardPreset = target() === "drive" && card && Object.keys(card.installed).length
    ? [{ id: "card", name: "Update my card", description: "Exactly what's on this SD card now, at the newest versions.", special: true }]
    : [];
  $("#presets").innerHTML = [...cardPreset, ...presets].map((p) => `
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
  const v = state.versions[p.id];
  if (!p.repo) pills.push(`<span class="pill">Included</span>`);
  else if (!v) pills.push(`<span class="pill"><span class="pulse"></span>Checking</span>`);
  else if (v.error) pills.push(`<span class="pill err" title="${esc(v.error)}">Unavailable</span>`);
  else {
    pills.push(`<span class="pill"><a href="${esc(v.url)}" target="_blank" rel="noopener" title="Release notes">${esc(v.version)}</a></span>`);
    if (v.publishedAt) pills.push(`<span class="pill">${esc(fmtDate(v.publishedAt))}</span>`);
    if (v.size) pills.push(`<span class="pill">${esc(fmtBytes(v.size))}</span>`);
  }
  const inst = installedVersion(p.id);
  if (inst) {
    pills.push(hasUpdate(p.id)
      ? `<span class="pill upd">Update: ${esc(inst)} → ${esc(v.version)}</span>`
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
  const d = currentDrive();
  $("#cleanRow").hidden = !(d && (d.card.hasAtmosphere || d.card.hasHekate));

  if (!d) {
    box.innerHTML = `
      <div class="card-row">
        <div class="card-icon">${SD_ICON}</div>
        <div><div class="card-name"><span class="pulse"></span>Waiting for your SD card</div>
        <div class="card-sub">Insert it into your PC (card slot or USB reader). It will appear here automatically.</div></div>
      </div>`;
    return;
  }

  const usedPct = Math.round(100 * (1 - d.freeGb / d.totalGb));
  const select = state.drives.length > 1
    ? `<select id="drivePick">${state.drives.map((x) => `<option value="${esc(x.root)}" ${x.root === d.root ? "selected" : ""}>${esc(x.root)} ${esc(x.label || "Removable disk")}</option>`).join("")}</select>`
    : "";

  const notes = [];
  if (d.format === "FAT32") notes.push(`<div class="note ok">FAT32: the recommended format.</div>`);
  else if (d.format === "exFAT") notes.push(`<div class="note warn">exFAT works, but it is more prone to corruption on the Switch. FAT32 is recommended.</div>`);
  else notes.push(`<div class="note err">${esc(d.format)} can't be read by the Switch. Format the card as FAT32 first.</div>`);

  const c = d.card;
  const installedCount = Object.keys(c.installed).length;
  if (installedCount) {
    const upd = Object.keys(c.installed).filter(hasUpdate).length;
    notes.push(`<div class="note ${upd ? "warn" : "ok"}">Set up with SwitchSetup on ${esc(fmtDate(c.lastBuilt))}. ${upd ? `<strong>${upd} update${upd > 1 ? "s" : ""} available.</strong>` : "Everything is up to date."}</div>`);
  } else if (c.hasAtmosphere || c.hasHekate) {
    notes.push(`<div class="note warn">This card already has ${c.hasAtmosphere ? "Atmosphère" : "Hekate"} from another tool. Building updates it.</div>`);
  } else if (c.usedInConsole) {
    notes.push(`<div class="note">This card has been used in a Switch. Your games and data are left alone.</div>`);
  }
  if (c.hasEmummc) notes.push(`<div class="note ok">emuMMC found. It won't be touched.</div>`);

  box.innerHTML = `
    <div class="card-row">
      <div class="card-icon">${SD_ICON}</div>
      <div style="flex:1;min-width:0">
        <div class="card-name">${esc(d.label || "SD card")} <span class="muted">(${esc(d.root.replace(/\\$/, ""))})</span></div>
        <div class="card-sub">${esc(d.format)} · ${d.freeGb} GB free of ${d.totalGb} GB</div>
        <div class="meter"><div style="width:${usedPct}%"></div></div>
      </div>
    </div>
    ${select}
    ${notes.join("")}`;
  const pick = $("#drivePick");
  if (pick) pick.onchange = () => { state.drive = pick.value; renderAll(); };
}

function renderTotals() {
  const ids = [...state.selected];
  const size = ids.reduce((s, id) => s + (state.versions[id]?.size || 0), 0);
  $("#totCount").textContent = ids.length;
  $("#totSize").textContent = fmtBytes(size);
  const upd = ids.filter(hasUpdate).length;
  $("#totUpdRow").hidden = !upd;
  $("#totUpd").textContent = upd;

  const t = target();
  $("#drivePane").hidden = t !== "drive";
  $("#zipPane").hidden = t !== "zip";

  const btn = $("#build");
  const d = currentDrive();
  const badFormat = d && d.format !== "FAT32" && d.format !== "exFAT";
  if (t === "zip") {
    btn.textContent = "Build ZIP";
    btn.disabled = state.building;
    $("#buildHint").textContent = "";
  } else {
    btn.textContent = d && Object.keys(d.card.installed).length ? "Update SD card" : "Write to SD card";
    btn.disabled = state.building || !d || badFormat;
    $("#buildHint").textContent = !d ? "Insert an SD card, or switch to ZIP file." : badFormat ? "This card needs to be formatted as FAT32." : "";
  }
}

function renderAll() {
  renderPresets();
  renderChips();
  renderPackages();
  renderCard();
  renderTotals();
}

// ---------- data ----------
async function loadVersions(refresh) {
  state.versions = {};
  renderPackages();
  try {
    const list = await api("/api/versions" + (refresh ? "?refresh=true" : ""));
    for (const v of list) state.versions[v.id] = v;
    const failed = list.find((v) => v.error);
    if (failed) toast(failed.error, 7000);
    else if (refresh) toast("All packages are at their latest versions.");
  } catch (e) {
    toast("Could not reach GitHub: " + e.message, 7000);
  }
  renderAll();
}

async function pollDrives() {
  if (target() === "drive" && !state.building) {
    try {
      const drives = await api("/api/drives");
      const sig = JSON.stringify(drives);
      if (sig !== state.drivesSig) {
        state.drivesSig = sig;
        const hadDrive = !!currentDrive();
        state.drives = drives;
        if (!currentDrive()) state.drive = drives[0]?.root ?? null;
        if (!hadDrive && currentDrive()) toast(`SD card found: ${currentDrive().root}`);
        renderAll();
      }
    } catch { /* app closing */ }
  }
  setTimeout(pollDrives, 2500);
}

// ---------- build ----------
const dlg = $("#buildDlg");
dlg.addEventListener("cancel", (e) => { if (state.building) e.preventDefault(); });

function confirmDrive(d) {
  return new Promise((resolve) => {
    $("#buildRunning").hidden = true;
    const done = $("#buildDone");
    done.hidden = false;
    const clean = $("#clean").checked && !$("#cleanRow").hidden;
    done.innerHTML = `
      <h3>Write to ${esc(d.label || "SD card")} (${esc(d.root.replace(/\\$/, ""))})?</h3>
      <p>${state.selected.size} packages will be written. Files with the same names are replaced.
      ${clean ? "Old Atmosphère and Hekate system files are backed up to your PC and removed first." : ""}</p>
      <p class="muted small">Your games, saves, emuMMC, Nintendo folder and mods in <code>atmosphere/contents</code> are not touched.</p>
      <div class="dlg-actions">
        <button class="btn btn-quiet" data-a="no">Cancel</button>
        <button class="btn btn-primary" data-a="yes">Write to card</button>
      </div>`;
    dlg.showModal();
    $$("[data-a]", done).forEach((b) => (b.onclick = () => { if (b.dataset.a === "no") dlg.close(); resolve(b.dataset.a === "yes"); }));
    dlg.addEventListener("close", () => resolve(false), { once: true });
  });
}

function phaseList(t, clean) {
  return t === "zip"
    ? ["Downloading", "Building ZIP", "Compressing", "Done"]
    : ["Downloading", ...(clean ? ["Cleaning old files"] : []), "Writing to SD card", "Done"];
}

$("#build").onclick = async () => {
  const t = target();
  const d = currentDrive();
  const clean = t === "drive" && $("#clean").checked && !$("#cleanRow").hidden;
  if (t === "drive" && !(await confirmDrive(d))) return;

  state.building = true;
  renderTotals();
  $("#buildRunning").hidden = false;
  $("#buildDone").hidden = true;
  $("#bar").style.width = "0";
  $("#log").textContent = "";
  const phases = phaseList(t, clean);
  $("#phases").innerHTML = phases.map((p) => `<li data-p="${esc(p)}">${esc(p)}</li>`).join("");
  if (!dlg.open) dlg.showModal();

  let job;
  try {
    const { id } = await api("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ packages: [...state.selected], target: t, drive: t === "drive" ? d.root : null, cleanUpdate: clean }),
    });
    do {
      await new Promise((r) => setTimeout(r, 400));
      job = await api(`/api/jobs/${id}`);
      $("#phase").textContent = job.status === "running" ? `${job.phase}…` : job.phase;
      $("#bar").style.width = `${Math.round(job.progress * 100)}%`;
      const idx = phases.indexOf(job.phase);
      $$("#phases li").forEach((li, i) => {
        li.className = i < idx || job.status === "done" ? "done" : i === idx ? "active" : "";
      });
      const log = $("#log");
      log.textContent = job.log.join("\n");
      log.scrollTop = log.scrollHeight;
    } while (job.status === "running");
  } catch (e) {
    job = { status: "error", error: e.message };
  }
  state.building = false;
  showResult(job, d);
  renderTotals();
  state.drivesSig = ""; // force a fresh card read so "On card" badges update
};

const ICON_OK = `<svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
const ICON_BAD = `<svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>`;

function showResult(job, d) {
  $("#buildRunning").hidden = true;
  const box = $("#buildDone");
  box.hidden = false;
  if (job.status !== "done") {
    box.innerHTML = `
      <div class="result-icon bad">${ICON_BAD}</div>
      <h3>Something went wrong</h3>
      <p>${esc(job.error)}</p>
      <p class="muted small">If a package keeps failing, its project may have renamed its release files. Try "Check for updates", or turn that package off.</p>
      <div class="dlg-actions">
        ${job.backupPath ? `<button class="btn btn-quiet" id="openBackup">Open backups folder</button>` : ""}
        <button class="btn btn-primary" data-close>Close</button>
      </div>`;
  } else if (job.target === "zip") {
    box.innerHTML = `
      <div class="result-icon ok">${ICON_OK}</div>
      <h3>Your ZIP is ready</h3>
      <p class="muted">${fmtBytes(job.bytes)} · ${job.installed.length} packages</p>
      <ol class="next">
        <li>Extract <strong>everything inside the ZIP</strong> to the root of your SD card. Choose "Replace" if asked.</li>
        <li>Put the card in your Switch and boot Hekate (inject <code>bootloader/update.bin</code> as the RCM payload, or use your modchip).</li>
        <li>Choose <strong>Launch → CFW (emuMMC)</strong>. First time? Follow <a href="https://switch.hacks.guide" target="_blank" rel="noopener">switch.hacks.guide</a> to create an emuMMC first.</li>
      </ol>
      <div class="dlg-actions">
        <button class="btn btn-quiet" data-close>Close</button>
        <a class="btn btn-primary" href="/api/jobs/${esc(job.id)}/download">Download ZIP</a>
      </div>${SUPPORT_NUDGE}`;
    location.href = `/api/jobs/${job.id}/download`;
  } else {
    box.innerHTML = `
      <div class="result-icon ok">${ICON_OK}</div>
      <h3>Your SD card is ready</h3>
      <p class="muted">${job.installed.length} packages written to ${esc(d.root.replace(/\\$/, ""))}.</p>
      ${job.backupPath ? `<p class="small">Your old files were backed up to <code>${esc(job.backupPath)}</code>.</p>` : ""}
      <ol class="next">
        <li>Eject the card, then put it in your Switch.</li>
        <li>Boot Hekate (inject <code>bootloader/update.bin</code> as the RCM payload, or use your modchip).</li>
        <li>Choose <strong>Launch → CFW (emuMMC)</strong>. First time? Follow <a href="https://switch.hacks.guide" target="_blank" rel="noopener">switch.hacks.guide</a> to create an emuMMC first.</li>
      </ol>
      <div class="dlg-actions">
        ${job.backupPath ? `<button class="btn btn-quiet" id="openBackup">Open backups folder</button>` : ""}
        <button class="btn btn-quiet" data-close>Close</button>
        <button class="btn btn-primary" id="eject">Eject SD card</button>
      </div>${SUPPORT_NUDGE}`;
    const ej = $("#eject");
    ej.onclick = async () => {
      ej.disabled = true;
      ej.textContent = "Ejecting…";
      try {
        await api("/api/drives/eject", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ drive: d.root }) });
        ej.textContent = "Safe to remove";
        toast("You can now remove the SD card.");
      } catch (e) {
        ej.disabled = false;
        ej.textContent = "Eject SD card";
        toast(e.message, 6000);
      }
    };
  }
  const ob = $("#openBackup");
  if (ob) ob.onclick = () => api("/api/backups/open", { method: "POST" });
}

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) e.target.closest("dialog")?.close();
});

// ---------- save / load ----------
$("#export").onclick = () => {
  const blob = new Blob([JSON.stringify({ switchsetup: 1, packages: [...state.selected] }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "my-switchsetup.json";
  a.click();
  URL.revokeObjectURL(a.href);
};
$("#import").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.packages)) throw new Error("this isn't a saved selection");
    state.selected = new Set(data.packages);
    state.preset = null;
    normalize();
    store.save();
    renderAll();
    toast(`Loaded ${state.selected.size} packages from ${file.name}.`);
  } catch (err) {
    toast("Could not load that file: " + err.message, 6000);
  }
  e.target.value = "";
};

// ---------- support ----------
function openSupport() {
  const sup = state.catalog.support;
  $("#supportMsg").textContent = sup?.message ?? "";
  $("#supportLinks").innerHTML = (sup?.links ?? []).map((l) => l.url
    ? `<a class="support-link" href="${esc(l.url)}" target="_blank" rel="noopener">
         <span><strong>${esc(l.name)}</strong><small>${esc(l.description)}</small></span><span class="go">Donate →</span></a>`
    : `<div class="support-link soon"><span><strong>${esc(l.name)}</strong><small>${esc(l.description)}</small></span><span class="go">Coming soon</span></div>`
  ).join("");
  $("#supportDlg").showModal();
}
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-support]")) { e.target.closest("dialog")?.close(); openSupport(); }
});
$("#supportToCredits").onclick = () => { $("#supportDlg").close(); $("#openCredits").click(); };
const SUPPORT_NUDGE = `<div class="support-nudge">Did SwitchSetup save you time? It's free and ad-free, and kept running by donations. <button class="linkbtn" data-support>Support the project ♥</button></div>`;

// ---------- credits ----------
$("#openCredits").onclick = () => {
  $("#creditList").innerHTML = state.catalog.packages
    .map((p) => `<li><strong>${esc(p.name)}</strong>: ${p.repo ? `<a href="https://github.com/${esc(p.repo)}" target="_blank" rel="noopener">${esc(p.authors)}</a>` : esc(p.authors)}</li>`)
    .join("");
  $("#creditsDlg").showModal();
};

// ---------- wiring ----------
$("#search").oninput = (e) => { state.query = e.target.value; renderPackages(); };
$("#refresh").onclick = () => loadVersions(true);
$$("input[name=target]").forEach((r) => (r.onchange = () => { store.save(); renderAll(); }));

(async function init() {
  try {
    state.catalog = await api("/api/catalog");
  } catch (e) {
    $("main").innerHTML = `<div class="panel"><h2>SwitchSetup couldn't start</h2><p>${esc(e.message)}</p></div>`;
    return;
  }
  api("/api/info").then((i) => ($("#appver").textContent = "v" + i.version)).catch(() => { });

  const saved = store.load();
  if (saved?.target) {
    const r = $(`input[name=target][value="${saved.target}"]`);
    if (r) r.checked = true;
  }
  if (saved?.packages) {
    state.selected = new Set(saved.packages);
    state.preset = saved.preset ?? null;
    normalize();
    renderAll();
  } else {
    applyPreset(state.catalog.presets[0].id);
  }
  loadVersions(false);
  pollDrives();
})();
