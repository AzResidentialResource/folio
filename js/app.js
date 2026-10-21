import { CONFIG, DEMO } from "./config.js";
import { initAuth, login, logout, reauth, AuthNeeded } from "./auth.js";
import { drive, Offline } from "./graph.js";
import { sheets } from "./store.js";
import * as lib from "./library.js";
import { createTree } from "./tree.js";
import { createEditor, countText } from "./editor.js";

const $ = (s) => document.querySelector(s);
const body = document.body;

// ---------- preferences (per device) ----------
const PREF_KEY = "folio-prefs";
const prefs = Object.assign(
  { theme: "auto", font: "serif", size: 19, width: "medium", typewriter: false, focus: false, expanded: [], lastSheet: null, libHidden: false },
  (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } })()
);
const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {} };
const expanded = new Set(prefs.expanded);

function applyPrefs() {
  const root = document.documentElement;
  if (prefs.theme === "auto") root.removeAttribute("data-theme");
  else root.dataset.theme = prefs.theme;
  root.dataset.font = prefs.font;
  root.dataset.width = prefs.width;
  root.style.setProperty("--size", prefs.size + "px");
  ed?.setTypewriter(prefs.typewriter);
  ed?.setFocus(prefs.focus);
  body.classList.toggle("lib-hidden", prefs.libHidden);
  for (const b of document.querySelectorAll("[data-pref]")) {
    const [k, v] = b.dataset.pref.split(":");
    b.setAttribute("aria-pressed", v === undefined ? String(!!prefs[k]) : String(String(prefs[k]) === v));
  }
}

// ---------- ui helpers ----------
let toastTimer = 0;
function toast(msg, ms = 3500) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}
function setStatus(kind, text) {
  const s = $("#status");
  s.dataset.kind = kind;
  s.textContent = text ?? { saved: "Saved", saving: "Saving…", edited: "Edited", offline: "Offline · kept on this device", auth: "Sign in again to sync", error: "Not synced yet", loading: "Loading…" }[kind] ?? "";
}
const isPhone = () => matchMedia("(max-width: 760px)").matches;
function showLibrary(on) { body.classList.toggle("lib-open", on); }

function explain(e) {
  if (e instanceof AuthNeeded) { $("#authbar").hidden = false; return "Sign in again to sync."; }
  if (e instanceof Offline) return "No connection. Your text is kept on this device.";
  return e?.message || String(e);
}

// ---------- editor ----------
let ed = null;
let current = null; // { node, rec }
const recs = new Map(); // id -> in-memory sheet record (single object per sheet)
let openToken = 0;
let leaving = false; // set when redirecting to Microsoft sign-in

const fromDisk = (raw) => ({ text: raw.replace(/\r\n?/g, "\n"), crlf: /\r\n/.test(raw) });
const toDisk = (text, crlf) => (crlf ? text.replace(/\n/g, "\r\n") : text);

async function getRec(id) {
  if (recs.has(id)) return recs.get(id);
  const r = await sheets.get(id);
  if (r) recs.set(id, r);
  return r || null;
}
function setRec(rec) { recs.set(rec.id, rec); return rec; }

function updateCounts() {
  const c = countText(current?.rec?.text ?? "");
  $("#counts").textContent = current ? `${c.words.toLocaleString()} words · ${c.chars.toLocaleString()} characters` : "";
}

let persistTimer = 0, saveTimer = 0;
function onEdit(text) {
  const rec = current?.rec;
  if (!rec) return;
  rec.text = text;
  rec.dirty = true;
  setStatus("edited");
  updateCounts();
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => persist(rec), 300);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveNow(rec), 1500);
}
function persist(rec) {
  if (rec === current?.rec) rec.sel = ed.view.state.selection.main.head;
  return sheets.put(rec).catch(() => toast("This device's storage is full or blocked; keep the app online while writing."));
}

// ---------- saving & conflicts ----------
const saving = new Map();

