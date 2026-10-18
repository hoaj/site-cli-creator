// HTML for the fixture site. The account page's inline script is the
// "frontend" whose calls the Capture tool records: full named GraphQL queries
// (wider than what the CLI needs), REST calls and, for auth login, the token
// and post-login steps. The login page is served on the separate login host.

export type Auth = "login" | "none";

const STYLE = `
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 52rem; padding: 0 1rem; color: #1b1f24; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #d0d7de; }
  label { display: block; margin-top: .75rem; }
  #status { color: #57606a; }
`;

export const QUERIES = {
  getAccount: `query getAccount($customerId: ID) {
  getAccount(customerId: $customerId) {
    __typename
    id
    customerId
    name
    email
    phone
    createdAt
    notes { __typename id text createdAt }
  }
}`,
  listSubscriptions: `query listSubscriptions($accountId: ID!) {
  listSubscriptions(accountId: $accountId) {
    __typename
    id
    name
    status
    startDate
    price
    currency
    features { __typename code label }
  }
}`,
};

/** The note form and the mutation it sends; the "write-shape" and "ui-change" drifts alter it. */
export type NoteForm = { arg: "text" | "body"; label: string; button: string };

export const NOTE_FORM: NoteForm = { arg: "text", label: "Ny note", button: "Tilføj note" };

const addNoteQuery = (arg: NoteForm["arg"]) => `mutation addNote($accountId: ID!, $${arg}: String!) {
  addNote(accountId: $accountId, ${arg}: $${arg}) { __typename id text createdAt }
}`;

const SCRIPT = (auth: Auth, form: NoteForm) => `
const AUTH = ${JSON.stringify(auth)};
const NOTE_ARG = ${JSON.stringify(form.arg)};
const QUERIES = ${JSON.stringify({ ...QUERIES, addNote: addNoteQuery(form.arg) })};
const $ = (id) => document.getElementById(id);
let bearer = null;
let accountId = null;

function readCookie(name) {
  const hit = document.cookie.split("; ").find((c) => c.startsWith(name + "="));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

function apiHeaders() {
  const h = { "content-type": "application/json", accept: "application/json" };
  if (AUTH === "login") h.authorization = "Bearer " + bearer;
  else h["x-csrf-token"] = readCookie("csrf_token");
  return h;
}

async function api(path, init) {
  const res = await fetch(path, { credentials: "same-origin", ...init, headers: apiHeaders() });
  const body = await res.json().catch(() => null);
  if (!res.ok || (body && body.errors)) throw Object.assign(new Error(path + " failed with " + res.status), { status: res.status });
  return body;
}

const gql = async (operationName, variables) =>
  (await api("/graphql", { method: "POST", body: JSON.stringify({ operationName, query: QUERIES[operationName], variables }) })).data;

function decodeClaims(token) {
  const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(part + "=".repeat((4 - (part.length % 4)) % 4)));
}

function cell(row, text) {
  const td = document.createElement("td");
  td.textContent = text;
  row.appendChild(td);
}

function renderNote(note) {
  const li = document.createElement("li");
  li.textContent = note.text;
  $("notes").appendChild(li);
}

// Like many SPAs, the token and the customer id are kept in localStorage for the
// login session named by the readable shop_hint cookie, so later page loads make
// no token or post-login request.
const STORE = "shop_session";

function cachedSession() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) || "null");
    return s && s.hint === readCookie("shop_hint") ? s : null;
  } catch {
    return null;
  }
}

async function signIn() {
  const tokenRes = await fetch("/oauth/token", { method: "POST", credentials: "same-origin" });
  if (!tokenRes.ok) throw new Error("/oauth/token failed with " + tokenRes.status);
  bearer = (await tokenRes.json()).access_token;
  const claims = decodeClaims(bearer);
  const info = await api("/api/session/post-login", {
    method: "POST",
    body: JSON.stringify({ accountRef: claims.account_ref, personRef: claims.person_ref }),
  });
  const customerId = info.personalInfo.customerId;
  localStorage.setItem(STORE, JSON.stringify({ hint: readCookie("shop_hint"), bearer, customerId }));
  return customerId;
}

async function session() {
  const cached = cachedSession();
  if (!cached) return { customerId: await signIn(), cached: false };
  bearer = cached.bearer;
  return { customerId: cached.customerId, cached: true };
}

async function loadAccount() {
  if (AUTH !== "login") return (await gql("getAccount", {})).getAccount;
  const { customerId, cached } = await session();
  try {
    return (await gql("getAccount", { customerId })).getAccount;
  } catch (e) {
    if (!cached || e.status !== 401) throw e;
    localStorage.removeItem(STORE);
    return (await gql("getAccount", { customerId: await signIn() })).getAccount;
  }
}

async function start() {
  const account = await loadAccount();
  accountId = account.id;
  $("account-name").textContent = account.name;
  $("account-email").textContent = account.email ?? "ingen e-mail";
  account.notes.forEach(renderNote);

  const { listSubscriptions } = await gql("listSubscriptions", { accountId });
  for (const s of listSubscriptions) {
    const row = document.createElement("tr");
    cell(row, s.name);
    cell(row, s.status);
    cell(row, s.startDate ?? "-");
    cell(row, s.price === null ? "gratis" : s.price + " kr./md.");
    $("subscriptions").appendChild(row);
  }

  const { invoices } = await api("/api/invoices?accountId=" + encodeURIComponent(accountId));
  for (const inv of invoices) {
    const li = document.createElement("li");
    li.textContent = inv.number + ": " + inv.amountDKK + " kr. (" + inv.status + ")";
    $("invoices").appendChild(li);
  }
  if (invoices.length) await api("/api/invoices/" + encodeURIComponent(invoices[0].id));

  $("add-note").disabled = false;
  $("status").textContent = "Klar";
  document.body.dataset.state = "loaded";
}

$("note-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const { addNote } = await gql("addNote", { accountId, [NOTE_ARG]: $("note-text").value });
    renderNote(addNote);
    $("note-text").value = "";
  } catch (e) {
    $("status").textContent = "Noten kunne ikke gemmes: " + e.message;
  }
});

start().catch((e) => {
  $("status").textContent = "Fejl: " + e.message;
  document.body.dataset.state = "error";
});
`;

