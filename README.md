# Folio (writing app)

Jon's Ulysses replacement. A browser app for PC and iPhone that edits plain Markdown files in OneDrive.

## How your writing is stored

- Library sections: `book/drafts` and `bible-study` in this workspace (set in `js/config.js`).
- A **sheet** is one `.md` file. A **group** is a folder. Groups can nest.
- Each group folder may contain `_writing.json`. It holds the order of sheets and groups (and, from stage 2, goals, notes and keywords). The app hides it. Don't hand-edit it; deleting it only resets that group to alphabetical order.
- Files whose names start with `.`, `_` or `~` are hidden from the library.
- `.md` files stay pure text, so Claude sessions, Word, or any editor can read them.

## Safety

- Every keystroke is kept in the browser's on-device storage; the file is uploaded about 1.5 seconds after you stop typing (Ctrl+S saves immediately).
- Uploads only succeed if OneDrive still has the version this device last saw. If the other device saved first, the app shows both versions and asks which to keep. "Keep both" (the default, and what happens automatically for sheets you aren't looking at) saves your text as a separate "conflict copy" sheet.
- Without a connection, you can keep writing in sheets already opened on that device; they upload when you're back online.
- Deleting a sheet or group moves it to the OneDrive recycle bin.

## Keyboard (PC)

Ctrl+B bold, Ctrl+I italic, Ctrl+S save now, Ctrl+\ show or hide the library, Ctrl+Z / Ctrl+Y undo and redo.

## Files

`index.html`, `app.css`, `js/` (app code), `vendor/` (prebuilt libraries, see `vendor/README.md`), `sw.js` (offline support), `manifest.webmanifest` and `icons/` (home-screen app), `deploy.ps1` (publish to GitHub Pages), `SETUP.md`, `PLAN.md`.

Try it without signing in: open the site with `?demo` at the end of the address. Demo mode uses a fake library stored only in that browser.

## Status

Stage 1 (library, editor, sync, conflicts, offline) built 2026-10-20. Stage 2 (goals, notes, keywords) and stage 3 (export to .docx, ePub, PDF) not started.