function saveNow(rec) {
  if (!rec || rec.conflict) return Promise.resolve();
  if (saving.has(rec.id)) { rec.again = true; return saving.get(rec.id); }
  const p = (async () => {
    do {
      rec.again = false;
      if (!rec.dirty) break;
      const sent = rec.text;
      if (rec === current?.rec) setStatus("saving");
      try {
        const item = await drive.writeText(rec.id, toDisk(sent, rec.crlf), rec.eTag);
        rec.eTag = item.eTag;
        if (rec.text === sent) rec.dirty = false;
        await persist(rec);
      } catch (e) {
        await persist(rec);
        if (e.status === 412) await resolveConflict(rec);
        else if (e.status === 404) await recreateDeleted(rec);
        else {
          if (rec === current?.rec) setStatus(e instanceof Offline ? "offline" : e instanceof AuthNeeded ? "auth" : "error");
          if (!(e instanceof Offline)) explain(e);
          break;
        }
      }
    } while (rec.again);
    if (rec === current?.rec && !rec.dirty) setStatus("saved");
  })().finally(() => saving.delete(rec.id));
  saving.set(rec.id, p);
  return p;
}

async function flushAll() {
  let all = [];
  try { all = await sheets.all(); } catch { return; }
  for (const r of all) if (r.dirty) await saveNow(await getRec(r.id));
}

const stamp = () => {
  const d = new Date();
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
};

async function resolveConflict(rec) {
  const { text: raw, item } = await drive.readText(rec.id);
  const remote = fromDisk(raw);
  if (remote.text === rec.text) {
    rec.eTag = item.eTag;
    rec.dirty = false;
    return persist(rec);
  }
  let choice = "both";
  if (rec === current?.rec) {
    rec.conflict = true;
    choice = await conflictDialog(rec.text, remote.text, item);
    rec.conflict = false;
  }
  if (choice === "mine") {
    rec.eTag = item.eTag;
    rec.again = true;
    return;
  }
  if (choice === "both") {
    const name = `${lib.title({ name: rec.name, kind: "sheet" })} (conflict copy ${stamp()})`;
    const parent = lib.nodes.get(rec.parentId);
    if (parent) await lib.createSheet(parent, name, toDisk(rec.text, rec.crlf));
    else await drive.createText(rec.parentId, lib.cleanName(name) + ".md", toDisk(rec.text, rec.crlf));
    toast(`Both versions kept. Your edits are in "${name}".`, 6000);
    renderTree();
  }
  rec.text = remote.text;
  rec.crlf = remote.crlf;
  rec.eTag = item.eTag;
  rec.dirty = false;
  await persist(rec);
  if (rec === current?.rec) { ed.replace(rec.text); updateCounts(); }
}

function conflictDialog(mine, theirs, item) {
  const dlg = $("#conflict");
  $("#cf-mine").textContent = mine;
  $("#cf-theirs").textContent = theirs;
  $("#cf-when").textContent = item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime).toLocaleString() : "recently";
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue || "both"), { once: true });
  });
}

async function recreateDeleted(rec) {
  const parent = lib.nodes.get(rec.parentId) || lib.roots[0];
  const n = await lib.createSheet(parent, lib.title({ name: rec.name, kind: "sheet" }), toDisk(rec.text, rec.crlf));
  await sheets.del(rec.id);
  recs.delete(rec.id);
  const fresh = setRec({ ...rec, id: n.id, name: n.name, parentId: parent.id, eTag: n.eTag, dirty: false });
  await persist(fresh);
  if (current?.rec === rec) current = { node: n, rec: fresh };
  toast("This sheet had been deleted on another device. Your text was saved as a new sheet.", 6000);
  renderTree();
}

// Pull a newer version saved elsewhere, if this device has no unsaved edits.
async function checkRemote() {
  const rec = current?.rec;
  if (!rec || rec.dirty || rec.conflict || saving.has(rec.id) || !navigator.onLine) return;
  try {
    const item = await drive.getItem(rec.id);
    if (item.eTag === rec.eTag) return;
    if (item.name !== current.node.name) { current.node.name = rec.name = item.name; $("#doc-title").textContent = lib.title(current.node); renderTree(); }
    const { text: raw, item: it2 } = await drive.readText(rec.id);
    if (rec.dirty || rec !== current?.rec) return;
    const remote = fromDisk(raw);
    rec.eTag = it2.eTag;
    rec.crlf = remote.crlf;
    if (remote.text !== rec.text) {
      rec.text = remote.text;
      ed.replace(rec.text);
      updateCounts();
      toast("Updated with changes from another device.");
    }
    await persist(rec);
    setStatus("saved");
  } catch (e) {
    if (e.status === 404) toast("This sheet was deleted or moved on another device.");
    else if (e instanceof AuthNeeded) explain(e);
  }
}

