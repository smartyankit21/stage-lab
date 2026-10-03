/* Stage Lab - Watchlist and Journal, saved to the owner's Supabase database.
   Uses helpers from app.js ($, esc, fmt, load, stockTable, COL, nice, sym, enrich, view). */
"use strict";

/* ---------- connection and sign-in ---------- */
let SB = null;
function db() {
  const c = window.STAGE_CFG || {};
  if (!SB && c.supabaseUrl && c.supabaseKey && window.supabase) {
    SB = window.supabase.createClient(c.supabaseUrl, c.supabaseKey, {
      auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
    });
  }
  return SB;
}
async function currentUser() {
  const sb = db();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session?.user || null;
}
/* After an emailed link brings you back (?code=...), finish sign-in and return to the page you started from.
   A password-reset link lands on the "set a new password" form instead. */
async function finishSignIn() {
  const sb = db();
  if (sb) sb.auth.onAuthStateChange((event) => {
    if (event === "PASSWORD_RECOVERY") { try { sessionStorage.setItem("pwRecovery", "1"); } catch { /* private mode */ } }
    renderAccountChip();
  });
  if (!new URLSearchParams(location.search).has("code") || !sb) { renderAccountChip(); return; }
  await currentUser();                       // the library swaps the code for a session here
  let back = "#/watchlist";
  try {
    back = localStorage.getItem("afterSignIn") || back; localStorage.removeItem("afterSignIn");
    if (sessionStorage.getItem("pwRecovery") || localStorage.getItem("pwResetAsked")) { back = "#/account/reset"; localStorage.removeItem("pwResetAsked"); }
  } catch { /* private mode */ }
  history.replaceState(null, "", location.pathname + back);
  renderAccountChip();
}
const rows = (r) => { if (r.error) throw new Error(r.error.message); return r.data; };

function notConnected(title) {
  view().innerHTML = `<h1>${title}</h1><div class="notice">The database for watchlists and the journal isn't connected yet.
    Once the Supabase address and public key are added to <code>site/config.js</code>, this page will ask you to sign in.</div>`;
}

/* ---------- sign in with email and password ---------- */
const MIN_PW = 8;
const backHere = () => location.origin + location.pathname;
function friendly(error) {
  const m = error?.message || String(error);
  if (/invalid login credentials/i.test(m)) return "That email and password don't match. Check them, or use “Forgot password?”.";
  if (/email not confirmed/i.test(m)) return "Please confirm your email first: open the link we sent when you created the account.";
  if (/already registered|already exists/i.test(m)) return "An account with this email already exists. Sign in instead, or use “Forgot password?”.";
  if (/rate|limit|seconds/i.test(m)) return "Too many emails were sent just now. Please try again in a little while.";
  if (/password/i.test(m) && /least|short|weak/i.test(m)) return `Choose a longer password (at least ${MIN_PW} characters).`;
  return m;
}
function signInForm(title, intro, mode = "signin") {
  const tab = (m, label) => `<a href="#" data-mode="${m}" class="${mode === m ? "on" : ""}">${label}</a>`;
  view().innerHTML = `<h1>${title}</h1><p class="muted">${intro}</p>
    <div class="auth-card">
      <nav class="tabs">${tab("signin", "Sign in")}${tab("signup", "Create account")}</nav>
      <form class="auth-form" id="auth-form" novalidate>
        <label>Email<input name="email" type="email" required autocomplete="email" placeholder="you@example.com"></label>
        <label>Password<input name="password" type="password" required minlength="${MIN_PW}" autocomplete="${mode === "signup" ? "new-password" : "current-password"}" placeholder="${mode === "signup" ? `At least ${MIN_PW} characters` : "Your password"}"></label>
        ${mode === "signup" ? `<label>Repeat password<input name="password2" type="password" required minlength="${MIN_PW}" autocomplete="new-password"></label>` : ""}
        <button type="submit" class="primary">${mode === "signup" ? "Create account" : "Sign in"}</button>
        <p class="auth-msg small" id="auth-msg" role="status"></p>
      </form>
      <div class="auth-links">${mode === "signin" ? `<button type="button" class="linkish" id="auth-forgot">Forgot password?</button>` : "<span></span>"}
        <button type="button" class="linkish" id="auth-link">Email me a one-time sign-in link instead</button></div>
    </div>`;
  document.querySelectorAll(".auth-card [data-mode]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); signInForm(title, intro, a.dataset.mode); addEyebrow((location.hash.split("?")[0].split("/")[1]) || ""); }));
  const form = $("#auth-form"), msg = $("#auth-msg"), say = (h, bad) => { msg.innerHTML = h; msg.className = `auth-msg small ${bad ? "down" : ""}`; };
  const remember = () => { try { localStorage.setItem("afterSignIn", location.hash && !location.hash.startsWith("#/account") ? location.hash : "#/watchlist"); } catch { /* private mode */ } };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const email = form.email.value.trim(), pw = form.password.value, btn = $("button[type=submit]", form);
    if (!email || !/.+@.+\..+/.test(email)) return say("Enter a valid email address.", true);
    if (pw.length < MIN_PW) return say(`Passwords need at least ${MIN_PW} characters.`, true);
    if (mode === "signup" && pw !== form.password2.value) return say("The two passwords don't match.", true);
    btn.disabled = true;
    try {
      if (mode === "signup") {
        remember();
        const { data, error } = await db().auth.signUp({ email, password: pw, options: { emailRedirectTo: backHere() } });
        if (error) throw error;
        if (data.session) { toast("Account created. You're signed in."); renderAccountChip(); route(); }
        else say(`Almost done: we sent a confirmation email to <b>${esc(email)}</b>. Open it once, then sign in here with your password.`);
      } else {
        const { error } = await db().auth.signInWithPassword({ email, password: pw });
        if (error) throw error;
        toast("Signed in."); renderAccountChip();
        if (location.hash.startsWith("#/account")) location.hash = "#/watchlist"; else route();
      }
    } catch (x) { say(esc(friendly(x)), true); }
    btn.disabled = false;
  };
  const forgot = $("#auth-forgot");
  if (forgot) forgot.onclick = async () => {
    const email = form.email.value.trim();
    if (!/.+@.+\..+/.test(email)) return say("Type your email above first, then tap “Forgot password?”.", true);
    try { localStorage.setItem("pwResetAsked", "1"); } catch { /* private mode */ }
    const { error } = await db().auth.resetPasswordForEmail(email, { redirectTo: backHere() });
    say(error ? esc(friendly(error)) : `We sent a reset link to <b>${esc(email)}</b>. Open it on this device to choose a new password.`, !!error);
  };
  $("#auth-link").onclick = async () => {
    const email = form.email.value.trim();
    if (!/.+@.+\..+/.test(email)) return say("Type your email above first.", true);
    remember();
    const { error } = await db().auth.signInWithOtp({ email, options: { emailRedirectTo: backHere() } });
    say(error ? esc(friendly(error)) : `Sent. Check the inbox for <b>${esc(email)}</b> and tap the link. It works once and expires in an hour.`, !!error);
  };
}

