/* Localiser — app des parents et proches (PWA, sans étape de build). */
/* global supabase, L, qrcode */

const CFG = window.LOCALISER_CONFIG || {};
const APP_URL = location.origin + location.pathname;
const FUNCTIONS_URL = (CFG.supabaseUrl || "") + "/functions/v1";
const OWNTRACKS_APPSTORE = "https://apps.apple.com/app/owntracks/id692424691";
const COLORS = ["#2563eb", "#e11d48", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#4b5563"];
const WATCH_EVERY_MS = 15000;
const LIVE_MAX_AGE_S = 30;

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// Petits utilitaires
// ---------------------------------------------------------------------------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function initials(name) {
  const clean = String(name || "?").normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  const s = parts.length > 1 ? parts[0][0] + parts[1][0] : clean.slice(0, 2);
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "X").padEnd(2, "X");
}

function ago(date) {
  if (!date) return "jamais";
  const t = new Date(date).getTime();
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 10) return "à l'instant";
  if (s < 60) return `il y a ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const hrs = Math.floor(m / 60);
  if (hrs < 6) return `il y a ${hrs} h ${String(m % 60).padStart(2, "0")}`;
  const d = new Date(t);
  const today = new Date();
  const yest = new Date(Date.now() - 86400000);
  const hm = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `à ${hm}`;
  if (d.toDateString() === yest.toDateString()) return `hier à ${hm}`;
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }) + ` à ${hm}`;
}

function ageSeconds(date) {
  return date ? (Date.now() - new Date(date).getTime()) / 1000 : Infinity;
}

function distanceM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function toast(text, opts = {}) {
  const el = h("div", { class: "toast" + (opts.sos ? " sos" : "") }, text);
  if (opts.onclick) el.addEventListener("click", () => { opts.onclick(); el.remove(); });
  $("#toasts").append(el);
  setTimeout(() => el.remove(), opts.sos ? 20000 : 5000);
}

function errorText(e) {
  const m = String(e?.message || e || "");
  if (m.includes("invalid_code")) return "Code invalide, expiré ou déjà utilisé.";
  if (m.includes("already_in_family")) return "Cet appareil fait déjà partie d'une famille.";
  if (m.includes("forbidden")) return "Action réservée aux parents.";
  if (/anonymous/i.test(m)) return "Les connexions anonymes ne sont pas activées dans Supabase (voir le guide d'installation).";
  if (/fetch|network/i.test(m)) return "Pas de connexion internet.";
  return m || "Erreur inconnue";
}

function qrImg(text) {
  const qr = qrcode(0, "L");
  qr.addData(text);
  qr.make();
  return h("div", { class: "qr" }, h("img", { src: qr.createDataURL(6, 4), alt: "QR code" }));
}

function b64utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

function urlB64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

function storeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function storeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } }

// ---------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------
const S = {
  sb: null,
  user: null,
  me: null,           // ligne members de l'utilisateur
  family: null,
  children: new Map(),
  members: [],
  zones: [],
  events: [],
  map: null,
  markers: new Map(),  // child_id -> { marker, circle }
  zoneLayer: null,
  historyLayer: null,
  history: null,       // { childId, dayOffset }
  channel: null,
  watchTimer: null,
  fitted: false,
};

const isParent = () => S.me?.role === "parent";

// ---------------------------------------------------------------------------
// Pages plein écran
// ---------------------------------------------------------------------------
const pageStack = [];

function openPage(title, render, { root = false } = {}) {
  if (root) pageStack.length = 0;
  pageStack.push({ title, render, root });
  showTopPage();
}

function showTopPage() {
  const top = pageStack[pageStack.length - 1];
  if (!top) { $("#page").hidden = true; return; }
  $("#page").hidden = false;
  $("#page-title").textContent = top.title;
  $("#page-back").hidden = !!top.root;
  const body = $("#page-body");
  body.replaceChildren();
  body.scrollTop = 0;
  top.render(body);
}

function closePage() {
  pageStack.pop();
  showTopPage();
}

function closeAllPages() {
  pageStack.length = 0;
  showTopPage();
}

$("#page-back").addEventListener("click", closePage);

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
async function start() {
  const hash = new URLSearchParams(location.hash.slice(1));

  if (hash.get("sos")) {
    renderSosSetup(hash.get("sos"));
    return;
  }

  if (!CFG.supabaseUrl || !CFG.supabaseKey) {
    openPage("Configuration manquante", (b) => b.append(
      h("p", {}, "Le fichier config.js ne contient pas l'adresse Supabase et la clé publique."),
      h("p", { class: "muted" }, "Il est généré automatiquement par le déploiement GitHub Actions (voir docs/INSTALLATION.md)."),
    ), { root: true });
    return;
  }

  S.sb = supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW", e));
  }

  const invite = hash.get("invite");
  if (invite) history.replaceState(null, "", APP_URL);

  const { data: { session } } = await S.sb.auth.getSession();
  S.user = session?.user || null;

  if (S.user && await loadMembership()) {
    await enterApp();
    if (hash.has("alerts")) openAlerts();
    return;
  }
  // Sur iPhone, l'app doit être installée sur l'écran d'accueil AVANT de
  // rejoindre (Safari et l'app installée ne partagent pas la connexion).
  if (invite && isIOS && !isStandalone) {
    renderInstallIOS(invite);
    return;
  }
  renderOnboarding(invite);
}

async function loadMembership() {
  const { data, error } = await S.sb.from("members").select("*").eq("user_id", S.user.id).limit(1);
  if (error) throw error;
  S.me = data?.[0] || null;
  return !!S.me;
}

// ---------------------------------------------------------------------------
// Accueil : créer / rejoindre une famille
// ---------------------------------------------------------------------------
function renderOnboarding(inviteCode) {
  openPage("Bienvenue", (b) => {
    b.append(h("p", {}, "Localiser permet à la famille de voir en direct où sont les enfants."));
    if (inviteCode) {
      b.append(joinForm(inviteCode));
      return;
    }
    b.append(
      h("div", { class: "card stack" },
        h("strong", {}, "Premier parent ?"),
        h("p", { class: "muted small" }, "Créez la famille sur ce téléphone. Vous inviterez ensuite l'autre parent, les proches et les enfants avec des QR codes."),
        h("button", { class: "btn block", onclick: () => openPage("Créer la famille", (bb) => bb.append(createForm())) }, "Créer ma famille"),
      ),
      h("div", { class: "card stack" },
        h("strong", {}, "On vous a invité ?"),
        h("p", { class: "muted small" }, "Scannez le QR code affiché sur le téléphone d'un parent avec l'appareil photo, ou saisissez le code."),
        h("button", { class: "btn ghost block", onclick: () => openPage("Rejoindre", (bb) => bb.append(joinForm(""))) }, "J'ai un code d'invitation"),
      ),
    );
    if (isIOS && !isStandalone) {
      b.append(h("p", { class: "muted small" }, "Astuce iPhone : ajoutez d'abord Localiser à l'écran d'accueil (bouton Partager ⬆︎ puis « Sur l'écran d'accueil ») et ouvrez-le depuis là, pour recevoir les alertes."));
    }
  }, { root: true });
}

async function ensureSignedIn() {
  if (S.user) return;
  const { data, error } = await S.sb.auth.signInAnonymously();
  if (error) throw error;
  S.user = data.user;
}

function createForm() {
  const fam = h("input", { maxlength: 60, placeholder: "Famille Martin", required: true });
  const name = h("input", { maxlength: 40, placeholder: "Papa, Maman, Jean…", required: true });
  const err = h("p", { class: "danger-text small" });
  const btn = h("button", { class: "btn block", type: "submit" }, "Créer");
  return h("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = "";
      btn.disabled = true;
      try {
        await ensureSignedIn();
        const { error } = await S.sb.rpc("create_family", { p_family_name: fam.value, p_display_name: name.value });
        if (error) throw error;
        await loadMembership();
        closeAllPages();
        await enterApp();
        openFamily();
      } catch (ex) {
        err.textContent = errorText(ex);
      } finally {
        btn.disabled = false;
      }
    },
  },
  h("label", { class: "field" }, "Nom de la famille", fam),
  h("label", { class: "field" }, "Votre prénom (vu par la famille)", name),
  err, btn);
}

function joinForm(code) {
  const codeIn = h("input", { maxlength: 12, placeholder: "ABCD2345", value: code || "", autocapitalize: "characters", required: true, style: { textTransform: "uppercase", letterSpacing: ".1em" } });
  const name = h("input", { maxlength: 40, placeholder: "Mamie, Papi, Maman…", required: true });
  const err = h("p", { class: "danger-text small" });
  const btn = h("button", { class: "btn block", type: "submit" }, "Rejoindre la famille");
  return h("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = "";
      btn.disabled = true;
      try {
        await ensureSignedIn();
        const { error } = await S.sb.rpc("join_family", { p_code: codeIn.value, p_display_name: name.value });
        if (error) throw error;
        await loadMembership();
        closeAllPages();
        await enterApp();
        toast("Bienvenue dans la famille 👋");
        suggestNotifications();
      } catch (ex) {
        err.textContent = errorText(ex);
      } finally {
        btn.disabled = false;
      }
    },
  },
  h("label", { class: "field" }, "Code d'invitation", codeIn),
  h("label", { class: "field" }, "Votre prénom (vu par la famille)", name),
  err, btn);
}

function renderInstallIOS(code) {
  openPage("Installer Localiser", (b) => b.append(
    h("p", {}, "Pour suivre les enfants et recevoir les alertes sur cet iPhone :"),
    h("ol", { class: "steps" },
      h("li", {}, "Touchez le bouton ", h("strong", {}, "Partager ⬆︎"), " en bas de Safari."),
      h("li", {}, "Choisissez ", h("strong", {}, "« Sur l'écran d'accueil »"), ", puis « Ajouter »."),
      h("li", {}, "Ouvrez ", h("strong", {}, "Localiser"), " depuis l'écran d'accueil."),
      h("li", {}, "Choisissez « J'ai un code d'invitation » et saisissez :"),
    ),
    h("div", { class: "card" }, h("div", { class: "code" }, code)),
    h("p", { class: "muted small" }, "Le code est valable 24 h et ne sert qu'une fois."),
    h("button", { class: "btn ghost block", onclick: () => { closeAllPages(); renderOnboarding(code); } }, "Continuer quand même dans Safari"),
  ), { root: true });
}

// ---------------------------------------------------------------------------
// Application principale
// ---------------------------------------------------------------------------
async function enterApp() {
  const fid = S.me.family_id;
  const [fam, kids, mem, zones, events] = await Promise.all([
    S.sb.from("families").select("*").eq("id", fid).single(),
    S.sb.from("children").select("*").eq("family_id", fid).order("created_at"),
    S.sb.from("members").select("*").eq("family_id", fid).order("created_at"),
    S.sb.from("zones").select("*").eq("family_id", fid).order("name"),
    S.sb.from("events").select("*").eq("family_id", fid).order("created_at", { ascending: false }).limit(50),
  ]);
  for (const r of [fam, kids, mem, zones, events]) if (r.error) throw r.error;
  S.family = fam.data;
  S.children = new Map(kids.data.map((c) => [c.id, c]));
  S.members = mem.data;
  S.zones = zones.data;
  S.events = events.data;

  $("#family-name").textContent = S.family.name;
  $("#topbar").hidden = false;
  $("#sheet").hidden = false;

  initMap();
  renderZones();
  renderChildren();
  renderAlertsBadge();
  fitAll();
  subscribeRealtime();
  startWatching();
  setInterval(refreshTimes, 1000);
}

// ----- carte -----
function initMap() {
  if (S.map) return;
  S.map = L.map("map", { zoomControl: false, attributionControl: true }).setView([46.6, 2.4], 5);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(S.map);
  S.zoneLayer = L.layerGroup().addTo(S.map);
}

function fitAll() {
  const pts = [...S.children.values()].filter((c) => c.lat != null).map((c) => [c.lat, c.lon]);
  if (pts.length === 1) S.map.setView(pts[0], 15);
  else if (pts.length > 1) S.map.fitBounds(pts, { padding: [60, 60], maxZoom: 16 });
  else if (S.zones.length) S.map.fitBounds(S.zones.map((z) => [z.lat, z.lon]), { padding: [60, 60], maxZoom: 15 });
  S.fitted = pts.length > 0;
}

function childState(c) {
  const age = ageSeconds(c.last_fix_at);
  const seen = ageSeconds(c.last_seen_at);
  const silentLimit = c.idle_mode === "reactif" ? 30 * 60 : 12 * 3600;
  if (!c.last_seen_at) return { key: "never", label: "Jamais connecté", cls: "off" };
  if (c.profile === "direct" && age <= LIVE_MAX_AGE_S) return { key: "live", label: "EN DIRECT", cls: "live" };
  if (seen > silentLimit) return { key: "off", label: "Sans nouvelles", cls: "off" };
  if (c.profile !== "direct") return { key: "wait", label: "Passage en direct…", cls: "wait" };
  return { key: "idle", label: "", cls: "" };
}

function avatarEl(c) {
  return h("div", { class: "avatar", style: { background: c.color } }, c.name.trim()[0]?.toUpperCase() || "?");
}

function battText(c) {
  if (c.batt == null) return "";
  const charging = c.batt_status === 2 || c.batt_status === 3;
  return (charging ? "⚡" : "🔋") + " " + c.batt + " %";
}

function metaText(c) {
  const st = childState(c);
  const parts = [ago(c.last_fix_at)];
  if (c.acc) parts.push(`±${c.acc} m`);
  if (c.vel && c.vel > 2) parts.push(`${c.vel} km/h`);
  if (st.key === "wait") parts.push("bascule au prochain envoi du téléphone");
  return parts.join(" · ");
}

function renderChildren() {
  const list = $("#children-list");
  list.replaceChildren();
  $("#children-empty").hidden = S.children.size > 0;
  for (const c of S.children.values()) {
    const st = childState(c);
    list.append(h("li", { class: "child-item", "data-id": c.id },
      avatarEl(c),
      h("div", { class: "child-main", onclick: () => focusChild(c.id) },
        h("div", { class: "name" }, c.name, " ", st.label ? h("span", { class: "pill " + st.cls }, st.label) : null),
        h("div", { class: "meta" }, metaText(c)),
      ),
      h("span", { class: "batt" + (c.batt != null && c.batt < 15 ? " low" : "") }, battText(c)),
      h("div", { class: "child-actions" },
        h("button", { class: "icon-btn small", "aria-label": "Historique de " + c.name, onclick: () => openHistory(c.id) }, "🕘"),
      ),
    ));
    updateMarker(c);
  }
  for (const id of [...S.markers.keys()]) {
    if (!S.children.has(id)) {
      S.markers.get(id).marker.remove();
      S.markers.get(id).circle.remove();
      S.markers.delete(id);
    }
  }
  renderLiveStatus();
}

function refreshTimes() {
  let rerender = false;
  for (const li of document.querySelectorAll(".child-item")) {
    const c = S.children.get(li.dataset.id);
    if (!c) continue;
    const st = childState(c);
    li.querySelector(".meta").textContent = metaText(c);
    const pill = li.querySelector(".pill");
    if ((pill ? pill.textContent : "") !== st.label) rerender = true;
  }
  if (rerender) renderChildren();
  else renderLiveStatus();
}

function renderLiveStatus() {
  const el = $("#live-status");
  const states = [...S.children.values()].map(childState);
  const live = states.filter((s) => s.key === "live").length;
  if (!S.children.size) { el.textContent = ""; return; }
  if (live) {
    el.textContent = `● En direct (${live}/${S.children.size})`;
    el.className = "live-status on";
  } else {
    el.textContent = document.visibilityState === "visible" ? "Demande du direct envoyée" : "";
    el.className = "live-status";
  }
}

function markerIcon(c) {
  const st = childState(c);
  const letter = c.name.trim()[0]?.toUpperCase() || "?";
  return L.divIcon({
    className: "marker" + (st.key === "off" ? " stale" : ""),
    iconSize: [38, 38],
    iconAnchor: [19, 19],
    html: `${st.key === "live" ? '<span class="pulse"></span>' : ""}<div class="avatar" style="background:${esc(c.color)}">${esc(letter)}</div>`,
  });
}

function popupHtml(c) {
  return `<strong>${esc(c.name)}</strong><br>${esc(ago(c.last_fix_at))}${c.acc ? ` · ±${c.acc} m` : ""}<br>${esc(battText(c))}`;
}

function updateMarker(c) {
  if (c.lat == null || c.lon == null) return;
  const ll = [c.lat, c.lon];
  let m = S.markers.get(c.id);
  if (!m) {
    const marker = L.marker(ll, { icon: markerIcon(c), zIndexOffset: 1000 }).addTo(S.map);
    marker.bindPopup(() => popupHtml(c));
    const circle = L.circle(ll, { radius: c.acc || 0, color: c.color, weight: 1, fillOpacity: 0.08, interactive: false }).addTo(S.map);
    m = { marker, circle };
    S.markers.set(c.id, m);
  } else {
    m.marker.setLatLng(ll);
    m.marker.setIcon(markerIcon(c));
    m.marker.setPopupContent(popupHtml(c));
    m.circle.setLatLng(ll).setRadius(c.acc || 0).setStyle({ color: c.color });
  }
}

function focusChild(id) {
  const c = S.children.get(id);
  if (!c) return;
  if (c.lat == null) {
    toast(`${c.name} n'a encore envoyé aucune position.`);
    return;
  }
  S.map.flyTo([c.lat, c.lon], Math.max(S.map.getZoom(), 16), { duration: 0.6 });
  S.markers.get(id)?.marker.openPopup();
}

