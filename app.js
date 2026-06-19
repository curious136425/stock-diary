/**
 * 选股日记 — 单页备忘录风格
 * 左右滑翻页 · 上下滚看内容
 */
(function() { 'use strict';

// ====== IndexedDB ======
const DB_NAME = 'stock_diary_db', DB_VERSION = 1;
let db = null;

function openDB() { return new Promise((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = (e) => {
    const d = e.target.result;
    if (!d.objectStoreNames.contains('diary')) d.createObjectStore('diary', { keyPath: 'date' });
    if (!d.objectStoreNames.contains('images')) {
      const s = d.createObjectStore('images', { keyPath: 'id', autoIncrement: true });
      s.createIndex('date', 'date', { unique: false });
    }
  };
  req.onsuccess = (e) => { db = e.target.result; resolve(db); };
  req.onerror = (e) => reject(e.target.error);
}); }

function getDiary(date) {
  return new Promise(r => {
    const tx = db.transaction('diary','readonly');
    const req = tx.objectStore('diary').get(date);
    req.onsuccess = () => r(req.result || emptyDiary(date));
  });
}
function putDiary(d) {
  return new Promise(r => {
    const tx = db.transaction('diary','readwrite');
    tx.objectStore('diary').put(d);
    tx.oncomplete = () => r(d);
  });
}
function getAllDates() {
  return new Promise(r => {
    const tx = db.transaction('diary','readonly');
    const req = tx.objectStore('diary').getAllKeys();
    req.onsuccess = () => r(req.result.sort());
  });
}
function emptyDiary(date) { return { date, is_temporary:false, hot_sectors:'', capital_trends:'', selection_philosophy:'', best_pick:'', tomorrow_plan:'', thoughts:'', picks:[], images:[] }; }

// 图片
function saveImage(date, dataUrl) {
  return new Promise(r => {
    const tx = db.transaction('images','readwrite');
    const img = { date, dataUrl, created: Date.now() };
    const req = tx.objectStore('images').add(img);
    req.onsuccess = () => r({ id: req.result, ...img });
  });
}
function getImages(date) {
  return new Promise(r => {
    const tx = db.transaction('images','readonly');
    const req = tx.objectStore('images').index('date').getAll(date);
    req.onsuccess = () => r(req.result || []);
  });
}
function deleteImage(id) {
  return new Promise(r => {
    const tx = db.transaction('images','readwrite');
    tx.objectStore('images').delete(id);
    tx.oncomplete = () => r();
  });
}

// ====== 全局状态 ======
const S = {
  module: 'regular',
  currentDate: new Date().toISOString().slice(0,10),
  diaryData: null,
  allDates: [],
  pageIdx: -1,
  flipping: false,
  saveTimer: null,
};

const criteriaMeta = {
  1: { title: '月线连续3月红柱，突破前高回踩', sub: '市值100亿-1000亿 | 涨幅2%-6%' },
  2: { title: '月线、周线、日线均为多头排列', sub: '' },
  3: { title: '一月内突破前高，回踩不破20日均线', sub: '' },
  4: { title: '均线多头向上排列30度以上，即将突破前高', sub: '' },
  5: { title: '横盘震荡的股票', sub: '' },
};

// ====== 初始化 ======
document.addEventListener('DOMContentLoaded', async () => {
  await openDB();
  await loadAllDates();
  initDatePicker();
  bindUI();
  initSwipe();
  if (S.allDates.length > 0 && !S.allDates.includes(S.currentDate))
    S.currentDate = S.allDates[S.allDates.length - 1];
  await loadAndRender(S.currentDate);
  updateIndicator();
});

async function loadAllDates() {
  S.allDates = await getAllDates();
  if (S.allDates.length === 0) S.allDates = [S.currentDate];
}

function initDatePicker() {
  const dp = document.getElementById('datePicker');
  dp.value = S.currentDate;
  dp.addEventListener('change', () => jumpTo(dp.value));
}

function bindUI() {
  document.getElementById('modalOverlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.querySelectorAll('.dropdown-menu a').forEach(a => {
    a.addEventListener('click', e => { e.preventDefault(); exportDiary(a.dataset.format); });
  });
}

// ====== 模块切换 ======
function switchModule(mod) {
  if (S.module === mod) return;
  S.module = mod;
  document.querySelectorAll('.module-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.module === mod));
  renderPage();
}

// ====== 数据 & 渲染 ======
async function loadAndRender(dateStr) {
  const data = await getDiary(dateStr);
  data.images = await getImages(dateStr);
  S.diaryData = data;
  S.currentDate = dateStr;
  if (!S.allDates.includes(dateStr)) { S.allDates.push(dateStr); S.allDates.sort(); }
  S.pageIdx = S.allDates.indexOf(dateStr);
  document.getElementById('datePicker').value = dateStr;
  renderPage();
  updateIndicator();
}

function updateIndicator() {
  document.getElementById('pageIndicator').textContent =
    `第 ${S.pageIdx+1} / ${S.allDates.length} 页`;
}

async function jumpTo(dateStr) {
  await loadAndRender(dateStr);
  document.getElementById('pageScroll').scrollTop = 0;
}

// ====== 内容渲染 ======
function renderPage() {
  S.module === 'regular' ? renderRegular() : renderTemp();
  document.getElementById('pageScroll').scrollTop = 0;
}

function renderRegular() {
  const d = S.diaryData || emptyDiary(S.currentDate);
  document.getElementById('pageScroll').innerHTML = regularHTML(d);
  bindStockHover();
}

function regularHTML(d) {
  const byC = {};
  (d.picks||[]).forEach(p => { (byC[p.criteria_type]=byC[p.criteria_type]||[]).push(p); });

  let html = `
    <div class="page-date">${fmtDate(d.date)}</div>
    <div class="page-title">📊 选股日记</div>`;

  for (let ct=1; ct<=5; ct++) {
    const stocks = byC[ct]||[];
    html += `<div class="criteria-block">
      <div class="criteria-label"><span class="num">${ct}</span> ${criteriaMeta[ct].title}</div>`;
    if (criteriaMeta[ct].sub) html += `<div class="criteria-sub">${criteriaMeta[ct].sub}</div>`;
    html += `<div class="stock-tags" id="stocks-${ct}">`;
    stocks.forEach(p => { html += stockTag(p); });
    html += `<span class="add-tag" onclick="quickAdd(${ct})">+</span></div></div>`;
  }

  html += `
    <div class="summary-section">
      <h3>📊 总结复盘</h3>
      <div class="field"><label>🔥 热点板块</label><textarea id="hotSectors" rows="2" onblur="save()" oninput="dsave()">${esc(d.hot_sectors||'')}</textarea></div>
      <div class="field"><label>💰 资金趋势</label><textarea id="capitalTrends" rows="2" onblur="save()" oninput="dsave()">${esc(d.capital_trends||'')}</textarea></div>
      <div class="field"><label>🧠 选股理念</label><textarea id="selectionPhilosophy" rows="2" onblur="save()" oninput="dsave()">${esc(d.selection_philosophy||'')}</textarea></div>
      <div class="field"><label>⭐ 最看好</label><input type="text" id="bestPick" onblur="save()" oninput="dsave()" value="${esc(d.best_pick||'')}"></div>
      <div class="field"><label>📋 明天怎么做</label><textarea id="tomorrowPlan" rows="2" onblur="save()" oninput="dsave()">${esc(d.tomorrow_plan||'')}</textarea></div>
    </div>
    <div class="thoughts-section">
      <h3>💭 碎碎念</h3>
      <textarea id="thoughts" onblur="save()" oninput="dsave()">${esc(d.thoughts||'')}</textarea>
      <div class="thoughts-imgs" id="thoughtsImgs">${(d.images||[]).map(img => img.dataUrl ? `<div style="position:relative;display:inline-block"><img src="${img.dataUrl}" onclick="viewImg('${img.dataUrl}')"><span style="position:absolute;top:-7px;right:-7px;width:17px;height:17px;background:#e74c3c;color:#fff;border:none;border-radius:50%;font-size:9px;cursor:pointer;line-height:17px;text-align:center;display:none" class="img-del" onclick="delImg(${img.id})">×</span></div>` : '').join('')}</div>
      <div class="action-row">
        <button class="btn-sm" onclick="uploadImg()">📷 传图</button>
        <button class="btn-sm" onclick="openReview()">📋 加载前日好票</button>
      </div>
    </div>`;

  document.getElementById('frontScroll').innerHTML = html;
  bindStockHover();
}

function bindStockHover() {
  document.querySelectorAll('.thoughts-imgs > div').forEach(d => {
    d.addEventListener('mouseenter',()=>d.querySelector('.img-del').style.display='block');
    d.addEventListener('mouseleave',()=>d.querySelector('.img-del').style.display='none');
    d.addEventListener('touchstart',()=>{ const b=d.querySelector('.img-del'); b.style.display=b.style.display==='block'?'none':'block'; });
  });
}

function renderTemp() {
  const d = S.diaryData || emptyDiary(S.currentDate);
  document.getElementById('pageScroll').innerHTML = tempHTML(d);
}

function tempHTML(d) {
  return `<div class="page-date">${fmtDate(d.date)}</div>
    <div class="page-title">📝 临时日记</div>
    <input type="text" class="temp-title-input" id="tempTitle" placeholder="标题..."
      value="${esc(d.selection_philosophy||'')}" onblur="saveTempTitle()">
    <textarea class="temp-content" id="tempContent" placeholder="自由书写..."
      onblur="save()" oninput="dsave()">${esc(d.thoughts||'')}</textarea>`;
}

function stockTag(p) {
  const c = p.performance_color || 'none';
  return `<span class="stock-tag" data-id="${p.id}" onclick="editTag(event,${p.id})">
    <span class="dot ${c}"></span>${esc(p.stock_name)}
    <span class="del" onclick="delTag(event,${p.id})">×</span></span>`;
}

// ====== 保存 ======
function dsave() { clearTimeout(S.saveTimer); S.saveTimer = setTimeout(save, 1200); }
async function save() {
  clearTimeout(S.saveTimer);
  const d = S.diaryData;
  if (S.module === 'regular') {
    ['hotSectors','capitalTrends','selectionPhilosophy','bestPick','tomorrowPlan','thoughts'].forEach(id => {
      const el = document.getElementById(id); if (el) d[id === 'selectionPhilosophy' ? 'selection_philosophy' : id === 'hotSectors' ? 'hot_sectors' : id] = el.value;
    });
  } else {
    d.is_temporary = true;
    d.selection_philosophy = document.getElementById('tempTitle')?.value || '';
    d.thoughts = document.getElementById('tempContent')?.value || '';
  }
  await putDiary(d);
}
async function saveTempTitle() { S.diaryData.is_temporary = true; S.diaryData.selection_philosophy = document.getElementById('tempTitle')?.value||''; await putDiary(S.diaryData); }

// ====== 选票操作 ======
async function quickAdd(ct) { const n = prompt('股票名称：'); if (!n?.trim()) return;
  S.diaryData.picks = S.diaryData.picks || [];
  S.diaryData.picks.push({ id: Date.now(), criteria_type: ct, stock_name: n.trim(), performance_color:'', sector:'', company_description:'', hotspot_relevance:'', industry_position:'', notes:'', kline_image:'', is_review_pick:false });
  await putDiary(S.diaryData); renderPage(); toast('✅ 已添加'); }

function editTag(e, id) { e.stopPropagation();
  const p = S.diaryData.picks.find(x=>x.id===id); if (!p) return;
  const mc = document.getElementById('modalContent');
  const labels = { red:'🔴涨>6%', yellow:'🟡0-6%', blue:'🔵-3~0', green:'🟢跌>3%', '':'⬜未记' };
  mc.innerHTML = `<button class="close-btn" onclick="closeModal()">✕</button><h3>${esc(p.stock_name)}</h3>
    <input id="en" value="${esc(p.stock_name)}"><br>
    <small>表现：</small><div class="color-dots">${
      ['red','yellow','blue','green'].map(c=>`<span class="color-dot ${c} ${p.performance_color===c?'sel':''}" onclick="selCol('${c}')"></span>`).join('')}</div>
    <input type="hidden" id="ec" value="${p.performance_color||''}">
    <input id="es" placeholder="板块" value="${esc(p.sector||'')}">
    <textarea id="ed" rows="2" placeholder="公司简介">${esc(p.company_description||'')}</textarea>
    <textarea id="eh" rows="2" placeholder="热点关联">${esc(p.hotspot_relevance||'')}</textarea>
    <input id="ep" placeholder="行业位置" value="${esc(p.industry_position||'')}">
    <textarea id="enote" rows="2" placeholder="备注">${esc(p.notes||'')}</textarea>
    ${p.kline_image?`<img src="${p.kline_image}" style="max-width:160px;cursor:pointer" onclick="viewImg('${p.kline_image}')">`:''}
    <div style="margin-top:8px;display:flex;gap:6px">
      <button class="btn" onclick="saveTag(${id})">保存</button>
      <button class="btn btn-outline" onclick="upKline(${id})">📈 K线图</button></div>`;
  document.getElementById('modalOverlay').style.display = 'flex';
}
function selCol(c) { document.getElementById('ec').value=c;
  document.querySelectorAll('.color-dot').forEach(d=>d.classList.toggle('sel', d.classList.contains(c))); }
async function saveTag(id) {
  const p = S.diaryData.picks.find(x=>x.id===id); if (!p) return;
  Object.assign(p, { stock_name: document.getElementById('en').value, performance_color: document.getElementById('ec').value,
    sector: document.getElementById('es').value, company_description: document.getElementById('ed').value,
    hotspot_relevance: document.getElementById('eh').value, industry_position: document.getElementById('ep').value,
    notes: document.getElementById('enote').value });
  await putDiary(S.diaryData); closeModal(); renderPage(); toast('💾 已保存');
}
async function delTag(e, id) { e.stopPropagation(); if (!confirm('删除？')) return;
  S.diaryData.picks = S.diaryData.picks.filter(x=>x.id!==id);
  await putDiary(S.diaryData); renderPage(); toast('🗑️ 已删除'); }
function upKline(id) {
  const i = document.createElement('input'); i.type='file'; i.accept='image/*';
  i.onchange = () => { const f = i.files[0]; if (!f) return; const r = new FileReader();
    r.onload = async () => { const p = S.diaryData.picks.find(x=>x.id===id); if (p) { p.kline_image = r.result; await putDiary(S.diaryData); } toast('📈 已上传'); }; r.readAsDataURL(f); }; i.click();
}

async function uploadImg() {
  const i = document.createElement('input'); i.type='file'; i.accept='image/*';
  i.onchange = () => { const f = i.files[0]; if (!f) return; const r = new FileReader();
    r.onload = async () => { await saveImage(S.currentDate, r.result); S.diaryData.images = await getImages(S.currentDate); renderPage(); toast('📷 已上传'); }; r.readAsDataURL(f); }; i.click();
}
async function delImg(id) { if (!confirm('删除？')) return; await deleteImage(id); S.diaryData.images = S.diaryData.images.filter(x=>x.id!==id); renderPage(); }
function viewImg(url) { document.getElementById('modalContent').innerHTML = `<button class="close-btn" onclick="closeModal()">✕</button><img src="${url}" style="max-width:100%;max-height:70vh;border-radius:4px">`;
  document.getElementById('modalOverlay').style.display = 'flex'; }

// 回顾
async function openReview() {
  const d = new Date(S.currentDate); d.setDate(d.getDate()-1);
  const prev = await getDiary(d.toISOString().slice(0,10));
  if (!prev.picks?.length) { toast('前一天无选股'); return; }
  const mc = document.getElementById('modalContent');
  const order = { red:0, yellow:1, blue:2, green:3 };
  const sorted = [...prev.picks].sort((a,b)=>(order[a.performance_color]??99)-(order[b.performance_color]??99));
  mc.innerHTML = `<button class="close-btn" onclick="closeModal()">✕</button><h3>${prev.date} 验证回顾</h3><p style="font-size:11px;color:#999">勾选后加入今日</p>
    <div style="max-height:300px;overflow-y:auto">${sorted.map(p =>
      `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #eee;font-size:13px">
        <input type="checkbox" class="rc" data-p='${esc(JSON.stringify(p))}' ${p.performance_color==='red'||p.performance_color==='yellow'?'checked':''}>
        <b>${esc(p.stock_name)}</b> <span style="font-size:10px;color:#999">${criteriaMeta[p.criteria_type]?.title.slice(0,5)||''}</span>
        <span style="font-size:11px">${({red:'🔴',yellow:'🟡',blue:'🔵',green:'🟢','':'⬜'})[p.performance_color]||''}</span></div>`).join('')}</div>
    <button class="btn" style="margin-top:8px" onclick="addReview()">✅ 加入今日</button>`;
  document.getElementById('modalOverlay').style.display = 'flex';
}
async function addReview() {
  const cs = document.querySelectorAll('.rc:checked'); let n = 0;
  for (const c of cs) { const p = JSON.parse(c.dataset.p); p.id = Date.now()+n; p.notes = `[回顾] ${p.notes||''}`; p.is_review_pick = true; S.diaryData.picks.push(p); n++; }
  await putDiary(S.diaryData); closeModal(); renderPage(); toast(`✅ +${n}`);
}

// AI
async function runAIAnalysis() {
  const d = S.diaryData; const byC={}, byCol={};
  (d.picks||[]).forEach(p=>{ byC[p.criteria_type]=(byC[p.criteria_type]||0)+1; byCol[p.performance_color||'未记']=(byCol[p.performance_color||'未记']||0)+1; });
  let prompt = `## ${S.currentDate} 选股分析\n### 热点\n${d.hot_sectors||'-'}\n### 资金\n${d.capital_trends||'-'}\n### 理念\n${d.selection_philosophy||'-'}\n### 最看好\n${d.best_pick||'-'}\n### 选股\n`;
  (d.picks||[]).forEach(p=>{ prompt += `- [${criteriaMeta[p.criteria_type]?.title||''}] ${p.stock_name} (${p.sector||''})\n`; });
  const mc = document.getElementById('modalContent');
  mc.innerHTML = `<button class="close-btn" onclick="closeModal()">✕</button><h3>🤖 分析 — ${S.currentDate}</h3>
    <p>总选股: ${(d.picks||[]).length}只</p>
    <p>按条件: ${Object.entries(byC).map(([k,v])=>`条件${k}:${v}`).join(' ')}</p>
    <p>按表现: ${Object.entries(byCol).map(([k,v])=>`${k}:${v}`).join(' ')}</p>
    <p style="font-size:11px;color:#999">Prompt (可复制到AI):</p>
    <pre class="ai-result">${esc(prompt)}</pre>
    <button class="btn btn-sm" style="margin-top:6px" onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent);toast('📋 已复制')">📋 复制</button>`;
  document.getElementById('modalOverlay').style.display = 'flex';
}

// 导出
function exportDiary(fmt) {
  const d = S.diaryData; if (!d) return;
  const byC = {}; (d.picks||[]).forEach(p => { (byC[p.criteria_type]=byC[p.criteria_type]||[]).push(p); });
  if (fmt === 'md') {
    let md = `# ${d.date} 选股日记\n\n`;
    for (let ct=1;ct<=5;ct++){ md+=`## ${criteriaMeta[ct].title}\n\n`; const s=byC[ct]||[];
      if(!s.length){md+='(无)\n\n';continue;} s.forEach(p=>{ md+=`- ${p.stock_name} ${({red:'🔴',yellow:'🟡',blue:'🔵',green:'🟢'})[p.performance_color]||''} ${p.sector||''} ${p.notes||''}\n`; }); md+='\n'; }
    md += `---\n## 总结\n- 热点: ${d.hot_sectors||''}\n- 资金: ${d.capital_trends||''}\n- 理念: ${d.selection_philosophy||''}\n- 最看好: ${d.best_pick||''}\n- 明日: ${d.tomorrow_plan||''}\n`;
    if (d.thoughts) md += `\n## 碎碎念\n${d.thoughts}\n`;
    download(md, `选股日记_${d.date}.md`, 'text/markdown');
  } else if (fmt === 'html') {
    let t=''; for(let ct=1;ct<=5;ct++){ t+=`<h2>${criteriaMeta[ct].title}</h2>`; const s=byC[ct]||[];
      if(!s.length){t+='<p>(无)</p>';continue;} t+='<table border=1 cellpadding=6><tr><th>股票</th><th>表现</th><th>板块</th><th>简介</th><th>热点</th><th>位置</th><th>备注</th></tr>';
      s.forEach(p=>{ t+=`<tr><td><b>${esc(p.stock_name)}</b></td><td>${{red:'🔴',yellow:'🟡',blue:'🔵',green:'🟢'}[p.performance_color]||''}</td><td>${esc(p.sector||'')}</td><td>${esc(p.company_description||'')}</td><td>${esc(p.hotspot_relevance||'')}</td><td>${esc(p.industry_position||'')}</td><td>${esc(p.notes||'')}</td></tr>`; });
      t+='</table>'; }
    const h = `<!DOCTYPE html><html lang=zh><head><meta charset=UTF-8><title>${d.date}选股日记</title><style>body{font-family:"PingFang SC",sans-serif;max-width:800px;margin:40px auto;line-height:1.8}h1{border-bottom:3px solid #c0392b}h2{border-left:4px solid #c0392b;padding-left:12px}table{width:100%;border-collapse:collapse}th{background:#1a1a2e;color:#fff;padding:8px}td{padding:6px;border-bottom:1px solid #eee}</style></head><body><h1>${d.date} 选股日记</h1>${t}<h2>📊 总结</h2><p>热点: ${d.hot_sectors||'-'}</p><p>资金: ${d.capital_trends||'-'}</p><p>理念: ${d.selection_philosophy||'-'}</p><p>最看好: ${d.best_pick||'-'}</p><p>明日: ${d.tomorrow_plan||'-'}</p>${d.thoughts?`<h2>💭 碎碎念</h2><p>${esc(d.thoughts)}</p>`:''}</body></html>`;
    download(h, `选股日记_${d.date}.html`, 'text/html');
  } else if (fmt === 'xlsx') {
    let csv = '\uFEFF'; for(let ct=1;ct<=5;ct++){ csv+=`${criteriaMeta[ct].title}\n股票,表现,板块,简介,热点,位置,备注\n`;
      (byC[ct]||[]).forEach(p=>{ csv+=`${p.stock_name},${p.performance_color||''},${p.sector||''},${p.company_description||''},${p.hotspot_relevance||''},${p.industry_position||''},${p.notes||''}\n`; }); csv+='\n'; }
    csv += `总结\n热点,${d.hot_sectors||''}\n资金,${d.capital_trends||''}\n理念,${d.selection_philosophy||''}\n最看好,${d.best_pick||''}\n明日,${d.tomorrow_plan||''}\n`;
    if(d.thoughts) csv += `碎碎念,${d.thoughts}\n`;
    download(csv, `选股日记_${d.date}.csv`, 'text/csv');
  } else {
    download(`选股日记_${d.date}.txt`, '', 'text/plain');
  }
  toast('📥 已导出');
}
function download(content, name, type) {
  const b = new Blob([content], { type }); const u = URL.createObjectURL(b);
  const a = document.createElement('a'); a.href = u; a.download = name; a.click(); URL.revokeObjectURL(u);
}

// ====== 翻书翻页（简单可靠：左滑前进，右滑后退）======
const THRESH = 0.20;
const sw = { active:false, sx:0, sy:0, cx:0, cy:0, dir:0, st:0, locked:false, sheet:null, shadow:null };

function initSwipe() {
  sw.sheet = document.getElementById('pageSheet');
  sw.shadow = document.getElementById('pageShadow');
  const pw = document.getElementById('pageWrapper');
  pw.addEventListener('touchstart', onStart, { passive: false });
  pw.addEventListener('touchmove', onMove, { passive: false });
  pw.addEventListener('touchend', onEnd);
  pw.addEventListener('touchcancel', onEnd);
}

function onStart(e) {
  if (S.flipping) return;
  const t = e.touches[0];
  sw.active = true;
  sw.sx = t.clientX; sw.sy = t.clientY;
  sw.cx = t.clientX; sw.cy = t.clientY;
  sw.st = Date.now(); sw.dir = 0; sw.locked = false;
  sw.sheet.style.transition = 'none';
}

function onMove(e) {
  if (!sw.active) return;
  sw.cx = e.touches[0].clientX; sw.cy = e.touches[0].clientY;
  const dx = sw.cx - sw.sx, dy = sw.cy - sw.sy;

  if (!sw.locked) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    if (Math.abs(dx) > Math.abs(dy) * 1.8) {
      // 左滑(dx<0)=前进，右滑(dx>0)=后退
      sw.dir = dx < 0 ? 1 : -1; // 1=前进, -1=后退
      sw.locked = true;
      e.preventDefault();
    } else { sw.dir = 0; sw.locked = true; return; }
  }
  if (sw.dir === 0) return;
  e.preventDefault();

  const w = sw.sheet.parentElement.clientWidth;
  const clampedDx = Math.max(-w, Math.min(w, sw.cx - sw.sx));
  const ratio = Math.min(Math.abs(clampedDx) / w, 1);

  // 页面跟手平移 + 轻微旋转
  const rotateY = (clampedDx / w) * 15;
  sw.sheet.style.transform = `translateX(${clampedDx}px) rotateY(${rotateY}deg)`;

  // 折叠侧阴影
  if (sw.dir === 1) {
    sw.shadow.style.background = `linear-gradient(to left, rgba(0,0,0,0) 30%, rgba(0,0,0,${ratio*0.12}) 100%)`;
  } else {
    sw.shadow.style.background = `linear-gradient(to right, rgba(0,0,0,0) 30%, rgba(0,0,0,${ratio*0.12}) 100%)`;
  }
  sw.shadow.style.opacity = ratio;
}

async function onEnd(e) {
  if (!sw.active || sw.dir === 0) { resetSwipe(); return; }
  const dx = sw.cx - sw.sx;
  const w = sw.sheet.parentElement.clientWidth;
  const absR = Math.abs(dx / w);
  const quick = (Date.now() - sw.st) < 280 && absR > 0.04;
  const flip = absR > THRESH || quick;

  const EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';

  if (flip) {
    S.flipping = true;
    // 滑出
    sw.sheet.style.transition = `transform 0.5s ${EASE}`;
    sw.sheet.style.transform = `translateX(${sw.dir * 105}%) rotateY(${sw.dir * 20}deg)`;
    sw.shadow.style.transition = 'opacity 0.3s';
    sw.shadow.style.opacity = '0';

    setTimeout(async () => {
      const target = getTarget(sw.dir === 1 ? 'forward' : 'backward');
      await loadAndRender(target);
      document.getElementById('pageScroll').scrollTop = 0;

      // 从另一侧准备滑入
      sw.sheet.style.transition = 'none';
      sw.sheet.style.transform = `translateX(${-sw.dir * 20}%) rotateY(${-sw.dir * 5}deg)`;

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          sw.sheet.style.transition = `transform 0.5s ${EASE}`;
          sw.sheet.style.transform = 'translateX(0) rotateY(0)';
        });
      });

      S.flipping = false;
      setTimeout(() => {
        sw.sheet.style.transition = '';
        sw.sheet.style.transform = '';
      }, 550);
    }, 250);
  } else {
    // 弹回
    sw.sheet.style.transition = `transform 0.4s ${EASE}`;
    sw.sheet.style.transform = 'translateX(0) rotateY(0)';
    sw.shadow.style.transition = 'opacity 0.3s';
    sw.shadow.style.opacity = '0';
    setTimeout(() => {
      sw.sheet.style.transition = '';
      sw.sheet.style.transform = '';
    }, 450);
  }
  resetSwipe();
}