/* ---------- account page: sign in / create account, change password, sign out ---------- */
async function pageAccount(sub) {
  if (!db()) { notConnected("Account"); return; }
  const user = await currentUser();
  let recovering = sub === "reset";
  try { if (sessionStorage.getItem("pwRecovery")) recovering = true; } catch { /* private mode */ }
  if (!user) { signInForm("Account", "Sign in to save your watchlists and trade journal. They sync across your phone and laptop."); return; }
  view().innerHTML = `<h1>${recovering ? "Choose a new password" : "Your account"}</h1>
    <p class="muted">Signed in as <b>${esc(user.email)}</b>.</p>
    <div class="auth-card">
      <h2>${recovering ? "New password" : "Change password"}</h2>
      <form class="auth-form" id="pw-form" novalidate>
        <label>New password<input name="password" type="password" minlength="${MIN_PW}" autocomplete="new-password" placeholder="At least ${MIN_PW} characters"></label>
        <label>Repeat new password<input name="password2" type="password" minlength="${MIN_PW}" autocomplete="new-password"></label>
        <button type="submit" class="primary">Save password</button>
        <p class="auth-msg small" id="pw-msg" role="status"></p>
      </form>
    </div>
    <div class="stat-cards two" style="margin-top:18px">
      <a class="stat-card" href="#/watchlist"><span>Your lists</span><strong>Watchlist</strong><small>Stocks you are following</small><em class="tap">open ›</em></a>
      <a class="stat-card" href="#/journal"><span>Your trades</span><strong>Journal</strong><small>Entries, exits and results</small><em class="tap">open ›</em></a>
    </div>
    <p style="margin-top:18px"><button type="button" data-signout>Sign out</button></p>`;
  const f = $("#pw-form"), m = $("#pw-msg");
  f.onsubmit = async (e) => {
    e.preventDefault();
    const pw = f.password.value;
    if (pw.length < MIN_PW) { m.innerHTML = `<span class="down">Passwords need at least ${MIN_PW} characters.</span>`; return; }
    if (pw !== f.password2.value) { m.innerHTML = `<span class="down">The two passwords don't match.</span>`; return; }
    const { error } = await db().auth.updateUser({ password: pw });
    if (error) { m.innerHTML = `<span class="down">${esc(friendly(error))}</span>`; return; }
    try { sessionStorage.removeItem("pwRecovery"); } catch { /* private mode */ }
    f.reset(); m.innerHTML = "Saved. Use this password next time you sign in.";
    toast("Password saved.");
  };
  wireSignOut();
}