function renderZones() {
  if (!S.zoneLayer) return;
  S.zoneLayer.clearLayers();
  for (const z of S.zones) {
    L.circle([z.lat, z.lon], { radius: z.radius_m, color: "#0f766e", weight: 2, dashArray: "6 6", fillOpacity: 0.06, interactive: false })
      .bindTooltip(z.name, { permanent: true, direction: "center", className: "zone-label" })
      .addTo(S.zoneLayer);
  }
}

// ----- temps réel -----
function subscribeRealtime() {
  const fid = S.family.id;
  if (S.channel) S.sb.removeChannel(S.channel);
  S.channel = S.sb.channel("famille-" + fid)
    .on("postgres_changes", { event: "*", schema: "public", table: "children", filter: `family_id=eq.${fid}` }, (p) => {
      if (p.eventType === "DELETE") S.children.delete(p.old.id);
      else S.children.set(p.new.id, p.new);
      renderChildren();
      if (p.eventType !== "DELETE" && S.history?.childId === p.new.id && S.history.dayOffset === 0) appendHistoryPoint(p.new);
      if (!S.fitted && p.new?.lat != null) fitAll();
    })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "events", filter: `family_id=eq.${fid}` }, (p) => {
      S.events.unshift(p.new);
      S.events = S.events.slice(0, 100);
      renderAlertsBadge();
      const ev = p.new;
      toast(ev.title, { sos: ev.type === "sos", onclick: () => showEventOnMap(ev) });
      if (ev.type === "sos" && navigator.vibrate) navigator.vibrate([400, 150, 400, 150, 400]);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "zones", filter: `family_id=eq.${fid}` }, async () => {
      const { data } = await S.sb.from("zones").select("*").eq("family_id", fid).order("name");
      S.zones = data || [];
      renderZones();
    })
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        setTimeout(() => subscribeRealtime(), 5000);
      }
    });
}

