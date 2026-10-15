'use strict';

// ---- チェーン定義(判定は上から順。DAISO系の派生ブランドを先に判定する) ----
const CHAINS = [
  { id: 'threeppy', label: 'THREEPPY',          short: '3',  color: '#00a0c6', re: /threeppy|スリーピー/i },
  { id: 'standard', label: 'Standard Products', short: 'SP', color: '#7a6a58', re: /standard\s*products|スタンダードプロダクツ/i },
  { id: 'daiso',    label: 'ダイソー',          short: 'ダ', color: '#e4007f', re: /ダイソー|daiso/i },
  { id: 'seria',    label: 'セリア',            short: 'セ', color: '#2e9e3f', re: /セリア|seria/i },
  { id: 'cando',    label: 'キャンドゥ',        short: 'キ', color: '#f08300', re: /キャンドゥ|can.?do/i },
  { id: 'watts',    label: 'ワッツ',            short: 'ワ', color: '#1e63c4', re: /ワッツ|watts|ミーツ|meets/i },
];
const QUERY_RE = 'ダイソー|DAISO|セリア|Seria|キャンドゥ|Can.?Do|ワッツ|Watts|ミーツ|THREEPPY|スリーピー|Standard Products|スタンダードプロダクツ';
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const DEFAULT_POS = [35.6812, 139.7671]; // 位置情報が取れないとき(東京駅)
const STORE_KEY = 'hyakkin-map:v1';

// ---- 状態 ----
let shops = [];            // {id, lat, lon, chain, name, branch, addr, hours}
let origin = null;         // 距離計算の基準(現在地 or 検索中心)
let myPos = null;
let enabled = new Set(CHAINS.map(c => c.id));
const markers = new Map(); // shop.id -> L.Marker

const saved = load();
if (saved.enabled) enabled = new Set(saved.enabled);
if (saved.radius) document.getElementById('radius').value = saved.radius;

// ---- 地図 ----
const map = L.map('map', { zoomControl: false, attributionControl: true })
  .setView(saved.center || DEFAULT_POS, 15);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const layer = L.layerGroup().addTo(map);
let meMarker = null;
let rangeCircle = null;

// ---- UI 要素 ----
const $chips = document.getElementById('chips');
const $list = document.getElementById('list');
const $status = document.getElementById('status');
const $sheet = document.getElementById('sheet');
const $searchHere = document.getElementById('searchHere');
const $radius = document.getElementById('radius');

renderChips();

document.getElementById('sheetHandle').onclick = () => $sheet.classList.toggle('collapsed');
document.getElementById('locate').onclick = () => locate(true);
$searchHere.onclick = () => search(map.getCenter().lat, map.getCenter().lng);
$radius.onchange = () => {
  persist();
  const c = rangeCircle ? rangeCircle.getLatLng() : map.getCenter();
  search(c.lat, c.lng);
};

let programmaticMove = false;
map.on('movestart', () => { if (!programmaticMove) $searchHere.classList.remove('hidden'); });
map.on('moveend', () => { programmaticMove = false; });

// 前回の結果があれば先に表示しておく
if (saved.shops && saved.center) {
  shops = saved.shops;
  origin = saved.center;
  render();
}
locate(false);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ---- 現在地 ----
function locate(userAction) {
  if (!navigator.geolocation) {
    setStatus('この端末では位置情報が使えません');
    if (!saved.shops) search(...DEFAULT_POS);
    return;
  }
  setStatus('現在地を取得しています…');
  navigator.geolocation.getCurrentPosition(
    pos => {
      myPos = [pos.coords.latitude, pos.coords.longitude];
      if (meMarker) meMarker.setLatLng(myPos);
      else meMarker = L.marker(myPos, {
        icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [16, 16] }),
        interactive: false, zIndexOffset: 1000,
      }).addTo(map);
      search(...myPos);
    },
    err => {
      const msg = err.code === 1 ? '位置情報の許可がありません' : '現在地を取得できませんでした';
      if (userAction || !saved.shops) {
        setStatus(msg + '(地図を動かして「このエリアで再検索」)');
        if (!saved.shops) search(...(saved.center || DEFAULT_POS));
      } else {
        setStatus(msg);
      }
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
  );
}

