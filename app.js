/**
 * 每日选股日记 — 独立静态版
 * IndexedDB 本地存储 | 离线可用 | PWA
 */
(function() {
'use strict';

// ====== IndexedDB 封装 ======
const DB_NAME = 'stock_diary_db';
const DB_VERSION = 1;
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('diary')) {
        db.createObjectStore('diary', { keyPath: 'date' });
      }
      if (!db.objectStoreNames.contains('images')) {
        const imgs = db.createObjectStore('images', { keyPath: 'id', autoIncrement: true });
        imgs.createIndex('date', 'date', { unique: false });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = (e) => reject(e.target.error);
  });
}

function getDiary(date) {
  return new Promise((resolve) => {
    const tx = db.transaction('diary', 'readonly');
    const req = tx.objectStore('diary').get(date);
    req.onsuccess = () => resolve(req.result || emptyDiary(date));
  });
}

function putDiary(data) {
  return new Promise((resolve) => {
    const tx = db.transaction('diary', 'readwrite');
    tx.objectStore('diary').put(data);
    tx.oncomplete = () => resolve(data);
  });
}

function getAllDates() {
  return new Promise((resolve) => {
    const tx = db.transaction('diary', 'readonly');
    const req = tx.objectStore('diary').getAllKeys();
    req.onsuccess = () => resolve(req.result.sort());
  });
}

function emptyDiary(date) {
  return {
    date,
    is_temporary: false,
    hot_sectors: '', capital_trends: '', selection_philosophy: '',
    best_pick: '', tomorrow_plan: '', thoughts: '',
    picks: [], images: []
  };
}

// 图片操作
function saveImage(date, dataUrl) {
  return new Promise((resolve) => {
    const tx = db.transaction('images', 'readwrite');
    const img = { date, dataUrl, created: Date.now() };
    const req = tx.objectStore('images').add(img);
    req.onsuccess = () => resolve({ id: req.result, ...img });
  });
}

function getImages(date) {
  return new Promise((resolve) => {
    const tx = db.transaction('images', 'readonly');
    const idx = tx.objectStore('images').index('date');
    const req = idx.getAll(date);
    req.onsuccess = () => resolve(req.result || []);
  });
}

function deleteImage(id) {
  return new Promise((resolve) => {
    const tx = db.transaction('images', 'readwrite');
    tx.objectStore('images').delete(id);
    tx.oncomplete = () => resolve();
  });
}

// ====== 全局状态 ======
const state = {
  module: 'regular',
  currentDate: new Date().toISOString().slice(0, 10),
  diaryData: null,
  allDates: [],
  pageIndex: -1,
  isFlipping: false,
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
  bindEvents();
  if (state.allDates.length > 0 && !state.allDates.includes(state.currentDate)) {
    state.currentDate = state.allDates[state.allDates.length - 1];
  }
  await loadAndRender(state.currentDate);
  updateDotNavigation();
});

async function loadAllDates() {
  state.allDates = await getAllDates();
  if (state.allDates.length === 0) state.allDates = [state.currentDate];
}

function initDatePicker() {
  const dp = document.getElementById('datePicker');
  dp.value = state.currentDate;
  dp.addEventListener('change', () => navigateToDate(dp.value));
}

function bindEvents() {
  document.getElementById('btnAI').addEventListener('click', runAIAnalysis);
  document.getElementById('modalOverlay').addEventListener('click', (e) => {
    if (e.target === e.target.currentTarget) closeModal();
  });

  // 导出下拉
  document.querySelectorAll('.dropdown-menu a').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault(); exportDiary(a.dataset.format);
    });
  });

  // 键盘
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' && !e.target.closest('input,textarea')) { e.preventDefault(); flipPrev(); }
    if (e.key === 'ArrowRight' && !e.target.closest('input,textarea')) { e.preventDefault(); flipNext(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); autoSave(); showToast('💾 已保存'); }
  });

  initDragToFlip();
}

// ====== 模块切换 ======
function switchModule(mod) {
  if (state.module === mod) return;
  state.module = mod;
  document.querySelectorAll('.module-tab').forEach(t => t.classList.toggle('active', t.dataset.module === mod));
  document.getElementById('btnAI').style.display = mod === 'temporary' ? 'none' : '';
  renderPages();
}

// ====== 数据加载 ======
async function loadAndRender(dateStr) {
  const data = await getDiary(dateStr);
  // 加载图片
  const images = await getImages(dateStr);
  data.images = images;
  state.diaryData = data;
  state.currentDate = dateStr;

  if (!state.allDates.includes(dateStr)) {
    state.allDates.push(dateStr);
    state.allDates.sort();
  }
  state.pageIndex = state.allDates.indexOf(dateStr);
  document.getElementById('datePicker').value = dateStr;
  renderPages();
  updateDotNavigation();
}