// Recharge les données au retour sur l'app (après une mise en veille)
async function resync() {
  if (!S.family) return;
  const fid = S.family.id;
  const [kids, events] = await Promise.all([
    S.sb.from("children").select("*").eq("family_id", fid).order("created_at"),
    S.sb.from("events").select("*").eq("family_id", fid).order("created_at", { ascending: false }).limit(50),
  ]);
  if (!kids.error) { S.children = new Map(kids.data.map((c) => [c.id, c])); renderChildren(); }
  if (!events.error) { S.events = events.data; renderAlertsBadge(); }
}

// ----- « je regarde » : demande le mode direct aux téléphones -----
async function sendWatch() {
  if (!S.family || document.visibilityState !== "visible") return;
  const { error } = await S.sb.rpc("watch", { p_family_id: S.family.id });
  if (error) console.warn("watch", error);
}

function startWatching() {
  clearInterval(S.watchTimer);
  sendWatch();
  S.watchTimer = setInterval(sendWatch, WATCH_EVERY_MS);
}

document.addEventListener("visibilitychange", () => {
  if (!S.family) return;
  if (document.visibilityState === "visible") {
    startWatching();
    resync();
    S.sb.realtime?.connect?.();
  } else {
    clearInterval(S.watchTimer);
    S.sb.rpc("unwatch", { p_family_id: S.family.id }).then(() => {}, () => {});
  }
});

