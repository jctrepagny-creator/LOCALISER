/* Pages ouvertes sur l'iPhone de l'enfant :
 *   enfant.html?k=…  assistant d'installation (OwnTracks, autorisations, SOS, Localiser d'Apple)
 *   sos.html?k=…     bouton SOS à ajouter sur l'écran d'accueil
 * La clé k = "<utilisateur>:<secret>" est générée par l'app des parents.
 */
(function () {
  "use strict";
  const CFG = window.LOCALISER_CONFIG || {};
  const FN = (CFG.supabaseUrl || "") + "/functions/v1";
  const BASE = location.href.split("?")[0].replace(/[^/]*$/, "");
  const KEY = new URLSearchParams(location.search).get("k") || "";
  const OWNTRACKS_APPSTORE = "https://apps.apple.com/app/owntracks/id692424691";

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function initials(name) {
    const clean = String(name || "?").normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
    const parts = clean.split(/\s+/).filter(Boolean);
    const s = parts.length > 1 ? parts[0][0] + parts[1][0] : clean.slice(0, 2);
    return s.toUpperCase().replace(/[^A-Z0-9]/g, "X").padEnd(2, "X");
  }

  function b64utf8(str) {
    let bin = "";
    new TextEncoder().encode(str).forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin);
  }

  function hm(date) {
    return new Date(date).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  }

  async function fetchStatus() {
    const r = await fetch(FN + "/child-status?k=" + encodeURIComponent(KEY), { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Erreur " + r.status);
    return j;
  }

  // Configuration OwnTracks importée en un geste (lien owntracks:///config)
  function ownTracksLink(name) {
    const sep = KEY.indexOf(":");
    const cfg = {
      _type: "configuration",
      mode: 3,
      url: FN + "/owntracks",
      auth: true,
      username: KEY.slice(0, sep),
      password: KEY.slice(sep + 1),
      deviceId: "iphone",
      tid: initials(name),
      monitoring: 1,
      cmd: true,
      remoteConfiguration: true,
      allowRemoteLocation: true,
      extendedData: true,
      downgrade: 15,
      locked: true,
      maxHistory: 0,
      // Zone invisible qui suit l'enfant : quand il en sort, iOS relance
      // OwnTracks en arrière-plan, même si l'app a été fermée.
      waypoints: [{ _type: "waypoint", desc: "+follow", lat: 0, lon: 0, rad: 50, tst: 1000000000 }],
    };
    return "owntracks:///config?inline=" + encodeURIComponent(b64utf8(JSON.stringify(cfg)));
  }

  function step(num, title, ...body) {
    return h("section", { class: "step", id: "step-" + num },
      h("h2", {}, h("span", { class: "num" }, String(num)), title), ...body);
  }

  // -------------------------------------------------------------------------
  // Assistant d'installation
  // -------------------------------------------------------------------------
  async function setup() {
    const intro = document.getElementById("intro");
    const steps = document.getElementById("steps");
    if (!KEY) {
      intro.textContent = "Lien incomplet : rescannez le QR code affiché dans l'app des parents.";
      return;
    }
    let st;
    try {
      st = await fetchStatus();
    } catch (e) {
      intro.textContent = "⚠️ " + e.message;
      return;
    }
    const name = st.name;
    document.title = "Installation — " + name;
    intro.textContent = `iPhone de ${name} · 6 étapes, environ 5 minutes. Gardez cette page ouverte dans Safari et revenez-y après chaque étape.`;

    const statusLine = h("p", { class: "status-line wait" }, "⏳ En attente de la première position…");
    const statusHelp = h("p", { class: "small muted" },
      "Ouvrez OwnTracks et touchez la flèche ↑ en haut à droite pour envoyer la position.");

    steps.append(
      step(1, "Installer OwnTracks",
        h("p", {}, "Application gratuite qui envoie la position aux parents."),
        h("a", { class: "big-btn", href: OWNTRACKS_APPSTORE }, "Ouvrir l'App Store"),
        h("p", { class: "small muted" }, "Touchez « Obtenir », puis revenez sur cette page."),
      ),
      step(2, "Configurer OwnTracks",
        h("a", { class: "big-btn", href: ownTracksLink(name) }, "Configurer OwnTracks"),
        h("p", { class: "small" }, "L'iPhone demande « Ouvrir dans OwnTracks ? » : touchez ", h("strong", {}, "Ouvrir"), ", puis acceptez la configuration."),
        h("p", { class: "small muted" }, "Message « not allowed » ? Réglages → OwnTracks → autorisez la configuration par URL, puis retouchez le bouton."),
      ),
      step(3, "Autoriser la position",
        h("p", {}, "Quand OwnTracks le demande, acceptez tout. Puis vérifiez dans ", h("strong", {}, "Réglages → OwnTracks"), " :"),
        h("ul", {},
          h("li", {}, "Position : ", h("strong", {}, "Toujours")),
          h("li", {}, "Position exacte : ", h("strong", {}, "activée")),
          h("li", {}, "Actualisation en arrière-plan : ", h("strong", {}, "activée")),
        ),
      ),
      step(4, "Vérifier",
        statusLine, statusHelp,
      ),
      step(5, "Bouton SOS sur l'écran d'accueil",
        h("a", { class: "big-btn", href: BASE + "sos.html?k=" + encodeURIComponent(KEY) }, "Ouvrir le bouton SOS"),
        h("p", { class: "small" }, "Sur la page rouge : touchez ", h("strong", {}, "Partager ⬆︎"), " en bas de Safari → ", h("strong", {}, "« Sur l'écran d'accueil »"), " → Ajouter. Une icône SOS apparaît."),
      ),
      step(6, "Localiser d'Apple (sécurité)",
        h("p", {}, "Permet aux parents de voir l'iPhone sur ", h("strong", {}, "icloud.com/find"), ", même si OwnTracks est fermé."),
        h("p", {}, h("strong", {}, "Réglages"), " → touchez le nom en haut → ", h("strong", {}, "Localiser"), " → ", h("strong", {}, "Localiser mon iPhone"), " : activez les 3 options (Localiser mon iPhone, Réseau Localiser, Envoyer la dernière position)."),
        h("p", { class: "small muted" }, "Les parents se connectent sur icloud.com/find avec l'identifiant Apple de cet iPhone."),
      ),
      h("details", { class: "step" },
        h("summary", {}, "Facultatif : verrouiller les réglages (Temps d'écran)"),
        h("p", { class: "small" }, "Réglages → Temps d'écran → activez-le et choisissez un code parent. Puis Contenu et confidentialité → activez :"),
        h("ul", { class: "small" },
          h("li", {}, "Achats dans l'App Store → Suppression d'apps : Ne pas autoriser"),
          h("li", {}, "Service de localisation : Ne pas autoriser les modifications"),
          h("li", {}, "Actualisation en arrière-plan : Ne pas autoriser les modifications"),
        ),
      ),
      h("p", { class: "small muted" }, "Si OwnTracks est fermé, iOS le relance tout seul dès que l'iPhone se déplace."),
    );

    const loadedAt = Date.now();
    const check = async () => {
      try {
        const s = await fetchStatus();
        const seen = s.last_seen_at ? new Date(s.last_seen_at).getTime() : 0;
        if (seen && Date.now() - seen < 15 * 60 * 1000) {
          statusLine.className = "status-line ok";
          statusLine.textContent = `✅ Position reçue à ${hm(s.last_seen_at)} : les parents voient ${name} sur la carte.`;
          statusHelp.textContent = seen >= loadedAt - 60000 ? "Tout fonctionne." : "";
          document.getElementById("step-4").classList.add("done");
          return;
        }
      } catch { /* réseau : on réessaie */ }
      setTimeout(check, 4000);
    };
    check();
  }

  // -------------------------------------------------------------------------
  // Bouton SOS
  // -------------------------------------------------------------------------
  function getPosition(timeoutMs) {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      const timer = setTimeout(() => resolve(null), timeoutMs);
      navigator.geolocation.getCurrentPosition(
        (p) => { clearTimeout(timer); resolve(p.coords); },
        () => { clearTimeout(timer); resolve(null); },
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 },
      );
    });
  }

  function sos() {
    const main = document.getElementById("sos-main");
    if (!KEY) {
      main.append(h("p", {}, "Lien incomplet : rescannez le QR code depuis l'app des parents."));
      return;
    }
    const standalone = navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
    const msg = h("div", { class: "sos-msg" }, "Appuie pour prévenir tes parents");
    const btn = h("button", { class: "sos-btn", "aria-label": "Envoyer une alerte SOS" }, "SOS");

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      msg.className = "sos-msg";
      msg.textContent = "Envoi de l'alerte…";
      const pos = await getPosition(6000);
      try {
        const r = await fetch(FN + "/sos?k=" + encodeURIComponent(KEY), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(pos ? { lat: pos.latitude, lon: pos.longitude, acc: Math.round(pos.accuracy) } : {}),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.message || "Erreur");
        msg.className = "sos-msg ok";
        msg.textContent = "✅ Alerte envoyée ! Tes parents sont prévenus" + (pos ? "." : " (position approximative).");
        if (navigator.vibrate) navigator.vibrate(300);
      } catch (e) {
        msg.className = "sos-msg err";
        msg.textContent = "❌ Pas envoyé (" + e.message + "). Réessaie, ou appelle le 112.";
      } finally {
        setTimeout(() => { btn.disabled = false; }, 4000);
      }
    });

    const wrap = h("div", { class: "sos-wrap" }, btn, msg,
      h("p", { class: "muted small" }, "En cas de danger immédiat, appelle le 112."));

    if (!standalone) {
      main.append(h("div", { class: "card" },
        h("strong", {}, "Installer le bouton SOS"),
        h("p", {}, "Touchez ", h("strong", {}, "Partager ⬆︎"), " en bas de Safari, puis ", h("strong", {}, "« Sur l'écran d'accueil »"), " et ", h("strong", {}, "Ajouter"), "."),
        h("p", { class: "muted small" }, "Une icône rouge « SOS » apparaît sur l'écran d'accueil. Pour tester, prévenez d'abord les parents : le bouton envoie une vraie alerte."),
      ));
    }
    main.append(wrap);
  }

  if (document.body.dataset.page === "sos") sos();
  else setup();
})();