// ====== 拖拽翻页（电子书风格：左滑前进，右滑后退）======
const DRAG_THRESHOLD = 0.25, MAX_ROTATE = 160;
const drag = { active: false, startX: 0, currentX: 0, direction: null, startTime: 0,
               leftPage: null, rightPage: null };

function initDragToFlip() {
  const book = document.getElementById('book');
  book.addEventListener('mousedown', onDragStart);
  book.addEventListener('touchstart', onDragStart, { passive: false });
  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('touchmove', onDragMove, { passive: false });
  window.addEventListener('mouseup', onDragEnd);
  window.addEventListener('touchend', onDragEnd);
  window.addEventListener('touchcancel', onDragEnd);
}

function getEventX(e) { return e.touches ? e.touches[0].clientX : e.clientX; }

function onDragStart(e) {
  if (state.isFlipping) return;
  if (e.target.closest('.stock-tag,input,textarea,button,.add-tag-btn,.install-btn,.install-dismiss')) return;

  const x = getEventX(e);
  drag.active = true;
  drag.startX = x;
  drag.currentX = x;
  drag.startTime = Date.now();
  drag.direction = null; // 由滑动方向决定
  drag.leftPage = document.getElementById('leftContent');
  drag.rightPage = document.getElementById('rightContent');

  drag.leftPage.style.transition = 'none';
  drag.rightPage.style.transition = 'none';
  document.getElementById('book').classList.add('dragging');
  document.body.style.cursor = 'grabbing';
  e.preventDefault();
}

function onDragMove(e) {
  if (!drag.active) return;
  drag.currentX = getEventX(e);
  const deltaX = drag.currentX - drag.startX;

  // 判断滑动方向
  if (deltaX < -5) drag.direction = 'forward';      // 左滑 = 前进
  else if (deltaX > 5) drag.direction = 'backward'; // 右滑 = 后退
  if (!drag.direction) return;

  const book = document.getElementById('book');
  const pageWidth = book.clientWidth / 2; // 单页宽度
  const absDelta = Math.abs(deltaX);
  const ratio = Math.min(absDelta / pageWidth, 1);

  const overlay = document.getElementById('flipOverlay');
  overlay.style.opacity = ratio * 0.7;

  if (drag.direction === 'forward') {
    // 左滑前进：右页从书脊向左翻
    drag.rightPage.style.transformOrigin = 'left center';
    drag.rightPage.style.transform = `rotateY(${-ratio * MAX_ROTATE}deg)`;
    drag.leftPage.style.transform = '';
    overlay.style.background = `radial-gradient(ellipse at 25% 50%, rgba(0,0,0,${ratio * 0.2}) 0%, transparent 70%)`;
  } else {
    // 右滑后退：左页从书脊向右翻
    drag.leftPage.style.transformOrigin = 'right center';
    drag.leftPage.style.transform = `rotateY(${ratio * MAX_ROTATE}deg)`;
    drag.rightPage.style.transform = '';
    overlay.style.background = `radial-gradient(ellipse at 75% 50%, rgba(0,0,0,${ratio * 0.2}) 0%, transparent 70%)`;
  }
  e.preventDefault();
}

async function onDragEnd(e) {
  if (!drag.active || !drag.direction) {
    drag.active = false;
    return;
  }

  const book = document.getElementById('book');
  const overlay = document.getElementById('flipOverlay');
  book.classList.remove('dragging');
  document.body.style.cursor = '';

  const deltaX = drag.currentX - drag.startX;
  const pageWidth = book.clientWidth / 2;
  const absRatio = Math.abs(deltaX / pageWidth);
  const wasQuick = (Date.now() - drag.startTime) < 250 && absRatio > 0.06;
  const shouldFlip = absRatio > DRAG_THRESHOLD || wasQuick;

  if (shouldFlip) {
    // 完成翻页
    state.isFlipping = true;
    const targetAngle = drag.direction === 'forward' ? -MAX_ROTATE : MAX_ROTATE;
    const turningPage = drag.direction === 'forward' ? drag.rightPage : drag.leftPage;

    turningPage.style.transition = 'transform 0.35s cubic-bezier(0.4, 0, 0.2, 1)';
    turningPage.style.transform = `rotateY(${targetAngle}deg)`;

    setTimeout(async () => {
      const targetDate = getTargetDate(drag.direction);
      await loadAndRender(targetDate);
      // 重置
      turningPage.style.transition = 'none';
      turningPage.style.transform = '';
      turningPage.style.transformOrigin = '';
      drag.leftPage.style.transformOrigin = '';
      drag.rightPage.style.transformOrigin = '';
      overlay.style.opacity = '0';
      overlay.style.background = '';
      state.isFlipping = false;
    }, 180);
  } else {
    // 弹回原位
    const spring = 'transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
    if (drag.direction === 'forward') {
      drag.rightPage.style.transition = spring;
      drag.rightPage.style.transform = 'rotateY(0deg)';
    } else {
      drag.leftPage.style.transition = spring;
      drag.leftPage.style.transform = 'rotateY(0deg)';
    }
    overlay.style.transition = 'opacity 0.2s';
    overlay.style.opacity = '0';
    overlay.style.background = '';

    setTimeout(() => {
      drag.leftPage.style.transition = '';
      drag.leftPage.style.transform = '';
      drag.leftPage.style.transformOrigin = '';
      drag.rightPage.style.transition = '';
      drag.rightPage.style.transform = '';
      drag.rightPage.style.transformOrigin = '';
    }, 350);
  }

  drag.active = false;
  drag.leftPage = null;
  drag.rightPage = null;
  drag.direction = null;
}