// ---------------------------------------------------------------------------
// Historique
// ---------------------------------------------------------------------------
function dayRange(offset) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - offset);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start, end];
}

function dayLabel(offset) {
  if (offset === 0) return "Aujourd'hui";
  if (offset === 1) return "Hier";
  const [d] = dayRange(offset);
  return d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric" });
}

function openHistory(childId) {
  closeAllPages();
  S.history = { childId, dayOffset: 0 };
  $("#sheet").hidden = true;
  $("#history-bar").hidden = false;
  loadHistory();
}

function closeHistory() {
  S.history = null;
  S.historyLayer?.remove();
  S.historyLayer = null;
  $("#history-bar").hidden = true;
  $("#sheet").hidden = false;
}
$("#history-close").addEventListener("click", closeHistory);

async function loadHistory() {
  const { childId, dayOffset } = S.history;
  const c = S.children.get(childId);
  $("#history-title").textContent = "Trajets de " + (c?.name || "");
  const chips = $("#history-days");
  chips.replaceChildren(...[0, 1, 2, 3, 4, 5, 6].map((o) =>
    h("button", { class: "chip" + (o === dayOffset ? " on" : ""), onclick: () => { S.history.dayOffset = o; loadHistory(); } }, dayLabel(o))));
  $("#history-summary").textContent = "Chargement…";

  const [from, to] = dayRange(dayOffset);
  const rows = [];
  for (let page = 0; page < 20; page++) {
    const { data, error } = await S.sb.from("locations")
      .select("lat,lon,acc,recorded_at,trigger")
      .eq("child_id", childId)
      .gte("recorded_at", from.toISOString())
      .lt("recorded_at", to.toISOString())
      .order("recorded_at")
      .range(page * 1000, page * 1000 + 999);
    if (error) { $("#history-summary").textContent = errorText(error); return; }
    rows.push(...data);
    if (data.length < 1000) break;
  }
  if (!S.history || S.history.childId !== childId || S.history.dayOffset !== dayOffset) return;
  drawHistory(c, rows);
}

function drawHistory(c, rows) {
  S.historyLayer?.remove();
  S.historyLayer = L.layerGroup().addTo(S.map);
  const good = rows.filter((r) => !r.acc || r.acc <= 200);
  S.history.points = good.map((r) => [r.lat, r.lon]);
  S.history.line = L.polyline(S.history.points, { color: c.color, weight: 5, opacity: 0.85 }).addTo(S.historyLayer);
  if (good.length <= 1500) {
    for (const r of good) {
      L.circleMarker([r.lat, r.lon], { radius: 3, color: c.color, weight: 1, fillOpacity: 1 })
        .bindTooltip(new Date(r.recorded_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }))
        .addTo(S.historyLayer);
    }
  }
  if (!good.length) {
    $("#history-summary").textContent = "Aucune position enregistrée ce jour-là.";
    return;
  }
  const first = good[0], last = good[good.length - 1];
  L.circleMarker([first.lat, first.lon], { radius: 8, color: "#fff", weight: 3, fillColor: "#16a34a", fillOpacity: 1 }).bindTooltip("Départ").addTo(S.historyLayer);
  L.circleMarker([last.lat, last.lon], { radius: 8, color: "#fff", weight: 3, fillColor: "#dc2626", fillOpacity: 1 }).bindTooltip("Dernière position").addTo(S.historyLayer);
  S.map.fitBounds(S.history.points, { padding: [40, 40], maxZoom: 17 });
  updateHistorySummary(good);
}

