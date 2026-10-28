/* Farm Power Watch - front end (PAPER v18 model).
   Outcome: realized agricultural electricity price (FERC Form 1).
   Exposure: log(1 + operating megawatts). Estimates are associations from the
   v18 study; central point estimate shown in the UI, full CI documented in the
   paper. Constants (BETA and the CI bounds BLO/BHI) mirror the v18 manuscript. */
"use strict";

const BETA = 0.0200;      // controlled, 2022-2025 endpoint, per log(1+MW)
const BLO = -0.0025;      // 95% CI lower
const BHI = 0.0424;       // 95% CI upper
const REF_MW = 364;       // study's reference capacity
const GROWTH = { low: 0.130, central: 0.207, high: 0.269 }; // LBNL load-growth scenarios
const BASE_YEAR = 2026;
const NAT_SPEND_FALLBACK = 8726;

// association in % on the ag price for a given operating-MW exposure
const pctEff = (beta, mw) => (Math.exp(beta * Math.log1p(Math.max(0, mw))) - 1) * 100;

function projectedMwRaw(u, scen, year) {
  const t = Math.max(0, year - BASE_YEAR);
  const ramp = (a28, a30) => {
    if (year <= BASE_YEAR) return 0;
    if (year <= 2028) return a28 * (year - BASE_YEAR) / 2;
    return a28 + (a30 - a28) * (year - 2028) / 2;
  };
  if (scen === "pipeline") return u.omw + ramp(0.25 * u.pmw, 0.5 * u.pmw);
  if (scen === "state") {
    const s = STATES[u.st];
    if (!s || !s.omw) return u.omw;
    return u.omw * (1 + ramp(0.25 * s.pmw, 0.5 * s.pmw) / s.omw);
  }
  return u.omw * Math.pow(1 + GROWTH[scen], t);
}
const projectedMw = (u, scen, year) => Math.round(projectedMwRaw(u, scen, year));

const fmtPct = (x) => (x >= 0.05 ? "+" : (x <= -0.05 ? "" : "")) + x.toFixed(1) + "%";
const fmtRange = (lo, hi) => `${lo >= 0 ? "+" : ""}${lo.toFixed(1)}% to +${hi.toFixed(1)}%`;
const fmtUsd = (x) => (x < 0 ? "-$" : "$") + Math.round(Math.abs(x)).toLocaleString("en-US");
const fmtMw = (x) => Math.round(x).toLocaleString("en-US") + " MW";
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let UTILS = [], COUNTIES = {}, STATES = {}, NAT_SPEND = NAT_SPEND_FALLBACK, byId = {};
let selected = null;
let map, terrLayer;

async function boot() {
  let u, c, t, f, s, ns;
  if (window.FPW_DATA) {
    ({ utilities: u, counties: c, territories: t, facilities: f, states: s,
       national_spend: ns } = window.FPW_DATA);
  } else {
    let st;
    [u, c, t, f, st] = await Promise.all([
      fetch("data/utilities.json").then((r) => r.json()),
      fetch("data/counties.json").then((r) => r.json()),
      fetch("data/territories.geojson").then((r) => r.json()),
      fetch("data/facilities.json").then((r) => r.json()),
      fetch("data/states.json").then((r) => r.json()),
    ]);
    s = st.states; ns = st.national_spend;
  }
  UTILS = u; COUNTIES = c; STATES = s || {}; NAT_SPEND = ns || NAT_SPEND_FALLBACK;
  u.forEach((x) => (byId[x.u] = x));
  initSearch();
  initMap(t, f);
  document.getElementById("yr").addEventListener("input", renderProj);
  document.getElementById("scen").addEventListener("change", renderProj);
  document.getElementById("spend").addEventListener("input", renderFarm);
  if (byId[7140]) select(byId[7140], null, false);   // Georgia Power (a paper case)
}