function resetSwipe() { sw.active = false; sw.dir = 0; sw.locked = false; }

function getTarget(dir) {
  const idx = S.pageIdx;
  if (dir === 'backward') {
    if (idx <= 0) { const d = new Date(S.currentDate); d.setDate(d.getDate()-1); return d.toISOString().slice(0,10); }
    return S.allDates[idx-1];
  }
  if (idx >= S.allDates.length-1 || idx < 0) { const d = new Date(S.currentDate); d.setDate(d.getDate()+1); return d.toISOString().slice(0,10); }
  return S.allDates[idx+1];
}

// ====== 工具 ======
function esc(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtDate(d) { if (!d) return ''; const p = d.split('-'); return `${p[0]}年${parseInt(p[1])}月${parseInt(p[2])}日`; }
function closeModal() { document.getElementById('modalOverlay').style.display = 'none'; }
function toast(m) { const c = document.getElementById('toastContainer'); const t = document.createElement('div'); t.className = 'toast'; t.textContent = m; c.appendChild(t); setTimeout(() => t.remove(), 2600); }

// 暴露全局
window.switchModule = switchModule;
window.quickAdd = quickAdd;
window.editTag = editTag;
window.delTag = delTag;
window.saveTag = saveTag;
window.selCol = selCol;
window.upKline = upKline;
window.uploadImg = uploadImg;
window.delImg = delImg;
window.viewImg = viewImg;
window.openReview = openReview;
window.addReview = addReview;
window.runAIAnalysis = runAIAnalysis;
window.exportDiary = exportDiary;
window.save = save;
window.dsave = dsave;
window.saveTempTitle = saveTempTitle;
window.closeModal = closeModal;
window.toast = toast;
})();