function updateHistorySummary(good) {
  let dist = 0;
  for (let i = 1; i < good.length; i++) dist += distanceM([good[i - 1].lat, good[i - 1].lon], [good[i].lat, good[i].lon]);
  const t = (r) => new Date(r.recorded_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  $("#history-summary").textContent =
    `${good.length} positions · ${(dist / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} km · de ${t(good[0])} à ${t(good[good.length - 1])}`;
}

function appendHistoryPoint(c) {
  if (!S.history?.line || c.lat == null || (c.acc && c.acc > 200)) return;
  S.history.points.push([c.lat, c.lon]);
  S.history.line.setLatLngs(S.history.points);
}

// ---------------------------------------------------------------------------
// Alertes
// ---------------------------------------------------------------------------
function unseenCount() {
  const lastSeen = Number(storeGet("localiser.lastSeenEvent") || 0);
  return S.events.filter((e) => e.id > lastSeen).length;
}

function renderAlertsBadge() {
  const n = unseenCount();
  const b = $("#alerts-badge");
  b.hidden = n === 0;
  b.textContent = n > 9 ? "9+" : String(n);
}

function showEventOnMap(ev) {
  closeAllPages();
  if (ev.lat != null) {
    S.map.flyTo([ev.lat, ev.lon], 16, { duration: 0.6 });
    L.popup().setLatLng([ev.lat, ev.lon]).setContent(`<strong>${esc(ev.title)}</strong><br>${esc(ev.body)}<br><small>${esc(ago(ev.created_at))}</small>`).openOn(S.map);
  }
}

function openAlerts() {
  openPage("Alertes", (b) => {
    if (S.events.length) storeSet("localiser.lastSeenEvent", String(Math.max(...S.events.map((e) => e.id))));
    renderAlertsBadge();
    if (!S.events.length) {
      b.append(h("p", { class: "muted center" }, "Aucune alerte pour l'instant."));
      return;
    }
    for (const ev of S.events) {
      b.append(h("div", { class: "event" + (ev.type === "sos" ? " sos" : ""), onclick: () => showEventOnMap(ev) },
        h("div", { class: "grow" },
          h("div", {}, h("strong", {}, ev.title)),
          ev.body ? h("div", { class: "small" }, ev.body) : null,
          h("div", { class: "when" }, ago(ev.created_at)),
        ),
      ));
    }
  });
}
$("#btn-alerts").addEventListener("click", openAlerts);

// ---------------------------------------------------------------------------
// Notifications push
// ---------------------------------------------------------------------------
async function pushState() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return isIOS && !isStandalone ? "ios-install" : "unsupported";
  }
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? "on" : "off";
}

async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notifications refusées dans les réglages du téléphone.");
  const reg = await navigator.serviceWorker.ready;
  const res = await fetch(FUNCTIONS_URL + "/push-key");
  if (!res.ok) throw new Error("Serveur de notifications indisponible.");
  const { publicKey } = await res.json();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(publicKey) });
  }
  const j = sub.toJSON();
  const { error } = await S.sb.from("push_subscriptions").upsert({
    endpoint: j.endpoint, user_id: S.user.id, family_id: S.family.id, p256dh: j.keys.p256dh, auth: j.keys.auth,
  }, { onConflict: "endpoint" });
  if (error) throw error;
}

async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await S.sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
    await sub.unsubscribe();
  }
}

async function suggestNotifications() {
  if ((await pushState()) === "off") {
    toast("Activez les alertes (SOS, zones…) depuis le menu ☰ → Notifications.", { onclick: openFamily });
  }
}

function notificationsCard() {
  const card = h("div", { class: "card stack" }, h("p", { class: "muted small" }, "Vérification…"));
  (async () => {
    const st = await pushState();
    const btn = (label, fn, cls = "btn block") => h("button", {
      class: cls,
      onclick: async (e) => {
        e.target.disabled = true;
        try { await fn(); toast("C'est fait ✅"); } catch (ex) { toast(errorText(ex)); }
        card.replaceWith(notificationsCard());
      },
    }, label);
    const texts = {
      "on": "✅ Les alertes (SOS, zones, batterie, silence) arrivent sur cet appareil, même app fermée.",
      "off": "Les alertes ne sont pas activées sur cet appareil.",
      "denied": "Les notifications sont bloquées pour Localiser dans les réglages du téléphone. Autorisez-les puis revenez ici.",
      "ios-install": "Sur iPhone, les alertes ne fonctionnent que si Localiser est ajouté à l'écran d'accueil (Partager ⬆︎ → « Sur l'écran d'accueil ») et ouvert depuis là.",
      "unsupported": "Ce navigateur ne permet pas les notifications. Sur Android, utilisez Chrome.",
    };
    card.replaceChildren(h("p", {}, texts[st]));
    if (st === "off") card.append(btn("Activer les alertes", enablePush));
    if (st === "on") card.append(btn("Désactiver sur cet appareil", disablePush, "btn ghost block"));
  })();
  return card;
}