function getTargetDate(direction) {
  const idx = state.pageIndex;
  if (direction === 'backward') {
    if (idx <= 0) { const d = new Date(state.currentDate); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); }
    return state.allDates[idx - 1];
  }
  if (idx >= state.allDates.length - 1 || idx < 0) { const d = new Date(state.currentDate); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); }
  return state.allDates[idx + 1];
}

async function flipPrev() { if (state.isFlipping) return; await animateAndFlip('backward'); }
async function flipNext() { if (state.isFlipping) return; await animateAndFlip('forward'); }

function animateAndFlip(direction) {
  return new Promise(resolve => {
    state.isFlipping = true;
    const book = document.getElementById('book');
    const overlay = document.getElementById('flipOverlay');
    const animClass = direction === 'forward' ? 'flip-forward' : 'flip-backward';

    overlay.classList.add('active');
    book.classList.add(animClass);

    setTimeout(async () => {
      const targetDate = getTargetDate(direction);
      await loadAndRender(targetDate);
    }, 320);

    setTimeout(() => {
      book.classList.remove('flip-forward', 'flip-backward');
      overlay.classList.remove('active');
      state.isFlipping = false;
      resolve();
    }, 700);
  });
}

async function navigateToDate(dateStr) {
  if (state.isFlipping) return;
  await loadAndRender(dateStr);
}

async function goToday() {
  const today = new Date().toISOString().slice(0, 10);
  if (today === state.currentDate) return;
  await animateAndFlip(today > state.currentDate ? 'forward' : 'backward');
}

function updateDotNavigation() {
  const dots = document.querySelectorAll('.nav-dot');
  const total = state.allDates.length;
  const current = state.pageIndex;
  dots.forEach((dot, i) => {
    dot.style.display = i < Math.min(total, 5) ? '' : 'none';
    if (i < Math.min(total, 5)) {
      const mappedIdx = total <= 5 ? i : Math.round((i / 4) * (total - 1));
      dot.classList.toggle('active', mappedIdx === current);
      dot.onclick = () => {
        const targetDate = state.allDates[mappedIdx];
        if (targetDate !== state.currentDate) {
          animateAndFlip(targetDate > state.currentDate ? 'forward' : 'backward');
        }
      };
    }
  });
  document.getElementById('navLabel').textContent = `第 ${current + 1} / ${total} 页`;
}

// ====== 渲染 ======
function renderPages() {
  state.module === 'regular' ? renderRegular() : renderTemp();
  updatePageNumbers();
}

function updatePageNumbers() {
  const idx = state.pageIndex >= 0 ? state.pageIndex + 1 : '–';
  document.getElementById('leftPageNum').textContent = idx;
  document.getElementById('rightPageNum').textContent = '';
}

