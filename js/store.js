// Small IndexedDB wrapper: the on-device copy of sheets and folder listings.
// "sheets": { id, name, parentId, text, eTag, dirty, crlf, updated }
// "kv":     arbitrary cached values (folder listings, root ids)
const DB_NAME = "folio";
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore("sheets", { keyPath: "id" });
        d.createObjectStore("kv");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function run(storeName, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(storeName, mode);
    const r = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(r && "result" in r ? r.result : undefined);
    tx.onerror = () => reject(tx.error);
  });
}

export const sheets = {
  get: (id) => run("sheets", "readonly", (s) => s.get(id)),
  put: (rec) => run("sheets", "readwrite", (s) => s.put({ ...rec, updated: Date.now() })),
  del: (id) => run("sheets", "readwrite", (s) => s.delete(id)),
  all: () => run("sheets", "readonly", (s) => s.getAll()),
};

export const kv = {
  get: (k) => run("kv", "readonly", (s) => s.get(k)),
  put: (k, v) => run("kv", "readwrite", (s) => s.put(v, k)),
};