// ---------------------------------------------------------------------------
// Famille, enfants, zones, membres
// ---------------------------------------------------------------------------
function openFamily() {
  openPage("Famille", (b) => {
    // Enfants
    b.append(h("h2", {}, "Enfants"));
    const kids = h("ul", { class: "list" });
    for (const c of S.children.values()) {
      const st = childState(c);
      kids.append(h("li", {},
        avatarEl(c),
        h("div", { class: "grow" }, h("div", {}, c.name), h("div", { class: "sub" }, (st.label ? st.label + " · " : "") + ago(c.last_seen_at) + (c.batt != null ? " · " + battText(c) : ""))),
        isParent() ? h("button", { class: "btn small ghost", onclick: () => openChild(c.id) }, "Gérer") : null,
      ));
    }
    if (!S.children.size) kids.append(h("li", { class: "muted" }, "Aucun enfant."));
    b.append(kids);
    if (isParent()) b.append(h("button", { class: "btn block", onclick: openAddChild }, "＋ Ajouter un enfant"));

    // Zones
    b.append(h("h2", {}, "Zones (alertes d'arrivée / de départ)"));
    const zl = h("ul", { class: "list" });
    for (const z of S.zones) {
      zl.append(h("li", {},
        h("div", { class: "grow" }, h("div", {}, "📍 " + z.name), h("div", { class: "sub" }, `rayon ${z.radius_m} m`)),
        h("button", { class: "btn small ghost", onclick: () => { closeAllPages(); S.map.flyTo([z.lat, z.lon], 16); } }, "Voir"),
        isParent() ? h("button", {
          class: "btn small ghost", "aria-label": "Supprimer " + z.name,
          onclick: async () => {
            if (!confirm(`Supprimer la zone « ${z.name} » ?`)) return;
            const { error } = await S.sb.from("zones").delete().eq("id", z.id);
            if (error) return toast(errorText(error));
            S.zones = S.zones.filter((x) => x.id !== z.id);
            renderZones();
            showTopPage();
          },
        }, "🗑") : null,
      ));
    }
    if (!S.zones.length) zl.append(h("li", { class: "muted small" }, "Aucune zone. Exemple : Maison, École, Club de sport."));
    b.append(zl);
    if (isParent()) b.append(h("button", { class: "btn ghost block", onclick: startZonePlacement }, "＋ Ajouter une zone"));

    // Membres
    b.append(h("h2", {}, "Parents et proches"));
    const ml = h("ul", { class: "list" });
    for (const m of S.members) {
      const me = m.user_id === S.user.id;
      ml.append(h("li", {},
        h("div", { class: "grow" }, h("div", {}, m.display_name + (me ? " (vous)" : "")), h("div", { class: "sub" }, m.role === "parent" ? "Parent" : "Proche (consultation)")),
        isParent() && !me ? h("button", {
          class: "btn small ghost",
          onclick: async () => {
            if (!confirm(`Retirer ${m.display_name} de la famille ?`)) return;
            const { error } = await S.sb.from("members").delete().eq("family_id", m.family_id).eq("user_id", m.user_id);
            if (error) return toast(errorText(error));
            S.members = S.members.filter((x) => x.user_id !== m.user_id);
            showTopPage();
          },
        }, "Retirer") : null,
      ));
    }
    b.append(ml);
    if (isParent()) {
      b.append(h("div", { class: "row gap" },
        h("button", { class: "btn", onclick: () => openInvite("parent") }, "Inviter un parent"),
        h("button", { class: "btn ghost", onclick: () => openInvite("proche") }, "Inviter un proche"),
      ));
    }

    // Notifications
    b.append(h("h2", {}, "Notifications sur cet appareil"), notificationsCard());

    // Appareil
    b.append(h("h2", {}, "Cet appareil"),
      h("button", {
        class: "btn ghost block",
        onclick: async () => {
          const parents = S.members.filter((m) => m.role === "parent");
          const warn = isParent() && parents.length === 1
            ? "Vous êtes le seul parent : personne ne pourra plus gérer la famille. Quitter quand même ?"
            : "Quitter la famille sur cet appareil ? Il faudra une nouvelle invitation pour revenir.";
          if (!confirm(warn)) return;
          try { await disablePush(); } catch { /* ignoré */ }
          await S.sb.from("members").delete().eq("family_id", S.family.id).eq("user_id", S.user.id);
          await S.sb.auth.signOut();
          location.reload();
        },
      }, "Quitter la famille"),
      h("p", { class: "muted small" }, "Localiser · données hébergées sur votre projet Supabase · historique conservé 7 jours."),
    );
  });
}
$("#btn-menu").addEventListener("click", openFamily);

function openInvite(role) {
  openPage(role === "parent" ? "Inviter un parent" : "Inviter un proche", (b) => {
    b.append(h("p", { class: "muted" }, "Création du code…"));
    S.sb.rpc("create_invite", { p_family_id: S.family.id, p_role: role }).then(({ data, error }) => {
      b.replaceChildren();
      if (error) { b.append(h("p", { class: "danger-text" }, errorText(error))); return; }
      const link = `${APP_URL}#invite=${data.code}`;
      b.append(
        h("p", {}, role === "parent"
          ? "Sur le téléphone de l'autre parent, ouvrez l'appareil photo et scannez ce QR code :"
          : "Sur le téléphone du proche, ouvrez l'appareil photo et scannez ce QR code :"),
        qrImg(link),
        h("p", { class: "center muted small" }, "ou saisissez ce code dans Localiser :"),
        h("div", { class: "code" }, data.code),
        h("p", { class: "muted small" }, "Valable 24 h, pour une seule personne. " +
          (role === "proche" ? "Un proche peut voir la carte et recevoir les alertes, mais pas modifier la famille." : "Un parent peut tout gérer.")),
        h("p", { class: "muted small" }, "Sur iPhone, la page expliquera comment ajouter Localiser à l'écran d'accueil."),
        navigator.share
          ? h("button", { class: "btn ghost block", onclick: () => navigator.share({ title: "Rejoindre la famille sur Localiser", text: `Code : ${data.code}`, url: link }).catch(() => {}) }, "Envoyer le lien…")
          : "",
      );
    });
  });
}

function colorPicker(initial) {
  let value = initial;
  const wrap = h("div", { class: "colors" });
  const draw = () => wrap.replaceChildren(...COLORS.map((c) => h("button", {
    type: "button", class: c === value ? "on" : "", style: { background: c }, "aria-label": "Couleur " + c,
    onclick: () => { value = c; draw(); },
  })));
  draw();
  return { el: wrap, get value() { return value; } };
}

function openAddChild() {
  openPage("Ajouter un enfant", (b) => {
    const used = new Set([...S.children.values()].map((c) => c.color));
    const name = h("input", { maxlength: 40, placeholder: "Prénom", required: true });
    const color = colorPicker(COLORS.find((c) => !used.has(c)) || COLORS[0]);
    const err = h("p", { class: "danger-text small" });
    const btn = h("button", { class: "btn block", type: "submit" }, "Ajouter et configurer son iPhone");
    b.append(h("form", {
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        const { data, error } = await S.sb.rpc("add_child", { p_family_id: S.family.id, p_name: name.value, p_color: color.value });
        btn.disabled = false;
        if (error) { err.textContent = errorText(error); return; }
        closePage();
        openChildSetup(name.value.trim(), data);
      },
    },
    h("label", { class: "field" }, "Prénom", name),
    h("div", { class: "field" }, "Couleur sur la carte", color.el),
    err, btn));
  });
}