/* ---------- top-bar account button: "Sign in", or your initial with a small menu ---------- */
async function renderAccountChip() {
  const box = document.getElementById("acct");
  if (!box) return;
  const user = db() ? await currentUser() : null;
  if (!user) {
    box.innerHTML = `<a href="#/account" class="nav-btn acct-signin" data-route="account">Sign in</a>`;
    return;
  }
  const initial = esc((user.email || "?")[0].toUpperCase());
  box.innerHTML = `<div class="nav-group"><button type="button" class="nav-btn acct-chip" aria-haspopup="true" aria-label="Account"><span class="avatar">${initial}</span><span class="acct-mail">${esc(user.email)}</span></button>
    <div class="menu menu-right">
      <a href="#/watchlist" class="menu-item"><span><b>Watchlist</b><small>stocks you follow</small></span><i aria-hidden="true">›</i></a>
      <a href="#/journal" class="menu-item"><span><b>Journal</b><small>your trades</small></span><i aria-hidden="true">›</i></a>
      <a href="#/account" class="menu-item"><span><b>Account</b><small>change password</small></span><i aria-hidden="true">›</i></a>
      <button type="button" class="menu-item menu-btn" data-signout><span><b>Sign out</b><small>${esc(user.email)}</small></span></button>
    </div></div>`;
  wireSignOut();
}

/* Shared gate: returns the signed-in user, or draws the right screen and returns null. */
async function gate(title, intro) {
  if (!db()) { notConnected(title); return null; }
  const user = await currentUser();
  if (!user) { signInForm(title, intro); return null; }
  return user;
}
const whoLine = (user) => `<p class="whoami">Signed in as ${esc(user.email)} · <button type="button" class="linkish" data-signout>Sign out</button></p>`;
function wireSignOut() {
  document.querySelectorAll("[data-signout]").forEach((b) => (b.onclick = async () => { await db().auth.signOut(); renderAccountChip(); toast("Signed out."); route(); }));
}

/* ---------- small UI pieces ---------- */
function toast(msg, bad = false) {
  document.querySelector(".toast")?.remove();
  const t = document.createElement("div");
  t.className = `toast${bad ? " bad" : ""}`;
  t.setAttribute("role", "status");
  t.innerHTML = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}
/* A form in a modal panel. onSubmit(formData) may throw to keep it open. */
function formDialog(title, body, onSubmit, { submit = "Save", extra = "" } = {}) {
  document.querySelector("dialog.sheet")?.remove();
  const d = document.createElement("dialog");
  d.className = "sheet";
  d.innerHTML = `<form method="dialog" novalidate><h2>${title}</h2><div class="sheet-body">${body}</div>
    <p class="form-err down" hidden></p>
    <div class="sheet-foot">${extra}<span class="grow"></span><button type="button" data-cancel>Cancel</button><button type="submit" class="primary">${submit}</button></div></form>`;
  document.body.appendChild(d);
  const form = $("form", d), err = $(".form-err", d);
  const close = () => { d.close(); d.remove(); };
  $("[data-cancel]", d).onclick = close;
  d.addEventListener("cancel", () => d.remove());
  form.onsubmit = async (e) => {
    e.preventDefault();
    err.hidden = true;
    const btn = $("button[type=submit]", d);
    btn.disabled = true;
    try { await onSubmit(new FormData(form), form); close(); }
    catch (x) { err.textContent = x.message; err.hidden = false; }
    btn.disabled = false;
  };
  d.showModal();
  $("input:not([type=hidden]),select,textarea", d)?.focus();
  return d;
}
/* Delete buttons ask twice instead of using a browser pop-up. */
function twoStep(btn, action) {
  btn.onclick = async () => {
    if (btn.dataset.armed) { btn.disabled = true; await action(); return; }
    btn.dataset.armed = "1"; btn.dataset.label = btn.textContent; btn.textContent = "Click again to delete"; btn.classList.add("danger");
    setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; btn.classList.remove("danger"); } }, 4000);
  };
}

