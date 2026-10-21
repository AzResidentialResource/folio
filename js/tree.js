// Library sidebar: renders groups and sheets, and handles drag to reorder or move.
// Drag works with a mouse anywhere on a row, and with a finger on the ≡ handle.
import { roots, nodes, title, parentOf, isInside } from "./library.js";

export function createTree(el, { isExpanded, currentId, onOpen, onToggle, onMenu, onDrop, filter }) {
  const line = document.createElement("div");
  line.className = "drop-line";

  function render() {
    el.textContent = "";
    for (const r of roots) el.append(...rowsFor(r, 0));
    el.append(line);
    line.hidden = true;
  }

  function rowsFor(n, depth) {
    const out = [];
    const visible = !filter || filter(n);
    if (visible) {
      const row = document.createElement("div");
      row.className = `row ${n.kind}${n.isRoot ? " root" : ""}${n.id === currentId() ? " current" : ""}${n.stale ? " stale" : ""}`;
      row.dataset.id = n.id;
      row.style.setProperty("--depth", depth);
      row.setAttribute("role", "treeitem");
      const open = n.kind === "group" && isExpanded(n);
      if (n.kind === "group") row.setAttribute("aria-expanded", open);
      row.innerHTML = `
        ${n.isRoot ? "" : `<span class="handle" aria-hidden="true">≡</span>`}
        <span class="twisty" aria-hidden="true">${n.kind === "group" ? (open ? "▾" : "▸") : ""}</span>
        <span class="icon" aria-hidden="true">${n.kind === "group" ? "" : "¶"}</span>
        <span class="name"></span>
        <button class="more" title="More" aria-label="More actions">⋯</button>`;
      row.querySelector(".name").textContent = title(n);
      out.push(row);
      if (open) for (const c of n.children) out.push(...rowsFor(c, depth + 1));
    }
    return out;
  }

  // ---- clicks ----
  let justDragged = false;
  el.addEventListener("click", (e) => {
    if (justDragged) { justDragged = false; return; }
    const row = e.target.closest(".row");
    if (!row) return;
    const n = nodes.get(row.dataset.id);
    if (e.target.closest(".more")) return onMenu(n, e.target.closest(".more"));
    if (n.kind === "group") onToggle(n);
    else onOpen(n);
  });

  // ---- drag ----
  let drag = null;

  el.addEventListener("pointerdown", (e) => {
    const row = e.target.closest(".row");
    if (!row || row.classList.contains("root") || e.target.closest(".more") || e.button > 0) return;
    const onHandle = !!e.target.closest(".handle");
    if (e.pointerType !== "mouse" && !onHandle) return; // fingers scroll unless on the handle
    drag = { id: row.dataset.id, x: e.clientX, y: e.clientY, active: false, pointerId: e.pointerId, row, immediate: onHandle };
  });

  el.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      if (!drag.immediate && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
      drag.active = true;
      drag.row.classList.add("dragging");
      el.classList.add("is-dragging");
      try { el.setPointerCapture(e.pointerId); } catch {}
    }
    e.preventDefault();
    drag.target = targetAt(e.clientX, e.clientY);
    showTarget(drag.target);
    autoscroll(e.clientY);
  });

  const end = async (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    clearTimeout(scrollTimer);
    el.classList.remove("is-dragging");
    d.row.classList.remove("dragging");
    showTarget(null);
    if (!d.active) return;
    justDragged = true;
    setTimeout(() => (justDragged = false), 50);
    if (e.type === "pointercancel" || !d.target) return;
    const n = nodes.get(d.id);
    const { node: t, where } = d.target;
    let parent, index;
    if (where === "into") { parent = t; index = t.children.length; }
    else { parent = parentOf(t); index = parent.children.indexOf(t) + (where === "after" ? 1 : 0); }
    onDrop(n, parent, index);
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  // iOS: stop the page from scrolling while a handle drag is in progress.
  el.addEventListener("touchmove", (e) => { if (drag) e.preventDefault(); }, { passive: false });

  function targetAt(x, y) {
    const hit = document.elementFromPoint(x, y)?.closest(".row");
    if (!hit || !el.contains(hit)) return null;
    const node = nodes.get(hit.dataset.id);
    const dragged = nodes.get(drag.id);
    if (!node || node.id === dragged.id) return null;
    if (dragged.kind === "group" && isInside(node, dragged)) return null;
    const r = hit.getBoundingClientRect();
    const f = (y - r.top) / r.height;
    let where;
    if (node.isRoot) where = "into";
    else if (node.kind === "group") where = f < 0.3 ? "before" : f > 0.7 ? "after" : "into";
    else where = f < 0.5 ? "before" : "after";
    return { node, where, row: hit };
  }

  let lit = null;
  function showTarget(t) {
    lit?.classList.remove("drop-into");
    lit = null;
    if (!t) { line.hidden = true; return; }
    if (t.where === "into") {
      line.hidden = true;
      lit = t.row;
      lit.classList.add("drop-into");
      return;
    }
    const r = t.row.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    line.hidden = false;
    line.style.top = `${(t.where === "before" ? r.top : r.bottom) - box.top + el.scrollTop - 1}px`;
    line.style.left = `calc(${getComputedStyle(t.row).paddingLeft} + 4px)`;
  }

  let scrollTimer = 0;
  function autoscroll(y) {
    clearTimeout(scrollTimer);
    const box = el.getBoundingClientRect();
    const dy = y < box.top + 40 ? -12 : y > box.bottom - 40 ? 12 : 0;
    if (!dy) return;
    el.scrollTop += dy;
    scrollTimer = setTimeout(() => autoscroll(y), 30);
  }

  return { render };
}