function renderRegular() {
  const d = state.diaryData || emptyDiary(state.currentDate);
  const byCriteria = {};
  (d.picks || []).forEach(p => {
    if (!byCriteria[p.criteria_type]) byCriteria[p.criteria_type] = [];
    byCriteria[p.criteria_type].push(p);
  });

  // 左页
  let left = `<div class="page-date">${fmtDate(d.date)}</div><div class="page-title">📊 选股日记</div>`;
  for (let ct = 1; ct <= 5; ct++) {
    const stocks = byCriteria[ct] || [];
    left += `<div class="criteria-block"><div class="criteria-block-title"><span class="num">${ct}</span> ${criteriaMeta[ct].title}</div>`;
    if (criteriaMeta[ct].sub) left += `<div style="font-size:10px;color:var(--page-text-light);padding-left:26px;margin-bottom:4px;">${criteriaMeta[ct].sub}</div>`;
    left += `<div class="criteria-stocks" id="stocks-${ct}">`;
    stocks.forEach(p => { left += renderStockTag(p); });
    left += `<button class="add-tag-btn" onclick="quickAddStock(${ct})" title="添加股票">+</button></div></div>`;
  }
  document.getElementById('leftContent').innerHTML = left;

  // 右页
  document.getElementById('rightContent').innerHTML = `
    <div class="summary-section">
      <h3>📊 总结复盘</h3>
      <div class="summary-field"><label>🔥 热点板块</label><textarea id="hotSectors" rows="2" onblur="autoSave()" oninput="debounceSave()">${esc(d.hot_sectors || '')}</textarea></div>
      <div class="summary-field"><label>💰 资金趋势板块</label><textarea id="capitalTrends" rows="2" onblur="autoSave()" oninput="debounceSave()">${esc(d.capital_trends || '')}</textarea></div>
      <div class="summary-field"><label>🧠 我的选股理念</label><textarea id="selectionPhilosophy" rows="2" onblur="autoSave()" oninput="debounceSave()">${esc(d.selection_philosophy || '')}</textarea></div>
      <div class="summary-field"><label>⭐ 最看好哪个票</label><input type="text" id="bestPick" onblur="autoSave()" oninput="debounceSave()" value="${esc(d.best_pick || '')}"></div>
      <div class="summary-field"><label>📋 明天怎么做</label><textarea id="tomorrowPlan" rows="2" onblur="autoSave()" oninput="debounceSave()">${esc(d.tomorrow_plan || '')}</textarea></div>
    </div>
    <div class="thoughts-section">
      <h3>💭 碎碎念</h3>
      <textarea id="thoughts" onblur="autoSave()" oninput="debounceSave()">${esc(d.thoughts || '')}</textarea>
      <div class="thoughts-images" id="thoughtsImages">${(d.images || []).map(img => img.dataUrl ? `<div style="position:relative;display:inline-block;"><img src="${img.dataUrl}" onclick="viewImage('${img.dataUrl}')"><button style="position:absolute;top:-6px;right:-6px;width:18px;height:18px;background:#e74c3c;color:#fff;border:none;border-radius:50%;font-size:10px;cursor:pointer;line-height:18px;" onclick="deleteThoughtsImage(${img.id})">×</button></div>` : '').join('')}</div>
      <button class="btn-sm" style="margin-top:6px;" onclick="uploadThoughtsImage()">📷 上传图片</button>
    </div>
    <div style="margin-top:12px;"><button class="btn-sm" onclick="openReviewModal()">📋 加载前一天好票</button></div>`;
}

function renderTemp() {
  const d = state.diaryData || emptyDiary(state.currentDate);
  document.getElementById('leftContent').innerHTML = `
    <div class="temp-page-left">
      <div class="page-date">${fmtDate(d.date)}</div>
      <div class="page-title">📝 临时日记</div>
      <input type="text" class="temp-title-input" id="tempTitle" placeholder="给这篇日记起个标题..." value="${esc(d.selection_philosophy || '')}" onblur="saveTempTitle()">
      <div class="temp-hint">📌 左边写标题，右边写内容。<br>适合灵感、市场观察、交易心得。</div>
    </div>`;
  document.getElementById('rightContent').innerHTML = `
    <div class="temp-page-right">
      <textarea id="tempContent" placeholder="在这里自由书写..." onblur="autoSave()" oninput="debounceSave()">${esc(d.thoughts || '')}</textarea>
    </div>`;
}

function renderStockTag(pick) {
  const cc = pick.performance_color || 'none';
  return `<span class="stock-tag" data-pick-id="${pick.id}" onclick="editStockTag(event, ${pick.id})">
    <span class="color-dot-mini ${cc}"></span>${esc(pick.stock_name)}
    <button class="delete-tag" onclick="deleteStockTag(event, ${pick.id})">×</button></span>`;
}

// ====== 选票操作 ======
async function quickAddStock(ct) {
  const name = prompt('输入股票名称：');
  if (!name || !name.trim()) return;
  if (!state.diaryData.picks) state.diaryData.picks = [];
  const pick = { id: Date.now(), criteria_type: ct, stock_name: name.trim(), performance_color: '', sector: '', company_description: '', hotspot_relevance: '', industry_position: '', notes: '', kline_image: '', is_review_pick: false };
  state.diaryData.picks.push(pick);
  await saveDiary();
  renderPages();
  showToast('✅ 已添加');
}