/* Symbol picker: "RELIANCE" or "Reliance Industries" -> stock key. */
async function stockIndex() {
  const stocks = await load("stocks.json");
  const byKey = Object.fromEntries(stocks.map((s) => [s.key, s]));
  const bySym = {};
  for (const s of stocks) {
    const k = sym(s.key).toUpperCase();
    if (!bySym[k] || s.exchange === "NSE") bySym[k] = s;      // prefer the NSE listing
  }
  const options = stocks.map((s) => `<option value="${esc(sym(s.key))}">${esc(nice(s.name, s.key))}${s.exchange === "BSE" ? " (BSE)" : ""}</option>`).join("");
  const find = (q) => {
    q = String(q || "").trim();
    if (!q) return null;
    if (byKey[q]) return byKey[q];
    const hit = bySym[q.toUpperCase()];
    if (hit) return hit;
    const low = q.toLowerCase();
    const named = stocks.filter((s) => nice(s.name, s.key).toLowerCase() === low);
    return named.length === 1 ? named[0] : null;
  };
  return { stocks, byKey, options, find };
}
const stockPicker = (name, idx, value = "") => `<input name="${name}" list="dl-stocks" value="${esc(value)}" placeholder="Symbol, e.g. RELIANCE" autocomplete="off" required>
  <datalist id="dl-stocks">${idx.options}</datalist>`;

/* =================================================================== */
/* Watchlist                                                            */
/* =================================================================== */
async function pageWatchlist(listId) {
  const user = await gate("Watchlist", "Sign in to keep your watchlists. They sync across your phone and laptop.");
  if (!user) return;
  const sb = db();
  const [idx, sum] = await Promise.all([stockIndex(), load("summary.json")]);
  enrich(idx.stocks);
  let lists = rows(await sb.from("watchlists").select("*").order("position").order("created_at"));
  if (!lists.length) lists = rows(await sb.from("watchlists").insert({ name: "My watchlist" }).select());
  const list = lists.find((l) => l.id === listId) || lists[0];
  const allItems = rows(await sb.from("watchlist_items").select("*"));
  const items = allItems.filter((i) => i.list_id === list.id);
  const counts = {};
  allItems.forEach((i) => (counts[i.list_id] = (counts[i.list_id] || 0) + 1));

  view().innerHTML = `${whoLine(user)}
    <h1>Watchlist</h1>
    <p class="muted">Prices and ratings update after each market close. "Since added" compares today's price with the price on the day you added the stock.</p>
    <nav class="tabs">${lists.map((l) => `<a href="#/watchlist/${l.id}" class="${l.id === list.id ? "on" : ""}">${esc(l.name)}<span class="count">${counts[l.id] || 0}</span></a>`).join("")}
      <span class="tabs-right"><button type="button" class="linkish" id="wl-new">New list</button></span></nav>
    <form class="toolbar" id="wl-add">
      <label>Add a stock${stockPicker("q", idx)}</label>
      <button type="submit" class="primary">Add</button>
      <span class="grow"></span>
      <button type="button" id="wl-rename">Rename list</button>
      ${lists.length > 1 ? `<button type="button" id="wl-del">Delete list</button>` : ""}
    </form>
    <div id="tbl"></div>`;
  wireSignOut();

  const data = items.map((it) => {
    const s = idx.byKey[it.key];
    const base = s ? { ...s } : { key: it.key, name: "", file: it.key.replace(":", "_"), _missing: true };
    base._item = it;
    base._note = it.note || "";
    base._added = it.added_on;
    base._since = s && it.added_price ? (s.close / it.added_price - 1) * 100 : null;
    return base;
  });
  const cols = [
    { ...COL.name, render: (r) => `<b>${esc(sym(r.key))}</b> <span class="muted">${r._missing ? "Not traded on the latest day" : esc(nice(r.name, r.key))}</span>` },
    COL.spark, COL.stage, COL.close, COL.chg, COL.rs(), COL.rsd7,
    { key: "_since", label: "Since added", num: true, render: (r) => (r._since == null ? "–" : fmt.pct(r._since)) },
    COL.offHigh,
    { key: "_added", label: "Added", render: (r) => fmt.date(r._added), hidden: true },
    off(COL.rsd30), off(COL.industry), off(COL.mcap),
    { key: "_note", label: "Note", cls: "note", render: (r) => `<span class="note-text">${esc(r._note) || '<span class="muted">Add note</span>'}</span>`, sortVal: (r) => r._note.toLowerCase() },
    { key: "_act", label: "", nosort: true, fixed: true, cls: "act", render: (r) => `<button type="button" class="icon" data-remove="${r._item.id}" title="Remove from this list" aria-label="Remove ${esc(sym(r.key))}">×</button>` },
  ].map((c) => (c.hidden ? off(c) : c));
  const tbl = $("#tbl");
  if (!data.length) tbl.innerHTML = `<p class="empty" style="margin-top:18px">This list is empty. Add a stock above, or use <b>Watch</b> on any stock's page.</p>`;
  else stockTable(tbl, data, cols, { sort: "_added", dir: -1, id: "watchlist" });

  // Remove and note clicks are caught before the row's own "open stock" click.
  tbl.addEventListener("click", async (e) => {
    const rm = e.target.closest("[data-remove]");
    const nt = e.target.closest("td.note");
    if (!rm && !nt) return;
    e.stopPropagation();
    if (rm) {
      rows(await sb.from("watchlist_items").delete().eq("id", rm.dataset.remove));
      toast("Removed.");
      route();
      return;
    }
    const tr = nt.closest("tr"), href = tr.dataset.href;
    const r = data.find((x) => `#/stock/${encodeURIComponent(x.file)}` === href);
    if (!r) return;
    formDialog(`Note for ${esc(sym(r.key))}`, `<label class="field">Note<textarea name="note" rows="4" maxlength="500" placeholder="Why you're watching it, the level you want, etc.">${esc(r._note)}</textarea></label>`,
      async (fd) => { rows(await sb.from("watchlist_items").update({ note: fd.get("note").trim() || null }).eq("id", r._item.id)); toast("Note saved."); route(); });
  }, true);

  $("#wl-add").onsubmit = async (e) => {
    e.preventDefault();
    const q = e.target.q.value, s = idx.find(q);
    if (!s) { toast(`No stock called "${esc(q)}" in today's list. Pick one from the suggestions.`, true); return; }
    if (items.some((i) => i.key === s.key)) { toast(`${esc(sym(s.key))} is already on this list.`); return; }
    rows(await sb.from("watchlist_items").insert({ list_id: list.id, key: s.key, added_on: sum.date, added_price: s.close }));
    toast(`Added ${esc(sym(s.key))}.`);
    route();
  };
  $("#wl-new").onclick = () => formDialog("New watchlist", `<label class="field">Name<input name="name" maxlength="60" required placeholder="e.g. Breakouts to watch"></label>`, async (fd) => {
    const name = fd.get("name").trim();
    if (!name) throw new Error("Give the list a name.");
    const [made] = rows(await sb.from("watchlists").insert({ name, position: lists.length }).select());
    location.hash = `#/watchlist/${made.id}`;
  }, { submit: "Create" });
  $("#wl-rename").onclick = () => formDialog("Rename list", `<label class="field">Name<input name="name" maxlength="60" required value="${esc(list.name)}"></label>`, async (fd) => {
    const name = fd.get("name").trim();
    if (!name) throw new Error("Give the list a name.");
    rows(await sb.from("watchlists").update({ name }).eq("id", list.id));
    route();
  });
  if ($("#wl-del")) twoStep($("#wl-del"), async () => {
    rows(await sb.from("watchlists").delete().eq("id", list.id));
    toast(`Deleted "${esc(list.name)}".`);
    location.hash = "#/watchlist";
  });
}

