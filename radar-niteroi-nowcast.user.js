// ==UserScript==
// @name         Preditor de Chuva - Radar Niterói
// @namespace    https://radar.niteroi.rj.gov.br/
// @version      2.1.1
// @description  Prevê quando a chuva chega, quanto dura e quanto chove num ponto escolhido, a partir do radar meteorológico de Niterói
// @author       marco-jardim
// @homepageURL  https://github.com/marco-jardim/radar-niteroi-nowcast
// @supportURL   https://github.com/marco-jardim/radar-niteroi-nowcast/issues
// @updateURL    https://raw.githubusercontent.com/marco-jardim/radar-niteroi-nowcast/main/radar-niteroi-nowcast.user.js
// @downloadURL  https://raw.githubusercontent.com/marco-jardim/radar-niteroi-nowcast/main/radar-niteroi-nowcast.user.js
// @license      MIT
// @match        https://radar.niteroi.rj.gov.br/*
// @icon         https://radar.niteroi.rj.gov.br/assets/logo.c4021fe7.png
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '2.1.1';
  const LOG = '[Preditor de Chuva]';

  // ── Instância única ──────────────────────────────────────────────
  if (window.__rp2Instance && typeof window.__rp2Instance.destroy === 'function') {
    try {
      window.__rp2Instance.destroy();
    } catch (err) {
      console.error(LOG, err);
    }
  }
  const leftoverV1 = document.getElementById('rain-predictor-ui');
  if (leftoverV1) leftoverV1.remove();

  // ── Constantes ───────────────────────────────────────────────────
  const API = 'https://radar.niteroi.rj.gov.br:3337';
  const DS = 4; // fator de redução da imagem
  const STEP = 5; // minutos entre passos da previsão
  const NFRAMES = 7;
  const CACHE_MAX = 16;
  const POLL_MS = 60000;
  const TICK_MS = 30000;
  const DEFAULT_TARGET = { lat: -22.9033, lon: -43.1089, name: 'Icaraí, Niterói' };
  const KEYS = { settings: 'rp2:settings', ui: 'rp2:ui', target: 'rp2:target' };
  const COMPASS = ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO'];
  const R_EARTH = 6371;
  const RAD = Math.PI / 180;
  const TITLE_RE = /^\(🌧[^)]*\)\s/;
  const Z_TABLE = new Float32Array(256);
  for (let i = 0; i < 256; i++) Z_TABLE[i] = Math.pow(10, i / 10);

  const OPTIONS = {
    horizon: [60, 90, 120, 180],
    lead: [15, 30, 45, 60],
    minChance: [30, 50, 70],
    thr: [15, 20, 25],
  };
  const DEFAULTS = { v: 1, horizon: 120, lead: 30, minChance: 50, thr: 20, alerts: false, showMap: true };

  // ── Utilitários ──────────────────────────────────────────────────
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const sleep0 = () => new Promise((r) => setTimeout(r, 0));
  const fmtClock = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const num = (x, d = 1) => x.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const mercInv = (y) => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
  const rateOf = (dbz) => Math.pow(Math.pow(10, dbz / 10) / 200, 1 / 1.6);
  const dbzOfRate = (r) => 10 * Math.log10(200 * Math.pow(r, 1.6));
  const fmtRate = (r) => (r < 10 ? num(r, 1) : num(r, 0));

  function median(arr) {
    const s = arr.slice().sort((a, b) => a - b);
    const n = s.length;
    if (!n) return 0;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }

  function haversine(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * RAD;
    const dLon = (lon2 - lon1) * RAD;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function dirName(deg) {
    return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  }

  function rainClass(r) {
    if (r < 2.5) return 'fraca';
    if (r < 10) return 'moderada';
    if (r < 50) return 'forte';
    return 'muito forte';
  }

  function readJSON(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      console.warn(LOG, 'Falha ao ler ' + key, err);
      return null;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      console.warn(LOG, 'Falha ao gravar ' + key, err);
    }
  }

  // ── Configurações persistidas ────────────────────────────────────
  function loadSettings() {
    const s = Object.assign({}, DEFAULTS);
    const raw = readJSON(KEYS.settings);
    if (raw && typeof raw === 'object' && raw.v === 1) {
      Object.keys(OPTIONS).forEach((k) => {
        if (OPTIONS[k].includes(raw[k])) s[k] = raw[k];
      });
      if (typeof raw.alerts === 'boolean') s.alerts = raw.alerts;
      if (typeof raw.showMap === 'boolean') s.showMap = raw.showMap;
    }
    return s;
  }
  const settings = loadSettings();
  const saveSettings = () => writeJSON(KEYS.settings, settings);

  function loadTarget() {
    const t = readJSON(KEYS.target);
    if (t && Number.isFinite(t.lat) && Number.isFinite(t.lon) && Math.abs(t.lat) <= 90 && Math.abs(t.lon) <= 180) {
      return { lat: t.lat, lon: t.lon, name: typeof t.name === 'string' && t.name ? t.name.slice(0, 60) : 'Local escolhido' };
    }
    return Object.assign({}, DEFAULT_TARGET);
  }

  function loadUiState() {
    const u = readJSON(KEYS.ui) || {};
    return {
      x: Number.isFinite(u.x) ? u.x : null,
      y: Number.isFinite(u.y) ? u.y : null,
      min: !!u.min,
      closed: !!u.closed,
    };
  }

  // ── Estado ───────────────────────────────────────────────────────
  const state = {
    destroyed: false,
    disc: null,
    discPromise: null,
    frameCache: new Map(),
    frames: [],
    latestId: null,
    result: null,
    error: null,
    loading: true,
    runPromise: null,
    again: null,
    map: null,
    mapFailed: false,
    layer: null,
    picking: null,
    notifiedKey: null,
    timers: [],
    cleanups: [],
    msgTimer: null,
    target: loadTarget(),
    timings: {},
    skill: null,
    skillKey: null,
  };
  const skillKey = (productId, thr) => productId + ':' + thr;
  const uiState = loadUiState();
  const ui = { root: null, fab: null, style: null };

  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    state.cleanups.push(() => target.removeEventListener(type, fn, opts));
  }

  // ── API ──────────────────────────────────────────────────────────
  async function apiGet(path) {
    let res;
    try {
      res = await fetch(API + path, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    } catch (err) {
      const e = new Error('Sem conexão com o servidor do radar');
      e.cause = err;
      throw e;
    }
    let body = null;
    const text = await res.text();
    try {
      body = text ? JSON.parse(text) : null;
    } catch (err) {
      if (res.ok) throw new Error('Resposta inválida do radar (JSON malformado)');
    }
    let code = '';
    if (body && !Array.isArray(body) && Array.isArray(body.errors) && body.errors[0] && body.errors[0].code) {
      code = String(body.errors[0].code);
    }
    if (!res.ok) {
      const e = new Error('Radar respondeu HTTP ' + res.status + (code ? ' ' + code : ''));
      e.status = res.status;
      e.code = code;
      throw e;
    }
    if (!Array.isArray(body)) {
      const e = new Error('Resposta inesperada do radar' + (code ? ' (' + code + ')' : ''));
      e.status = res.status;
      e.code = code;
      throw e;
    }
    return body;
  }

  // ── Descoberta (radar, tipo de produto, paleta) ──────────────────
  async function doDiscover() {
    const radars = await apiGet('/radars');
    const radar = radars.find((r) => r && r.id && !r.inactive);
    if (!radar) throw new Error('Nenhum radar ativo encontrado');
    const types = await apiGet('/radars/product-types');
    const hasMap = (t) => t && Array.isArray(t.colormaps) && t.colormaps.length;
    const type = types.find((t) => hasMap(t) && t.alias === 'pmax-zv') || types.find((t) => hasMap(t) && t.is_map);
    if (!type) throw new Error('Produto de refletividade não encontrado no radar');

    const lut = new Uint8Array(1 << 24);
    const colors = [];
    let minDbz = Infinity;
    type.colormaps.forEach((c) => {
      const v = Number(c && c.value);
      const m = /^#?([0-9a-f]{6})$/i.exec(String((c && c.color) || ''));
      if (!Number.isFinite(v) || !m) return;
      lut[parseInt(m[1], 16)] = clamp(Math.round(v), 1, 255);
      colors.push({ dbz: v, css: '#' + m[1].toLowerCase() });
      minDbz = Math.min(minDbz, v);
    });
    if (!colors.length) throw new Error('Paleta de cores do radar inválida');
    colors.sort((a, b) => a.dbz - b.dbz);

    const lat0 = Number(radar.central_latitude);
    const lon0 = Number(radar.central_longitude);
    const lats = [Number(radar.minor_latitude), Number(radar.major_latitude)];
    const lons = [Number(radar.minor_longitude), Number(radar.major_longitude)];
    const radiusKm = Number(radar.radius);
    if (![lat0, lon0, radiusKm, ...lats, ...lons].every(Number.isFinite)) throw new Error('Geometria do radar inválida');
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    return {
      radar,
      type,
      lut,
      colors,
      minDbz,
      lat0,
      lon0,
      radiusKm,
      freq: Number(radar.time_frequency) || 5,
      minLat,
      maxLat,
      minLon: Math.min(...lons),
      maxLon: Math.max(...lons),
      yTop: mercY(maxLat),
      yBot: mercY(minLat),
      geom: null,
    };
  }

  function discover(force) {
    if (force) {
      state.disc = null;
      state.discPromise = null;
      state.frameCache.clear();
    }
    if (state.disc) return Promise.resolve(state.disc);
    if (!state.discPromise) {
      state.discPromise = doDiscover()
        .then((d) => {
          state.disc = d;
          return d;
        })
        .finally(() => {
          state.discPromise = null;
        });
    }
    return state.discPromise;
  }

  async function fetchProducts(n) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const disc = await discover(attempt > 0);
      try {
        const list = await apiGet(
          '/radars/' + encodeURIComponent(disc.radar.id) + '/products?type_id=' + encodeURIComponent(disc.type.id) +
            '&cutoff_datetime=' + Date.now() + '&amount=' + n
        );
        const prods = list
          .filter((p) => p && p.id && Number.isFinite(Number(p.datetime)) && Array.isArray(p.images) && p.images[0] && p.images[0].path)
          .sort((a, b) => Number(a.datetime) - Number(b.datetime));
        if (!prods.length) throw new Error('O radar não tem imagens recentes');
        return prods.slice(-n);
      } catch (err) {
        const notFound = err.status === 403 || err.status === 404 || /_NOT_FOUND$/.test(err.code || '');
        if (attempt === 0 && notFound) {
          console.warn(LOG, 'Catálogo do radar mudou; redescobrindo', err);
          state.disc = null;
          state.discPromise = null;
          state.frameCache.clear();
          continue;
        }
        throw err;
      }
    }
    throw new Error('Falha ao consultar o radar');
  }

  // ── Geometria da grade ───────────────────────────────────────────
  function getGeom(disc, W, H) {
    if (disc.geom && disc.geom.W === W && disc.geom.H === H) return disc.geom;
    const gw = Math.ceil(W / DS);
    const gh = Math.ceil(H / DS);
    const lonSpan = disc.maxLon - disc.minLon;
    const ySpan = disc.yTop - disc.yBot;
    const cosLat = Math.cos(disc.lat0 * RAD);
    const g = {
      W, H, gw, gh, lonSpan, ySpan,
      kmX: (lonSpan * RAD * R_EARTH * cosLat / W) * DS,
      kmY: (ySpan * R_EARTH * cosLat / H) * DS,
      cov: new Uint8Array(gw * gh),
      cov2: null,
    };
    g.geoToGrid = (lat, lon) => ({
      x: ((lon - disc.minLon) / lonSpan) * (W / DS) - 0.5,
      y: ((disc.yTop - mercY(lat)) / ySpan) * (H / DS) - 0.5,
    });
    g.gridToGeo = (x, y) => ({
      lat: mercInv(disc.yTop - ((y + 0.5) * DS / H) * ySpan),
      lon: disc.minLon + ((x + 0.5) * DS / W) * lonSpan,
    });
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const p = g.gridToGeo(x, y);
        if (haversine(p.lat, p.lon, disc.lat0, disc.lon0) <= disc.radiusKm) g.cov[y * gw + x] = 1;
      }
    }
    // cobertura da grade grossa (2x): célula coberta se qualquer filha for coberta
    const cw = Math.ceil(gw / 2);
    const ch = Math.ceil(gh / 2);
    g.cov2 = new Uint8Array(cw * ch);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) if (g.cov[y * gw + x]) g.cov2[(y >> 1) * cw + (x >> 1)] = 1;
    }
    disc.geom = g;
    return g;
  }

  // ── Decodificação das imagens ────────────────────────────────────
  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Falha ao carregar a imagem do radar'));
      img.src = url;
    });
  }

  async function decodeFrame(prod, disc) {
    const path = prod.images[0].path;
    const img = await loadImage(/^https?:/i.test(path) ? path : API + path);
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    if (!W || !H) throw new Error('Imagem do radar vazia');
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    let data;
    try {
      data = ctx.getImageData(0, 0, W, H).data;
    } catch (err) {
      const e = new Error('Não foi possível ler os pixels da imagem do radar (CORS)');
      e.cause = err;
      throw e;
    }
    const geom = getGeom(disc, W, H);
    const gw = geom.gw;
    const sum = new Float32Array(gw * geom.gh);
    const lut = disc.lut;
    for (let y = 0; y < H; y++) {
      const row = Math.floor(y / DS) * gw;
      let i = y * W * 4;
      for (let x = 0; x < W; x++, i += 4) {
        if (data[i + 3] < 128) continue;
        const d = lut[(data[i] << 16) | (data[i + 1] << 8) | data[i + 2]];
        if (d) sum[row + Math.floor(x / DS)] += Z_TABLE[d];
      }
    }
    const grid = new Float32Array(sum.length);
    const area = DS * DS;
    for (let i = 0; i < sum.length; i++) {
      if (sum[i] <= 0) continue;
      const dbz = 10 * Math.log10(sum[i] / area);
      grid[i] = dbz < disc.minDbz - 0.01 ? 0 : dbz;
    }
    return { id: prod.id, t: Number(prod.datetime), grid, geom };
  }

  async function loadFrames(prods) {
    const disc = state.disc;
    const need = prods.filter((p) => !state.frameCache.has(p.id));
    const results = await Promise.allSettled(need.map((p) => decodeFrame(p, disc)));
    let lastErr = null;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        state.frameCache.set(need[i].id, r.value);
      } else {
        lastErr = r.reason;
        console.error(LOG, 'Quadro ' + need[i].id + ' ignorado', r.reason);
      }
    });
    while (state.frameCache.size > CACHE_MAX) state.frameCache.delete(state.frameCache.keys().next().value);
    const frames = prods.map((p) => state.frameCache.get(p.id)).filter(Boolean);
    if (!frames.length || frames[frames.length - 1].id !== prods[prods.length - 1].id) {
      throw lastErr || new Error('Não foi possível decodificar a imagem mais recente do radar');
    }
    return frames;
  }

  // ── Máscara de ruído estático ────────────────────────────────────
  function cleanFrames(frames, geom, thr) {
    const len = geom.gw * geom.gh;
    const N = frames.length;
    if (N < 3) return { grids: frames.map((f) => f.grid), clutterCells: 0 };
    const wetN = new Uint8Array(len);
    const sum = new Float32Array(len);
    const sq = new Float32Array(len);
    frames.forEach((f) => {
      const g = f.grid;
      for (let i = 0; i < len; i++) {
        const v = g[i];
        if (v >= thr) wetN[i]++;
        sum[i] += v;
        sq[i] += v * v;
      }
    });
    const mask = new Uint8Array(len);
    let clutterCells = 0;
    for (let i = 0; i < len; i++) {
      if (wetN[i] !== N) continue;
      const mean = sum[i] / N;
      if (Math.sqrt(Math.max(0, sq[i] / N - mean * mean)) < 1.5) {
        mask[i] = 1;
        clutterCells++;
      }
    }
    const grids = frames.map((f) => {
      const c = new Float32Array(f.grid);
      if (clutterCells) for (let i = 0; i < len; i++) if (mask[i]) c[i] = 0;
      return c;
    });
    return { grids, clutterCells };
  }

  // ── Movimento (busca exaustiva na grade DS sobre grades suavizadas) ──
  // média 3×3 em dBZ (zeros incluídos) e reaplicação da máscara de cobertura
  function smooth3(g, w, h, cov) {
    const out = new Float32Array(g.length);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - 1);
      const y1 = Math.min(h - 1, y + 1);
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!cov[i]) continue;
        const x0 = Math.max(0, x - 1);
        const x1 = Math.min(w - 1, x + 1);
        let s = 0;
        for (let yy = y0; yy <= y1; yy++) {
          for (let xx = x0; xx <= x1; xx++) s += g[yy * w + xx];
        }
        out[i] = s / 9;
      }
    }
    return out;
  }

  function wetList(g, w, thr) {
    const idx = [];
    const xs = [];
    const ys = [];
    for (let i = 0; i < g.length; i++) {
      if (g[i] >= thr) {
        idx.push(i);
        xs.push(i % w);
        ys.push((i / w) | 0);
      }
    }
    return { idx, xs, ys, n: idx.length };
  }

  const countWet = (g, thr) => {
    let n = 0;
    for (let i = 0; i < g.length; i++) if (g[i] >= thr) n++;
    return n;
  };

  // custo(dx,dy): erro absoluto médio entre A(p) e B(p+d) nas células onde A ou B >= limiar
  function makeCost(A, B, cov, w, h, thr) {
    const la = wetList(A, w, thr);
    const lb = wetList(B, w, thr);
    return function (dx, dy) {
      let sum = 0;
      let n = 0;
      for (let k = 0; k < la.n; k++) {
        const x = la.xs[k] + dx;
        const y = la.ys[k] + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = la.idx[k];
        const j = y * w + x;
        if (!cov[i] || !cov[j]) continue;
        sum += Math.abs(A[i] - B[j]);
        n++;
      }
      for (let k = 0; k < lb.n; k++) {
        const x = lb.xs[k] - dx;
        const y = lb.ys[k] - dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const j = lb.idx[k];
        const i = y * w + x;
        if (A[i] >= thr) continue; // já contada no primeiro laço
        if (!cov[i] || !cov[j]) continue;
        sum += Math.abs(A[i] - B[j]);
        n++;
      }
      return n >= 30 ? sum / n : Infinity;
    };
  }

  const searchRadius = (geom, dtMin) => Math.min(30, Math.max(1, Math.ceil((120 * dtMin) / 60 / Math.min(geom.kmX, geom.kmY))));

  // superfície de custo completa em [-S,S]² (índice (dy+S)*(2S+1)+(dx+S))
  function costSurface(A, B, geom, thr, S) {
    const cost = makeCost(A, B, geom.cov, geom.gw, geom.gh, thr);
    const W = 2 * S + 1;
    const surf = new Float32Array(W * W);
    for (let dy = -S; dy <= S; dy++) {
      for (let dx = -S; dx <= S; dx++) surf[(dy + S) * W + dx + S] = cost(dx, dy);
    }
    return surf;
  }

  // mínimo da superfície com refinamento parabólico por eixo
  function argminRefined(surf, S) {
    const W = 2 * S + 1;
    let best = Infinity;
    let bx = 0;
    let by = 0;
    let bmag = Infinity;
    for (let dy = -S; dy <= S; dy++) {
      for (let dx = -S; dx <= S; dx++) {
        const c = surf[(dy + S) * W + dx + S];
        if (!Number.isFinite(c)) continue;
        const mag = dx * dx + dy * dy;
        if (c < best || (c === best && mag < bmag)) {
          best = c;
          bx = dx;
          by = dy;
          bmag = mag;
        }
      }
    }
    if (!Number.isFinite(best)) return null;
    const at = (dx, dy) => (Math.abs(dx) > S || Math.abs(dy) > S ? Infinity : surf[(dy + S) * W + dx + S]);
    const refine = (cm, c0, cp) => {
      if (!Number.isFinite(cm) || !Number.isFinite(c0) || !Number.isFinite(cp)) return 0;
      const den = cm - 2 * c0 + cp;
      return den > 1e-9 ? clamp((0.5 * (cm - cp)) / den, -0.5, 0.5) : 0;
    };
    const sx = refine(at(bx - 1, by), best, at(bx + 1, by));
    const sy = refine(at(bx, by - 1), best, at(bx, by + 1));
    return { dx: bx + sx, dy: by + sy, cost: best, zero: at(0, 0) };
  }

  function medianFinite(surf) {
    const vals = [];
    for (let k = 0; k < surf.length; k++) if (Number.isFinite(surf[k])) vals.push(surf[k]);
    return vals.length ? median(vals) : NaN;
  }

  // casador de um par (grades já suavizadas)
  const matchOne = (A, B, geom, thr, S) => argminRefined(costSurface(A, B, geom, thr, S), S);

  async function estimateMotion(frames, grids, geom, thr) {
    const n = frames.length;
    const pairs = [];
    const smCache = new Map();
    const smoothed = (i) => {
      if (!smCache.has(i)) smCache.set(i, smooth3(grids[i], geom.gw, geom.gh, geom.cov));
      return smCache.get(i);
    };
    // pares candidatos (mais novo primeiro)
    for (let i = n - 3, c = 0; i >= 0 && c < 5; i--, c++) {
      const dtMin = (frames[i + 2].t - frames[i].t) / 60000;
      const rec = { idx: i, from: frames[i].id, to: frames[i + 2].id, dtMin: Math.round(dtMin * 10) / 10, wetA: countWet(grids[i], thr), wetB: countWet(grids[i + 2], thr), valid: false };
      if (dtMin < 4 || dtMin > 20) rec.skipped = 'intervalo fora de 4–20 min';
      else if (rec.wetA < 20) rec.skipped = 'poucos ecos no quadro inicial';
      else rec.eligible = true;
      pairs.push(rec);
    }
    // moda do intervalo entre os elegíveis
    const counts = new Map();
    pairs.forEach((p) => {
      if (p.eligible) counts.set(Math.round(p.dtMin), (counts.get(Math.round(p.dtMin)) || 0) + 1);
    });
    let modeDt = null;
    let modeCount = 0;
    pairs.forEach((p) => {
      if (!p.eligible) return;
      const k = Math.round(p.dtMin);
      if (counts.get(k) > modeCount) {
        modeCount = counts.get(k);
        modeDt = k;
      }
    });
    const kept = pairs.filter((p) => {
      if (!p.eligible) return false;
      if (Math.abs(p.dtMin - modeDt) > 1) {
        p.skipped = 'intervalo diferente da moda';
        return false;
      }
      return true;
    });
    const motion = { pairs: pairs.slice().reverse(), valid: 0, vx: 0, vy: 0, sigmaKmMin: null, speedKmh: 0, fromDeg: null, toDeg: null, unreliable: false, aggBest: null, aggZero: null };
    if (!kept.length) return motion;

    const S = searchRadius(geom, Math.max(...kept.map((p) => p.dtMin)));
    const W = 2 * S + 1;
    const num = new Float64Array(W * W);
    const den = new Float64Array(W * W);
    const valid = [];
    for (let r = 0; r < kept.length; r++) {
      const p = kept[r];
      const weight = Math.pow(0.8, r);
      const surf = costSurface(smoothed(p.idx), smoothed(p.idx + 2), geom, thr, S);
      await sleep0();
      const own = argminRefined(surf, S);
      const med = medianFinite(surf);
      if (!own || !(med > 1e-9)) {
        p.skipped = 'sem correspondência';
        continue;
      }
      for (let k = 0; k < surf.length; k++) {
        if (!Number.isFinite(surf[k])) continue;
        num[k] += (weight * surf[k]) / med;
        den[k] += weight;
      }
      p.dx = own.dx;
      p.dy = own.dy;
      p.cost = own.cost;
      p.zeroCost = own.zero;
      p.vx = own.dx / p.dtMin; // células/min
      p.vy = own.dy / p.dtMin;
      p.speedKmh = 60 * Math.hypot(p.vx * geom.kmX, p.vy * geom.kmY);
      p.weight = weight;
      p.valid = true;
      valid.push(p);
    }
    motion.valid = valid.length;
    if (!valid.length) return motion;
    const agg = new Float64Array(W * W);
    for (let k = 0; k < agg.length; k++) agg[k] = den[k] > 0 ? num[k] / den[k] : Infinity;
    const best = argminRefined(agg, S);
    if (!best) {
      motion.valid = 0;
      return motion;
    }
    let wsum = 0;
    let dtRef = 0;
    valid.forEach((p) => {
      wsum += p.weight;
      dtRef += p.weight * p.dtMin;
    });
    dtRef /= wsum;
    motion.aggBest = best.cost;
    motion.aggZero = best.zero;
    motion.vx = best.dx / dtRef;
    motion.vy = best.dy / dtRef;
    let acc = 0;
    valid.forEach((p) => {
      acc += ((p.vx - motion.vx) * geom.kmX) ** 2 + ((p.vy - motion.vy) * geom.kmY) ** 2;
    });
    motion.sigmaKmMin = Math.max(Math.sqrt(acc / valid.length), 2 / 60);
    motion.speedKmh = 60 * Math.hypot(motion.vx * geom.kmX, motion.vy * geom.kmY);
    if (motion.speedKmh > 150) {
      motion.unreliable = true;
      motion.sigmaKmMin = Math.max(motion.sigmaKmMin, motion.speedKmh / 60 / 2);
    }
    if (motion.speedKmh >= 0.5) {
      motion.toDeg = (((Math.atan2(motion.vx * geom.kmX, -(motion.vy * geom.kmY)) / RAD) % 360) + 360) % 360;
      motion.fromDeg = (motion.toDeg + 180) % 360;
    }
    return motion;
  }

  // ── Previsão no ponto (advecção constante + probabilidade de vizinhança) ──
  function nowcast(g, geom, tg, v, sigKmMin, thr, horizon) {
    const { gw, gh, kmX, kmY, cov } = geom;
    const steps = [];
    for (let t = 0; t <= horizon; t += STEP) {
      const sx = tg.x - v.x * t;
      const sy = tg.y - v.y * t;
      const rkm = Math.min(25, 2 + sigKmMin * t + 0.05 * t);
      const rx = rkm / kmX;
      const ry = rkm / kmY;
      let n = 0;
      let sumR = 0;
      const wetRates = [];
      const y0 = Math.max(0, Math.ceil(sy - ry));
      const y1 = Math.min(gh - 1, Math.floor(sy + ry));
      const x0 = Math.max(0, Math.ceil(sx - rx));
      const x1 = Math.min(gw - 1, Math.floor(sx + rx));
      for (let iy = y0; iy <= y1; iy++) {
        const dyk = (iy - sy) * kmY;
        for (let ix = x0; ix <= x1; ix++) {
          const dxk = (ix - sx) * kmX;
          if (dxk * dxk + dyk * dyk > rkm * rkm) continue;
          const i = iy * gw + ix;
          if (!cov[i]) continue;
          n++;
          const d = g[i];
          if (d >= thr) {
            const r = rateOf(d);
            sumR += r;
            wetRates.push(r);
          }
        }
      }
      const step = { t, p: 0, meanR: 0, wetR: 0, p90R: 0, outOfRange: n === 0, rkm, sx, sy };
      if (n > 0) {
        const w = wetRates.length;
        step.p = w / n;
        step.meanR = sumR / n;
        if (w) {
          step.wetR = sumR / w;
          wetRates.sort((a, b) => a - b);
          step.p90R = wetRates[Math.min(w - 1, Math.ceil(0.9 * w) - 1)];
        }
      }
      steps.push(step);
    }
    return steps;
  }

  function wetRainSum(g, geom, tg, radiusKm, thr) {
    let s = 0;
    for (let y = 0; y < geom.gh; y++) {
      const dyk = (y - tg.y) * geom.kmY;
      if (Math.abs(dyk) > radiusKm) continue;
      for (let x = 0; x < geom.gw; x++) {
        const dxk = (x - tg.x) * geom.kmX;
        if (dxk * dxk + dyk * dyk > radiusKm * radiusKm) continue;
        const i = y * geom.gw + x;
        if (geom.cov[i] && g[i] >= thr) s += rateOf(g[i]);
      }
    }
    return s;
  }

  // ── Análise completa ─────────────────────────────────────────────
  async function analyze(frames, disc) {
    const latest = frames[frames.length - 1];
    const geom = latest.geom;
    const thr = settings.thr;
    const horizon = settings.horizon;
    const target = Object.assign({}, state.target);
    if (haversine(target.lat, target.lon, disc.lat0, disc.lon0) > disc.radiusKm) {
      throw new Error('Local fora da cobertura do radar (raio de ' + Math.round(disc.radiusKm) + ' km)');
    }
    const tg = geom.geoToGrid(target.lat, target.lon);
    const timings = {};

    let t0 = performance.now();
    const { grids, clutterCells } = cleanFrames(frames, geom, thr);
    const g = grids[grids.length - 1];
    const motion = await estimateMotion(frames, grids, geom, thr);
    timings.motion = Math.round(performance.now() - t0);

    // chuva mais próxima no último quadro
    let anyRain = false;
    let nearest = null;
    let bestD2 = Infinity;
    for (let y = 0; y < geom.gh; y++) {
      for (let x = 0; x < geom.gw; x++) {
        const i = y * geom.gw + x;
        if (!geom.cov[i] || g[i] < thr) continue;
        anyRain = true;
        const dxk = (x - tg.x) * geom.kmX;
        const dyk = (y - tg.y) * geom.kmY;
        const d2 = dxk * dxk + dyk * dyk;
        if (d2 < bestD2) {
          bestD2 = d2;
          nearest = { km: Math.sqrt(d2), dxk, dyk };
        }
      }
    }
    if (nearest) {
      nearest.deg = (((Math.atan2(nearest.dxk, -nearest.dyk) / RAD) % 360) + 360) % 360;
      nearest.dir = dirName(nearest.deg);
    }

    t0 = performance.now();
    const hasMotion = motion.valid > 0;
    const v = hasMotion ? { x: motion.vx, y: motion.vy } : { x: 0, y: 0 };
    // habilidade da retroprevisão de 30 min (só vale para o produto/limiar atuais)
    const sk = state.skill && !state.skill.error && state.skill.key === skillKey(latest.id, thr) ? state.skill : null;
    const skillScored = !!(sk && Number.isFinite(sk.csiAdv) && Number.isFinite(sk.csiPers));
    const skillLoses = skillScored && sk.csiAdv < sk.csiPers;
    const skillPenalty = skillLoses && hasMotion;
    let sig = hasMotion ? motion.sigmaKmMin : anyRain ? 15 / 60 : 2 / 60;
    if (skillPenalty) sig = Math.max(sig, motion.speedKmh / 60 / 2);
    const steps = nowcast(g, geom, tg, v, sig, thr, horizon);
    timings.nowcast = Math.round(performance.now() - t0);

    // derivados
    const n = steps.length;
    const rainingNow = steps[0].p >= 0.5;
    let start = -1;
    let level = null;
    if (rainingNow) {
      start = 0;
      level = 'provável';
    } else {
      start = steps.findIndex((s) => s.p >= 0.5);
      if (start >= 0) {
        level = 'provável';
      } else {
        start = steps.findIndex((s) => s.p >= 0.25);
        if (start >= 0) level = 'possível';
      }
    }
    const thrP = level === 'provável' ? 0.5 : 0.25;
    let end = -1;
    let truncated = false;
    let plausibleMax = 0;
    let peak = null;
    if (start >= 0) {
      end = start;
      while (end < n && steps[end].p >= thrP) end++;
      truncated = end >= n;
      for (let k = start; k < end; k++) {
        plausibleMax += (steps[k].p90R * STEP) / 60;
        if (!peak || steps[k].wetR > peak.wetR) peak = steps[k];
      }
    }
    let expected = 0;
    steps.forEach((s) => {
      expected += (s.meanR * STEP) / 60;
    });
    plausibleMax = Math.max(plausibleMax, expected);
    const chance = Math.max(...steps.map((s) => s.p));
    const kind = rainingNow ? 'now' : start >= 0 ? (level === 'provável' ? 'approach' : 'possible') : anyRain ? 'none' : 'clear';
    const firstOut = steps.find((s) => s.outOfRange);

    // tendência: soma de chuva a ≤60 km, último quadro vs ~30 min antes
    let trend = null;
    let prevIdx = -1;
    let prevDiff = Infinity;
    frames.forEach((f, i) => {
      const ageMin = (latest.t - f.t) / 60000;
      if (ageMin >= 20 && Math.abs(ageMin - 30) < prevDiff) {
        prevDiff = Math.abs(ageMin - 30);
        prevIdx = i;
      }
    });
    if (prevIdx >= 0) {
      const a = wetRainSum(g, geom, tg, 60, thr);
      const b = wetRainSum(grids[prevIdx], geom, tg, 60, thr);
      if (a > 0 || b > 0) {
        const ratio = b > 0 ? a / b : Infinity;
        trend = {
          ratio,
          label: ratio > 1.25 ? 'intensificando' : ratio < 0.8 ? 'enfraquecendo' : 'estável',
          pct: Number.isFinite(ratio) ? Math.round((ratio - 1) * 100) : null,
          minutes: Math.round((latest.t - frames[prevIdx].t) / 60000),
        };
      }
    }

    // sentido do movimento vs chuva mais próxima
    let leaving = false;
    if (nearest && hasMotion && motion.speedKmh >= 3 && !motion.unreliable) {
      leaving = motion.vx * geom.kmX * nearest.dxk + motion.vy * geom.kmY * nearest.dyk < 0;
    }

    // confiança
    const LEVELS = ['baixa', 'média', 'alta'];
    const levelOf = (p) => Math.min(2, Math.max(0, p - 1));
    let ptsRest = 0; // pontos sem o critério de nº de pares
    if (hasMotion && motion.sigmaKmMin * 60 < 5) ptsRest++;
    if (chance >= 0.6 || chance <= 0.1) ptsRest++;
    const pts = motion.unreliable ? 0 : ptsRest + (motion.valid >= 3 ? 1 : 0);
    let lvl = levelOf(pts);
    if (skillLoses) {
      lvl = 0;
    } else if (skillScored && sk.csiAdv >= sk.csiPers + 0.05 && hasMotion && !motion.unreliable) {
      lvl = Math.min(lvl + 1, levelOf(ptsRest + 1)); // teto: o que as regras dariam com ≥3 pares
    }
    const confidence = !anyRain ? null : LEVELS[lvl];

    return {
      version: VERSION,
      target,
      originT: latest.t,
      productId: latest.id,
      computedAt: Date.now(),
      thr,
      horizon,
      steps,
      motion,
      sigmaKmMin: sig,
      kmX: geom.kmX,
      kmY: geom.kmY,
      kind,
      level,
      rainingNow,
      startT: start >= 0 ? steps[start].t : null,
      endT: start >= 0 ? steps[Math.min(end, n - 1)].t : null,
      endClock: start >= 0 && !truncated ? steps[end].t : null,
      truncated,
      durationMin: start >= 0 ? (end - start) * STEP : null,
      expected,
      plausibleMax,
      peak: peak && peak.wetR > 0 ? { t: peak.t, wetR: peak.wetR, cls: rainClass(peak.wetR) } : null,
      nowClass: rainClass(steps[0].wetR || steps[0].meanR),
      chance,
      anyRain,
      nearest,
      leaving,
      trend,
      confidence,
      skill: skillScored ? { csiAdv: sk.csiAdv, csiPers: sk.csiPers, motionKmh: sk.motionKmh, at: sk.at, loses: skillLoses } : null,
      skillPenalty,
      outOfRangeFrom: firstOut ? firstOut.t : null,
      clutterCells,
      timings,
    };
  }

  // ── Visão (texto do estado atual) ────────────────────────────────
  const ageMinOf = (R, now) => (now - R.originT) / 60000;

  function computeView(now) {
    if (state.error) {
      return { kind: 'error', title: '⚠️ ' + state.error.message, sub: '', mini: '⚠️ Erro no radar', retry: true, tab: null, notes: [] };
    }
    const R = state.result;
    if (!R) return { kind: 'loading', title: '⏳ Carregando radar…', sub: '', mini: '⏳ Carregando…', tab: null, notes: [] };
    const age = ageMinOf(R, now);
    const mins = R.startT == null ? null : Math.round(R.startT - age);
    const clock = (t) => fmtClock(R.originT + t * 60000);
    const pct = Math.round(R.chance * 100);
    const hh = R.horizon / 60;
    const hTxt = num(hh, Number.isInteger(hh) ? 0 : 1) + ' h';
    const view = { kind: R.kind, mins, pct, tab: null, notes: [] };
    if (R.kind === 'now') {
      view.title = '🌧️ Chovendo agora · ' + R.nowClass;
      view.sub = R.truncated ? 'continua além de ' + R.horizon + ' min' : 'deve parar por volta de ' + clock(R.endClock);
      view.mini = '🌧️ Chovendo agora · ' + R.nowClass;
      view.tab = '(🌧 agora) ';
    } else if (R.kind === 'approach' || R.kind === 'possible') {
      const soon = mins <= 0;
      const ico = R.kind === 'approach' ? '⏱️' : '🌦️';
      const lead = R.kind === 'approach' ? 'Chuva' : 'Possível chuva';
      view.title = ico + ' ' + lead + (soon ? ' a qualquer momento' : ' em ~' + mins + ' min');
      view.sub = 'por volta de ' + clock(R.startT) + ' · chance ' + pct + '%';
      view.mini = (R.kind === 'approach' ? '🌧️ Chuva' : '🌦️ Possível') + (soon ? ' a qualquer momento' : ' em ~' + mins + ' min') + ' · ' + pct + '%';
      view.tab = soon ? '(🌧 agora) ' : '(🌧 ' + mins + 'min) ';
    } else if (R.kind === 'none') {
      view.title = '🌤️ Sem chuva prevista nas próximas ' + hTxt;
      const mv = R.motion.valid > 0 && R.motion.toDeg != null ? ', indo p/ ' + dirName(R.motion.toDeg) : ', quase parada';
      view.sub = R.nearest ? 'chuva a ' + num(R.nearest.km, 0) + ' km ao ' + R.nearest.dir + mv : '';
      view.mini = '🌤️ Sem chuva prevista';
      view.leaving = R.leaving;
    } else {
      view.title = '☀️ Sem chuva no alcance do radar';
      view.sub = '';
      view.mini = '☀️ Sem chuva no radar';
    }
    if (age > 20) view.notes.push('⚠️ Dados do radar com mais de 20 min — previsão pode estar defasada');
    if (R.outOfRangeFrom != null) view.notes.push('Previsão limitada ao alcance do radar a partir de +' + R.outOfRangeFrom + ' min');
    if (R.anyRain && R.motion.valid === 0) view.notes.push('Movimento não detectado — previsão pouco confiável');
    else if (R.motion.unreliable) view.notes.push('Movimento instável — previsão pouco confiável');
    if (R.skill && R.skill.loses) view.notes.push('Chuva se formando/mudando de ritmo — deslocamento pouco previsível agora');
    return view;
  }

  // ── Mapa Leaflet (captura da instância) ──────────────────────────
  function captureMap() {
    const L = window.L;
    const cont = document.querySelector('.leaflet-container');
    if (!L || !L.Map || !cont) return null;
    const orig = L.Map.prototype._fireDOMEvent;
    if (typeof orig !== 'function') return null;
    let found = null;
    L.Map.prototype._fireDOMEvent = function () {
      if (!found) found = this;
      return orig.apply(this, arguments);
    };
    try {
      const r = cont.getBoundingClientRect();
      cont.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    } finally {
      L.Map.prototype._fireDOMEvent = orig;
    }
    return found && typeof found.getCenter === 'function' ? found : null;
  }

  function ensureMap() {
    if (state.map && state.map._container && document.contains(state.map._container)) return state.map;
    state.map = null;
    try {
      state.map = captureMap();
    } catch (err) {
      console.error(LOG, err);
    }
    state.mapFailed = !state.map;
    return state.map;
  }

  function clearOverlay() {
    if (state.layer) {
      try {
        if (state.map) state.map.removeLayer(state.layer);
      } catch (err) {
        console.error(LOG, err);
      }
      state.layer = null;
    }
  }

  function updateOverlay() {
    clearOverlay();
    const R = state.result;
    if (state.destroyed || !settings.showMap || !R || state.error || !window.L) {
      renderButtons();
      return;
    }
    const map = ensureMap();
    renderButtons();
    if (!map) return;
    try {
      const L = window.L;
      const geom = state.disc.geom;
      const layer = L.layerGroup();
      const tl = [R.target.lat, R.target.lon];
      L.circleMarker(tl, { radius: 7, color: '#ffffff', weight: 2, fillColor: '#ff3366', fillOpacity: 1 })
        .bindTooltip(R.target.name)
        .addTo(layer);
      if (R.motion.valid > 0 && R.motion.speedKmh >= 6) {
        const tg = geom.geoToGrid(R.target.lat, R.target.lon);
        const at = (t) => {
          const p = geom.gridToGeo(tg.x - R.motion.vx * t, tg.y - R.motion.vy * t);
          return [p.lat, p.lon];
        };
        L.polyline([tl, at(R.horizon)], { color: '#ff3366', weight: 2, dashArray: '6 6', opacity: 0.8 }).addTo(layer);
        Array.from({ length: Math.floor(R.horizon / 30) }, (_, i) => (i + 1) * 30).forEach((t) => {
          const pt = at(t);
          const step = R.steps[Math.min(R.steps.length - 1, Math.round(t / STEP))];
          L.circle(pt, { radius: step.rkm * 1000, color: '#ff3366', weight: 1, opacity: 0.4, fillOpacity: 0.03 }).addTo(layer);
          L.circleMarker(pt, { radius: 3, color: '#ffffff', weight: 1, fillColor: '#ff3366', fillOpacity: 1 })
            .bindTooltip(t + ' min', { permanent: true, direction: 'top', className: 'rp2-tip', offset: [0, -4] })
            .addTo(layer);
        });
      }
      layer.addTo(map);
      state.layer = layer;
    } catch (err) {
      console.error(LOG, err);
    }
  }

  // ── Escolha do ponto: mapa, GPS, reset ───────────────────────────
  function showMsg(text, ms, isError) {
    const el = document.getElementById('rp2-msg');
    if (!el) return;
    clearTimeout(state.msgTimer);
    el.textContent = text || '';
    el.classList.toggle('rp2-err', !!isError);
    if (text && ms !== 0) state.msgTimer = setTimeout(() => { el.textContent = ''; }, ms || 6000);
  }

  function applyPoint(lat, lon, name) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      showMsg('Coordenadas inválidas.', 6000, true);
      return false;
    }
    const d = state.disc;
    if (d && haversine(lat, lon, d.lat0, d.lon0) > d.radiusKm) {
      showMsg('Ponto fora da cobertura do radar (raio de ' + Math.round(d.radiusKm) + ' km).', 7000, true);
      return false;
    }
    state.target = { lat, lon, name: String(name || 'Local escolhido').slice(0, 60) };
    writeJSON(KEYS.target, state.target);
    state.notifiedKey = null;
    render();
    run({ local: true });
    return true;
  }

  function latLngFromImage(clientX, clientY) {
    const d = state.disc;
    const img = document.querySelector('img.leaflet-image-layer');
    if (!d || !img) return null;
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const fx = (clientX - r.left) / r.width;
    const fy = (clientY - r.top) / r.height;
    return { lat: mercInv(d.yTop - fy * (d.yTop - d.yBot)), lon: d.minLon + fx * (d.maxLon - d.minLon) };
  }

  function cancelPick(msg) {
    const p = state.picking;
    if (!p) return;
    state.picking = null;
    p.off();
    p.cont.classList.remove('rp2-picking');
    renderButtons();
    if (msg) showMsg(msg, 3000);
  }

  function startPick() {
    if (state.picking) {
      cancelPick('Seleção cancelada.');
      return;
    }
    const cont = document.querySelector('.leaflet-container');
    if (!cont) {
      showMsg('Mapa não encontrado na página.', 6000, true);
      return;
    }
    const map = ensureMap();
    cont.classList.add('rp2-picking');
    const onKey = (e) => {
      if (e.key === 'Escape') cancelPick('Seleção cancelada.');
    };
    document.addEventListener('keydown', onKey, true);
    let detach;
    const choose = (lat, lon) => {
      cancelPick();
      applyPoint(lat, lon, 'Ponto (' + lat.toFixed(4) + ', ' + lon.toFixed(4) + ')');
    };
    if (map) {
      const h = (e) => choose(e.latlng.lat, e.latlng.lng);
      map.once('click', h);
      detach = () => map.off('click', h);
    } else {
      const h = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const ll = latLngFromImage(e.clientX, e.clientY);
        if (ll) choose(ll.lat, ll.lon);
        else {
          cancelPick();
          showMsg('Não foi possível calcular a posição no mapa.', 6000, true);
        }
      };
      cont.addEventListener('click', h, true);
      detach = () => cont.removeEventListener('click', h, true);
    }
    state.picking = {
      cont,
      off: () => {
        detach();
        document.removeEventListener('keydown', onKey, true);
      },
    };
    renderButtons();
    showMsg('Clique no mapa para escolher o ponto (Esc cancela).', 0);
  }

  function useGeolocation() {
    if (!navigator.geolocation) {
      showMsg('Geolocalização não suportada neste navegador.', 6000, true);
      return;
    }
    showMsg('Obtendo sua localização…', 0);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        showMsg('');
        applyPoint(pos.coords.latitude, pos.coords.longitude, 'Minha localização');
      },
      (err) => {
        const msgs = {
          1: 'Permissão de localização negada. Libere o acesso nas configurações do site.',
          2: 'Não foi possível determinar sua localização (sinal indisponível).',
          3: 'Tempo esgotado ao obter a localização (10 s).',
        };
        showMsg(msgs[err.code] || 'Falha ao obter a localização.', 8000, true);
      },
      { timeout: 10000, maximumAge: 60000, enableHighAccuracy: false }
    );
  }

  // ── Alertas e título da aba ──────────────────────────────────────
  function evaluateAlerts() {
    const R = state.result;
    if (!R || state.error) return;
    if (R.kind === 'none' || R.kind === 'clear') {
      state.notifiedKey = null;
      return;
    }
    if (!settings.alerts || !('Notification' in window) || Notification.permission !== 'granted') return;
    const now = Date.now();
    const view = computeView(now);
    let key = null;
    let body = '';
    const name = R.target.name;
    if (R.kind === 'now') {
      key = 'now';
      body = 'Chuva ' + R.nowClass + ' agora em ' + name + '. ' + (R.truncated ? 'Deve continuar além de ' + R.horizon + ' min.' : 'Deve parar por volta de ' + fmtClock(R.originT + R.endClock * 60000) + '.');
    } else if (R.kind === 'approach' && view.mins <= settings.lead && R.chance * 100 >= settings.minChance) {
      key = 'soon';
      const cls = R.peak ? R.peak.cls : 'fraca';
      const dur = R.truncated ? '≥ ' + R.durationMin + ' min' : '~' + R.durationMin + ' min';
      body = 'Chuva ' + cls + (view.mins <= 0 ? ' a qualquer momento' : ' em ~' + view.mins + ' min') + ' em ' + name + ' (chance ' + view.pct + '%). Duração ' + dur + ', ~' + num(R.expected, 1) + ' mm.';
    }
    if (!key || key === state.notifiedKey) return;
    state.notifiedKey = key;
    try {
      new Notification('🌧️ Preditor de Chuva', { body, tag: 'rp2-rain' });
    } catch (err) {
      console.error(LOG, err);
    }
  }

  function updateTitle(view) {
    const base = document.title.replace(TITLE_RE, '');
    const next = view && view.tab ? view.tab + base : base;
    if (document.title !== next) document.title = next;
  }

  // ── Estilos ──────────────────────────────────────────────────────
  const CSS = `
#rp2-root{position:fixed;top:130px;right:20px;width:340px;max-height:calc(100vh - 150px);overflow:auto;z-index:10000;box-sizing:border-box;background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);color:#fff;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.45);font:13px/1.4 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;}
#rp2-root *{box-sizing:border-box}
#rp2-root.rp2-hidden{display:none}
#rp2-root .rp2-header{display:flex;align-items:center;gap:6px;padding:10px 12px;cursor:move;user-select:none;touch-action:none;position:sticky;top:0;z-index:1;background:#1a1a2e;border-radius:16px 16px 0 0}
#rp2-root.rp2-min .rp2-header{border-radius:16px}
#rp2-root .rp2-title{flex:1;font-weight:700;font-size:14px}
#rp2-root .rp2-mini{display:none;flex:1;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#rp2-root.rp2-min .rp2-title{display:none}
#rp2-root.rp2-min .rp2-mini{display:block}
#rp2-root.rp2-min .rp2-body{display:none}
#rp2-root .rp2-hbtn{background:rgba(255,255,255,.1);border:none;color:#fff;width:26px;height:26px;border-radius:8px;cursor:pointer;font:inherit;line-height:1}
#rp2-root .rp2-hbtn:hover{background:rgba(255,255,255,.22)}
#rp2-root .rp2-body{padding:0 12px 12px}
#rp2-root .rp2-loc{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
#rp2-root .rp2-locname{flex:1 0 100%;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#rp2-root .rp2-btn{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.15);color:#fff;border-radius:8px;padding:5px 9px;cursor:pointer;font:inherit;font-size:12px}
#rp2-root .rp2-btn:hover{background:rgba(255,255,255,.2)}
#rp2-root .rp2-btn.rp2-primary{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);border:none}
#rp2-root .rp2-btn.rp2-on{outline:2px solid #667eea}
#rp2-root .rp2-btn[disabled]{opacity:.5;cursor:not-allowed}
#rp2-root button:focus-visible,#rp2-root select:focus-visible{outline:2px solid #a5b4fc;outline-offset:1px}
#rp2-root .rp2-msg{font-size:12px;margin-top:6px;color:#ffd166}
#rp2-root .rp2-msg.rp2-err{color:#ff9b9b}
#rp2-root .rp2-msg:empty{display:none}
#rp2-root .rp2-status{margin:10px 0;padding:14px;border-radius:12px;text-align:center;background:linear-gradient(135deg,#636e72 0%,#4b5254 100%)}
#rp2-root .rp2-st-title{font-size:17px;font-weight:700}
#rp2-root .rp2-st-sub{font-size:12px;opacity:.92;margin-top:4px}
#rp2-root .rp2-st-note{font-size:11px;opacity:.85;margin-top:6px}
#rp2-root .rp2-st-approach{background:linear-gradient(135deg,#ff512f 0%,#f09819 100%)}
#rp2-root .rp2-st-possible{background:linear-gradient(135deg,#c77d12 0%,#e0a526 100%)}
#rp2-root .rp2-st-now{background:linear-gradient(135deg,#4776e6 0%,#8e54e9 100%)}
#rp2-root .rp2-st-none,#rp2-root .rp2-st-clear,#rp2-root .rp2-st-loading{background:linear-gradient(135deg,#2980b9 0%,#4a6fd8 100%)}
#rp2-root .rp2-st-leaving{background:linear-gradient(135deg,#0f9b6c 0%,#2bbf6a 100%)}
#rp2-root .rp2-st-error{background:linear-gradient(135deg,#636e72 0%,#4b5254 100%)}
#rp2-root .rp2-st-error .rp2-btn{margin-top:8px}
@media (prefers-reduced-motion:no-preference){#rp2-root .rp2-st-now{animation:rp2-pulse 2.4s ease-in-out infinite}}
@keyframes rp2-pulse{0%,100%{box-shadow:0 0 0 0 rgba(142,84,233,.55)}50%{box-shadow:0 0 0 8px rgba(142,84,233,0)}}
#rp2-root .rp2-metrics{display:grid;grid-template-columns:1fr 1fr;gap:6px}
#rp2-root .rp2-m{background:rgba(255,255,255,.07);border-radius:10px;padding:7px 9px;min-width:0}
#rp2-root .rp2-m-l{font-size:10px;text-transform:uppercase;letter-spacing:.04em;opacity:.65}
#rp2-root .rp2-m-v{font-size:15px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#rp2-root .rp2-m-s{font-size:11px;opacity:.7;min-height:15px}
#rp2-root .rp2-infohead{display:flex;align-items:center;gap:6px;margin:8px 0 2px;font-size:11px;opacity:.8}
#rp2-root .rp2-info-btn{background:none;border:none;color:#a5b4fc;cursor:pointer;font-size:14px;padding:0}
#rp2-root .rp2-info{display:none;font-size:11px;opacity:.9;background:rgba(0,0,0,.25);padding:8px;border-radius:8px;margin-bottom:4px}
#rp2-root .rp2-info.rp2-open{display:block}
#rp2-root .rp2-chart svg{width:100%;height:auto;display:block;background:rgba(255,255,255,.04);border-radius:10px}
#rp2-root .rp2-chart text{fill:#cbd5e1;font-size:8px}
#rp2-root .rp2-radar{font-size:11px;opacity:.8;margin:8px 0 6px}
#rp2-root .rp2-radar.rp2-stale{color:#ffd166;opacity:1}
#rp2-root .rp2-actions{display:flex;flex-wrap:wrap;gap:6px}
#rp2-root .rp2-settings{display:none;margin-top:8px;padding:10px;background:rgba(255,255,255,.06);border-radius:10px}
#rp2-root .rp2-settings.rp2-open{display:block}
#rp2-root .rp2-settings label{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:4px 0;font-size:12px}
#rp2-root select{background:#16213e;color:#fff;border:1px solid rgba(255,255,255,.2);border-radius:6px;padding:3px 6px;font:inherit;font-size:12px}
#rp2-fab{position:fixed;right:20px;bottom:20px;width:48px;height:48px;border-radius:50%;border:none;cursor:pointer;z-index:10000;font-size:22px;line-height:1;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.4);display:none}
#rp2-fab.rp2-show{display:block}
.rp2-picking,.rp2-picking *{cursor:crosshair !important}
.leaflet-tooltip.rp2-tip{font-size:10px;padding:1px 5px}
`;

  // ── Construção da interface ──────────────────────────────────────
  const opts = (list, cur, suffix) =>
    list.map((v) => '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + v + suffix + '</option>').join('');

  function buildUI() {
    ui.style = document.createElement('style');
    ui.style.id = 'rp2-style';
    ui.style.textContent = CSS;
    document.head.appendChild(ui.style);

    const root = document.createElement('div');
    root.id = 'rp2-root';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Preditor de chuva');
    root.innerHTML =
      '<div class="rp2-header" id="rp2-header">' +
      '<span class="rp2-title">🌧️ Preditor de Chuva</span>' +
      '<span class="rp2-mini" id="rp2-mini"></span>' +
      '<button class="rp2-hbtn" data-act="min" id="rp2-minbtn" title="Minimizar" aria-label="Minimizar">–</button>' +
      '<button class="rp2-hbtn" data-act="close" title="Fechar" aria-label="Fechar">✕</button>' +
      '</div>' +
      '<div class="rp2-body">' +
      '<div class="rp2-loc"><div class="rp2-locname" id="rp2-locname"></div>' +
      '<button class="rp2-btn" data-act="pick" id="rp2-pick">🎯 No mapa</button>' +
      '<button class="rp2-btn" data-act="geo">📡 Minha localização</button>' +
      '<button class="rp2-btn" data-act="reset" title="Voltar ao local padrão" aria-label="Voltar ao local padrão">↺</button></div>' +
      '<div class="rp2-msg" id="rp2-msg" role="status"></div>' +
      '<div class="rp2-status" id="rp2-status"></div>' +
      '<div class="rp2-metrics" id="rp2-metrics"></div>' +
      '<div class="rp2-infohead"><button class="rp2-info-btn" data-act="info" title="Como é calculado" aria-label="Como é calculado">ⓘ</button><span>Como é calculado</span></div>' +
      '<div class="rp2-info" id="rp2-info">Estimativa feita extrapolando o movimento dos ecos do radar, sem modelo físico. A chuva (mm/h) vem da relação Z = 200·R^1,6 (Marshall–Palmer); o produto MAXDISPLAY tende a superestimar a intensidade. A confiabilidade cai bastante depois de ~60 min.</div>' +
      '<div class="rp2-chart" id="rp2-chart"></div>' +
      '<div class="rp2-radar" id="rp2-radar"></div>' +
      '<div class="rp2-actions">' +
      '<button class="rp2-btn rp2-primary" data-act="refresh" id="rp2-refresh">🔄 Atualizar</button>' +
      '<button class="rp2-btn" data-act="alerts" id="rp2-alerts" aria-pressed="false">🔔 Alertas</button>' +
      '<button class="rp2-btn" data-act="overlay" id="rp2-overlay" aria-pressed="false">🗺️ Mostrar no mapa</button>' +
      '<button class="rp2-btn" data-act="settings" id="rp2-settingsbtn" title="Configurações" aria-label="Configurações">⚙️</button>' +
      '</div>' +
      '<div class="rp2-settings" id="rp2-settings">' +
      '<label>Horizonte <select name="rp2-horizon" data-set="horizon">' + opts(OPTIONS.horizon, settings.horizon, ' min') + '</select></label>' +
      '<label>Antecedência do alerta <select name="rp2-lead" data-set="lead">' + opts(OPTIONS.lead, settings.lead, ' min') + '</select></label>' +
      '<label>Chance mínima do alerta <select name="rp2-minchance" data-set="minChance">' + opts(OPTIONS.minChance, settings.minChance, '%') + '</select></label>' +
      '<label>Limiar de chuva <select name="rp2-thr" data-set="thr">' + opts(OPTIONS.thr, settings.thr, ' dBZ') + '</select></label>' +
      '</div>' +
      '</div>';
    document.body.appendChild(root);
    ui.root = root;

    const fab = document.createElement('button');
    fab.id = 'rp2-fab';
    fab.title = 'Abrir Preditor de Chuva';
    fab.setAttribute('aria-label', 'Abrir Preditor de Chuva');
    fab.textContent = '🌧️';
    document.body.appendChild(fab);
    ui.fab = fab;

    on(fab, 'click', () => {
      uiState.closed = false;
      saveUi();
      applyUi();
    });
    on(root, 'click', onRootClick);
    on(root, 'change', onRootChange);
    setupDrag(root.querySelector('#rp2-header'));
    on(window, 'resize', applyUi);
  }

  const saveUi = () => writeJSON(KEYS.ui, uiState);

  function applyUi() {
    if (!ui.root) return;
    ui.root.classList.toggle('rp2-min', uiState.min);
    ui.root.classList.toggle('rp2-hidden', uiState.closed);
    ui.fab.classList.toggle('rp2-show', uiState.closed);
    if (uiState.x != null && uiState.y != null) {
      const x = clamp(uiState.x, 0, Math.max(0, window.innerWidth - 340));
      const y = clamp(uiState.y, 0, Math.max(0, window.innerHeight - 40));
      ui.root.style.left = x + 'px';
      ui.root.style.top = y + 'px';
      ui.root.style.right = 'auto';
    }
    const mb = document.getElementById('rp2-minbtn');
    if (mb) {
      mb.textContent = uiState.min ? '▢' : '–';
      mb.title = uiState.min ? 'Expandir' : 'Minimizar';
    }
  }

  function setupDrag(header) {
    on(header, 'pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      const rect = ui.root.getBoundingClientRect();
      const offX = e.clientX - rect.left;
      const offY = e.clientY - rect.top;
      header.setPointerCapture(e.pointerId);
      const move = (ev) => {
        uiState.x = clamp(ev.clientX - offX, 0, Math.max(0, window.innerWidth - rect.width));
        uiState.y = clamp(ev.clientY - offY, 0, Math.max(0, window.innerHeight - 40));
        ui.root.style.left = uiState.x + 'px';
        ui.root.style.top = uiState.y + 'px';
        ui.root.style.right = 'auto';
      };
      const up = () => {
        header.removeEventListener('pointermove', move);
        header.removeEventListener('pointerup', up);
        header.removeEventListener('pointercancel', up);
        saveUi();
      };
      header.addEventListener('pointermove', move);
      header.addEventListener('pointerup', up);
      header.addEventListener('pointercancel', up);
    });
  }

  // ── Ações da interface ───────────────────────────────────────────
  async function toggleAlerts() {
    if (settings.alerts) {
      settings.alerts = false;
      saveSettings();
      renderButtons();
      return;
    }
    if (!('Notification' in window)) {
      showMsg('Este navegador não suporta notificações.', 6000, true);
      return;
    }
    let perm = Notification.permission;
    if (perm === 'default') {
      showMsg('Permita as notificações para receber alertas de chuva.', 0);
      try {
        perm = await Notification.requestPermission();
      } catch (err) {
        console.error(LOG, err);
        perm = 'denied';
      }
      showMsg('');
    }
    if (perm !== 'granted') {
      showMsg('Notificações bloqueadas. Libere-as nas configurações do site (cadeado na barra de endereço) para receber alertas.', 10000, true);
      return;
    }
    settings.alerts = true;
    saveSettings();
    renderButtons();
    showMsg('Alertas ativados.', 3000);
    evaluateAlerts();
  }

  function onRootClick(e) {
    const el = e.target.closest('[data-act]');
    if (!el || !ui.root.contains(el)) return;
    switch (el.dataset.act) {
      case 'min':
        uiState.min = !uiState.min;
        saveUi();
        applyUi();
        break;
      case 'close':
        uiState.closed = true;
        saveUi();
        applyUi();
        break;
      case 'pick':
        startPick();
        break;
      case 'geo':
        useGeolocation();
        break;
      case 'reset':
        applyPoint(DEFAULT_TARGET.lat, DEFAULT_TARGET.lon, DEFAULT_TARGET.name);
        break;
      case 'info':
        document.getElementById('rp2-info').classList.toggle('rp2-open');
        break;
      case 'refresh':
        run({ force: true });
        break;
      case 'alerts':
        toggleAlerts();
        break;
      case 'overlay':
        if (el.disabled) break;
        settings.showMap = !settings.showMap;
        saveSettings();
        updateOverlay();
        break;
      case 'settings':
        document.getElementById('rp2-settings').classList.toggle('rp2-open');
        break;
      default:
        break;
    }
  }

  function onRootChange(e) {
    const sel = e.target.closest('select[data-set]');
    if (!sel) return;
    const key = sel.dataset.set;
    const val = Number(sel.value);
    if (!OPTIONS[key] || !OPTIONS[key].includes(val)) return;
    settings[key] = val;
    saveSettings();
    if (key === 'horizon' || key === 'thr') run({ local: true });
    else evaluateAlerts();
  }

  // ── Renderização ─────────────────────────────────────────────────
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function colorForRate(rate) {
    const colors = state.disc ? state.disc.colors : null;
    if (!colors || !colors.length) return '#00b2ff';
    const dbz = rate > 0 ? dbzOfRate(rate) : -Infinity;
    let pick = colors[0];
    for (let i = 0; i < colors.length; i++) {
      if (colors[i].dbz <= dbz) pick = colors[i];
      else break;
    }
    return pick.css;
  }

  function metricCells(R, now) {
    const D = '--';
    const cell = (label, value, sub) => ({ label, value: value == null ? D : value, sub: sub || '' });
    if (!R) {
      return [cell('Chegada'), cell('Duração'), cell('Volume'), cell('Pico'), cell('Chance'), cell('Deslocamento'), cell('Tendência'), cell('Confiança')];
    }
    const age = ageMinOf(R, now);
    const clock = (t) => fmtClock(R.originT + t * 60000);
    const mins = R.startT == null ? null : Math.round(R.startT - age);
    const cells = [];
    if (R.kind === 'now') cells.push(cell('Chegada', 'Agora', 'chovendo'));
    else if (R.startT != null) {
      const rel = mins <= 0 ? 'a qualquer momento' : 'em ' + mins + ' min';
      cells.push(cell('Chegada', clock(R.startT), (R.kind === 'possible' ? 'possível · ' : '') + rel));
    } else cells.push(cell('Chegada'));
    cells.push(cell('Duração', R.durationMin != null ? (R.truncated ? '≥ ' : '~') + R.durationMin + ' min' : null, R.rainingNow ? 'restante' : ''));
    cells.push(cell('Volume', R.startT != null ? '~' + num(R.expected, 1) + ' mm' : null, R.startT != null ? 'até ' + num(R.plausibleMax, 1) + ' mm' : ''));
    cells.push(cell('Pico', R.peak ? fmtRate(R.peak.wetR) + ' mm/h' : null, R.peak ? R.peak.cls + ' · ' + clock(R.peak.t) : ''));
    cells.push(cell('Chance', Math.round(R.chance * 100) + '%', 'máx. em ' + R.horizon + ' min'));
    const m = R.motion;
    if (m.valid > 0 && m.toDeg != null) cells.push(cell('Deslocamento', num(m.speedKmh, 0) + ' km/h', 'de ' + dirName(m.fromDeg) + ' → ' + dirName(m.toDeg)));
    else if (m.valid > 0) cells.push(cell('Deslocamento', 'parada', '< 1 km/h'));
    else cells.push(cell('Deslocamento', null, 'sem dados'));
    cells.push(cell('Tendência', R.trend ? cap(R.trend.label) : null, R.trend && R.trend.pct != null ? (R.trend.pct >= 0 ? '+' : '') + R.trend.pct + '% em ' + R.trend.minutes + ' min' : R.trend ? 'chuva nova' : ''));
    const sk = R.skill;
    cells.push(cell('Confiança', R.confidence ? cap(R.confidence) : null, sk ? 'acerto 30 min: ' + Math.round(sk.csiAdv * 100) + '% vs ' + Math.round(sk.csiPers * 100) + '% parado' : ''));
    return cells;
  }

  function chartSvg(R, now) {
    const Wd = 316;
    const Ht = 86;
    const padL = 4;
    const top = 14;
    const bot = 68;
    const steps = R.steps;
    const n = steps.length;
    const step = (Wd - padL - 4) / n;
    const ph = bot - top;
    const cx = (i) => padL + (i + 0.5) * step;
    let s = '<svg viewBox="0 0 ' + Wd + ' ' + Ht + '" role="img" aria-label="Previsão de chuva a cada 5 minutos">';
    steps.forEach((st, i) => {
      const x = padL + i * step;
      const tip = fmtClock(R.originT + st.t * 60000) + (st.outOfRange ? ' · fora do alcance do radar' : ' · chance ' + Math.round(st.p * 100) + '% · ~' + num(st.meanR, 1) + ' mm/h');
      s += '<g><title>' + esc(tip) + '</title><rect x="' + x.toFixed(1) + '" y="' + top + '" width="' + step.toFixed(1) + '" height="' + ph + '" fill="transparent"/>';
      if (st.meanR > 0) {
        const h = Math.max(1.5, Math.sqrt(Math.min(st.meanR, 50) / 50) * ph);
        s += '<rect x="' + (x + 0.5).toFixed(1) + '" y="' + (bot - h).toFixed(1) + '" width="' + Math.max(1, step - 1).toFixed(1) + '" height="' + h.toFixed(1) + '" rx="1" fill="' + colorForRate(st.wetR || st.meanR) + '" fill-opacity="' + (0.25 + 0.75 * st.p).toFixed(2) + '"/>';
      }
      s += '</g>';
    });
    s += '<line x1="' + padL + '" y1="' + bot + '" x2="' + (Wd - 4) + '" y2="' + bot + '" stroke="#fff" stroke-opacity=".2"/>';
    if (n > 1) {
      s += '<polyline fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="1" points="' + steps.map((st, i) => cx(i).toFixed(1) + ',' + (bot - st.p * ph).toFixed(1)).join(' ') + '"/>';
    }
    steps.forEach((st, i) => {
      if (st.t % 30 !== 0) return;
      const x = cx(i);
      const anchor = x < 18 ? 'start' : x > Wd - 18 ? 'end' : 'middle';
      s += '<text x="' + (anchor === 'start' ? padL : anchor === 'end' ? Wd - 4 : x).toFixed(1) + '" y="' + (Ht - 5) + '" text-anchor="' + anchor + '">' + esc(fmtClock(R.originT + st.t * 60000)) + '</text>';
    });
    const age = ageMinOf(R, now);
    if (age >= 0 && age <= R.horizon) {
      const x = padL + (age / STEP + 0.5) * step;
      const anchor = x < 18 ? 'start' : x > Wd - 18 ? 'end' : 'middle';
      s += '<line x1="' + x.toFixed(1) + '" y1="' + (top - 2) + '" x2="' + x.toFixed(1) + '" y2="' + bot + '" stroke="#ffd166" stroke-width="1" stroke-dasharray="3 2"/>';
      s += '<text x="' + x.toFixed(1) + '" y="9" text-anchor="' + anchor + '" style="fill:#ffd166">agora</text>';
    }
    return s + '</svg>';
  }

  function renderButtons() {
    if (!ui.root) return;
    const q = (id) => document.getElementById(id);
    const pick = q('rp2-pick');
    if (pick) {
      pick.textContent = state.picking ? '✖ Cancelar' : '🎯 No mapa';
      pick.classList.toggle('rp2-on', !!state.picking);
    }
    const al = q('rp2-alerts');
    if (al) {
      al.classList.toggle('rp2-on', settings.alerts);
      al.setAttribute('aria-pressed', String(settings.alerts));
    }
    const ov = q('rp2-overlay');
    if (ov) {
      ov.classList.toggle('rp2-on', settings.showMap && !state.mapFailed);
      ov.setAttribute('aria-pressed', String(settings.showMap && !state.mapFailed));
      ov.disabled = state.mapFailed;
      ov.title = state.mapFailed ? 'Não foi possível acessar o mapa da página' : 'Mostrar trajetória no mapa';
    }
    const rf = q('rp2-refresh');
    if (rf) {
      rf.disabled = state.loading;
      rf.textContent = state.loading ? '⏳ Atualizando…' : '🔄 Atualizar';
    }
  }

  function render() {
    if (state.destroyed || !ui.root) return;
    const now = Date.now();
    const view = computeView(now);
    const R = state.error ? null : state.result;
    document.getElementById('rp2-locname').textContent = '📍 ' + state.target.name;
    document.getElementById('rp2-mini').textContent = view.mini;

    const st = document.getElementById('rp2-status');
    st.className = 'rp2-status rp2-st-' + (view.leaving ? 'leaving' : view.kind);
    st.innerHTML =
      '<div class="rp2-st-title">' + esc(view.title) + '</div>' +
      (view.sub ? '<div class="rp2-st-sub">' + esc(view.sub) + '</div>' : '') +
      view.notes.map((n) => '<div class="rp2-st-note">' + esc(n) + '</div>').join('') +
      (view.retry ? '<button class="rp2-btn" data-act="refresh">Tentar de novo</button>' : '');

    document.getElementById('rp2-metrics').innerHTML = metricCells(R, now)
      .map((c) => '<div class="rp2-m"><div class="rp2-m-l">' + esc(c.label) + '</div><div class="rp2-m-v">' + esc(c.value) + '</div><div class="rp2-m-s">' + esc(c.sub) + '</div></div>')
      .join('');

    document.getElementById('rp2-chart').innerHTML = R ? chartSvg(R, now) : '';

    const radar = document.getElementById('rp2-radar');
    if (R) {
      const age = Math.max(0, Math.round(ageMinOf(R, now)));
      radar.textContent = 'Radar ' + fmtClock(R.originT) + ' (há ' + age + ' min)' + (age > 20 ? ' · dados antigos' : '');
      radar.classList.toggle('rp2-stale', age > 20);
    } else {
      radar.textContent = 'Radar --';
      radar.classList.remove('rp2-stale');
    }
    renderButtons();
    updateTitle(view);
  }

  // ── Ciclo de execução ────────────────────────────────────────────
  async function execute(o) {
    state.loading = true;
    renderButtons();
    let changed = true;
    try {
      let frames;
      let disc;
      if (o.local && state.frames.length && state.disc) {
        frames = state.frames;
        disc = state.disc;
      } else {
        const t0 = performance.now();
        const prods = await fetchProducts(NFRAMES);
        if (state.destroyed) return;
        disc = state.disc;
        state.timings.fetch = Math.round(performance.now() - t0);
        const newest = prods[prods.length - 1];
        if (!o.force && !o.local && state.result && !state.error && newest.id === state.latestId) {
          changed = false;
        } else {
          const t1 = performance.now();
          frames = await loadFrames(prods);
          state.timings.decode = Math.round(performance.now() - t1);
          state.frames = frames;
        }
      }
      if (changed) {
        const result = await analyze(frames, disc);
        if (state.destroyed) return;
        state.timings.motion = result.timings.motion;
        state.timings.nowcast = result.timings.nowcast;
        state.result = result;
        state.latestId = result.productId;
        state.error = null;
      }
    } catch (err) {
      console.error(LOG, err);
      state.error = err instanceof Error ? err : new Error(String(err));
    } finally {
      state.loading = false;
    }
    if (state.destroyed) return;
    render();
    if (changed) {
      updateOverlay();
      evaluateAlerts();
      scheduleSkill();
    }
  }

  // verificação de habilidade (retroprevisão 30 min) — roda depois da renderização
  function scheduleSkill() {
    const R = state.result;
    if (state.destroyed || state.error || !R) return;
    const key = skillKey(R.productId, R.thr);
    if (state.skillKey === key) return;
    state.skillKey = key;
    runSkill(key);
  }

  async function runSkill(key) {
    let out;
    try {
      const h = await hindcast(30);
      if (h.error) throw new Error(h.error);
      out = { csiAdv: h.csiAdvection, csiPers: h.csiPersistence, motionKmh: h.motionKmh, at: Date.now(), key };
    } catch (err) {
      console.error(LOG, 'Verificação de habilidade falhou', err);
      out = { error: err.message, at: Date.now(), key };
    }
    if (state.destroyed || state.skillKey !== key) return;
    state.skill = out;
    if (out.error) render();
    else run({ local: true });
  }

  function run(o) {
    if (state.destroyed) return Promise.resolve();
    if (state.runPromise) {
      if (o.force || o.local) {
        const a = state.again;
        state.again = a ? { force: !!(a.force || o.force), local: !!(a.local && o.local) } : { force: !!o.force, local: !!o.local };
      }
      return state.runPromise;
    }
    state.runPromise = execute(o)
      .catch((err) => console.error(LOG, err))
      .finally(() => {
        state.runPromise = null;
        const next = state.again;
        state.again = null;
        if (next && !state.destroyed) run(next);
      });
    return state.runPromise;
  }

  // ── Depuração ────────────────────────────────────────────────────
  function debug() {
    const R = state.result;
    const d = state.disc;
    return {
      version: VERSION,
      target: state.target,
      discovery: d && { radarId: d.radar.id, typeId: d.type.id, typeAlias: d.type.alias, radiusKm: d.radiusKm, freqMin: d.freq, minDbz: d.minDbz },
      frames: state.frames.map((f) => ({ id: f.id, time: new Date(f.t).toISOString() })),
      pairs: R ? R.motion.pairs : [],
      medianV: R && R.motion.valid ? { vxCellsMin: R.motion.vx, vyCellsMin: R.motion.vy, speedKmh: R.motion.speedKmh, fromDeg: R.motion.fromDeg, toDeg: R.motion.toDeg } : null,
      skill: state.skill,
      skillPenalty: R ? R.skillPenalty : null,
      aggBest: R ? R.motion.aggBest : null,
      aggZero: R ? R.motion.aggZero : null,
      sigmaKmh: R ? R.sigmaKmMin * 60 : null,
      kmPerCell: R ? { x: R.kmX, y: R.kmY } : null,
      clutterCells: R ? R.clutterCells : null,
      steps: R ? R.steps.map((s) => ({ t: s.t, p: s.p, meanR: s.meanR, wetR: s.wetR, p90R: s.p90R, outOfRange: s.outOfRange })) : [],
      timings: Object.assign({}, state.timings),
    };
  }

  // ── Autoteste e retroprevisão (somente depuração) ────────────────
  async function selfTest() {
    if (!state.frames.length) await run({ force: true });
    const latest = state.frames[state.frames.length - 1];
    if (!latest) return [{ error: 'Sem quadros do radar' }];
    const geom = latest.geom;
    const { gw, gh, cov } = geom;
    const S = searchRadius(geom, 10);
    const A = smooth3(latest.grid, gw, gh, cov);
    const out = [];
    for (const [sx, sy] of [[5, -3], [-4, 6]]) {
      const shifted = new Float32Array(gw * gh);
      for (let y = 0; y < gh; y++) {
        const ny = y + sy;
        if (ny < 0 || ny >= gh) continue;
        for (let x = 0; x < gw; x++) {
          const nx = x + sx;
          if (nx >= 0 && nx < gw) shifted[ny * gw + nx] = latest.grid[y * gw + x];
        }
      }
      for (let i = 0; i < shifted.length; i++) if (!cov[i]) shifted[i] = 0;
      const m = matchOne(A, smooth3(shifted, gw, gh, cov), geom, settings.thr, S);
      out.push({ expected: [sx, sy], got: m ? [Math.round(m.dx * 100) / 100, Math.round(m.dy * 100) / 100] : null });
      await sleep0();
    }
    return out;
  }

  async function hindcast(leadMin = 30) {
    try {
      leadMin = Number(leadMin);
      if (!Number.isFinite(leadMin) || leadMin < STEP) return { error: 'leadMin inválido' };
      const need = Math.ceil(leadMin / STEP) + NFRAMES;
      if (need > CACHE_MAX) return { error: 'leadMin máximo: ' + (CACHE_MAX - NFRAMES) * STEP + ' min' };
      const thr = settings.thr;
      const prods = await fetchProducts(need);
      const frames = await loadFrames(prods);
      const latest = frames[frames.length - 1];
      const goal = latest.t - leadMin * 60000;
      let o = -1;
      let diff = Infinity;
      frames.forEach((f, i) => {
        if (Math.abs(f.t - goal) < diff) {
          diff = Math.abs(f.t - goal);
          o = i;
        }
      });
      if (o < 0 || diff > 3 * 60000) return { error: 'Quadro de origem não encontrado' };
      const hist = frames.slice(Math.max(0, o - (NFRAMES - 1)), o + 1);
      if (hist.length < 3) return { error: 'Quadros insuficientes antes da origem' };
      const geom = latest.geom;
      const histGrids = cleanFrames(hist, geom, thr).grids;
      const motion = await estimateMotion(hist, histGrids, geom, thr);
      const origin = histGrids[histGrids.length - 1];
      const recent = frames.slice(-NFRAMES);
      const actual = cleanFrames(recent, geom, thr).grids[recent.length - 1];
      const lead = (latest.t - frames[o].t) / 60000;
      const { gw, gh, cov } = geom;
      const score = (shiftX, shiftY) => {
        let hits = 0;
        let miss = 0;
        let fa = 0;
        for (let y = 0; y < gh; y++) {
          for (let x = 0; x < gw; x++) {
            const i = y * gw + x;
            if (!cov[i]) continue;
            const sx = Math.round(x - shiftX);
            const sy = Math.round(y - shiftY);
            const f = sx >= 0 && sy >= 0 && sx < gw && sy < gh && origin[sy * gw + sx] >= thr;
            const a = actual[i] >= thr;
            if (f && a) hits++;
            else if (a) miss++;
            else if (f) fa++;
          }
        }
        const d = hits + miss + fa;
        return d ? hits / d : null;
      };
      return {
        leadMin,
        motionKmh: motion.valid ? motion.speedKmh : null,
        csiAdvection: score(motion.vx * lead, motion.vy * lead),
        csiPersistence: score(0, 0),
        validPairs: motion.valid,
      };
    } catch (err) {
      console.error(LOG, err);
      return { error: err.message };
    }
  }

  // ── Encerramento ─────────────────────────────────────────────────
  function destroy() {
    if (state.destroyed) return;
    state.destroyed = true;
    state.timers.forEach((id) => clearInterval(id));
    state.timers = [];
    clearTimeout(state.msgTimer);
    cancelPick();
    clearOverlay();
    state.cleanups.forEach((fn) => {
      try {
        fn();
      } catch (err) {
        console.error(LOG, err);
      }
    });
    state.cleanups = [];
    [ui.root, ui.fab, ui.style].forEach((el) => {
      if (el) el.remove();
    });
    updateTitle(null);
    if (window.__rp2Instance === instance) window.__rp2Instance = null;
  }

  const instance = { destroy };

  // ── Início ───────────────────────────────────────────────────────
  function waitForContainer(timeoutMs) {
    return new Promise((resolve) => {
      const find = () => document.querySelector('.leaflet-container');
      if (find()) {
        resolve(find());
        return;
      }
      let done = false;
      let mo = null;
      let to = null;
      const finish = (v) => {
        if (done) return;
        done = true;
        if (mo) mo.disconnect();
        clearTimeout(to);
        resolve(v);
      };
      mo = new MutationObserver(() => {
        if (find()) finish(find());
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      to = setTimeout(() => {
        console.warn(LOG, 'Mapa (.leaflet-container) não apareceu em 60 s; preditor não iniciado');
        finish(null);
      }, timeoutMs);
      state.cleanups.push(() => finish(null));
    });
  }

  async function start() {
    const cont = await waitForContainer(60000);
    if (state.destroyed || !cont) return;
    buildUI();
    applyUi();
    render();
    state.timers.push(setInterval(() => run({}), POLL_MS));
    state.timers.push(setInterval(render, TICK_MS));
    run({ force: true });
  }

  window.__rp2Instance = instance;
  window.RainPredictor = {
    version: VERSION,
    run: (force) => run({ force: !!force }).then(() => state.result),
    setTarget: (lat, lon, name) => applyPoint(Number(lat), Number(lon), name || 'Local escolhido'),
    getLastResult: () => state.result,
    debug,
    selfTest,
    hindcast,
    settings,
  };
  console.log('🌧️ Preditor de Chuva v2 carregado — RainPredictor.setTarget(lat, lon, "Nome") para mudar o local');
  start().catch((err) => console.error(LOG, err));
})();
