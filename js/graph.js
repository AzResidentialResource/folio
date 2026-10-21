// OneDrive access through Microsoft Graph. Every content write sends If-Match with the
// eTag we last saw, so a newer version saved from another device is never overwritten
// (Graph answers 412 instead).
import { getToken } from "./auth.js";
import { DEMO } from "./config.js";

const G = "https://graph.microsoft.com/v1.0";
const SEL = "id,name,eTag,folder,file,lastModifiedDateTime,parentReference,size";

export class GraphError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `OneDrive error ${status}`);
    this.status = status;
  }
}
export class Offline extends Error {}

const enc = (p) => p.split("/").filter(Boolean).map(encodeURIComponent).join("/");

async function call(method, url, { body, headers = {}, raw = false } = {}) {
  const token = await getToken();
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url.startsWith("http") ? url : G + url, {
        method,
        body,
        cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, ...headers },
      });
    } catch {
      throw new Offline("No connection");
    }
    if ((res.status === 429 || res.status === 503) && attempt < 2) {
      const wait = Number(res.headers.get("Retry-After")) || 2;
      await new Promise((r) => setTimeout(r, Math.min(wait, 10) * 1000));
      continue;
    }
    if (!res.ok) {
      let b = null;
      try { b = await res.json(); } catch {}
      throw new GraphError(res.status, b);
    }
    if (raw) return res;
    return res.status === 204 ? null : res.json();
  }
}

const stripBom = (t) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
const json = (o) => ({ body: JSON.stringify(o), headers: { "Content-Type": "application/json" } });
const textBody = (t) => ({ body: t, headers: { "Content-Type": "text/plain; charset=utf-8" } });