export function accountPage(auth: Auth, form: NoteForm = NOTE_FORM): string {
  return `<!doctype html>
<html lang="da">
<head><meta charset="utf-8"><title>Min konto</title><style>${STYLE}</style></head>
<body data-state="loading">
  <h1>Min konto</h1>
  <p id="status">Indlæser…</p>
  <p><strong id="account-name"></strong> · <span id="account-email"></span></p>
  <h2>Abonnementer</h2>
  <table>
    <thead><tr><th>Navn</th><th>Status</th><th>Siden</th><th>Pris</th></tr></thead>
    <tbody id="subscriptions"></tbody>
  </table>
  <h2>Fakturaer</h2>
  <ul id="invoices"></ul>
  <h2>Noter</h2>
  <ul id="notes"></ul>
  <form id="note-form">
    <label for="note-text">${form.label}</label>
    <textarea id="note-text" name="text" rows="2" required></textarea>
    <button id="add-note" type="submit" disabled>${form.button}</button>
  </form>
  <script>${SCRIPT(auth, form)}</script>
</body>
</html>`;
}

export function loginPage(error?: string): string {
  return `<!doctype html>
<html lang="da">
<head><meta charset="utf-8"><title>Log ind</title><style>${STYLE}</style></head>
<body>
  <h1>Log ind</h1>
  ${error ? `<p role="alert">${error}</p>` : ""}
  <form method="post" action="/login">
    <label for="username">Brugernavn</label>
    <input id="username" name="username" autocomplete="username" required>
    <label for="password">Adgangskode</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Log ind</button>
  </form>
</body>
</html>`;
}