// ---------- opening sheets ----------
async function openSheet(n) {
  if (isPhone()) showLibrary(false);
  if (current?.node.id === n.id) return;
  if (current?.rec) { clearTimeout(saveTimer); await persist(current.rec); saveNow(current.rec); }
  const token = ++openToken;
  let rec = await getRec(n.id);
  current = { node: n, rec };
  prefs.lastSheet = n.id;
  savePrefs();
  $("#doc-title").textContent = lib.title(n);
  body.classList.add("has-doc");
  renderTree();
  if (rec) {
    ed.load(rec.text, { selection: rec.sel });
    ed.setReadOnly(false);
    updateCounts();
    if (rec.dirty) { setStatus("edited"); saveNow(rec); return; }
    setStatus("loading", "Checking for changes…");
  } else {
    ed.load("");
    ed.setReadOnly(true);
    setStatus("loading");
  }
  try {
    const item = await drive.getItem(n.id);
    if (token !== openToken) return;
    if (rec && rec.eTag === item.eTag) { setStatus("saved"); return; }
    const { text: raw, item: it2 } = await drive.readText(n.id);
    if (token !== openToken) return;
    if (rec?.dirty) return; // typed on the cached copy meanwhile; the save will compare versions
    const remote = fromDisk(raw);
    const fresh = setRec({ id: n.id, name: n.name, parentId: n.parentId, text: remote.text, crlf: remote.crlf, eTag: it2.eTag, dirty: false, sel: rec?.sel });
    current.rec = fresh;
    await persist(fresh);
    if (rec) { if (ed.text() !== fresh.text) ed.replace(fresh.text); }
    else ed.load(fresh.text, { selection: 0 });
    ed.setReadOnly(false);
    updateCounts();
    setStatus("saved");
  } catch (e) {
    if (token !== openToken) return;
    if (!rec) {
      ed.load("");
      setStatus("error", e instanceof Offline ? "Not on this device yet. Connect to open it." : explain(e));
    } else {
      setStatus(e instanceof Offline ? "offline" : "error", e instanceof Offline ? "Offline · showing this device's copy" : undefined);
      explain(e);
    }
  }
}

function closeSheet() {
  current = null;
  ed.load("");
  ed.setReadOnly(true);
  $("#doc-title").textContent = "";
  body.classList.remove("has-doc");
  setStatus("", "");
  updateCounts();
}

// ---------- library ----------
let tree = null;
let targetGroup = null;
let filterText = "";

function renderTree() { tree?.render(); }

async function toggleGroup(n) {
  targetGroup = n;
  if (expanded.has(n.id)) expanded.delete(n.id);
  else {
    expanded.add(n.id);
    if (!n.loaded) {
      try { await lib.loadFolder(n); } catch (e) { toast(explain(e)); expanded.delete(n.id); }
    }
  }
  prefs.expanded = [...expanded];
  savePrefs();
  renderTree();
}

async function loadExpanded(n) {
  if (!(n.isRoot || expanded.has(n.id))) return;
  await lib.loadFolder(n);
  for (const c of n.children) if (c.kind === "group") await loadExpanded(c).catch(() => {});
}

let lastLibRefresh = 0;
async function refreshLibrary(force = false) {
  if (!force && Date.now() - lastLibRefresh < 30000) return;
  lastLibRefresh = Date.now();
  try {
    for (const r of lib.roots) await loadExpanded(r);
    renderTree();
  } catch (e) { if (!(e instanceof Offline)) toast(explain(e)); }
}

function groupForNew() {
  if (targetGroup && lib.nodes.has(targetGroup.id)) return targetGroup;
  if (current) return lib.parentOf(current.node) || lib.roots[0];
  return lib.roots[0];
}