function editStockTag(event, pickId) {
  event.stopPropagation();
  const pick = (state.diaryData.picks || []).find(p => p.id === pickId);
  if (!pick) return;

  const labels = { red: '🔴 涨>6%', yellow: '🟡 0-6%', blue: '🔵 -3~0', green: '🟢 跌>3%', '': '⬜ 未标记' };
  const overlay = document.getElementById('modalOverlay');
  const content = document.getElementById('modalContent');
  content.innerHTML = `
    <button class="close-btn" onclick="closeModal()">✕</button>
    <h3>编辑: ${esc(pick.stock_name)}</h3>
    <div style="margin-bottom:10px;"><label style="font-size:12px;color:#666;">股票名称</label><input type="text" id="editName" value="${esc(pick.stock_name)}" style="width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:13px;"></div>
    <div style="margin-bottom:10px;"><label style="font-size:12px;color:#666;">表现颜色</label>
      <div class="color-options">${['red','yellow','blue','green'].map(c => `<div class="color-option ${c} ${pick.performance_color===c?'selected':''}" onclick="selectModalColor('${c}')"></div>`).join('')}</div>
      <input type="hidden" id="editColor" value="${pick.performance_color || ''}"></div>
    <div style="margin-bottom:10px;"><label style="font-size:12px;color:#666;">板块</label><input type="text" id="editSector" value="${esc(pick.sector||'')}" style="width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:13px;"></div>
    <div style="margin-bottom:10px;"><label style="font-size:12px;color:#666;">公司简介</label><textarea id="editDesc" rows="2" style="width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:13px;resize:vertical;">${esc(pick.company_description||'')}</textarea></div>
    <div style="margin-bottom:10px;"><label style="font-size:12px;color:#666;">热点关联度</label><textarea id="editHotspot" rows="2" style="width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:13px;resize:vertical;">${esc(pick.hotspot_relevance||'')}</textarea></div>
    <div style="margin-bottom:10px;"><label style="font-size:12px;color:#666;">行业位置</label><input type="text" id="editPosition" value="${esc(pick.industry_position||'')}" style="width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:13px;"></div>
    <div style="margin-bottom:10px;"><label style="font-size:12px;color:#666;">备注</label><textarea id="editNotes" rows="2" style="width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:13px;resize:vertical;">${esc(pick.notes||'')}</textarea></div>
    ${pick.kline_image ? `<div><label style="font-size:12px;color:#666;">K线图</label><img src="${pick.kline_image}" style="max-width:200px;cursor:pointer;" onclick="viewImage('${pick.kline_image}')"></div>` : ''}
    <div style="display:flex;gap:8px;margin-top:12px;"><button class="btn" onclick="savePickEdit(${pickId})">💾 保存</button><button class="btn-sm" onclick="uploadKlineForPick(${pickId})">📈 上传K线图</button></div>`;
  overlay.style.display = 'flex';
}

function selectModalColor(color) {
  document.getElementById('editColor').value = color;
  document.querySelectorAll('.color-option').forEach(o => o.classList.remove('selected'));
  document.querySelector(`.color-option.${color}`).classList.add('selected');
}

async function savePickEdit(pickId) {
  const pick = state.diaryData.picks.find(p => p.id === pickId);
  if (!pick) return;
  Object.assign(pick, {
    stock_name: document.getElementById('editName').value,
    performance_color: document.getElementById('editColor').value,
    sector: document.getElementById('editSector').value,
    company_description: document.getElementById('editDesc').value,
    hotspot_relevance: document.getElementById('editHotspot').value,
    industry_position: document.getElementById('editPosition').value,
    notes: document.getElementById('editNotes').value,
  });
  await saveDiary();
  closeModal();
  renderPages();
  showToast('💾 已保存');
}

async function deleteStockTag(event, pickId) {
  event.stopPropagation();
  if (!confirm('删除这只股票？')) return;
  state.diaryData.picks = state.diaryData.picks.filter(p => p.id !== pickId);
  await saveDiary();
  renderPages();
  showToast('🗑️ 已删除');
}