function openChild(id) {
  const c = S.children.get(id);
  if (!c) return;
  openPage(c.name, (b) => {
    const name = h("input", { maxlength: 40, value: c.name, required: true });
    const color = colorPicker(c.color);
    const mode = h("select", {},
      h("option", { value: "eco", selected: c.idle_mode === "eco" }, "Économie (recommandé)"),
      h("option", { value: "reactif", selected: c.idle_mode === "reactif" }, "Réactif"),
    );
    const err = h("p", { class: "danger-text small" });
    b.append(
      h("form", {
        onsubmit: async (e) => {
          e.preventDefault();
          const { error } = await S.sb.from("children").update({ name: name.value.trim(), color: color.value, idle_mode: mode.value }).eq("id", c.id);
          if (error) { err.textContent = errorText(error); return; }
          toast("Enregistré ✅");
          closePage();
        },
      },
      h("label", { class: "field" }, "Prénom", name),
      h("div", { class: "field" }, "Couleur", color.el),
      h("label", { class: "field" }, "Quand personne ne regarde la carte", mode),
      h("p", { class: "muted small" },
        "Économie : l'iPhone n'envoie sa position qu'en cas de déplacement important (environ 500 m). Batterie préservée, historique moins détaillé. ",
        "Réactif : une position au moins toutes les 3 minutes ou tous les 100 m. Le passage en direct est plus rapide quand vous ouvrez la carte, mais la batterie baisse davantage. ",
        "Dans les deux cas, dès qu'un parent ouvre la carte, l'iPhone passe en direct (une position toutes les 5 s) à son envoi suivant."),
      err,
      h("button", { class: "btn block", type: "submit" }, "Enregistrer")),
      h("h2", {}, "iPhone de " + c.name),
      h("p", { class: "muted small" }, "Pour installer ou réinstaller OwnTracks et le bouton SOS. Un nouveau QR code désactive l'ancienne configuration."),
      h("button", {
        class: "btn ghost block",
        onclick: async () => {
          if (!confirm("Générer une nouvelle configuration ? L'iPhone devra rescanner le QR code (et le Raccourci SOS devra être mis à jour).")) return;
          const { data, error } = await S.sb.rpc("reset_child_credentials", { p_child_id: c.id });
          if (error) return toast(errorText(error));
          closePage();
          openChildSetup(c.name, data);
        },
      }, "Nouveau QR code de configuration"),
      h("h2", {}, "Supprimer"),
      h("button", {
        class: "btn danger block",
        onclick: async () => {
          if (!confirm(`Supprimer ${c.name} et tout son historique ?`)) return;
          const { error } = await S.sb.from("children").delete().eq("id", c.id);
          if (error) return toast(errorText(error));
          S.children.delete(c.id);
          renderChildren();
          closePage();
          showTopPage();
        },
      }, "Supprimer " + c.name),
    );
  });
}

function ownTracksConfig(childName, creds) {
  return {
    _type: "configuration",
    mode: 3,
    url: FUNCTIONS_URL + "/owntracks",
    auth: true,
    username: creds.username,
    password: creds.password,
    deviceId: "iphone",
    tid: initials(childName),
    monitoring: 1,
    cmd: true,
    remoteConfiguration: true,
    allowRemoteLocation: true,
    extendedData: true,
    downgrade: 15,
    locked: true,
    maxHistory: 0,
    // Zone invisible qui suit l'enfant : quand il en sort, iOS relance
    // OwnTracks en arrière-plan, même si l'app a été fermée par balayage.
    waypoints: [{ _type: "waypoint", desc: "+follow", lat: 0, lon: 0, rad: 50, tst: 1000000000 }],
  };
}

function openChildSetup(childName, creds) {
  const cfg = ownTracksConfig(childName, creds);
  const otUrl = "owntracks:///config?inline=" + encodeURIComponent(b64utf8(JSON.stringify(cfg)));
  const sosUrl = `${APP_URL}#sos=${encodeURIComponent(creds.username + ":" + creds.password)}`;
  openPage("iPhone de " + childName, (b) => b.append(
    h("p", { class: "card small" }, "⚠️ Gardez cette page ouverte pendant l'installation : ces QR codes ne seront plus affichés ensuite (vous pourrez en générer de nouveaux)."),
    h("h2", {}, "1. Installer OwnTracks"),
    h("p", {}, "Sur l'iPhone de ", h("strong", {}, childName), ", installez l'app gratuite ", h("a", { href: OWNTRACKS_APPSTORE, target: "_blank", rel: "noopener" }, "OwnTracks"), " depuis l'App Store, puis ouvrez-la une première fois."),
    h("h2", {}, "2. Scanner la configuration"),
    h("p", {}, "Avec l'", h("strong", {}, "appareil photo"), " de l'iPhone, scannez ce QR code puis touchez « Ouvrir dans OwnTracks » et acceptez la configuration :"),
    qrImg(otUrl),
    h("h2", {}, "3. Autorisations sur l'iPhone"),
    h("ol", { class: "steps" },
      h("li", {}, "Localisation : ", h("strong", {}, "« Toujours »"), " et ", h("strong", {}, "« Position exacte »"), " activée (Réglages → OwnTracks → Position)."),
      h("li", {}, "Réglages → Général → ", h("strong", {}, "Actualisation en arrière-plan"), " : activée pour OwnTracks."),
      h("li", {}, "Expliquez à ", childName, " de ne pas fermer OwnTracks en le balayant vers le haut (sinon le suivi s'arrête jusqu'à la réouverture : vous recevrez alors une alerte « plus de nouvelles »)."),
      h("li", {}, "Dans OwnTracks, touchez la flèche ↑ pour envoyer une première position : ", childName, " doit apparaître sur votre carte."),
    ),
    h("h2", {}, "4. Bouton SOS (widget)"),
    h("p", {}, "Toujours avec l'appareil photo de l'iPhone de ", childName, ", scannez ce second QR code : une page explique comment créer le bouton SOS en 2 minutes."),
    qrImg(sosUrl),
    h("details", { class: "card small" },
      h("summary", {}, "Configuration manuelle (si le QR code ne fonctionne pas)"),
      h("p", {}, "Dans OwnTracks → ⓘ → Réglages : Mode ", h("strong", {}, "HTTP"), ", puis :"),
      h("p", {}, "URL : ", h("span", { class: "kv" }, cfg.url)),
      h("p", {}, "Authentification : activée"),
      h("p", {}, "Identifiant : ", h("span", { class: "kv" }, creds.username)),
      h("p", {}, "Mot de passe : ", h("span", { class: "kv" }, creds.password)),
      h("p", {}, "Device ID : iphone · Tracker ID : ", cfg.tid),
      h("p", {}, "Commandes à distance (cmd) et configuration à distance : activées."),
      h("p", {}, "Si l'iPhone affiche « URI or file configuration not allowed » : Réglages iOS → OwnTracks → autoriser la configuration par URL, puis rescanner."),
    ),
    h("button", { class: "btn block", onclick: () => { closeAllPages(); } }, "Terminé"),
  ));
}