/* ---------- search ---------- */
function initSearch() {
  const idx = [];
  UTILS.forEach((x) => idx.push({
    k: (x.n + " " + (x.st || "")).toLowerCase(),
    label: x.n + (x.st && !x.n.includes("(" + x.st + ")") ? " (" + x.st + ")" : ""),
    kind: "utility", u: x,
  }));
  Object.entries(COUNTIES).forEach(([fips, c]) =>
    idx.push({ k: (c.nm + " " + c.st).toLowerCase(), label: c.nm + ", " + c.st, kind: "county", fips, c }));
  const input = document.getElementById("search"), box = document.getElementById("suggest");
  let items = [], sel = -1;
  function show(q) {
    q = q.trim().toLowerCase();
    if (q.length < 2) { box.hidden = true; return; }
    const toks = q.split(/\s+/);
    items = idx.filter((e) => toks.every((t) => e.k.includes(t))).slice(0, 12);
    sel = -1;
    box.innerHTML = items.map((e, i) =>
      `<div data-i="${i}">${esc(e.label)}<span class="kind">${e.kind}</span></div>`).join("");
    box.hidden = !items.length;
  }
  function choose(e) {
    box.hidden = true;
    if (e.kind === "utility") { input.value = e.label; select(e.u, null, true); }
    else { input.value = e.label; selectCounty(e.fips, e.c); }
  }
  input.addEventListener("input", () => show(input.value));
  input.addEventListener("keydown", (ev) => {
    if (box.hidden) return;
    if (ev.key === "ArrowDown") { sel = Math.min(sel + 1, items.length - 1); mark(); ev.preventDefault(); }
    else if (ev.key === "ArrowUp") { sel = Math.max(sel - 1, 0); mark(); ev.preventDefault(); }
    else if (ev.key === "Enter" && sel >= 0) { choose(items[sel]); ev.preventDefault(); }
    else if (ev.key === "Escape") box.hidden = true;
  });
  function mark() { [...box.children].forEach((d, i) => d.classList.toggle("sel", i === sel)); }
  box.addEventListener("mousedown", (ev) => {
    const d = ev.target.closest("div[data-i]");
    if (d) choose(items[+d.dataset.i]);
  });
  document.addEventListener("click", (ev) => { if (!ev.target.closest(".search-wrap")) box.hidden = true; });
}

function selectCounty(fips, c) {
  const dom = byId[c.ut[0]];
  const others = c.ut.slice(1).map((id) => byId[id]).filter(Boolean);
  if (dom) select(dom, { county: c, others }, true);
  if (c.ll && map) map.flyTo(c.ll, 8);
}

/* ---------- render ---------- */
function card(lbl, val, note, cls = "") {
  return `<div class="card"><p class="lbl">${lbl}</p><p class="val ${cls}">${val}</p>${note ? `<p class="note">${note}</p>` : ""}</div>`;
}

const SCEN_NOTE = {
  pipeline: "this utility's planned capacity",
  state: "state planned-capacity trajectory",
  low: "LBNL low load growth (+13%/yr)",
  central: "LBNL central load growth (+21%/yr)",
  high: "LBNL high load growth (+27%/yr)",
};
const getSpend = () => Math.max(0, +document.getElementById("spend").value || NAT_SPEND);
const stateSpend = (u) => (STATES[u.st] && STATES[u.st].spend) ? STATES[u.st].spend : NAT_SPEND;

function select(u, ctx, fly) {
  selected = u;
  document.getElementById("result").hidden = false;
  document.getElementById("spend").value = stateSpend(u);
  document.getElementById("u-name").textContent = u.n;
  let meta = [u.st, u.own].filter(Boolean).join(" · ");
  if (ctx && ctx.county) {
    meta = `Dominant utility for ${esc(ctx.county.nm)}, ${ctx.county.st} · ` + meta;
    if (ctx.others.length) meta += ` · county also served by: ${ctx.others.map((o) => esc(o.n)).join(", ")}`;
  }
  document.getElementById("u-meta").innerHTML = meta;

  const b = [];
  if (u.own) b.push(`<span class="badge">${esc(u.own)}</span>`);
  if (u.omw === 0 && u.oc === 0 && u.pmw > 0) b.push(`<span class="badge new">data centers on the way (planned capacity only)</span>`);
  document.getElementById("u-badges").innerHTML = b.join("");

  const hasMw = u.omw > 0;
  const eff = pctEff(BETA, u.omw);
  const cards = [];
  cards.push(card("Data center load on this utility",
    hasMw ? fmtMw(u.omw) : (u.oc > 0 ? "not reported" : "none"),
    u.oc > 0 ? `${u.oc} data ${u.oc === 1 ? "center" : "centers"} drawing power here` : "none in its territory"));
  if (hasMw) {
    cards.push(card(`How much faster farm power prices are climbing <span class="tag tag-est">estimated</span>`,
      fmtPct(eff), `as this utility absorbs ${fmtMw(u.omw)} of data center demand`, "up"));
    cards.push(card("What it's costing a typical farm", fmtUsd(eff / 100 * stateSpend(u)) + "/yr",
      `on a ${u.st || "U.S."} farm's ${fmtUsd(stateSpend(u))} power-and-utilities bill`));
  } else {
    cards.push(card(`How much faster farm power prices are climbing <span class="tag tag-est">estimated</span>`, "n/a",
      "no operating capacity reported here yet"));
  }
  cards.push(card("Planned capacity", u.pmw > 0 ? fmtMw(u.pmw) : "none",
    u.pc > 0 ? `${u.pc} more ${u.pc === 1 ? "facility" : "facilities"} on the way` : "none in the pipeline"));
  document.getElementById("now-cards").innerHTML = cards.join("");

  renderProj();
  renderFarm();
  if (fly && terrLayer) {
    const lyr = terrLayer.getLayers().find((l) => l.feature.properties.u === u.u);
    if (lyr && map) map.flyToBounds(lyr.getBounds(), { maxZoom: 7 });
  }
}