function uploadKlineForPick(pickId) {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const pick = state.diaryData.picks.find(p => p.id === pickId);
      if (pick) { pick.kline_image = reader.result; await saveDiary(); }
      showToast('📈 K线图已上传');
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

// ====== 图片 ======
async function uploadThoughtsImage() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      await saveImage(state.currentDate, reader.result);
      const images = await getImages(state.currentDate);
      state.diaryData.images = images;
      renderPages();
      showToast('📷 已上传');
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

async function deleteThoughtsImage(id) {
  if (!confirm('删除这张图片？')) return;
  await deleteImage(id);
  state.diaryData.images = state.diaryData.images.filter(i => i.id !== id);
  renderPages();
}

function viewImage(url) {
  document.getElementById('modalContent').innerHTML = `<button class="close-btn" onclick="closeModal()">✕</button><img src="${url}" style="max-width:100%;max-height:70vh;border-radius:4px;">`;
  document.getElementById('modalOverlay').style.display = 'flex';
}

// ====== 保存 ======
function debounceSave() { clearTimeout(state.saveTimer); state.saveTimer = setTimeout(autoSave, 1500); }

async function autoSave() {
  clearTimeout(state.saveTimer);
  const d = state.diaryData;
  if (state.module === 'regular') {
    d.hot_sectors = document.getElementById('hotSectors')?.value || '';
    d.capital_trends = document.getElementById('capitalTrends')?.value || '';
    d.selection_philosophy = document.getElementById('selectionPhilosophy')?.value || '';
    d.best_pick = document.getElementById('bestPick')?.value || '';
    d.tomorrow_plan = document.getElementById('tomorrowPlan')?.value || '';
    d.thoughts = document.getElementById('thoughts')?.value || '';
  } else {
    d.is_temporary = true;
    d.selection_philosophy = document.getElementById('tempTitle')?.value || '';
    d.thoughts = document.getElementById('tempContent')?.value || '';
  }
  await saveDiary();
}

async function saveDiary() {
  await putDiary(state.diaryData);
}

async function saveTempTitle() {
  const el = document.getElementById('tempTitle');
  state.diaryData.selection_philosophy = el?.value || '';
  state.diaryData.is_temporary = true;
  await saveDiary();
}

// ====== 回顾 ======
async function openReviewModal() {
  const overlay = document.getElementById('modalOverlay');
  const content = document.getElementById('modalContent');
  content.innerHTML = `<h3>📋 加载中...</h3>`;
  overlay.style.display = 'flex';

  const d = new Date(state.currentDate);
  d.setDate(d.getDate() - 1);
  const prevDate = d.toISOString().slice(0, 10);
  const prevData = await getDiary(prevDate);

  if (!prevData.picks || prevData.picks.length === 0) {
    content.innerHTML = `<button class="close-btn" onclick="closeModal()">✕</button><h3>📋 昨日验证回顾 — ${prevDate}</h3><p style="color:#999;">前一天没有选股记录。</p>
      <input type="date" id="reviewCustomDate" value="${prevDate}" style="margin-top:8px;padding:6px 10px;border:1px solid #ddd;border-radius:4px;">
      <button class="btn-sm" onclick="loadCustomReview()">加载该日期</button>`;
    return;
  }
  renderReviewContent(prevData, prevDate);
}

function loadCustomReview() {
  const dateVal = document.getElementById('reviewCustomDate').value;
  if (!dateVal) return;
  getDiary(dateVal).then(data => renderReviewContent(data, dateVal));
}

function renderReviewContent(prevData, reviewDate) {
  const order = { red: 0, yellow: 1, blue: 2, green: 3 };
  const sorted = [...prevData.picks].sort((a, b) => (order[a.performance_color] ?? 99) - (order[b.performance_color] ?? 99));
  const content = document.getElementById('modalContent');
  content.innerHTML = `
    <button class="close-btn" onclick="closeModal()">✕</button>
    <h3>📋 ${reviewDate} 验证回顾</h3>
    <p style="font-size:12px;color:#999;">共 ${prevData.picks.length} 只票，勾选加入今日观察。</p>
    <div style="max-height:350px;overflow-y:auto;">
      ${sorted.map(p => {
        const labels = { red: '🔴', yellow: '🟡', blue: '🔵', green: '🟢', '': '⬜' };
        return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #eee;font-size:13px;">
          <input type="checkbox" class="review-check" data-pick='${esc(JSON.stringify(p))}' ${p.performance_color==='red'||p.performance_color==='yellow'?'checked':''}>
          <b>${esc(p.stock_name)}</b> <span style="font-size:11px;color:#999;">${(criteriaMeta[p.criteria_type]?.title||'').slice(0,6)}</span> ${labels[p.performance_color]||''}</div>`;
      }).join('')}
    </div>
    <button class="btn" style="margin-top:12px;" onclick="addReviewPicks()">✅ 加入今日观察</button>`;
}

async function addReviewPicks() {
  const checks = document.querySelectorAll('.review-check:checked');
  let added = 0;
  for (const cb of checks) {
    const p = JSON.parse(cb.dataset.pick);
    state.diaryData.picks = state.diaryData.picks || [];
    state.diaryData.picks.push({ ...p, id: Date.now() + added, notes: `[回顾] ${p.notes||''}`, is_review_pick: true });
    added++;
  }
  await saveDiary();
  closeModal();
  renderPages();
  showToast(`✅ 已添加 ${added} 只`);
}

// ====== AI分析 ======
async function runAIAnalysis() {
  const overlay = document.getElementById('modalOverlay');
  const content = document.getElementById('modalContent');
  content.innerHTML = `<h3>🤖 分析中...</h3>`;
  overlay.style.display = 'flex';

  const d = state.diaryData;
  const byC = {};
  (d.picks||[]).forEach(p => { byC[p.criteria_type] = (byC[p.criteria_type]||0)+1; });
  const byCol = {};
  (d.picks||[]).forEach(p => { const c = p.performance_color||'未标记'; byCol[c] = (byCol[c]||0)+1; });

  const prompt = [
    `## ${state.currentDate} 选股日记分析`,
    `### 热点板块\n${d.hot_sectors||'(未记录)'}`,
    `### 资金趋势\n${d.capital_trends||'(未记录)'}`,
    `### 选股理念\n${d.selection_philosophy||'(未记录)'}`,
    `### 最看好\n${d.best_pick||'(未记录)'}`,
    `### 选股明细`,
    ...(d.picks||[]).map(p => `- [${criteriaMeta[p.criteria_type]?.title||''}] ${p.stock_name} (${p.sector||''})`),
  ].join('\n');

  content.innerHTML = `
    <button class="close-btn" onclick="closeModal()">✕</button>
    <h3>🤖 分析报告 — ${state.currentDate}</h3>
    <p><b>总选股: ${(d.picks||[]).length} 只</b></p>
    <p><b>按条件:</b></p><pre style="font-size:12px;color:#555;">${Object.entries(byC).map(([k,v])=>`  条件${k}: ${v}只`).join('\n')||'无'}</pre>
    <p><b>按表现:</b></p><pre style="font-size:12px;color:#555;">${Object.entries(byCol).map(([k,v])=>`  ${k}: ${v}只`).join('\n')||'无'}</pre>
    <p style="font-size:12px;color:#999;">📋 分析Prompt (可复制到AI模型):</p>
    <pre class="ai-result">${esc(prompt)}</pre>
    <button class="btn btn-sm" style="margin-top:8px;" onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent);showToast('📋 已复制')">📋 复制Prompt</button>`;
}