// ---- 検索(Overpass API) ----
let searchSeq = 0;
async function search(lat, lon) {
  const seq = ++searchSeq;
  const r = Number($radius.value);
  $searchHere.classList.add('hidden');
  setStatus('100均を探しています…');

  origin = [lat, lon];
  if (rangeCircle) rangeCircle.remove();
  rangeCircle = L.circle(origin, {
    radius: r, color: '#e4007f', weight: 1, fillOpacity: .04, interactive: false,
  }).addTo(map);
  programmaticMove = true;
  map.fitBounds(rangeCircle.getBounds(), { padding: [10, 10] });

  const a = `(around:${r},${lat},${lon})`;
  // 先に範囲内の店舗だけに絞ってから名前で照合する(逆順だとサーバーが重くなる)
  const q = `[out:json][timeout:25];nwr${a}["shop"]->.s;(` +
    `nwr.s["name"~"${QUERY_RE}",i];` +
    `nwr.s["brand"~"${QUERY_RE}",i];` +
    `);out center tags;`;

  // メインサーバーは混雑(429/504)しやすいので少し待って再試行し、だめなら予備へ
  const attempts = [ENDPOINTS[0], ENDPOINTS[0], ...ENDPOINTS.slice(1)];
  let data = null;
  for (const [i, url] of attempts.entries()) {
    if (seq !== searchSeq) return;
    if (i > 0) {
      setStatus(`サーバーが混み合っています。再試行中…(${i + 1}/${attempts.length})`);
      await new Promise(r => setTimeout(r, 2000));
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000); // 応答しないサーバーで止まらないように
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q),
      });
      if (!res.ok) throw new Error(res.status);
      data = await res.json();
      break;
    } catch (e) {
      /* 次のサーバーを試す */
    } finally {
      clearTimeout(timer);
    }
  }
  if (seq !== searchSeq) return; // より新しい検索が始まっている
  if (!data) {
    setStatus('通信に失敗しました。時間をおいて再検索してください');
    $searchHere.classList.remove('hidden');
    return;
  }

  shops = data.elements.map(toShop).filter(Boolean);
  render();
  persist();
}

function toShop(e) {
  const t = e.tags || {};
  const hay = [t.name, t.brand, t['name:en'], t['brand:en'], t['name:ja']].filter(Boolean).join(' ');
  const chain = CHAINS.find(c => c.re.test(hay));
  if (!chain) return null;
  const lat = e.lat ?? e.center?.lat;
  const lon = e.lon ?? e.center?.lon;
  if (lat == null) return null;
  const addr = t['addr:full'] || [
    t['addr:province'], t['addr:city'], t['addr:suburb'], t['addr:quarter'],
    t['addr:neighbourhood'], t['addr:block_number'], t['addr:housenumber'],
  ].filter(Boolean).join('');
  return {
    id: e.type + e.id, lat, lon, chain: chain.id,
    name: t.name || chain.label, branch: t.branch || '',
    addr, hours: jpHours(t.opening_hours || ''), level: t.level || '',
  };
}