const real = {
  itemByPath: (path) => call("GET", `/me/drive/root:/${enc(path)}?$select=${SEL}`),
  getItem: (id) => call("GET", `/me/drive/items/${id}?$select=${SEL}`),

  async children(id) {
    const out = [];
    let url = `/me/drive/items/${id}/children?$select=${SEL}&$top=999`;
    while (url) {
      const r = await call("GET", url);
      out.push(...r.value);
      url = r["@odata.nextLink"];
    }
    return out;
  },

  async childByName(parentId, name) {
    try { return await call("GET", `/me/drive/items/${parentId}:/${enc(name)}?$select=${SEL}`); }
    catch (e) { if (e.status === 404) return null; throw e; }
  },

  // Reads text plus the eTag that matches it (re-reads if the file changed mid-read).
  async readText(id) {
    for (let i = 0; i < 3; i++) {
      const before = await real.getItem(id);
      const res = await call("GET", `/me/drive/items/${id}/content`, { raw: true });
      const text = stripBom(await res.text());
      const after = await real.getItem(id);
      if (after.eTag === before.eTag) return { text, item: after };
    }
    throw new GraphError(409, { error: { message: "File kept changing while reading" } });
  },

  writeText: (id, text, eTag) =>
    call("PUT", `/me/drive/items/${id}/content`, {
      body: text,
      headers: { "Content-Type": "text/plain; charset=utf-8", ...(eTag ? { "If-Match": eTag } : {}) },
    }),

  createText: (parentId, name, text) =>
    call("PUT", `/me/drive/items/${parentId}:/${enc(name)}:/content?@microsoft.graph.conflictBehavior=fail`, textBody(text)),

  createFolder: (parentId, name) =>
    call("POST", `/me/drive/items/${parentId}/children`, json({ name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" })),

  rename: (id, name) => call("PATCH", `/me/drive/items/${id}`, json({ name })),
  move: (id, parentId) => call("PATCH", `/me/drive/items/${id}`, json({ parentReference: { id: parentId } })),
  remove: (id) => call("DELETE", `/me/drive/items/${id}`), // goes to the OneDrive recycle bin
};

// ---- Demo backend: a fake drive kept in this browser only (open the app with ?demo) ----
const DKEY = "folio-demo-drive";
function dload() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(DKEY)); } catch {}
  if (!d) {
    d = { n: 10, items: { root: { id: "root", name: "root", folder: {} } } };
    const mk = (id, name, parentId, text) => {
      d.items[id] = { id, name, parentId, eTag: `"${id}-1"`, lastModifiedDateTime: new Date().toISOString(), ...(text == null ? { folder: {} } : { file: {}, text }) };
    };
    mk("cw", "Claude Work", "root"); mk("bss", "Bible Study Series", "cw"); mk("book", "book", "bss");
    mk("drafts", "drafts", "book"); mk("bs", "bible-study", "bss");
    mk("s1", "thesis-working.md", "drafts", "# Thesis\n\nForgiveness, not forgetting, is what *actually* resolves the wound.\n");
    mk("g1", "Part One", "drafts");
    mk("s2", "01 The Wound We Carry.md", "g1", "# The Wound We Carry\n\nSome words here.\n\n> A quote with **bold** text.\n");
    mk("s3", "02 What the Bible Says.md", "g1", "## Survey\n\n- Gen 45\n- Matt 18:21-35\n");
    localStorage.setItem(DKEY, JSON.stringify(d));
  }
  return d;
}
const dsave = (d) => localStorage.setItem(DKEY, JSON.stringify(d));
const dpub = (it) => ({ id: it.id, name: it.name, eTag: it.eTag, folder: it.folder, file: it.file, lastModifiedDateTime: it.lastModifiedDateTime, parentReference: { id: it.parentId } });
const dget = (d, id) => { const it = d.items[id]; if (!it) throw new GraphError(404); return it; };
const dbump = (it) => { const n = Number(it.eTag.match(/-(\d+)"/)?.[1] || 1) + 1; it.eTag = `"${it.id}-${n}"`; it.lastModifiedDateTime = new Date().toISOString(); };
const dkids = (d, pid) => Object.values(d.items).filter((x) => x.parentId === pid);
const dslow = () => new Promise((r) => setTimeout(r, 120));
function dnew(d, parentId, name, extra) {
  if (dkids(d, parentId).some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new GraphError(409);
  const id = "d" + d.n++;
  d.items[id] = { id, name, parentId, eTag: `"${id}-1"`, lastModifiedDateTime: new Date().toISOString(), ...extra };
  dsave(d);
  return dpub(d.items[id]);
}

const demo = {
  async itemByPath(path) {
    await dslow(); const d = dload();
    let cur = d.items.root;
    for (const part of path.split("/").filter(Boolean)) {
      cur = dkids(d, cur.id).find((x) => x.name === part);
      if (!cur) throw new GraphError(404);
    }
    return dpub(cur);
  },
  async getItem(id) { await dslow(); return dpub(dget(dload(), id)); },
  async children(id) { await dslow(); const d = dload(); dget(d, id); return dkids(d, id).map(dpub); },
  async childByName(pid, name) { const d = dload(); const it = dkids(d, pid).find((x) => x.name === name); return it ? dpub(it) : null; },
  async readText(id) { await dslow(); const it = dget(dload(), id); return { text: it.text, item: dpub(it) }; },
  async writeText(id, text, eTag) {
    await dslow(); const d = dload(); const it = dget(d, id);
    if (eTag && eTag !== it.eTag) throw new GraphError(412);
    it.text = text; dbump(it); dsave(d); return dpub(it);
  },
  async createText(pid, name, text) { await dslow(); return dnew(dload(), pid, name, { file: {}, text }); },
  async createFolder(pid, name) { await dslow(); return dnew(dload(), pid, name, { folder: {} }); },
  async rename(id, name) {
    await dslow(); const d = dload(); const it = dget(d, id);
    if (dkids(d, it.parentId).some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) throw new GraphError(409);
    it.name = name; dbump(it); dsave(d); return dpub(it);
  },
  async move(id, pid) {
    await dslow(); const d = dload(); const it = dget(d, id);
    if (dkids(d, pid).some((x) => x.name.toLowerCase() === it.name.toLowerCase())) throw new GraphError(409);
    it.parentId = pid; dbump(it); dsave(d); return dpub(it);
  },
  async remove(id) {
    await dslow(); const d = dload();
    const kill = (i) => { dkids(d, i).forEach((k) => kill(k.id)); delete d.items[i]; };
    kill(id); dsave(d); return null;
  },
};

// Demo helper: simulate an edit from "another device" (used from the browser console).
if (DEMO) window.demoRemoteEdit = (id, text) => { const d = dload(); const it = d.items[id]; it.text = text; dbump(it); dsave(d); };

export const drive = DEMO ? demo : real;