// ====== 导出 ======
function exportDiary(format) {
  const d = state.diaryData;
  if (!d) return;

  if (format === 'md') exportMarkdown(d);
  else if (format === 'html') exportHTML(d);
  else if (format === 'xlsx') exportExcel(d);
  else if (format === 'docx') exportWord(d);
}

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function exportMarkdown(d) {
  const byC = {};
  (d.picks||[]).forEach(p => { if (!byC[p.criteria_type]) byC[p.criteria_type] = []; byC[p.criteria_type].push(p); });
  let md = `# ${d.date} 每日选股日记\n\n`;
  for (let ct=1;ct<=5;ct++) {
    md += `## ${criteriaMeta[ct].title}\n\n`;
    const stocks = byC[ct] || [];
    if (stocks.length === 0) { md += '(无)\n\n'; continue; }
    md += '| 股票 | 表现 | 板块 | 公司简介 | 热点关联 | 行业位置 | 备注 |\n|------|------|------|----------|----------|----------|------|\n';
    stocks.forEach(p => {
      const emoji = {red:'🔴',yellow:'🟡',blue:'🔵',green:'🟢'}[p.performance_color]||'';
      md += `| ${p.stock_name} | ${emoji} | ${p.sector||''} | ${p.company_description||''} | ${p.hotspot_relevance||''} | ${p.industry_position||''} | ${p.notes||''} |\n`;
    });
    md += '\n';
  }
  md += `---\n\n## 📊 总结复盘\n- 热点板块: ${d.hot_sectors||''}\n- 资金趋势: ${d.capital_trends||''}\n- 选股理念: ${d.selection_philosophy||''}\n- 最看好: ${d.best_pick||''}\n- 明日计划: ${d.tomorrow_plan||''}\n`;
  if (d.thoughts) md += `\n## 💭 碎碎念\n${d.thoughts}\n`;
  downloadBlob(md, `选股日记_${d.date}.md`, 'text/markdown');
  showToast('📥 Markdown 已导出');
}