// ----- placement d'une zone -----
let zonePreview = null;
function startZonePlacement() {
  closeAllPages();
  $("#sheet").hidden = true;
  $("#crosshair").hidden = false;
  $("#zone-bar").hidden = false;
  $("#zone-name").value = "";
  const radius = $("#zone-radius");
  const update = () => {
    $("#zone-radius-label").textContent = radius.value + " m";
    const center = zoneCenter();
    if (!zonePreview) zonePreview = L.circle(center, { radius: +radius.value, color: "#dc2626", weight: 2, fillOpacity: 0.1, interactive: false }).addTo(S.map);
    zonePreview.setLatLng(center).setRadius(+radius.value);
  };
  radius.oninput = update;
  S.map.on("move", update);
  if (S.map.getZoom() < 15) S.map.setZoom(16);
  update();
  startZonePlacement.cleanup = () => {
    S.map.off("move", update);
    zonePreview?.remove();
    zonePreview = null;
    $("#crosshair").hidden = true;
    $("#zone-bar").hidden = true;
    $("#sheet").hidden = false;
  };
}

// La croix est placée à 40 % de la hauteur : on convertit ce point en coordonnées
function zoneCenter() {
  const size = S.map.getSize();
  return S.map.containerPointToLatLng([size.x / 2, size.y * 0.4]);
}

$("#zone-cancel").addEventListener("click", () => startZonePlacement.cleanup?.());
$("#zone-save").addEventListener("click", async () => {
  const name = $("#zone-name").value.trim();
  if (!name) { toast("Donnez un nom à la zone."); return; }
  const c = zoneCenter();
  const { data, error } = await S.sb.from("zones").insert({
    family_id: S.family.id, name, lat: c.lat, lon: c.lng, radius_m: +$("#zone-radius").value,
  }).select().single();
  if (error) {
    toast(/duplicate|unique/.test(error.message) ? "Une zone porte déjà ce nom." : errorText(error));
    return;
  }
  S.zones.push(data);
  renderZones();
  startZonePlacement.cleanup?.();
  toast(`Zone « ${name} » créée. Elle sera envoyée aux iPhone à leur prochain envoi.`);
});

// ---------------------------------------------------------------------------
// Page d'aide « bouton SOS » (ouverte sur l'iPhone de l'enfant)
// ---------------------------------------------------------------------------
function renderSosSetup(key) {
  const sosUrl = `${FUNCTIONS_URL}/sos?k=${encodeURIComponent(key)}`;
  const copyBtn = h("button", {
    class: "btn block",
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(sosUrl);
        copyBtn.textContent = "Adresse copiée ✅";
      } catch {
        prompt("Copiez cette adresse :", sosUrl);
      }
    },
  }, "Copier l'adresse SOS");
  openPage("Bouton SOS", (b) => b.append(
    h("p", {}, "Ce bouton envoie une alerte immédiate avec ta position à tes parents."),
    h("h2", {}, "1. Copier l'adresse"),
    copyBtn,
    h("h2", {}, "2. Créer le Raccourci"),
    h("ol", { class: "steps" },
      h("li", {}, "Ouvre l'app ", h("strong", {}, "Raccourcis"), " (déjà installée sur l'iPhone) et touche ", h("strong", {}, "＋"), "."),
      h("li", {}, "Renomme le raccourci ", h("strong", {}, "« SOS »"), " (touche le nom en haut). Tu peux choisir une icône rouge."),
      h("li", {}, "Ajoute l'action ", h("strong", {}, "« Obtenir la position actuelle »"), "."),
      h("li", {}, "Ajoute l'action ", h("strong", {}, "« Obtenir le contenu de l'URL »"), " et colle l'adresse copiée à la place de « URL »."),
      h("li", {}, "Touche la flèche ", h("strong", {}, "›"), " de cette action : Méthode ", h("strong", {}, "POST"), ", Corps de la requête ", h("strong", {}, "JSON"), "."),
      h("li", {}, "Ajoute un champ ", h("strong", {}, "Texte"), " nommé ", h("strong", {}, "lat"), " : comme valeur, choisis la variable « Position actuelle » puis touche-la et choisis ", h("strong", {}, "Latitude"), "."),
      h("li", {}, "Ajoute un champ ", h("strong", {}, "Texte"), " nommé ", h("strong", {}, "lon"), " : variable « Position actuelle » → ", h("strong", {}, "Longitude"), "."),
      h("li", {}, "Ajoute l'action ", h("strong", {}, "« Afficher la notification »"), " avec « Contenu de l'URL » (pour voir que l'alerte est partie)."),
      h("li", {}, "Touche « OK ». La première fois, l'iPhone demande d'autoriser la position et la connexion : accepte toujours."),
    ),
    h("h2", {}, "3. Mettre le bouton sur l'écran d'accueil"),
    h("ol", { class: "steps" },
      h("li", {}, "Appuie longtemps sur un espace vide de l'écran d'accueil, puis ", h("strong", {}, "Modifier → Ajouter un widget"), "."),
      h("li", {}, "Choisis ", h("strong", {}, "Raccourcis"), ", le petit widget, puis sélectionne le raccourci ", h("strong", {}, "SOS"), "."),
    ),
    h("h2", {}, "4. Tester"),
    h("p", { class: "muted small" }, "Préviens tes parents avant : un test envoie une vraie alerte SOS."),
  ), { root: true });
}

// ---------------------------------------------------------------------------
// Un lien #sos=… ou #invite=… ouvert alors que l'app est déjà affichée
window.addEventListener("hashchange", () => {
  if (/^#(sos|invite)=/.test(location.hash)) location.reload();
});
window.addEventListener("error", (e) => console.error(e.error || e.message));
start().catch((e) => {
  console.error(e);
  openPage("Erreur", (b) => b.append(
    h("p", {}, errorText(e)),
    h("button", { class: "btn block", onclick: () => location.reload() }, "Réessayer"),
  ), { root: true });
});
