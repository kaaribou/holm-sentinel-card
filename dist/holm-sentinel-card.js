/* HOLM Sentinel Card — v1
 * État des batteries, alimenté par l'add-on Battery Sentinel Plus.
 * - Même rendu que la carte « État des batteries » (lignes d'alerte colorées),
 *   en dynamique : niveaux en direct, seuils par appareil de Sentinel,
 *   type de pile, dernier remplacement, appareils injoignables, silencieux.
 * - Animations : apparition en cascade, jauge qui se remplit, alerte qui pulse.
 * - Un toucher sur une ligne ouvre la page de l'appareil.
 * - Sans Sentinel (ou hors Supervisor), la carte fonctionne avec les entités
 *   « batterie » de Home Assistant.
 * Tout se règle dans l'éditeur visuel.
 */
(() => {
  const VERSION = "1.0.2";
  const DEFAULTS = {
    title: "État des batteries", emoji: "🔋", max_items: 10,
    show_type: true, show_area: false, show_replaced: false, show_bar: true,
    hide_ignored: true, hide_browser: true, show_unavailable: true, show_ok: true,
  };
  const ADDON_SLUGS = ["a4b9316c_battery_sentinel"];
  const REFRESH = 5 * 60 * 1000;
  const S = (window.__holmSentinel = window.__holmSentinel || { data: null, settings: null, ts: 0, base: null, state: "idle", waiters: [] });

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtPct = (v) => (Number.isInteger(v) ? `${v} %` : `${v.toFixed(1).replace(/\.0$/, "")} %`);
  const ago = (d) => {
    if (!d) return "";
    const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
    if (isNaN(days)) return "";
    if (days < 1) return "aujourd'hui";
    if (days < 31) return `il y a ${days} j`;
    const m = Math.round(days / 30.4);
    return m < 12 ? `il y a ${m} mois` : `il y a ${(days / 365).toFixed(1).replace(".0", "").replace(".", ",")} an${days >= 730 ? "s" : ""}`;
  };
  const isBrowser = (id, it) => /browser_battery$|^sensor\.browser_mod_/.test(id) || (it && it.manufacturer === "Browser Mod");

  // ---------------- accès à Sentinel via l'ingress de l'add-on ----------------
  const setCookie = (session) => {
    document.cookie = `ingress_session=${session};path=/api/hassio_ingress/;SameSite=Strict${location.protocol === "https:" ? ";Secure" : ""}`;
  };
  async function connect(hass, slug) {
    if (S.state === "ready") return true;
    if (S.state === "none") return false;
    if (S.state === "loading") return new Promise((r) => S.waiters.push(r));
    S.state = "loading";
    const done = (ok) => { S.state = ok ? "ready" : "none"; S.waiters.splice(0).forEach((r) => r(ok)); return ok; };
    if (!hass.config || !hass.config.components || !hass.config.components.includes("hassio")) return done(false);
    let info = null;
    for (const s of slug ? [slug] : ADDON_SLUGS) {
      try {
        const r = await hass.callWS({ type: "supervisor/api", endpoint: `/addons/${s}/info`, method: "get" });
        if (r && r.ingress_url && r.state === "started") { info = r; break; }
      } catch (e) { /* suivant */ }
    }
    if (!info) return done(false);
    try {
      const ses = await hass.callWS({ type: "supervisor/api", endpoint: "/ingress/session", method: "post" });
      S.session = ses.session;
      setCookie(ses.session);
      S.base = info.ingress_url.replace(/\/+$/, "");
      S.hass = hass;
      clearInterval(S.keep);
      S.keep = setInterval(async () => {
        try {
          await S.hass.callWS({ type: "supervisor/api", endpoint: "/ingress/validate_session", method: "post", data: { session: S.session } });
          setCookie(S.session);
        } catch (e) {
          try { const n = await S.hass.callWS({ type: "supervisor/api", endpoint: "/ingress/session", method: "post" }); S.session = n.session; setCookie(n.session); } catch (e2) { /* ignore */ }
        }
      }, 60000);
      return done(true);
    } catch (e) {
      return done(false);
    }
  }
  async function load(hass, slug, force) {
    if (!force && S.data && Date.now() - S.ts < REFRESH) return S.data;
    if (S.loading) return S.loading;
    S.loading = (async () => {
      try {
        if (!(await connect(hass, slug))) return null;
        const [b, st] = await Promise.all([fetch(`${S.base}/api/batteries`), fetch(`${S.base}/api/settings`)]);
        if (!b.ok) throw new Error(`HTTP ${b.status}`);
        S.data = await b.json();
        S.settings = st.ok ? await st.json() : null;
        S.ts = Date.now();
        window.dispatchEvent(new CustomEvent("holm-sentinel-data"));
        return S.data;
      } catch (e) {
        S.error = e.message;
        return S.data;
      } finally {
        S.loading = null;
      }
    })();
    return S.loading;
  }

  // ------------------------------------------------------------------
  class HolmSentinelCard extends HTMLElement {
    static getConfigElement() { return document.createElement("holm-sentinel-card-editor"); }
    static getStubConfig() { return { type: "custom:holm-sentinel-card" }; }
    setConfig(config) {
      this._config = { ...DEFAULTS, ...config };
      if (!this.shadowRoot) this.attachShadow({ mode: "open" });
      this._key = null;
      this._render();
    }
    getCardSize() { return 3 + Math.min(Number(this._config.max_items) || 10, 12); }
    getGridOptions() { return { columns: 12, min_columns: 6, rows: "auto" }; }
    set hass(hass) {
      const first = !this._hass;
      this._hass = hass;
      if (first) this._fetch();
      this._render();
    }
    connectedCallback() {
      this._onData = () => { this._key = null; this._render(); };
      window.addEventListener("holm-sentinel-data", this._onData);
      this._timer = setInterval(() => this._fetch(), REFRESH);
      if (this._hass) this._fetch();
    }
    disconnectedCallback() {
      window.removeEventListener("holm-sentinel-data", this._onData);
      clearInterval(this._timer);
    }
    async _fetch(force) {
      if (!this._hass) return;
      await load(this._hass, this._config.addon, force);
    }

    // ---------------- données ----------------
    _items() {
      const h = this._hass, c = this._config;
      const exclude = new Set(c.exclude || []);
      const set = S.settings || {};
      const red = Number(c.red_threshold ?? set.color_threshold_red ?? 10);
      const yellow = Number(c.yellow_threshold ?? set.color_threshold_yellow ?? 25);
      let src;
      if (S.data) {
        src = S.data.filter((it) => !it.hidden);
      } else {
        src = Object.values(h.states).filter((s) => s.attributes.device_class === "battery" && (s.entity_id.startsWith("sensor.") || s.entity_id.startsWith("binary_sensor.")))
          .map((s) => ({ entity_id: s.entity_id, name: s.attributes.friendly_name, alert_threshold: 0, device_id: h.entities && h.entities[s.entity_id] && h.entities[s.entity_id].device_id }));
      }
      const out = [];
      for (const it of src) {
        const id = it.entity_id;
        if (exclude.has(id)) continue;
        if (c.hide_ignored && Number(it.alert_threshold) < 0) continue;
        if (c.hide_browser && isBrowser(id, it)) continue;
        const st = h.states[id];
        const ent = h.entities && h.entities[id];
        const name = (st && st.attributes.friendly_name) || it.name || id;
        const raw = st ? st.state : it.state;
        let lvl = null, disp = "", status;
        if (!st || raw === "unavailable" || raw === "unknown") {
          if (!c.show_unavailable) continue;
          status = "off";
          disp = "Injoignable";
        } else if (id.startsWith("binary_sensor.")) {
          lvl = raw === "on" ? 0 : 100;
          disp = raw === "on" ? "Faible" : "OK";
        } else {
          lvl = parseFloat(raw);
          if (isNaN(lvl)) continue;
          disp = fmtPct(lvl);
        }
        if (lvl !== null) {
          const thr = Math.max(Number(it.alert_threshold) || 0, 0);
          status = lvl < red ? "error" : lvl < yellow || (thr && lvl <= thr) ? "warning" : "ok";
        }
        if (status === "ok" && !c.show_ok) continue;
        const muted = it.muted_until && new Date(it.muted_until).getTime() > Date.now();
        out.push({
          id, name, lvl, disp, status, muted,
          type: it.battery_type || "", qty: Number(it.battery_quantity) || 1,
          area: it.area || "", replaced: it.last_replaced, notes: it.notes || "",
          device: it.device_id || (ent && ent.device_id) || null,
          since: it.unavailable_since,
        });
      }
      const rank = { error: 0, warning: 1, off: 2, ok: 3 };
      out.sort((a, b) => rank[a.status] - rank[b.status] || (a.lvl ?? 999) - (b.lvl ?? 999) || a.name.localeCompare(b.name));
      return out;
    }

    // ---------------- rendu ----------------
    _render() {
      if (!this._hass || !this._config || !this.shadowRoot) return;
      const waiting = !S.data && (S.state === "idle" || S.state === "loading");
      if (waiting && !this._waitT) this._waitT = setTimeout(() => { this._waitT = null; this._key = null; this._render(); }, 1500);
      const items = waiting ? [] : this._items();
      const c = this._config;
      const key = JSON.stringify([items.map((i) => [i.id, i.disp, i.status, i.muted]), !!S.data, c]);
      if (key === this._key) return;
      const first = this._key == null || !this._built;
      this._key = key;
      const max = Math.max(1, Number(c.max_items) || 10);
      const top = items.slice(0, max), rest = items.slice(max);
      const watch = items.filter((i) => i.status === "error" || i.status === "warning").length;
      const off = items.filter((i) => i.status === "off").length;
      const wasOpen = this._open;
      const summary = waiting ? "Chargement des batteries…" : `${items.filter((i) => i.status !== "off").length} batteries suivies — ${watch} à surveiller${off ? ` · ${off} injoignable${off > 1 ? "s" : ""}` : ""}`;
      const src = S.data ? "Battery Sentinel" : S.state === "loading" || S.state === "idle" ? "…" : "Home Assistant";
      if (!this._built) {
        this.shadowRoot.innerHTML = `<style>${HolmSentinelCard.css()}</style>
          <ha-card>
            <div class="hd"><span class="emo">${esc(c.emoji || "")}</span><span class="tt"></span><button class="rf" title="Actualiser"><ha-icon icon="mdi:refresh"></ha-icon></button></div>
            <div class="sum"></div>
            <div class="list" id="top"></div>
            <div class="more" id="more"><button class="mbtn"><ha-icon icon="mdi:chevron-right"></ha-icon><span></span></button><div class="list rest" id="rest"></div></div>
            <div class="src"></div>
          </ha-card>`;
        const r = this.shadowRoot;
        r.querySelector(".mbtn").addEventListener("click", () => { this._open = !this._open; r.getElementById("more").classList.toggle("open", this._open); });
        r.querySelector(".rf").addEventListener("click", async (e) => {
          const b = e.currentTarget; b.classList.add("spin");
          await this._fetch(true); this._key = null; this._render();
          setTimeout(() => b.classList.remove("spin"), 600);
        });
        r.addEventListener("click", (e) => {
          const row = e.target.closest(".row");
          if (!row) return;
          this._tap(row.dataset.id, row.dataset.dev);
        });
        this._built = true;
      }
      const r = this.shadowRoot;
      r.querySelector(".emo").textContent = c.emoji || "";
      r.querySelector(".tt").textContent = c.title || "";
      r.querySelector(".sum").textContent = summary;
      r.getElementById("top").innerHTML = top.map((it, i) => this._row(it, i, first)).join("");
      const more = r.getElementById("more");
      more.style.display = rest.length ? "" : "none";
      more.querySelector(".mbtn span").textContent = `Voir les ${rest.length} autre${rest.length > 1 ? "s" : ""} batterie${rest.length > 1 ? "s" : ""}`;
      r.getElementById("rest").innerHTML = rest.map((it, i) => this._row(it, i, false)).join("");
      more.classList.toggle("open", !!wasOpen);
      r.querySelector(".src").textContent = `Source : ${src}`;
      if (first) requestAnimationFrame(() => r.querySelectorAll(".bar i").forEach((b) => (b.style.width = b.dataset.w)));
      else r.querySelectorAll(".bar i").forEach((b) => (b.style.width = b.dataset.w));
    }
    _row(it, i, anim) {
      const c = this._config;
      const icon = { error: "mdi:alert-circle-outline", warning: "mdi:alert-outline", ok: "mdi:check-circle-outline", off: "mdi:lan-disconnect" }[it.status];
      const sub = [];
      if (c.show_area && it.area) sub.push(esc(it.area));
      if (c.show_replaced && it.replaced) sub.push(`Remplacée ${ago(it.replaced)}`);
      if (it.status === "off" && it.since) sub.push(`Depuis ${ago(it.since).replace("il y a ", "")}`);
      const chip = c.show_type && it.type ? `<span class="chip">${esc(it.type)}${it.qty > 1 ? ` ×${it.qty}` : ""}</span>` : "";
      const w = it.lvl == null ? 0 : Math.max(2, Math.min(100, it.lvl));
      return `<button class="row s-${it.status}${anim ? " in" : ""}" style="--i:${i}" data-id="${esc(it.id)}" data-dev="${esc(it.device || "")}" title="${esc(it.notes || it.name)}">
        ${c.show_bar && it.lvl != null ? `<span class="bar"><i data-w="${w}%"></i></span>` : ""}
        <ha-icon class="ic" icon="${icon}"></ha-icon><span class="dot"></span>
        <span class="tx"><span class="nm"><span class="n">${esc(it.name)}</span><span class="v">&nbsp;— ${esc(it.disp)}${it.muted ? ` <ha-icon class="mute" icon="mdi:bell-off-outline" title="Alertes en pause"></ha-icon>` : ""}</span></span>${sub.length ? `<small>${sub.join(" · ")}</small>` : ""}</span>
        ${chip}</button>`;
    }
    _tap(id, dev) {
      window.dispatchEvent(new CustomEvent("haptic", { detail: "light" }));
      if (dev) {
        history.pushState(null, "", `/config/devices/device/${dev}`);
        window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
      } else {
        this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId: id }, bubbles: true, composed: true }));
      }
    }

    static css() {
      return `
      :host { display: block; }
      ha-card { padding: 16px; overflow: hidden; }
      button { font: inherit; color: inherit; border: 0; background: none; padding: 0; cursor: pointer; text-align: left; -webkit-tap-highlight-color: transparent; }
      .hd { display: flex; align-items: center; gap: 10px; margin: 0 0 14px; }
      .emo { font-size: 24px; line-height: 1; }
      .tt { flex: 1; font-size: 24px; font-weight: 400; letter-spacing: -.01em; color: var(--primary-text-color); }
      .rf { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; color: var(--secondary-text-color); opacity: .6; transition: opacity .2s, background .2s; }
      .rf:hover { opacity: 1; background: rgba(255,255,255,.08); }
      .rf ha-icon { --mdc-icon-size: 18px; }
      .rf.spin ha-icon { animation: spin .6s linear; }
      @keyframes spin { to { transform: rotate(360deg); } }
      .sum { font-weight: 700; font-size: 14px; margin: 0 0 12px; color: var(--primary-text-color); }
      .list { display: flex; flex-direction: column; gap: 8px; }
      .row {
        --c: #4caf50; position: relative; overflow: hidden; display: flex; align-items: center; gap: 8px; width: 100%; min-height: 36px; box-sizing: border-box;
        padding: 7px 12px; border-radius: 6px; color: var(--primary-text-color); font-size: 14px;
        background: color-mix(in srgb, var(--c) 12%, transparent);
        transition: transform .2s, background .3s, box-shadow .3s;
      }
      .row:hover { background: color-mix(in srgb, var(--c) 20%, transparent); transform: translateX(2px); }
      .row:active { transform: scale(.985); }
      .row.in { animation: rin .45s cubic-bezier(.3,1.3,.5,1) backwards; animation-delay: calc(var(--i) * 45ms); }
      @keyframes rin { from { opacity: 0; transform: translateY(6px); } }
      .s-error { --c: #db4437; }
      .s-warning { --c: #ffa600; }
      .s-ok { --c: #43a047; }
      .s-off { --c: #9e9e9e; }
      .s-error { animation: glow 2.2s ease-in-out infinite; }
      .s-error.in { animation: rin .45s cubic-bezier(.3,1.3,.5,1) backwards, glow 2.2s ease-in-out .5s infinite; animation-delay: calc(var(--i) * 45ms), calc(var(--i) * 45ms + .5s); }
      @keyframes glow { 50% { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c) 45%, transparent), 0 0 14px -4px var(--c); } }
      .bar { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: color-mix(in srgb, var(--c) 10%, transparent); }
      .bar i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, color-mix(in srgb, var(--c) 40%, transparent), var(--c)); border-radius: 0 2px 2px 0; transition: width 1.1s cubic-bezier(.2,.8,.2,1); }
      .ic { --mdc-icon-size: 22px; color: var(--c); flex: none; }
      .dot { flex: none; width: 10px; height: 10px; border-radius: 50%; background: radial-gradient(circle at 35% 35%, color-mix(in srgb, var(--c) 55%, #fff), var(--c)); box-shadow: 0 0 6px -1px var(--c); }
      .s-error .dot { animation: beat 1.2s ease-in-out infinite; }
      @keyframes beat { 50% { transform: scale(1.35); box-shadow: 0 0 10px 1px var(--c); } }
      .tx { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      .nm { display: flex; min-width: 0; white-space: nowrap; }
      .nm .n { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
      .nm .v { flex: none; }
      .tx small { font-size: 11.5px; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .mute { --mdc-icon-size: 14px; color: var(--secondary-text-color); vertical-align: -2px; }
      .chip { flex: none; font-size: 11px; font-weight: 700; letter-spacing: .02em; padding: 2px 7px; border-radius: 8px; color: color-mix(in srgb, var(--c) 60%, #fff); background: color-mix(in srgb, var(--c) 16%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c) 30%, transparent); }
      .more { margin-top: 10px; }
      .mbtn { display: flex; align-items: center; gap: 4px; font-size: 14px; color: var(--primary-text-color); padding: 4px 0; }
      .mbtn ha-icon { --mdc-icon-size: 18px; transition: transform .3s; }
      .more.open .mbtn ha-icon { transform: rotate(90deg); }
      .rest { overflow: hidden; display: flex; max-height: 0; opacity: 0; transition: max-height .5s cubic-bezier(.3,1,.4,1), opacity .35s, margin .3s; }
      .more.open .rest { max-height: 5000px; opacity: 1; margin-top: 8px; }
      .src { margin-top: 10px; font-size: 10.5px; color: var(--secondary-text-color); opacity: .55; text-align: right; }
      @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }`;
    }
  }

  // ------------------------------------------------------------------
  //  Éditeur visuel
  // ------------------------------------------------------------------
  class HolmSentinelCardEditor extends HTMLElement {
    setConfig(config) {
      this._config = { ...config };
      if (this._form) this._form.data = { ...DEFAULTS, ...this._config };
    }
    set hass(hass) {
      this._hass = hass;
      if (!this._form) this._build();
      else this._form.hass = hass;
    }
    _build() {
      const f = document.createElement("ha-form");
      f.hass = this._hass;
      f.schema = [
        { type: "grid", name: "", schema: [{ name: "emoji", selector: { text: {} } }, { name: "title", selector: { text: {} } }] },
        { name: "max_items", selector: { number: { min: 3, max: 30, step: 1, mode: "slider" } } },
        { type: "expandable", name: "", title: "Affichage", icon: "mdi:eye-outline", schema: [
          { type: "grid", name: "", schema: [
            { name: "show_type", selector: { boolean: {} } },
            { name: "show_bar", selector: { boolean: {} } },
            { name: "show_area", selector: { boolean: {} } },
            { name: "show_replaced", selector: { boolean: {} } },
            { name: "show_unavailable", selector: { boolean: {} } },
            { name: "show_ok", selector: { boolean: {} } },
          ] },
        ] },
        { type: "expandable", name: "", title: "Filtres et seuils", icon: "mdi:filter-outline", schema: [
          { type: "grid", name: "", schema: [
            { name: "hide_ignored", selector: { boolean: {} } },
            { name: "hide_browser", selector: { boolean: {} } },
          ] },
          { type: "grid", name: "", schema: [
            { name: "red_threshold", selector: { number: { min: 1, max: 50, step: 1, mode: "box", unit_of_measurement: "%" } } },
            { name: "yellow_threshold", selector: { number: { min: 1, max: 80, step: 1, mode: "box", unit_of_measurement: "%" } } },
          ] },
          { name: "exclude", selector: { entity: { multiple: true, filter: { device_class: "battery" } } } },
        ] },
        { type: "expandable", name: "", title: "Avancé", icon: "mdi:cog-outline", schema: [{ name: "addon", selector: { text: {} } }] },
      ];
      const L = {
        emoji: "Émoji", title: "Titre", max_items: "Batteries affichées avant « Voir les autres »",
        show_type: "Type de pile", show_bar: "Jauge animée", show_area: "Pièce", show_replaced: "Dernier remplacement",
        show_unavailable: "Appareils injoignables", show_ok: "Batteries en bon état",
        hide_ignored: "Masquer les appareils ignorés dans Sentinel", hide_browser: "Masquer les navigateurs (Browser Mod)",
        red_threshold: "Seuil rouge", yellow_threshold: "Seuil orange", exclude: "Batteries à exclure",
        addon: "Identifiant de l'add-on Sentinel",
      };
      const H = {
        red_threshold: "Vide = réglage de Battery Sentinel (10 % par défaut).",
        yellow_threshold: "Vide = réglage de Battery Sentinel (25 % par défaut). Le seuil d'alerte propre à chaque appareil est aussi pris en compte.",
        addon: "Vide = détection automatique (a4b9316c_battery_sentinel).",
      };
      f.computeLabel = (s) => L[s.name] || s.name;
      f.computeHelper = (s) => H[s.name];
      f.data = { ...DEFAULTS, ...this._config };
      f.addEventListener("value-changed", (e) => {
        const v = { ...e.detail.value };
        Object.keys(v).forEach((k) => {
          if (v[k] === "" || v[k] == null || (Array.isArray(v[k]) && !v[k].length) || (k in DEFAULTS && DEFAULTS[k] === v[k])) delete v[k];
        });
        this._config = { type: this._config.type || "custom:holm-sentinel-card", ...v };
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true }));
      });
      this._form = f;
      this.appendChild(f);
    }
  }

  if (!customElements.get("holm-sentinel-card")) customElements.define("holm-sentinel-card", HolmSentinelCard);
  if (!customElements.get("holm-sentinel-card-editor")) customElements.define("holm-sentinel-card-editor", HolmSentinelCardEditor);
  window.customCards = window.customCards || [];
  if (!window.customCards.some((c) => c.type === "holm-sentinel-card")) {
    window.customCards.push({ type: "holm-sentinel-card", name: "HOLM Batteries (Sentinel)", description: "État des batteries animé, alimenté par Battery Sentinel Plus : seuils, type de pile, remplacement, injoignables.", preview: true });
  }
  console.info(`%c HOLM-SENTINEL %c ${VERSION} `, "background:#43a047;color:#fff;border-radius:3px 0 0 3px", "background:#123;color:#fff;border-radius:0 3px 3px 0");
})();
