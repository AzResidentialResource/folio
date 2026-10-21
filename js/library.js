// Library model: groups are OneDrive folders, sheets are .md files.
// Each folder may hold a sidecar "_writing.json" with the display order (and, from stage 2,
// goals, notes and keywords). Entries are matched by OneDrive item id, falling back to file
// name, so an outside edit that replaces a file still keeps its place.
import { drive } from "./graph.js";
import { kv } from "./store.js";

export const META = "_writing.json";
export const nodes = new Map(); // id -> node
export const roots = [];

const hiddenName = (n) => /^[._~]/.test(n);
const isSheetItem = (it) => it.file && /\.(md|markdown|txt)$/i.test(it.name);
export const emptyMeta = () => ({ version: 1, order: [], group: {}, sheets: {} });
const parseMeta = (t) => {
  try { return { ...emptyMeta(), ...JSON.parse(t) }; } catch { return emptyMeta(); }
};

export const title = (n) => n.label || (n.kind === "sheet" ? n.name.replace(/\.(md|markdown|txt)$/i, "") : n.name);
export const parentOf = (n) => nodes.get(n.parentId) || null;

function upsert(item, parentId) {
  let n = nodes.get(item.id);
  if (!n) {
    n = { id: item.id, kind: item.folder ? "group" : "sheet", children: [], loaded: false };
    nodes.set(item.id, n);
  }
  n.name = item.name;
  n.eTag = item.eTag;
  n.modified = item.lastModifiedDateTime;
  n.parentId = parentId;
  return n;
}

export async function loadRoots(rootConfigs) {
  roots.length = 0;
  for (const r of rootConfigs) {
    const key = "root:" + r.path;
    let item;
    try {
      item = await drive.itemByPath(r.path);
      await kv.put(key, item);
    } catch (e) {
      item = await kv.get(key);
      if (!item) {
        if (e.status === 404) throw new Error(`Folder not found in OneDrive: ${r.path}`);
        throw e;
      }
    }
    const n = upsert(item, null);
    n.label = r.label;
    n.isRoot = true;
    roots.push(n);
  }
}

export async function loadFolder(n) {
  let list, meta, metaItem;
  try {
    list = await drive.children(n.id);
    const mi = list.find((c) => c.name === META);
    if (!mi) {
      meta = emptyMeta();
      metaItem = null;
    } else if (n.metaItem && n.metaItem.eTag === mi.eTag && n.meta) {
      meta = n.meta;
      metaItem = n.metaItem;
    } else {
      const r = await drive.readText(mi.id);
      meta = parseMeta(r.text);
      metaItem = { id: r.item.id, eTag: r.item.eTag };
    }
    await kv.put("folder:" + n.id, { list, meta, metaItem });
    n.stale = false;
  } catch (e) {
    const c = await kv.get("folder:" + n.id);
    if (!c) throw e;
    ({ list, meta, metaItem } = c);
    n.stale = true;
  }
  n.meta = meta;
  n.metaItem = metaItem;
  const kids = list.filter((it) => !hiddenName(it.name) && (it.folder || isSheetItem(it))).map((it) => upsert(it, n.id));
  const keep = new Set(kids.map((k) => k.id));
  for (const old of n.children) if (!keep.has(old.id) && nodes.get(old.id)?.parentId === n.id) nodes.delete(old.id);
  n.children = ordered(kids, meta);
  n.loaded = true;
  return n;
}

function ordered(kids, meta) {
  const byId = new Map(kids.map((k) => [k.id, k]));
  const listedIds = new Set(meta.order.map((o) => o.id));
  const used = new Set();
  const out = [];
  for (const o of meta.order) {
    let k = byId.get(o.id);
    if (!k) k = kids.find((x) => !used.has(x.id) && !listedIds.has(x.id) && x.name === o.name);
    if (k && !used.has(k.id)) { used.add(k.id); out.push(k); }
  }
  const rest = kids
    .filter((k) => !used.has(k.id))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return out.concat(rest);
}