// ---- 描画 ----
function render() {
  layer.clearLayers();
  markers.clear();
  const base = myPos || origin;
  for (const s of shops) s.dist = base ? distance(base, [s.lat, s.lon]) : 0;
  shops.sort((a, b) => a.dist - b.dist);

  const visible = shops.filter(s => enabled.has(s.chain));
  for (const s of visible) {
    const c = chainById(s.chain);
    const m = L.marker([s.lat, s.lon], {
      icon: L.divIcon({
        className: '',
        html: `<div class="pin" style="--c:${c.color}"><span>${c.short}</span></div>`,
        iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -30],
      }),
    }).bindPopup(popupHtml(s));
    m.addTo(layer);
    markers.set(s.id, m);
  }

  $list.innerHTML = '';
  for (const s of visible) {
    const c = chainById(s.chain);
    const li = document.createElement('li');
    li.innerHTML =
      `<div class="dot" style="--c:${c.color}">${c.short}</div>` +
      `<div class="info"><div class="name">${esc(displayName(s))}</div>` +
      `<div class="sub">${esc(c.label)}${s.hours ? ' ・ ' + esc(s.hours) : ''}</div></div>` +
      `<div class="dist">${fmtDist(s.dist)}</div>`;
    li.onclick = () => {
      $sheet.classList.add('collapsed');
      programmaticMove = true;
      map.setView([s.lat, s.lon], Math.max(map.getZoom(), 17));
      markers.get(s.id)?.openPopup();
    };
    $list.appendChild(li);
  }

  renderChips();
  if (!shops.length) setStatus('この範囲には見つかりませんでした(範囲を広げてみてください)');
  else if (!visible.length) setStatus(`${shops.length}件(絞り込みで全部非表示中)`);
  else setStatus(`${visible.length}件 見つかりました ・ 一番近い店まで ${fmtDist(visible[0].dist)}`);
}

function renderChips() {
  $chips.innerHTML = '';
  for (const c of CHAINS) {
    const n = shops.filter(s => s.chain === c.id).length;
    const b = document.createElement('button');
    b.className = 'chip' + (enabled.has(c.id) ? '' : ' off');
    b.style.setProperty('--c', c.color);
    b.innerHTML = `${esc(c.label)}${shops.length ? `<span class="n">${n}</span>` : ''}`;
    b.onclick = () => {
      enabled.has(c.id) ? enabled.delete(c.id) : enabled.add(c.id);
      persist();
      render();
    };
    $chips.appendChild(b);
  }
}

function popupHtml(s) {
  const c = chainById(s.chain);
  const dest = `${s.lat},${s.lon}`;
  const route = `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=walking`;
  return `<div style="--c:${c.color}">` +
    `<div class="pop-chain">${esc(c.label)}</div>` +
    `<div class="pop-name">${esc(displayName(s))}</div>` +
    `<div class="pop-meta">${fmtDist(s.dist)}` +
    (s.level ? ` ・ ${esc(jpFloor(s.level))}` : '') + `</div>` +
    (s.hours ? `<div class="pop-meta">営業: ${esc(s.hours)}</div>` : '') +
    (s.addr ? `<div class="pop-meta">${esc(s.addr)}</div>` : '') +
    `<a class="pop-btn" href="${route}" target="_blank" rel="noopener">ルート案内</a>` +
    `</div>`;
}

// ---- ユーティリティ ----
function displayName(s) {
  return s.branch && !s.name.includes(s.branch) ? `${s.name} ${s.branch}` : s.name;
}
// OSMの営業時間表記(Mo-Su 10:00-21:00 など)を日本語に
function jpHours(s) {
  const days = { Mo: '月', Tu: '火', We: '水', Th: '木', Fr: '金', Sa: '土', Su: '日', PH: '祝' };
  return s
    .replace(/\bMo-Su\b/g, '毎日')
    .replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su|PH)\b/g, d => days[d])
    .replace(/\boff\b/g, '休み')
    .replace(/;\s*/g, ' / ');
}
// OSMの level は地上階が0、地下1階が-1
function jpFloor(level) {
  const n = Number(level);
  if (!Number.isInteger(n)) return `${level}階`;
  return n >= 0 ? `${n + 1}階` : `地下${-n}階`;
}
function chainById(id) { return CHAINS.find(c => c.id === id); }
function setStatus(t) { $status.textContent = t; }
function fmtDist(m) { return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`; }
function esc(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function distance([la1, lo1], [la2, lo2]) {
  const R = 6371000, rad = Math.PI / 180;
  const dLa = (la2 - la1) * rad, dLo = (lo2 - lo1) * rad;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}
function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      enabled: [...enabled], radius: $radius.value, center: origin, shops,
    }));
  } catch { /* 保存できなくても動作には影響しない */ }
}