/* "Watch" button on a stock page: choose which lists the stock is on. */
async function watchDialog(stock) {
  if (!db()) { location.hash = "#/watchlist"; return; }
  const user = await currentUser();
  if (!user) { location.hash = "#/watchlist"; return; }
  const sb = db();
  let lists = rows(await sb.from("watchlists").select("*").order("position").order("created_at"));
  if (!lists.length) lists = rows(await sb.from("watchlists").insert({ name: "My watchlist" }).select());
  const on = new Set(rows(await sb.from("watchlist_items").select("list_id").eq("key", stock.key)).map((r) => r.list_id));
  const sum = await load("summary.json");
  formDialog(`Watch ${esc(sym(stock.key))}`,
    `<p class="muted small" style="margin:0 0 10px">Tick the lists it should be on.</p>
     <div class="checklist">${lists.map((l) => `<label><input type="checkbox" name="l" value="${l.id}" ${on.has(l.id) ? "checked" : ""}> ${esc(l.name)}</label>`).join("")}</div>`,
    async (fd) => {
      const want = new Set(fd.getAll("l"));
      const add = [...want].filter((id) => !on.has(id)).map((id) => ({ list_id: id, key: stock.key, added_on: sum.date, added_price: stock.close }));
      const drop = [...on].filter((id) => !want.has(id));
      if (add.length) rows(await sb.from("watchlist_items").insert(add));
      if (drop.length) rows(await sb.from("watchlist_items").delete().eq("key", stock.key).in("list_id", drop));
      toast(want.size ? `${esc(sym(stock.key))} is on ${want.size} list${want.size === 1 ? "" : "s"}.` : `${esc(sym(stock.key))} removed from your lists.`);
      markWatched(stock);
    });
}
async function markWatched(stock) {
  const b = $("#btn-watch");
  if (!b || !db() || !(await currentUser())) return;
  const r = await db().from("watchlist_items").select("id").eq("key", stock.key).limit(1);
  const yes = !r.error && r.data.length > 0;
  b.textContent = yes ? "Watching" : "Watch";
  b.setAttribute("aria-pressed", yes);
}

