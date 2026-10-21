// Settings Jon fills in once, during setup (see SETUP.md).
export const CONFIG = {
  appName: "Folio",

  // From the Azure app registration "Overview" page.
  clientId: "a95b4fc5-6165-46dc-8816-f2377d7d62c5",
  tenantId: "0183c366-8a4c-43f6-b001-31bf8c8f22b1",

  scopes: ["User.Read", "Files.ReadWrite"],

  // Library sections. Paths are relative to the top of Jon's OneDrive.
  roots: [
    { label: "Book drafts", path: "Claude Work/Bible Study Series/book/drafts" },
    { label: "Bible study", path: "Claude Work/Bible Study Series/bible-study" },
  ],
};

// Open the app with ?demo in the address to try it with a fake, local-only library.
export const DEMO = new URLSearchParams(location.search).has("demo");
