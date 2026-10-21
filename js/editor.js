// The writing surface: CodeMirror 6 with Markdown, markup characters faded,
// optional typewriter scrolling (current line kept centered) and focus mode
// (everything but the current paragraph dimmed).
import {
  EditorView, keymap, ViewPlugin, Decoration, placeholder, drawSelection,
  EditorState, Compartment, RangeSetBuilder,
  markdown, markdownLanguage, HighlightStyle, syntaxHighlighting,
  defaultKeymap, history, historyKeymap, tags as t,
} from "../vendor/editor.js";

const style = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.45em", fontWeight: "700" },
  { tag: t.heading2, fontSize: "1.25em", fontWeight: "700" },
  { tag: t.heading3, fontSize: "1.1em", fontWeight: "700" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator, t.url], color: "var(--mark)" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.monospace, fontFamily: "var(--mono)", fontSize: "0.9em" },
  { tag: t.quote, color: "var(--quote)", fontStyle: "italic" },
]);

const dim = Decoration.line({ class: "cm-dim" });
const focusPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = this.build(view); }
    update(u) { if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = this.build(u.view); }
    build(view) {
      const { doc } = view.state;
      const cur = doc.lineAt(view.state.selection.main.head);
      let from = cur.number, to = cur.number;
      if (cur.text.trim()) {
        while (from > 1 && doc.line(from - 1).text.trim()) from--;
        while (to < doc.lines && doc.line(to + 1).text.trim()) to++;
      }
      const b = new RangeSetBuilder();
      let last = 0;
      for (const r of view.visibleRanges) {
        for (let pos = r.from; pos <= r.to; ) {
          const line = doc.lineAt(pos);
          if (line.number > last && (line.number < from || line.number > to)) b.add(line.from, line.from, dim);
          last = line.number;
          pos = line.to + 1;
        }
      }
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations }
);

// Center the cursor line when typing or moving with the keyboard (not on mouse clicks).
const typewriterScroll = EditorState.transactionExtender.of((tr) => {
  if (!(tr.docChanged || tr.selection)) return null;
  if (!(tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("select") || tr.isUserEvent("undo") || tr.isUserEvent("redo"))) return null;
  if (tr.isUserEvent("select.pointer")) return null;
  return { effects: EditorView.scrollIntoView(tr.newSelection.main.head, { y: "center" }) };
});

// Wrap selection in a markup pair (Ctrl/Cmd+B, Ctrl/Cmd+I).
function wrap(mark) {
  return (view) => {
    view.dispatch(view.state.changeByRange((r) => ({
      changes: [{ from: r.from, insert: mark }, { from: r.to, insert: mark }],
      range: r.empty ? { anchor: r.from + mark.length } : { anchor: r.from + mark.length, head: r.to + mark.length },
    })));
    return true;
  };
}

export function createEditor(parent, { onChange }) {
  const twComp = new Compartment();
  const focusComp = new Compartment();
  const editComp = new Compartment();
  let suppress = false;

  const extensions = () => [
    history(),
    drawSelection(),
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(style),
    EditorView.theme({
      ".cm-scroller": { fontFamily: "var(--body-font, var(--serif))", lineHeight: "1.65" },
      ".cm-content": { padding: "var(--pad-top) var(--pad-x) var(--pad-bottom)" },
    }),
    placeholder("Start writing…"),
    keymap.of([{ key: "Mod-b", run: wrap("**") }, { key: "Mod-i", run: wrap("*") }, ...defaultKeymap, ...historyKeymap]),
    EditorView.contentAttributes.of({ spellcheck: "true", autocorrect: "on", autocapitalize: "sentences" }),
    twComp.of(state.typewriter ? typewriterScroll : []),
    focusComp.of(state.focus ? focusPlugin : []),
    editComp.of(EditorView.editable.of(!state.readOnly)),
    EditorView.updateListener.of((u) => { if (u.docChanged && !suppress) onChange(u.state.doc.toString()); }),
  ];

  const state = { typewriter: false, focus: false, readOnly: false };
  const view = new EditorView({ parent, state: EditorState.create({ doc: "", extensions: extensions() }) });

  return {
    view,
    // Replace the whole document (opening a sheet). Resets undo history.
    load(text, { selection } = {}) {
      suppress = true;
      const anchor = selection == null ? 0 : Math.min(selection, text.length);
      view.setState(EditorState.create({ doc: text, selection: { anchor }, extensions: extensions() }));
      suppress = false;
    },
    // Swap in a newer version from another device, keeping cursor and scroll roughly in place.
    replace(text) {
      const sel = view.state.selection.main.head;
      const top = view.scrollDOM.scrollTop;
      suppress = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: Math.min(sel, text.length) } });
      suppress = false;
      view.scrollDOM.scrollTop = top;
    },
    text: () => view.state.doc.toString(),
    setTypewriter(on) {
      state.typewriter = on;
      view.dispatch({ effects: twComp.reconfigure(on ? typewriterScroll : []) });
      parent.classList.toggle("typewriter", on);
    },
    setFocus(on) {
      state.focus = on;
      view.dispatch({ effects: focusComp.reconfigure(on ? focusPlugin : []) });
    },
    focus: () => view.focus(),
    setReadOnly(on) {
      state.readOnly = on;
      view.dispatch({ effects: editComp.reconfigure(EditorView.editable.of(!on)) });
    },
  };
}

export function countText(text) {
  const plain = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/[#>*_`~\[\]]/g, " ");
  const words = plain.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu)?.length || 0;
  const chars = text.replace(/\n/g, "").length;
  return { words, chars };
}