// Read-modify-write of a folder's sidecar, retrying if another device changed it first.
export async function updateMeta(n, mutate) {
  for (let i = 0; i < 4; i++) {
    const data = structuredClone(n.meta || emptyMeta());
    mutate(data);
    const text = JSON.stringify(data, null, 2) + "\n";
    try {
      const item = n.metaItem
        ? await drive.writeText(n.metaItem.id, text, n.metaItem.eTag)
        : await drive.createText(n.id, META, text);
      n.meta = data;
      n.metaItem = { id: item.id, eTag: item.eTag };
      return data;
    } catch (e) {
      if (e.status !== 412 && e.status !== 409) throw e;
      const mi = await drive.childByName(n.id, META);
      if (mi) {
        const r = await drive.readText(mi.id);
        n.meta = parseMeta(r.text);
        n.metaItem = { id: r.item.id, eTag: r.item.eTag };
      } else {
        n.meta = emptyMeta();
        n.metaItem = null;
      }
    }
  }
  throw new Error("Could not save the group's order. Try again.");
}

export function saveOrder(n) {
  const order = n.children.map((c) => ({ id: c.id, name: c.name }));
  return updateMeta(n, (m) => { m.order = order; });
}

// ---- operations ----
const ILLEGAL = /[\\/:*?"<>|#%]/g;
export const cleanName = (s) => s.replace(ILLEGAL, "-").replace(/[. ]+$/, "").trim();

async function createUnique(base, ext, make) {
  for (let i = 1; i < 50; i++) {
    const name = (i === 1 ? base : `${base} ${i}`) + ext;
    try { return await make(name); } catch (e) { if (e.status !== 409) throw e; }
  }
  throw new Error("Could not find a free name");
}

export async function createSheet(group, name = "Untitled", text = "") {
  const item = await createUnique(cleanName(name) || "Untitled", ".md", (nm) => drive.createText(group.id, nm, text));
  const n = upsert(item, group.id);
  group.children.push(n);
  await saveOrder(group);
  return n;
}

export async function createGroup(parent, name = "New Group") {
  const item = await createUnique(cleanName(name) || "New Group", "", (nm) => drive.createFolder(parent.id, nm));
  const n = upsert(item, parent.id);
  n.loaded = true;
  parent.children.push(n);
  await saveOrder(parent);
  return n;
}

export async function renameNode(n, newTitle) {
  const base = cleanName(newTitle);
  if (!base) return n;
  const ext = n.kind === "sheet" ? (n.name.match(/\.(md|markdown|txt)$/i)?.[0] || ".md") : "";
  try {
    const item = await drive.rename(n.id, base + ext);
    n.name = item.name;
    n.eTag = item.eTag;
  } catch (e) {
    if (e.status === 409) throw new Error(`"${base}" already exists in this group.`);
    throw e;
  }
  const p = parentOf(n);
  if (p) await saveOrder(p);
  return n;
}

export async function deleteNode(n) {
  await drive.remove(n.id);
  const p = parentOf(n);
  if (p) {
    p.children = p.children.filter((c) => c.id !== n.id);
    await saveOrder(p);
  }
  nodes.delete(n.id);
}

export const isInside = (n, ancestor) => {
  for (let p = n; p; p = parentOf(p)) if (p.id === ancestor.id) return true;
  return false;
};

export async function moveNode(n, target, index) {
  const from = parentOf(n);
  if (!from || n.isRoot) return;
  if (target.id === from.id) {
    const i = from.children.indexOf(n);
    from.children.splice(i, 1);
    if (index > i) index--;
    from.children.splice(index, 0, n);
    await saveOrder(from);
    return;
  }
  if (n.kind === "group" && isInside(target, n)) throw new Error("A group can't go inside itself.");
  if (!target.loaded) await loadFolder(target);
  try {
    const item = await drive.move(n.id, target.id);
    n.eTag = item.eTag;
  } catch (e) {
    if (e.status === 409) throw new Error(`"${title(n)}" already exists in "${title(target)}".`);
    throw e;
  }
  from.children = from.children.filter((c) => c.id !== n.id);
  n.parentId = target.id;
  target.children.splice(Math.min(index, target.children.length), 0, n);
  const carried = from.meta?.sheets?.[n.id];
  await saveOrder(from);
  if (carried) {
    await updateMeta(from, (m) => { delete m.sheets[n.id]; });
    await updateMeta(target, (m) => { m.sheets[n.id] = carried; });
  }
  await saveOrder(target);
}