function renderProj() {
  if (!selected) return;
  const u = selected;
  const yr = +document.getElementById("yr").value;
  const scen = document.getElementById("scen").value;
  document.getElementById("yr-out").textContent = yr;
  const mw = projectedMw(u, scen, yr);
  const eff = pctEff(BETA, mw);
  const note = (scen === "state" && u.omw === 0)
    ? "no operating capacity to grow; use the planned-capacity scenario" : (SCEN_NOTE[scen] || "");
  const cards = [
    card("Projected data center load", fmtMw(mw), note),
    card(`How much faster farm power prices climb <span class="tag tag-scen">scenario</span>`, fmtPct(eff),
      `if this capacity gets built`, "up"),
    card("What it would cost a typical farm", fmtUsd(eff / 100 * stateSpend(u)) + "/yr",
      `in ${yr}, ${u.st || "U.S."} avg farm`),
  ];
  document.getElementById("proj-cards").innerHTML = cards.join("");
  renderFarm();
}

function renderFarm() {
  if (!selected) return;
  const u = selected;
  const spend = getSpend();
  const yr = +document.getElementById("yr").value;
  const scen = document.getElementById("scen").value;
  const eNow = pctEff(BETA, u.omw);
  const pMid = pctEff(BETA, projectedMw(u, scen, yr));
  document.getElementById("spend-help").innerHTML =
    `${u.st || "State"} average ${fmtUsd(stateSpend(u))}/yr &middot; national average ${fmtUsd(NAT_SPEND)}/yr`;
  document.getElementById("farm-cards").innerHTML = [
    card(`Added to your power bill today <span class="tag tag-est">estimated</span>`,
      fmtUsd(eNow / 100 * spend) + "/yr", null, "up"),
    card(`Added to your bill by ${yr} <span class="tag tag-scen">scenario</span>`,
      fmtUsd(pMid / 100 * spend) + "/yr", "drag the year slider above", "up"),
  ].join("");
}

/* ---------- map ---------- */
const BREAKS = [0.5, 5, 10, 15, 20];
const COLORS = ["#f6e3da", "#F5C4B3", "#F0997B", "#D85A30", "#993C1D"];
function effColor(mw) {
  const p = pctEff(BETA, mw);
  for (let i = BREAKS.length - 1; i >= 0; i--) if (p >= BREAKS[i]) return COLORS[i];
  return "#eceae5";
}

function initMap(terr, fac) {
  map = L.map("map", { scrollWheelZoom: false }).setView([39.5, -97], 4);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
    attribution: '&copy; <a href="https://www.esri.com/">Esri</a>',
    maxZoom: 12, maxNativeZoom: 12,
  }).addTo(map);

  terrLayer = L.geoJSON(terr, {
    style: (f) => {
      const u = byId[f.properties.u] || { omw: 0 };
      return { color: "#b09a8d", weight: 0.6, fillColor: effColor(u.omw), fillOpacity: 0.55 };
    },
    onEachFeature: (f, lyr) => {
      const u = byId[f.properties.u];
      if (!u) return;
      lyr.bindTooltip(`${esc(u.n)}: ${u.omw > 0 ? fmtMw(u.omw) + ", " + fmtPct(pctEff(BETA, u.omw)) + " ag-price growth" : "no operating capacity"}`, { sticky: true });
      lyr.on("click", () => { select(u, null, false); document.getElementById("result").scrollIntoView({ behavior: "smooth" }); });
    },
  }).addTo(map);

  const canvas = L.canvas({ padding: 0.3 });
  fac.forEach((p) => {
    const op = p.s === "op";
    const r = p.mw ? Math.min(10, 2 + Math.sqrt(p.mw) / 3) : 2.5;
    L.circleMarker(p.ll, {
      renderer: canvas, radius: r,
      color: op ? "#3a3a38" : "#BA7517", weight: op ? 0 : 1.2,
      fillColor: op ? "#3a3a38" : "transparent", fillOpacity: op ? 0.55 : 0.9,
    }).bindTooltip(`${esc(p.nm)}${p.op ? " · " + esc(p.op) : ""}${p.mw ? " · " + Math.round(p.mw) + " MW" : ""} (${op ? "operating" : "planned"})`)
      .addTo(map);
  });

  document.getElementById("legend").innerHTML =
    `<span><b>How much faster farm power prices are climbing:</b></span>` +
    BREAKS.map((b, i) => `<span><span class="sw" style="background:${COLORS[i]}"></span>&ge;${b}%</span>`).join("") +
    `<span style="margin-left:12px"><span class="dot" style="background:#3a3a38"></span>operating</span>` +
    `<span><span class="dot" style="border:1.2px solid #BA7517"></span>planned</span>`;
}

boot();