/* =================================================================== */
/* Journal                                                              */
/* =================================================================== */
const SETUPS = ["Stage 2 entry", "Cup & handle (VCP)", "High tight flag", "Breakout", "Pullback to average", "Other"];
const inr = (v, sign = false) => (v == null ? "–" : `${sign && v > 0 ? "+" : v < 0 ? "−" : ""}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`);
const money = (v) => (v == null ? "–" : `<span class="${v >= 0 ? "up" : "down"}">${inr(v, true)}</span>`);
const rmult = (v) => (v == null ? "–" : `<span class="${v >= 0 ? "up" : "down"}">${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}R</span>`);
const daysBetween = (a, b) => Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 864e5);

/* Profit, % and R for one trade, at its exit price or (if open) the latest close. */
function tradeMath(t, latest, asOf) {
  const dir = t.side === "short" ? -1 : 1;
  const entry = +t.entry_price, qty = +t.qty;
  const px = t.exit_price != null ? +t.exit_price : latest;
  const risk = t.stop != null ? dir * (entry - +t.stop) : null;          // per share; positive when the stop is on the right side
  const out = {
    px, cost: entry * qty,
    pnl: px == null ? null : dir * (px - entry) * qty,
    pct: px == null ? null : dir * (px / entry - 1) * 100,
    risk_rs: risk > 0 ? risk * qty : null,
    r: px != null && risk > 0 ? (dir * (px - entry)) / risk : null,
    days: daysBetween(t.entry_date, t.exit_date || asOf),
  };
  return out;
}

async function pageJournal(sub, arg, params) {
  const user = await gate("Journal", "Sign in to keep your trade journal. It syncs across your phone and laptop.");
  if (!user) return;
  const sb = db();
  const [idx, sum] = await Promise.all([stockIndex(), load("summary.json")]);
  const trades = rows(await sb.from("trades").select("*").order("entry_date", { ascending: false }).order("created_at", { ascending: false }));
  const asOf = sum.date;
  const all = trades.map((t) => {
    const s = idx.byKey[t.key];
    const m = tradeMath(t, s?.close ?? null, asOf);
    return { ...t, ...m, name: s?.name || "", file: s?.file || t.key.replace(":", "_"), stage: s?.stage, candidate: s?.candidate,
      _href: `#/journal/edit/${t.id}`, _open: t.exit_date == null };
  });
  const open = all.filter((t) => t._open), closed = all.filter((t) => !t._open);
  const sumOf = (a, k) => a.reduce((x, t) => x + (t[k] ?? 0), 0);
  const openPnl = sumOf(open.filter((t) => t.pnl != null), "pnl"), openCost = sumOf(open, "cost");
  const wins = closed.filter((t) => t.pnl > 0), losses = closed.filter((t) => t.pnl <= 0);
  const avg = (a, k) => (a.length ? sumOf(a, k) / a.length : null);
  const withR = closed.filter((t) => t.r != null);
  const atRisk = sumOf(open, "risk_rs");

  view().innerHTML = `${whoLine(user)}
    <div class="section-head"><h1>Journal</h1><span><button type="button" id="j-csv">Download CSV</button> <button type="button" class="primary" id="j-add">Log a trade</button></span></div>
    <p class="muted">Open trades are valued at the latest close (${fmt.date(asOf)}). R is profit measured in units of your planned risk: entry to stop.</p>
    <div class="figures">
      <div><div class="lbl">Open positions</div><div class="val">${open.length}</div><div class="sub">${inr(openCost)} invested${atRisk ? `, ${inr(atRisk)} at risk to stops` : ""}</div></div>
      <div><div class="lbl">Open profit</div><div class="val">${money(open.length ? openPnl : null)}</div><div class="sub">${openCost ? fmt.pct((openPnl / openCost) * 100) : "–"} on cost</div></div>
      <div><div class="lbl">Closed profit</div><div class="val">${money(closed.length ? sumOf(closed, "pnl") : null)}</div><div class="sub">${closed.length} closed trade${closed.length === 1 ? "" : "s"}</div></div>
      <div><div class="lbl">Win rate</div><div class="val">${closed.length ? `${Math.round((wins.length / closed.length) * 100)}%` : "–"}</div>
        <div class="sub">${closed.length ? `Avg win ${wins.length ? fmt.pct(avg(wins, "pct")) : "–"}, avg loss ${losses.length ? fmt.pct(avg(losses, "pct")) : "–"}${withR.length ? `, avg ${rmult(avg(withR, "r"))}` : ""}` : "No closed trades yet"}</div></div>
    </div>
    <section class="section"><h2>Open positions <span class="count">${open.length}</span></h2><div id="t-open"></div></section>
    <section class="section"><h2>Closed trades <span class="count">${closed.length}</span></h2><div id="t-closed"></div></section>`;
  wireSignOut();

  const stockCol = { ...COL.name, render: (r) => `<b>${esc(sym(r.key))}</b>${r.side === "short" ? ' <span class="badge cand">Short</span>' : ""} <span class="muted">${esc(nice(r.name, r.key))}</span>` };
  const c = {
    entryDate: { key: "entry_date", label: "Entry date", render: (r) => fmt.date(r.entry_date) },
    exitDate: { key: "exit_date", label: "Exit date", render: (r) => fmt.date(r.exit_date) },
    entry: { key: "entry_price", label: "Entry", num: true, render: (r) => fmt.px(+r.entry_price) },
    qty: { key: "qty", label: "Qty", num: true, render: (r) => fmt.int(+r.qty) },
    stop: { key: "stop", label: "Stop", num: true, render: (r) => (r.stop == null ? "–" : fmt.px(+r.stop)) },
    now: { key: "px", label: "Now", num: true, render: (r) => fmt.px(r.px) },
    exit: { key: "exit_price", label: "Exit", num: true, render: (r) => fmt.px(+r.exit_price) },
    pnl: { key: "pnl", label: "Profit", num: true, render: (r) => money(r.pnl) },
    pct: { key: "pct", label: "%", num: true, render: (r) => fmt.pct(r.pct) },
    r: { key: "r", label: "R", num: true, render: (r) => rmult(r.r) },
    days: { key: "days", label: "Days", num: true, render: (r) => fmt.int(r.days) },
    setup: { key: "setup", label: "Setup", render: (r) => esc(r.setup || "–") },
    cost: { key: "cost", label: "Invested", num: true, render: (r) => inr(r.cost) },
  };
  if (open.length) stockTable($("#t-open"), open, [stockCol, c.entryDate, c.entry, c.qty, c.stop, c.now, c.pnl, c.pct, c.r, c.days, COL.stage, off(c.setup), off(c.cost)],
    { sort: "entry_date", dir: -1, id: "j-open" });
  else $("#t-open").innerHTML = `<p class="empty">No open positions. Use <b>Log a trade</b> to add one.</p>`;
  if (closed.length) stockTable($("#t-closed"), closed, [stockCol, c.entryDate, c.exitDate, c.entry, c.exit, c.qty, c.pnl, c.pct, c.r, c.days, off(c.setup), off(c.stop), off(c.cost)],
    { sort: "exit_date", dir: -1, id: "j-closed" });
  else $("#t-closed").innerHTML = `<p class="empty">Closed trades appear here once you add an exit price and date.</p>`;

  $("#j-add").onclick = () => tradeDialog(null, idx, asOf);
  $("#j-csv").onclick = () => downloadCSV(all);
  if (sub === "new") tradeDialog(null, idx, asOf, params.get("s"));
  if (sub === "edit") {
    const t = trades.find((x) => x.id === arg);
    if (t) tradeDialog(t, idx, asOf);
  }
}