async function newSheet(group = groupForNew()) {
  const name = prompt(`New sheet in "${lib.title(group)}". Name:`, "Untitled");
  if (name === null) return;
  try {
    if (!group.loaded) await lib.loadFolder(group);
    const n = await lib.createSheet(group, name || "Untitled");
    expanded.add(group.id);
    prefs.expanded = [...expanded];
    savePrefs();
    await openSheet(n);
    ed.focus();
  } catch (e) { toast(explain(e)); }
}

async function newGroup(parent = groupForNew()) {
  const name = prompt(`New group inside "${lib.title(parent)}". Name:`, "New Group");
  if (name === null) return;
  try {
    if (!parent.loaded) await lib.loadFolder(parent);
    const n = await lib.createGroup(parent, name || "New Group");
    expanded.add(parent.id);
    expanded.add(n.id);
    prefs.expanded = [...expanded];
    savePrefs();
    targetGroup = n;
    renderTree();
  } catch (e) { toast(explain(e)); }
}

// Make sure a sheet has no unsaved text before renaming or moving it, so the eTag stays meaningful.
async function settle(n) {
  const r = recs.get(n.id);
  if (r?.dirty) await saveNow(r);
  if (r?.dirty) throw new Error("Can't do that until this sheet's latest edits are saved.");
  return r;
}
function syncRecAfter(n, r) {
  if (!r) return;
  r.eTag = n.eTag;
  r.name = n.name;
  r.parentId = n.parentId;
  persist(r);
}

async function renameItem(n) {
  const name = prompt("Rename:", lib.title(n));
  if (!name || name === lib.title(n)) return;
  try {
    const r = await settle(n);
    await lib.renameNode(n, name);
    syncRecAfter(n, r);
    if (current?.node.id === n.id) $("#doc-title").textContent = lib.title(n);
    renderTree();
  } catch (e) { toast(explain(e)); }
}

async function deleteItem(n) {
  const what = n.kind === "group" ? `the group "${lib.title(n)}" and everything in it` : `"${lib.title(n)}"`;
  if (!confirm(`Move ${what} to the OneDrive recycle bin?`)) return;
  try {
    await lib.deleteNode(n);
    if (current && (current.node.id === n.id || lib.isInside(current.node, n) || !lib.nodes.has(current.node.id))) closeSheet();
    await sheets.del(n.id).catch(() => {});
    recs.delete(n.id);
    renderTree();
  } catch (e) { toast(explain(e)); }
}

async function dropItem(n, parent, index) {
  try {
    const r = n.kind === "sheet" ? await settle(n) : null;
    await lib.moveNode(n, parent, index);
    syncRecAfter(n, r);
    if (parent.id !== lib.parentOf(n)?.id) expanded.add(parent.id);
    expanded.add(parent.id);
    prefs.expanded = [...expanded];
    savePrefs();
  } catch (e) { toast(explain(e)); }
  renderTree();
}

function openMenu(n, anchor) {
  const m = $("#menu");
  const items = [];
  if (n.kind === "group") items.push(["New sheet here", () => newSheet(n)], ["New group here", () => newGroup(n)]);
  if (!n.isRoot) items.push(["Rename…", () => renameItem(n)], ["Delete…", () => deleteItem(n)]);
  if (n.isRoot) items.push(["Refresh", () => refreshLibrary(true)]);
  m.textContent = "";
  for (const [label, fn] of items) {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => { m.hidePopover(); fn(); };
    m.append(b);
  }
  m.showPopover();
  const r = anchor.getBoundingClientRect();
  const mr = m.getBoundingClientRect();
  m.style.top = Math.min(r.bottom + 4, innerHeight - mr.height - 8) + "px";
  m.style.left = Math.max(8, r.right - mr.width) + "px";
}