function exportHTML(d) {
  const byC = {};
  (d.picks||[]).forEach(p => { if (!byC[p.criteria_type]) byC[p.criteria_type] = []; byC[p.criteria_type].push(p); });

  let tables = '';
  for (let ct=1;ct<=5;ct++) {
    tables += `<h2>${criteriaMeta[ct].title}</h2>`;
    const stocks = byC[ct] || [];
    if (stocks.length === 0) { tables += '<p>(无)</p>'; continue; }
    tables += '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%"><tr><th>股票</th><th>表现</th><th>板块</th><th>公司简介</th><th>热点关联</th><th>行业位置</th><th>备注</th></tr>';
    stocks.forEach(p => {
      const emoji = {red:'🔴涨>6%',yellow:'🟡0-6%',blue:'🔵-3~0',green:'🟢跌>3%'}[p.performance_color]||'';
      tables += `<tr><td><b>${esc(p.stock_name)}</b></td><td>${emoji}</td><td>${esc(p.sector||'')}</td><td>${esc(p.company_description||'')}</td><td>${esc(p.hotspot_relevance||'')}</td><td>${esc(p.industry_position||'')}</td><td>${esc(p.notes||'')}</td></tr>`;
    });
    tables += '</table>';
  }
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${d.date} 选股日记</title><style>body{font-family:"PingFang SC","Microsoft YaHei",sans-serif;max-width:900px;margin:40px auto;padding:20px;color:#333;line-height:1.8}h1{border-bottom:3px solid #c0392b;padding-bottom:12px}h2{border-left:4px solid #c0392b;padding-left:12px;margin-top:24px}table{width:100%;border-collapse:collapse;margin:12px 0}th{background:#1a1a2e;color:#fff;padding:8px 10px}td{padding:6px 10px;border-bottom:1px solid #eee}.summary{background:#f0f4ff;padding:16px;border-radius:8px;margin:20px 0}.thoughts{background:#fff8e1;padding:16px;border-radius:8px;border-left:4px solid #e6a817}</style></head><body>
    <h1>${d.date} 每日选股日记${d.is_temporary?' <small>(临时日记)</small>':''}</h1>
    ${tables}
    <div class="summary"><h2>📊 总结复盘</h2><p><b>热点板块:</b> ${d.hot_sectors||'-'}</p><p><b>资金趋势:</b> ${d.capital_trends||'-'}</p><p><b>选股理念:</b> ${d.selection_philosophy||'-'}</p><p><b>最看好:</b> ${d.best_pick||'-'}</p><p><b>明日计划:</b> ${d.tomorrow_plan||'-'}</p></div>
    ${d.thoughts?`<div class="thoughts"><h2>💭 碎碎念</h2><p>${esc(d.thoughts)}</p></div>`:''}
  </body></html>`;
  downloadBlob(html, `选股日记_${d.date}.html`, 'text/html');
  showToast('📥 HTML 已导出');
}

function exportExcel(d) {
  const byC = {};
  (d.picks||[]).forEach(p => { if (!byC[p.criteria_type]) byC[p.criteria_type] = []; byC[p.criteria_type].push(p); });

  // 生成CSV (Excel可直接打开)
  let csv = '\uFEFF';
  for (let ct=1;ct<=5;ct++) {
    csv += `"${criteriaMeta[ct].title}"\n`;
    csv += '股票名称,表现,板块,公司简介,热点关联,行业位置,备注\n';
    (byC[ct]||[]).forEach(p => {
      csv += `${p.stock_name},${p.performance_color||''},${p.sector||''},${p.company_description||''},${p.hotspot_relevance||''},${p.industry_position||''},${p.notes||''}\n`;
    });
    csv += '\n';
  }
  csv += '总结复盘\n';
  csv += `热点板块,${d.hot_sectors||''}\n资金趋势,${d.capital_trends||''}\n选股理念,${d.selection_philosophy||''}\n最看好,${d.best_pick||''}\n明日计划,${d.tomorrow_plan||''}\n`;
  if (d.thoughts) csv += `碎碎念,${d.thoughts}\n`;
  downloadBlob(csv, `选股日记_${d.date}.csv`, 'text/csv');
  showToast('📥 CSV (Excel) 已导出');
}

function exportWord(d) {
  // 导出HTML伪装doc
  const html = exportHTML(d);
  downloadBlob(html, `选股日记_${d.date}.doc`, 'application/msword');
  showToast('📥 Word 已导出');
}

// ====== 工具函数 ======
function esc(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtDate(d) { if (!d) return ''; const p = d.split('-'); return `${p[0]}年${parseInt(p[1])}月${parseInt(p[2])}日`; }
function closeModal() { document.getElementById('modalOverlay').style.display = 'none'; }
function showToast(msg) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast'; toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 2800);
}

// 暴露到全局
window.switchModule = switchModule;
window.quickAddStock = quickAddStock;
window.editStockTag = editStockTag;
window.deleteStockTag = deleteStockTag;
window.savePickEdit = savePickEdit;
window.selectModalColor = selectModalColor;
window.uploadKlineForPick = uploadKlineForPick;
window.uploadThoughtsImage = uploadThoughtsImage;
window.deleteThoughtsImage = deleteThoughtsImage;
window.viewImage = viewImage;
window.autoSave = autoSave;
window.debounceSave = debounceSave;
window.saveTempTitle = saveTempTitle;
window.openReviewModal = openReviewModal;
window.loadCustomReview = loadCustomReview;
window.addReviewPicks = addReviewPicks;
window.runAIAnalysis = runAIAnalysis;
window.exportDiary = exportDiary;
window.goToday = goToday;
window.closeModal = closeModal;
window.showToast = showToast;

})();