function tradeDialog(t, idx, asOf, presetKey = null) {
  const s0 = t ? idx.byKey[t.key] : presetKey ? idx.byKey[presetKey] : null;
  const v = (k, d = "") => (t && t[k] != null ? t[k] : d);
  const symVal = t ? sym(t.key) : s0 ? sym(s0.key) : "";
  const body = `
    <div class="form-grid">
      <label class="field wide">Stock${stockPicker("stock", idx, symVal)}<span class="hint" id="f-name">${s0 ? `${esc(nice(s0.name, s0.key))}, last ${fmt.px(s0.close)}` : ""}</span></label>
      <label class="field">Direction<select name="side"><option value="long" ${v("side") !== "short" ? "selected" : ""}>Long (bought)</option><option value="short" ${v("side") === "short" ? "selected" : ""}>Short (sold first)</option></select></label>
      <label class="field">Setup<input name="setup" list="dl-setups" value="${esc(v("setup"))}" placeholder="Optional"><datalist id="dl-setups">${SETUPS.map((x) => `<option value="${x}">`).join("")}</datalist></label>
      <label class="field">Entry date<input type="date" name="entry_date" required value="${v("entry_date", asOf)}"></label>
      <label class="field">Entry price<input type="number" name="entry_price" step="any" min="0" required value="${v("entry_price", s0 && !t ? s0.close : "")}"></label>
      <label class="field">Quantity<input type="number" name="qty" step="any" min="0" required value="${v("qty")}"></label>
      <label class="field">Stop loss<input type="number" name="stop" step="any" min="0" value="${v("stop")}" placeholder="Optional"></label>
      <label class="field">Target<input type="number" name="target" step="any" min="0" value="${v("target")}" placeholder="Optional"></label>
      <p class="calc wide" id="f-calc"></p>
      <fieldset class="wide"><legend>Exit <span class="muted">(leave empty while the trade is open)</span></legend>
        <div class="form-grid">
          <label class="field">Exit date<input type="date" name="exit_date" value="${v("exit_date")}"></label>
          <label class="field">Exit price<input type="number" name="exit_price" step="any" min="0" value="${v("exit_price")}"></label>
        </div></fieldset>
      <label class="field wide">Notes<textarea name="notes" rows="3" maxlength="2000" placeholder="Why you took it, what you'd do differently">${esc(v("notes"))}</textarea></label>
    </div>`;
  const d = formDialog(t ? `Edit ${esc(sym(t.key))} trade` : "Log a trade", body, async (fd) => {
    const s = idx.find(fd.get("stock")) || (t && sym(t.key) === fd.get("stock").trim() ? { key: t.key } : null);
    if (!s) throw new Error("Pick a stock from the suggestions.");
    const num = (k) => (fd.get(k) === "" ? null : +fd.get(k));
    const row = {
      key: s.key, side: fd.get("side"), setup: fd.get("setup").trim() || null, notes: fd.get("notes").trim() || null,
      entry_date: fd.get("entry_date"), entry_price: num("entry_price"), qty: num("qty"),
      stop: num("stop"), target: num("target"), exit_date: fd.get("exit_date") || null, exit_price: num("exit_price"),
    };
    if (!row.entry_date || !(row.entry_price > 0) || !(row.qty > 0)) throw new Error("Entry date, entry price and quantity are needed.");
    if ((row.exit_date == null) !== (row.exit_price == null)) throw new Error("To close the trade, fill in both exit date and exit price.");
    if (row.exit_date && row.exit_date < row.entry_date) throw new Error("The exit date is before the entry date.");
    const r = t ? await db().from("trades").update(row).eq("id", t.id) : await db().from("trades").insert(row);
    rows(r);
    toast(t ? "Trade updated." : "Trade saved.");
    if (location.hash === "#/journal") route(); else location.hash = "#/journal";
  }, { extra: t ? `<button type="button" id="f-del">Delete trade</button>` : "" });

  const f = $("form", d);
  const calc = () => {
    const s = idx.find(f.stock.value);
    $("#f-name", d).innerHTML = s ? `${esc(nice(s.name, s.key))}, last ${fmt.px(s.close)}` : "";
    const dir = f.side.value === "short" ? -1 : 1, e = +f.entry_price.value, q = +f.qty.value, st = +f.stop.value, tg = +f.target.value;
    const bits = [];
    if (e > 0 && q > 0) bits.push(`Position ${inr(e * q)}`);
    const risk = st > 0 ? dir * (e - st) : 0;
    if (e > 0 && st > 0) bits.push(risk > 0 ? `risk ${inr(risk * q || null)} (${((risk / e) * 100).toFixed(1)}% to stop)` : `<span class="down">stop is on the wrong side of the entry</span>`);
    if (risk > 0 && tg > 0) bits.push(`target is ${((dir * (tg - e)) / risk).toFixed(1)}R`);
    $("#f-calc", d).innerHTML = bits.join(", ");
  };
  // Suggest the latest close as entry price while a new trade's stock is being picked,
  // but never overwrite a price the user has typed.
  let priceTouched = !!t || !!f.entry_price.value && !s0;
  f.entry_price.addEventListener("input", () => (priceTouched = true));
  f.stock.addEventListener("input", () => {
    const s = idx.find(f.stock.value);
    if (s && !priceTouched) f.entry_price.value = s.close;
  });
  f.addEventListener("input", calc);
  calc();
  d.addEventListener("close", () => { if (location.hash.startsWith("#/journal/")) history.replaceState(null, "", "#/journal"); });
  const del = $("#f-del", d);
  if (del) twoStep(del, async () => {
    rows(await db().from("trades").delete().eq("id", t.id));
    d.close(); d.remove();
    toast("Trade deleted.");
    history.replaceState(null, "", "#/journal");
    route();
  });
}

function downloadCSV(all) {
  const head = ["symbol", "exchange", "side", "setup", "entry_date", "entry_price", "qty", "stop", "target", "exit_date", "exit_price", "price_used", "profit", "profit_pct", "r", "days", "notes"];
  const q = (x) => (x == null ? "" : /[",\n]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : String(x));
  const lines = all.map((t) => [sym(t.key), t.key.split(":")[0], t.side, t.setup, t.entry_date, t.entry_price, t.qty, t.stop, t.target, t.exit_date, t.exit_price,
    t.px, t.pnl == null ? null : t.pnl.toFixed(2), t.pct == null ? null : t.pct.toFixed(2), t.r == null ? null : t.r.toFixed(2), t.days, t.notes].map(q).join(","));
  const blob = new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `stage-lab-journal-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