// ---------- startup ----------
async function startApp(account) {
  $("#signin").hidden = true;
  $("#app").hidden = false;
  $("#who").textContent = account?.username || "";
  ed = createEditor($("#editor"), { onChange: onEdit });
  ed.setReadOnly(true);
  applyPrefs();

  tree = createTree($("#tree"), {
    isExpanded: (n) => n.isRoot || expanded.has(n.id),
    currentId: () => current?.node.id,
    onOpen: openSheet,
    onToggle: (n) => (n.isRoot ? (targetGroup = n) : toggleGroup(n)),
    onMenu: openMenu,
    onDrop: dropItem,
    filter: (n) => !filterText || n.kind === "group" || lib.title(n).toLowerCase().includes(filterText),
  });

  try {
    await lib.loadRoots(CONFIG.roots);
    for (const r of lib.roots) await loadExpanded(r).catch((e) => toast(explain(e)));
    lastLibRefresh = Date.now();
  } catch (e) {
    toast(explain(e), 8000);
  }
  renderTree();

  const last = prefs.lastSheet && lib.nodes.get(prefs.lastSheet);
  if (last) await openSheet(last);
  else if (isPhone()) showLibrary(true);
  flushAll();

  // keep in step with the other device
  const wake = () => { if (document.visibilityState === "visible") { checkRemote(); refreshLibrary(); flushAll(); } };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && current?.rec) { persist(current.rec); saveNow(current.rec); }
    wake();
  });
  addEventListener("focus", wake);
  addEventListener("online", () => { toast("Back online. Syncing…"); flushAll().then(checkRemote); });
  addEventListener("offline", () => setStatus("offline"));
  setInterval(() => { if (document.visibilityState === "visible") { checkRemote(); flushAll(); } }, 30000);
  addEventListener("beforeunload", (e) => {
    if (current?.rec) persist(current.rec);
    if (!leaving && [...recs.values()].some((r) => r.dirty) && navigator.onLine) e.preventDefault();
  });
}

function wireStatic() {
  $("#btn-signin").onclick = () => login();
  $("#btn-reauth").onclick = async () => { if (current?.rec) await persist(current.rec); leaving = true; reauth(); };
  $("#btn-lib").onclick = () => {
    if (isPhone()) showLibrary(!body.classList.contains("lib-open"));
    else { prefs.libHidden = !prefs.libHidden; savePrefs(); applyPrefs(); }
  };
  $("#btn-new").onclick = () => newSheet();
  $("#btn-closelib").onclick = () => showLibrary(false);
  $("#btn-newgroup").onclick = () => newGroup();
  $("#btn-signout").onclick = () => { if (confirm("Sign out on this device?")) logout(); };
  $("#filter").oninput = (e) => { filterText = e.target.value.trim().toLowerCase(); renderTree(); };
  $("#btn-settings").onclick = () => $("#settings").togglePopover();
  for (const b of document.querySelectorAll("[data-pref]")) {
    b.onclick = () => {
      const [k, v] = b.dataset.pref.split(":");
      prefs[k] = v === undefined ? !prefs[k] : v;
      savePrefs();
      applyPrefs();
    };
  }
  $("#size-down").onclick = () => { prefs.size = Math.max(14, prefs.size - 1); savePrefs(); applyPrefs(); };
  $("#size-up").onclick = () => { prefs.size = Math.min(28, prefs.size + 1); savePrefs(); applyPrefs(); };

  // fade the chrome away while typing (desktop)
  addEventListener("keydown", (e) => { if (e.target.closest?.(".cm-content") && !e.ctrlKey && !e.metaKey) body.classList.add("typing"); });
  addEventListener("pointermove", () => body.classList.remove("typing"));

  addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); if (current?.rec) saveNow(current.rec); }
    if (mod && e.key === "\\") { e.preventDefault(); $("#btn-lib").click(); }
  });
}

async function boot() {
  document.title = CONFIG.appName;
  for (const el of document.querySelectorAll(".app-name")) el.textContent = CONFIG.appName;
  applyPrefs();
  wireStatic();
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
  if (!DEMO && CONFIG.clientId.startsWith("PASTE")) {
    $("#signin-msg").textContent = "Setup isn't finished yet: the app registration ID still needs to go in js/config.js.";
    $("#signin").hidden = false;
    return;
  }
  let account = null;
  try { account = await initAuth(); }
  catch (e) { $("#signin-msg").textContent = "Sign-in problem: " + (e?.message || e); }
  if (account) startApp(account);
  else $("#signin").hidden = false;
}

boot();
