/* XR-Objects — web demo client
 *
 * Mirrors the Unity XR-Objects interaction model:
 *   camera frame -> object detection -> anchored object -> tap -> radial context menu
 *   -> information / ask / compare / note / timer / save
 *
 * All Gemini calls go through /api/* so the API key stays server-side.
 * All persistence goes to Supabase (objects, notes, timers, saved_items, object_actions).
 */

const CFG = { supabaseUrl: '', supabaseKey: '', gemini: false, model: '' };
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  sessionId: null,
  objects: [],
  selected: null,
  detecting: false,
  autoDetect: false,
  longPressMode: false,
  circleMode: false,
  saving: false,
  autoTimer: null,
  streaming: false,
  lastFrameAt: 0,
  timers: [],        // { objectId, kind, endsAt, el }
  chat: [],          // { role, text }
  savedCount: 0
};

/* ------------------------------------------------------------------ helpers */
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `o-${Math.random().toString(36).slice(2)}`);

function toast(message, kind = '') {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.append(el);
  setTimeout(() => {
    el.style.transition = 'opacity 220ms ease, transform 220ms ease';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 240);
  }, 3200);
}

function setStatus(kind, text) {
  const pill = $('#statusPill');
  const label = $('#statusText');
  if (pill) pill.className = `status-pill ${kind}`;
  if (label) label.textContent = text;
}

const ICONS = {
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="7.6" r=".9" fill="currentColor" stroke="none"/></svg>',
  ask: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4L3.5 21l1.2-4.4A8.4 8.4 0 1 1 21 11.5Z"/></svg>',
  compare: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h10M4 7l3-3M4 7l3 3"/><path d="M20 17H10M20 17l-3-3M20 17l-3 3"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h9l5 5v11H5Z"/><path d="M14 4v5h5"/><path d="M8.5 13.5h7M8.5 16.5h4"/></svg>',
  timer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13.5" r="7.5"/><path d="M12 10v3.8l2.4 1.6"/><path d="M9.5 3h5"/></svg>',
  save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h12v17l-6-4.2L6 21Z"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.9l1.3-2h6.6l1.3 2h1.9A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5Z"/><circle cx="12" cy="13" r="3.6"/></svg>',
  scan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5A1.5 1.5 0 0 1 18.5 20H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M4 12h16"/></svg>',
  grow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4h-4"/></svg>',
  frames: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M9 5v14"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12 21 4l-7 17-3-7Z"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11Z"/><circle cx="12" cy="10" r="2.4"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 12.5 5 5L20 6.5"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.5 6"/><path d="M20 4v5h-5"/></svg>'
};

/* --------------------------------------------------------------- supabase */
const SB = {
  get ready() { return Boolean(CFG.supabaseUrl && CFG.supabaseKey); },

  headers(extra = {}) {
    return {
      apikey: CFG.supabaseKey,
      Authorization: `Bearer ${CFG.supabaseKey}`,
      'Content-Type': 'application/json',
      ...extra
    };
  },

  async call(path, { method = 'GET', body, prefer } = {}) {
    if (!this.ready) return null;
    const res = await fetch(`${CFG.supabaseUrl}/rest/v1/${path}`, {
      method,
      headers: this.headers(prefer ? { Prefer: prefer } : {}),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Supabase ${res.status} ${detail.slice(0, 160)}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  },

  async startSession() {
    if (!this.ready) return null;
    try {
      const rows = await this.call('sessions', {
        method: 'POST',
        body: [{ device: deviceLabel(), user_agent: navigator.userAgent.slice(0, 400) }],
        prefer: 'return=representation'
      });
      return rows?.[0]?.id ?? null;
    } catch (err) {
      console.warn('[xr] supabase session failed', err.message);
      return null;
    }
  },

  async saveObject(obj) {
    if (!this.ready) return;
    try {
      const rows = await this.call('objects', {
        method: 'POST',
        body: [{
          session_id: state.sessionId,
          label: obj.label,
          category: obj.category || null,
          confidence: obj.confidence ?? null,
          bbox: obj.bbox,
          source: obj.source,
          metadata: obj.metadata || null
        }],
        prefer: 'return=representation'
      });
      if (rows?.[0]?.id) obj.dbId = rows[0].id;
    } catch (err) {
      console.warn('[xr] supabase object failed', err.message);
    }
  },

  async updateObjectMetadata(dbId, metadata) {
    if (!this.ready || !dbId) return;
    await this.call(`objects?id=eq.${dbId}`, { method: 'PATCH', body: { metadata } }).catch(() => {});
  },

  async logAction(action, input, output, payload) {
    if (!this.ready) return;
    await this.call('object_actions', {
      method: 'POST',
      body: [{
        object_id: payload?.objectDbId || null,
        session_id: state.sessionId,
        action,
        input: input ?? null,
        output: output ?? null,
        payload: payload || null
      }],
      prefer: 'return=minimal'
    }).catch(() => {});
  },

  async saveNote(objectDbId, body, anchor) {
    if (!this.ready) return;
    await this.call('notes', {
      method: 'POST',
      body: [{ object_id: objectDbId || null, body, anchor }],
      prefer: 'return=minimal'
    }).catch(() => {});
  },

  async saveTimer(objectDbId, kind, seconds) {
    if (!this.ready) return;
    await this.call('timers', {
      method: 'POST',
      body: [{ object_id: objectDbId || null, kind, duration_seconds: seconds }],
      prefer: 'return=minimal'
    }).catch(() => {});
  },

  async saveItem(objectDbId, label) {
    if (!this.ready) return;
    await this.call('saved_items', {
      method: 'POST',
      body: [{ object_id: objectDbId || null, label, list: 'default' }],
      prefer: 'return=minimal'
    }).catch(() => {});
  },

  async feed() {
    if (!this.ready) return [];
    return (await this.call('object_feed?select=*&order=created_at.desc&limit=40')) || [];
  }
};

function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Mac/i.test(ua) ? 'macOS' : /Win/i.test(ua) ? 'Windows' : 'Unknown';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : 'Browser';
  return `${os} · ${br}`;
}

/* -------------------------------------------------------------- camera */
async function ensureCamera() {
  const video = $('#video');
  if (state.streaming) return true;
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Trình duyệt này không hỗ trợ camera. Dùng Chrome/Safari bản mới, hoặc tải ảnh lên.', 'err');
    return false;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    state.streaming = true;
    video.classList.remove('hidden');
    $('#stageBg').classList.add('hidden');
    setStatus('live', 'Camera trực tiếp');
    $('#btnCamera').classList.add('active');
    $('#btnCamera span').textContent = 'Camera bật';
    return true;
  } catch (err) {
    const msg = err.name === 'NotAllowedError'
      ? 'Bạn đã từ chối quyền camera. Cấp quyền trong cài đặt trình duyệt rồi thử lại.'
      : err.name === 'NotFoundError'
        ? 'Không tìm thấy camera. Bạn vẫn có thể tải ảnh lên để thử.'
        : 'Không mở được camera. Bạn vẫn có thể tải ảnh lên để thử.';
    toast(msg, 'err');
    return false;
  }
}

function stopCamera() {
  const video = $('#video');
  const stream = video.srcObject;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
  state.streaming = false;
  video.classList.add('hidden');
  $('#stageBg').classList.remove('hidden');
  $('#btnCamera').classList.remove('active');
  $('#btnCamera span').textContent = 'Camera';
  setStatus(CFG.gemini ? 'live' : 'demo', CFG.gemini ? 'Sẵn sàng' : 'Chế độ demo');
}

/** Grab the current frame as a JPEG data URL, downscaled for latency + payload. */
function grabFrame(video) {
  const v = video || $('#video');
  const vw = v.videoWidth || 1280;
  const vh = v.videoHeight || 720;
  const maxW = 720;
  const scale = Math.min(1, maxW / vw);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vw * scale);
  canvas.height = Math.round(vh * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.72);
}

/** Crop a normalized bbox region out of the current video frame. */
function cropFrame(obj, pad = 0.04) {
  const v = $('#video');
  if (!v.videoWidth) {
    const img = $('#stageImage');
    if (!img?.src) return null;
    const c = document.createElement('canvas');
    const w = img.naturalWidth, h = img.naturalHeight;
    c.width = Math.round(w * clamp(obj.bbox.w + pad * 2, 0.02, 1));
    c.height = Math.round(h * clamp(obj.bbox.h + pad * 2, 0.02, 1));
    c.getContext('2d').drawImage(
      img,
      Math.round(clamp(obj.bbox.x - pad) * w),
      Math.round(clamp(obj.bbox.y - pad) * h),
      c.width, c.height, 0, 0, c.width, c.height
    );
    return c.toDataURL('image/jpeg', 0.8);
  }
  const vw = v.videoWidth, vh = v.videoHeight;
  const x = clamp(obj.bbox.x - pad) * vw;
  const y = clamp(obj.bbox.y - pad) * vh;
  const w = clamp(obj.bbox.w + pad * 2) * vw;
  const h = clamp(obj.bbox.h + pad * 2) * vh;
  const c = document.createElement('canvas');
  c.width = Math.round(w);
  c.height = Math.round(h);
  c.getContext('2d').drawImage(v, x, y, w, h, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
}

/* -------------------------------------------------------------- detection */
async function detectNow({ silent = false } = {}) {
  if (state.detecting) return;
  if (!CFG.gemini) {
    loadDemoObjects();
    if (!silent) toast('Chưa có GEMINI_API_KEY — đang hiển thị vật thể mẫu.', '');
    return;
  }

  let image;
  if (state.streaming) {
    image = grabFrame();
  } else if ($('#stageImage')?.src) {
    image = $('#stageImage').src;
  } else {
    if (!silent) toast('Bật camera hoặc tải ảnh lên trước đã.', 'err');
    return;
  }

  state.detecting = true;
  const scanFx = $('#scanFx');
  if (scanFx) scanFx.style.display = 'block';
  $('#btnDetect').disabled = true;
  $('#btnDetect').classList.add('active');

  try {
    const res = await fetch('/api/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Nhận diện thất bại');

    const found = data.objects || [];
    if (!found.length) {
      if (!silent) toast('Không thấy vật thể nào rõ ràng. Thử lại gần hơn.', '');
      return;
    }

    let added = 0;
    for (const o of found) {
      // skip near-duplicates of objects we already have
      const dup = state.objects.some(
        (e) => e.label === o.label && Math.abs(e.bbox.x - o.bbox.x) < 0.09 && Math.abs(e.bbox.y - o.bbox.y) < 0.09
      );
      if (dup) continue;
      const obj = {
        id: uid(),
        label: o.label,
        category: guessCategory(o.label),
        confidence: o.confidence,
        bbox: o.bbox,
        source: 'detector',
        metadata: null,
        notes: [],
        actions: 0
      };
      state.objects.push(obj);
      added += 1;
      SB.saveObject(obj);
      enrichLabel(obj);
    }
    render();
    if (!silent) {
      toast(added ? `Đã neo ${added} vật thể` : 'Không có vật thể mới', added ? 'ok' : '');
    }
  } catch (err) {
    if (!silent) toast(err.message, 'err');
  } finally {
    state.detecting = false;
    const scanFx = $('#scanFx');
    if (scanFx) scanFx.style.display = 'none';
    $('#btnDetect').disabled = false;
    $('#btnDetect').classList.remove('active');
  }
}

/** Follow-up: ask Gemini for the branded label of one specific object. */
async function enrichLabel(obj) {
  const crop = cropFrame(obj);
  if (!crop) return;
  try {
    const res = await fetch('/api/label', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: crop })
    });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.label) return;
    obj.metadata = { ...(obj.metadata || {}), name: data.label, model: data.model };
    obj.thumb = crop;
    render();
    SB.updateObjectMetadata(obj.dbId, { name: data.label, class: obj.label });
  } catch {
    /* label enrichment is best-effort */
  }
}

function guessCategory(label = '') {
  const l = label.toLowerCase();
  if (/cup|mug|glass|bottle|can|bowl|wine|tea|coffee/.test(l)) return 'drinkware';
  if (/laptop|keyboard|mouse|monitor|phone|headphone|tablet|camera/.test(l)) return 'electronics';
  if (/book|notebook|paper|pen/.test(l)) return 'stationery';
  if (/plant|flower|vase|pot/.test(l)) return 'plant';
  if (/apple|orange|banana|food|hot dog|sandwich|fruit/.test(l)) return 'food';
  if (/bag|backpack|handbag|wallet/.test(l)) return 'bag';
  return 'object';
}

/* --------------------------------------------------- manual registration */
function addManualObject(x, y, source) {
  const size = 0.22;
  const obj = {
    id: uid(),
    label: source === 'circle' ? 'vật thể khoanh tay' : 'vật thể nhấn giữ',
    category: 'object',
    confidence: null,
    bbox: {
      x: clamp(x - size / 2),
      y: clamp(y - size / 2),
      w: size,
      h: size
    },
    source,
    metadata: null,
    notes: [],
    actions: 0
  };
  state.objects.push(obj);
  render();
  SB.saveObject(obj);
  enrichLabel(obj);
  toast(source === 'circle' ? 'Đã đăng ký vật thể bằng vòng tròn' : 'Đã đăng ký vật thể bằng nhấn giữ', 'ok');
}

/* -------------------------------------------------------------- rendering */
function render() {
  const overlay = $('#overlay');
  const video = $('#video');
  const mirrored = video.classList.contains('mirrored');

  // clear previous boxes but keep timers/pins
  $$('.box, .chip.timer', overlay).forEach((n) => n.remove());

  state.objects.forEach((obj, i) => {
    const el = document.createElement('button');
    el.className = `box ${obj.source !== 'detector' ? 'manual' : ''} ${state.selected?.id === obj.id ? 'selected' : ''}`;
    el.style.left = `${obj.bbox.x * 100}%`;
    el.style.top = `${obj.bbox.y * 100}%`;
    el.style.width = `${obj.bbox.w * 100}%`;
    el.style.height = `${obj.bbox.h * 100}%`;
    el.dataset.id = obj.id;
    el.setAttribute('aria-label', obj.metadata?.name || obj.label);

    const name = obj.metadata?.name || obj.label;
    el.innerHTML = `
      <span class="tag">${escapeHtml(name)}</span>
      ${obj.notes.length ? `<span class="pin">${obj.notes.length}</span>` : ''}
      ${obj.actions ? `<span class="badge">${obj.actions}</span>` : ''}
    `;
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      selectObject(obj, el);
    });
    overlay.append(el);
    obj.el = el;
    void i;
    void mirrored;
  });

  // re-attach running timers
  state.timers.forEach((t) => {
    const obj = state.objects.find((o) => o.id === t.objectId);
    if (!obj) return;
    if (!t.el) {
      t.el = document.createElement('div');
      t.el.className = 'chip timer';
    }
    if (t.el.parentNode !== overlay) overlay.append(t.el);
    positionTimerChip(t, obj);
  });

  updateDock();
  updateDeskStats();
}

function positionTimerChip(t, obj) {
  if (!t.el) return;
  t.el.style.left = `${(obj.bbox.x + obj.bbox.w / 2) * 100}%`;
  t.el.style.top = `${(obj.bbox.y + obj.bbox.h) * 100 + 1}%`;
  const remain = Math.max(0, t.endsAt - Date.now());
  const mm = String(Math.floor(remain / 60000)).padStart(2, '0');
  const ss = String(Math.floor((remain % 60000) / 1000)).padStart(2, '0');
  t.el.textContent = `⏱ ${mm}:${ss}`;
  if (remain === 0) {
    t.el.textContent = '⏱ hết giờ';
    t.el.style.borderColor = 'rgba(255,123,123,.6)';
  }
}

function escapeHtml(s = '') {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function selectObject(obj, el) {
  state.selected = obj;
  $$('.box').forEach((b) => b.classList.toggle('selected', b.dataset.id === obj.id));
  openRadial(obj);
  if (navigator.vibrate) navigator.vibrate(8);
  void el;
}

/* ------------------------------------------------------------ radial menu */
const ACTIONS = [
  { key: 'info', icon: 'info', label: 'Thông tin', tone: 'mint', run: actionInfo },
  { key: 'ask', icon: 'ask', label: 'Hỏi', tone: 'mint', run: actionAsk },
  { key: 'compare', icon: 'compare', label: 'So sánh', tone: 'violet', run: actionCompare },
  { key: 'note', icon: 'note', label: 'Ghi chú', tone: 'blue', run: actionNote },
  { key: 'timer', icon: 'timer', label: 'Hẹn giờ', tone: 'amber', run: actionTimer },
  { key: 'save', icon: 'save', label: 'Lưu lại', tone: 'amber', run: actionSave }
];

function openRadial(obj) {
  closeRadial();
  const overlay = $('#overlay');
  const host = document.createElement('div');
  host.className = 'radial';
  const cx = (obj.bbox.x + obj.bbox.w / 2) * 100;
  const cy = (obj.bbox.y + obj.bbox.h / 2) * 100;
  host.style.left = `${cx}%`;
  host.style.top = `${cy}%`;

  const stageRect = $('#stage').getBoundingClientRect();
  const radius = Math.min(stageRect.width, stageRect.height) * 0.19;
  const r = Math.max(72, Math.min(radius, 118));

  const core = document.createElement('div');
  core.className = 'radial-core';
  core.innerHTML = ICONS.close;
  core.title = 'Đóng menu';
  core.addEventListener('click', (e) => { e.stopPropagation(); closeRadial(); });
  host.append(core);

  const n = ACTIONS.length;
  ACTIONS.forEach((action, i) => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    const btn = document.createElement('button');
    btn.className = `action tone-${action.tone}`;
    btn.style.left = `${Math.cos(angle) * r}px`;
    btn.style.top = `${Math.sin(angle) * r}px`;
    btn.style.animationDelay = `${i * 26}ms`;
    btn.innerHTML = `${ICONS[action.icon]}<span class="label">${action.label}</span>`;
    btn.title = action.label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeRadial();
      action.run(obj);
    });
    host.append(btn);
  });

  overlay.append(host);
  requestAnimationFrame(() => host.classList.remove('closing'));
}

function closeRadial() {
  $$('.radial').forEach((el) => {
    el.classList.add('closing');
    setTimeout(() => el.remove(), 190);
  });
}

$('#stage')?.addEventListener('click', (e) => {
  if (e.target.closest('.box') || e.target.closest('.radial') || e.target.closest('.chip')) return;
  state.selected = null;
  $$('.box').forEach((b) => b.classList.remove('selected'));
  closeRadial();
});

/* ---------------------------------------------------------------- sheets */
function openSheet(id) {
  const wrap = document.getElementById(id);
  if (!wrap) return;
  wrap.classList.add('open');
  wrap.setAttribute('aria-hidden', 'false');
}
function closeSheet(wrap) {
  const el = typeof wrap === 'string' ? document.getElementById(wrap) : wrap;
  if (!el) return;
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
}
$$('.sheet-wrap').forEach((wrap) => {
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) closeSheet(wrap);
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeSheet($('.sheet-wrap.open'));
    closeRadial();
  }
});

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Lỗi ${res.status}`);
  return data;
}

/* ----------------------------------------------------------- action: info */
async function actionInfo(obj) {
  obj.actions += 1;
  const name = obj.metadata?.name || obj.label;
  $('#infoTitle').textContent = name;
  $('#infoSub').textContent = `${obj.category} · ${obj.source === 'detector' ? 'nhận diện tự động' : 'đăng ký thủ công'}`;
  $('#infoBody').innerHTML = '<div class="skeleton" style="width:92%"></div><div class="skeleton" style="width:78%"></div><div class="skeleton" style="width:64%"></div>';
  const thumb = obj.thumb || cropFrame(obj);
  $('#infoThumb').src = thumb || '';
  $('#infoThumb').style.display = thumb ? 'block' : 'none';
  openSheet('sheetInfo');
  render();

  if (!CFG.gemini) {
    $('#infoBody').innerHTML = missKeyNotice('thông tin chi tiết') ||
      `<div class="prose">${escapeHtml(demoInfo(name))}</div>`;
    return;
  }

  try {
    const data = await apiPost('/api/describe', { image: cropFrame(obj), label: name });
    $('#infoBody').innerHTML = `<div class="prose">${escapeHtml(data.text)}</div>`;
    obj.metadata = { ...(obj.metadata || {}), info: data.text };
    SB.logAction('info', name, data.text, { objectDbId: obj.dbId, model: data.model, latencyMs: data.latencyMs });
  } catch (err) {
    $('#infoBody').innerHTML = `<div class="prose" style="color:var(--muted)">Không lấy được thông tin: ${escapeHtml(err.message)}</div>`;
  }
}

function missKeyNotice(feature) {
  if (CFG.gemini) return '';
  return `<div class="tagpill amber" style="margin-bottom:12px">${ICONS.gear} Chế độ demo — chưa cấu hình GEMINI_API_KEY</div>
    <div class="prose" style="color:var(--muted)">Đang hiển thị nội dung mẫu cho ${escapeHtml(feature)}. Thêm biến môi trường <b>GEMINI_API_KEY</b> trong Vercel để bật AI thật.</div>`;
}

function demoInfo(name) {
  return `${name} — nội dung mẫu.\n\nTrong bản Unity gốc, mục này gọi Gemini kèm Google Search để trả về 2–3 câu thông tin thực tế (thương hiệu, thông số, giá, xuất xứ…). Bản web dùng đúng prompt đó.`;
}

/* ------------------------------------------------------------ action: ask */
async function actionAsk(obj) {
  obj.actions += 1;
  render();
  const name = obj.metadata?.name || obj.label;
  state.chat = [];
  $('#askTitle').textContent = `Hỏi về ${name}`;
  $('#askSub').textContent = 'Hỏi bất cứ điều gì về vật thể đang ở trước mặt';
  $('#askChat').innerHTML = '';
  $('#askInput').value = '';
  renderChat();
  openSheet('sheetAsk');
  setTimeout(() => $('#askInput').focus(), 260);
}

function renderChat() {
  const host = $('#askChat');
  host.innerHTML = '';
  state.chat.forEach((m) => {
    const b = document.createElement('div');
    b.className = `bubble ${m.role === 'user' ? 'user' : 'ai'}`;
    b.textContent = m.text;
    host.append(b);
  });
  host.scrollTop = host.scrollHeight;
}

function addTyping() {
  const host = $('#askChat');
  const b = document.createElement('div');
  b.className = 'bubble ai typing';
  b.id = 'typingBubble';
  b.innerHTML = '<i></i><i></i><i></i>';
  host.append(b);
  host.scrollTop = host.scrollHeight;
}

async function submitAsk(question) {
  const obj = state.selected;
  if (!obj || !question.trim()) return;
  const q = question.trim();
  state.chat.push({ role: 'user', text: q });
  renderChat();
  $('#askInput').value = '';
  addTyping();

  const name = obj.metadata?.name || obj.label;
  if (!CFG.gemini) {
    $('#typingBubble')?.remove();
    state.chat.push({ role: 'ai', text: demoAnswer(q, name) });
    renderChat();
    return;
  }

  try {
    const data = await apiPost('/api/ask', {
      image: cropFrame(obj),
      label: name,
      question: q,
      history: state.chat.slice(-4)
    });
    $('#typingBubble')?.remove();
    state.chat.push({ role: 'ai', text: data.text });
    renderChat();
    SB.logAction('ask', q, data.text, { objectDbId: obj.dbId, model: data.model, latencyMs: data.latencyMs });
  } catch (err) {
    $('#typingBubble')?.remove();
    state.chat.push({ role: 'ai', text: `Không trả lời được: ${err.message}` });
    renderChat();
  }
}

function demoAnswer(q, name) {
  return `(Chế độ demo) Bạn hỏi "${q}" về ${name}. Khi GEMINI_API_KEY được cấu hình, câu trả lời sẽ do Gemini 2.0 Flash tạo, có Google Search để tra giá/thông số hiện tại.`;
}

/* -------------------------------------------------------- action: compare */
async function actionCompare(obj) {
  obj.actions += 1;
  render();
  const others = state.objects.filter((o) => o.id !== obj.id);
  if (others.length === 0) {
    toast('Cần ít nhất 2 vật thể. Nhấn "Nhận diện" thêm một lần nữa.', 'err');
    return;
  }
  const pool = [obj, ...others].slice(0, 4);
  $('#compareTitle').textContent = `So sánh ${pool.length} vật thể`;
  $('#compareSub').textContent = pool.map((o) => o.metadata?.name || o.label).join(' · ');
  $('#compareBody').innerHTML = '<div class="skeleton" style="width:94%"></div><div class="skeleton" style="width:86%"></div><div class="skeleton" style="width:70%"></div>';
  const grid = $('#compareThumbs');
  grid.innerHTML = pool.map((o) => `<img class="thumb" style="width:calc(50% - 4px);max-height:110px" src="${o.thumb || cropFrame(o) || ''}" alt="">`).join('');
  openSheet('sheetCompare');

  if (!CFG.gemini) {
    $('#compareBody').innerHTML = missKeyNotice('so sánh') || '<div class="prose">Demo</div>';
    return;
  }

  try {
    const data = await apiPost('/api/compare', {
      images: pool.map((o) => cropFrame(o)),
      labels: pool.map((o) => o.metadata?.name || o.label)
    });
    $('#compareBody').innerHTML = `<div class="prose">${escapeHtml(data.text)}</div>`;
    SB.logAction('compare', pool.map((o) => o.label).join(','), data.text, { objectDbId: obj.dbId, model: data.model });
  } catch (err) {
    $('#compareBody').innerHTML = `<div class="prose" style="color:var(--muted)">Không so sánh được: ${escapeHtml(err.message)}</div>`;
  }
}

/* --------------------------------------------------------- action: notes */
function actionNote(obj) {
  const name = obj.metadata?.name || obj.label;
  $('#noteTitle').textContent = `Ghi chú cho ${name}`;
  $('#noteSub').textContent = 'Ghi chú được neo vào vật thể và lưu lại trong scene';
  $('#noteInput').value = '';
  $('#noteList').innerHTML = obj.notes.length
    ? obj.notes.map((n) => `<div class="list-row"><div class="ic">${ICONS.note}</div><div class="txt"><b>${escapeHtml(n.body)}</b><span>${new Date(n.at).toLocaleString('vi-VN')}</span></div></div>`).join('')
    : '<div class="empty">Chưa có ghi chú nào cho vật thể này.</div>';
  openSheet('sheetNote');
  setTimeout(() => $('#noteInput').focus(), 260);
}

function saveNote(obj, body) {
  const note = { body, at: Date.now() };
  obj.notes.push(note);
  SB.saveNote(obj.dbId, body, { x: obj.bbox.x, y: obj.bbox.y });
  SB.logAction('note', body, null, { objectDbId: obj.dbId });
  render();
  toast('Đã thêm ghi chú', 'ok');
}

/* -------------------------------------------------------------- timers */
function actionTimer(obj) {
  const name = obj.metadata?.name || obj.label;
  $('#timerTitle').textContent = `Hẹn giờ cho ${name}`;
  $('#timerSub').textContent = 'Đồng hồ đếm ngược neo ngay trên vật thể';
  openSheet('sheetTimer');
}

function startTimer(obj, minutes) {
  const seconds = minutes * 60;
  const t = { objectId: obj.id, kind: 'countdown', endsAt: Date.now() + seconds * 1000, el: null };
  state.timers = state.timers.filter((x) => x.objectId !== obj.id).concat(t);
  SB.saveTimer(obj.dbId, 'countdown', seconds);
  SB.logAction('countdown', `${minutes} phút`, null, { objectDbId: obj.dbId });
  render();
  closeSheet('sheetTimer');
  toast(`Đã hẹn giờ ${minutes} phút`, 'ok');
}

setInterval(() => {
  if (!state.timers.length) return;
  const now = Date.now();
  state.timers.forEach((t) => {
    const obj = state.objects.find((o) => o.id === t.objectId);
    if (obj) positionTimerChip(t, obj);
  });
  const done = state.timers.filter((t) => t.endsAt <= now && !t.notified);
  done.forEach((t) => {
    t.notified = true;
    toast('Hết giờ!', 'ok');
    if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
  });
}, 1000);

/* -------------------------------------------------------------- save later */
async function actionSave(obj) {
  const name = obj.metadata?.name || obj.label;
  const item = {
    label: name,
    meta: obj.metadata,
    bbox: obj.bbox,
    at: Date.now()
  };
  state.saved = [...(state.saved || []), item];
  state.savedCount += 1;
  obj.actions += 1;
  await SB.saveItem(obj.dbId, name);
  await SB.logAction('save', name, null, { objectDbId: obj.dbId });
  render();
  toast(`Đã lưu "${name}"`, 'ok');
}

/* ------------------------------------------------------------- scene log */
async function openLog() {
  const body = $('#logBody');
  body.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  openSheet('sheetLog');

  const local = state.objects.map((o) => ({
    label: o.metadata?.name || o.label,
    category: o.category,
    source: o.source,
    created_at: new Date(o.createdAt || Date.now()).toISOString(),
    action_count: o.actions
  }));

  let remote = [];
  try {
    remote = await SB.feed();
  } catch {
    remote = [];
  }

  const rows = (remote.length ? remote : local);
  if (!rows.length) {
    body.innerHTML = `<div class="empty">Chưa có vật thể nào trong scene.<br>Bật camera rồi nhấn <b>Nhận diện</b> để bắt đầu.</div>`;
    return;
  }
  body.innerHTML = `
    <div class="meta-row">
      <span class="tagpill mint">${rows.length} vật thể</span>
      <span class="tagpill">${SB.ready ? 'Supabase: đã kết nối' : 'Supabase: chưa cấu hình'}</span>
    </div>
    <div class="list">
      ${rows.map((r) => `
        <div class="list-row">
          <div class="ic">${ICONS.pin}</div>
          <div class="txt">
            <b>${escapeHtml(r.label || 'object')}</b>
            <span>${escapeHtml(r.category || 'object')} · ${escapeHtml(r.source || 'detector')}${r.action_count ? ` · ${r.action_count} hành động` : ''}</span>
          </div>
          <div class="t">${new Date(r.created_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</div>
        </div>`).join('')}
    </div>`;
}

/* --------------------------------------------------------------- demo mode */
const DEMO_OBJECTS = [
  { label: 'cup', bbox: { x: 0.14, y: 0.42, w: 0.2, h: 0.28 }, confidence: 0.92 },
  { label: 'bottle', bbox: { x: 0.44, y: 0.3, w: 0.16, h: 0.46 }, confidence: 0.88 },
  { label: 'laptop', bbox: { x: 0.66, y: 0.52, w: 0.28, h: 0.24 }, confidence: 0.81 },
  { label: 'potted plant', bbox: { x: 0.03, y: 0.14, w: 0.18, h: 0.26 }, confidence: 0.76 }
];

const DEMO_NAMES = {
  cup: 'Ceramic Mug',
  bottle: 'Arizona Iced Tea',
  laptop: 'MacBook Pro 14"',
  'potted plant': 'Golden Pothos'
};

function loadDemoObjects() {
  if (state.objects.length) {
    // cycle a fresh set so "Nhận diện" always feels responsive
    state.objects = [];
  }
  DEMO_OBJECTS.forEach((d, i) => {
    setTimeout(() => {
      const obj = {
        id: uid(),
        label: d.label,
        category: guessCategory(d.label),
        confidence: d.confidence,
        bbox: d.bbox,
        source: 'detector',
        metadata: { name: DEMO_NAMES[d.label] || d.label },
        notes: [],
        actions: 0,
        createdAt: Date.now()
      };
      state.objects.push(obj);
      render();
      SB.saveObject(obj);
    }, i * 140);
  });
}

/* ------------------------------------------------------------------ dock */
function updateDock() {
  const btnDetect = $('#btnDetect');
  if (btnDetect) btnDetect.querySelector('span').textContent = 'Nhận diện';

  const auto = $('#btnAuto');
  auto.classList.toggle('active', state.autoDetect);
  auto.setAttribute('aria-pressed', String(state.autoDetect));

  const lp = $('#btnLongPress');
  lp.classList.toggle('active', state.longPressMode);
  lp.classList.toggle('warm', state.longPressMode);

  const ci = $('#btnCircle');
  ci.classList.toggle('active', state.circleMode);
  ci.classList.toggle('warm', state.circleMode);
}

function updateDeskStats() {
  const row = $('#deskStats');
  if (!row) return;
  row.innerHTML = `
    <span class="tagpill mint">${state.objects.length} vật thể</span>
    <span class="tagpill">${state.timers.length} hẹn giờ</span>
    <span class="tagpill">${state.objects.reduce((n, o) => n + o.notes.length, 0)} ghi chú</span>
    <span class="tagpill">${SB.ready ? 'Supabase ✓' : 'Supabase —'}</span>`;
}

/* --------------------------------------------------------- long press / circle */
function setupGestures() {
  const stage = $('#stage');
  let pressTimer = null;
  let start = null;

  stage.addEventListener('pointerdown', (e) => {
    if (!state.longPressMode) return;
    if (e.target.closest('.box,.radial,.chip')) return;
    start = { x: e.clientX, y: e.clientY };
    pressTimer = setTimeout(() => {
      const rect = stage.getBoundingClientRect();
      addManualObject((start.x - rect.left) / rect.width, (start.y - rect.top) / rect.height, 'longpress');
      pressTimer = null;
    }, 550);
  });

  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) =>
    stage.addEventListener(ev, () => {
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = null;
    })
  );

  // circle drawing
  const canvas = $('#circleCanvas');
  const ctx = canvas.getContext('2d');
  let drawing = false;
  let points = [];

  function resizeCanvas() {
    const r = stage.getBoundingClientRect();
    canvas.width = r.width;
    canvas.height = r.height;
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  stage.addEventListener('pointerdown', (e) => {
    if (!state.circleMode) return;
    if (e.target.closest('.box,.radial,.chip')) return;
    drawing = true;
    points = [{ x: e.clientX, y: e.clientY }];
  });

  stage.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    points.push({ x: e.clientX, y: e.clientY });
    const rect = stage.getBoundingClientRect();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(255,207,107,0.95)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = p.x - rect.left, y = p.y - rect.top;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });

  ['pointerup', 'pointercancel'].forEach((ev) =>
    stage.addEventListener(ev, () => {
      if (!drawing) return;
      drawing = false;
      const rect = stage.getBoundingClientRect();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (points.length > 8) {
        const xs = points.map((p) => p.x);
        const ys = points.map((p) => p.y);
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minY = Math.min(...ys), maxY = Math.max(...ys);
        const obj = {
          id: uid(),
          label: 'vật thể khoanh tay',
          category: 'object',
          confidence: null,
          bbox: {
            x: (minX - rect.left) / rect.width,
            y: (minY - rect.top) / rect.height,
            w: (maxX - minX) / rect.width,
            h: (maxY - minY) / rect.height
          },
          source: 'circle',
          metadata: null,
          notes: [],
          actions: 0
        };
        state.objects.push(obj);
        render();
        SB.saveObject(obj);
        enrichLabel(obj);
        toast('Đã đăng ký vật thể bằng vòng tròn', 'ok');
      }
      points = [];
    })
  );
}

/* ------------------------------------------------------------------ boot */
async function boot() {
  // runtime config
  try {
    const res = await fetch('/api/config');
    Object.assign(CFG, await res.json());
  } catch {
    /* keep defaults */
  }

  const gem = CFG.gemini;
  setStatus(gem ? 'live' : 'demo', gem ? 'Sẵn sàng' : 'Chế độ demo');
  $('#modelTag').textContent = gem ? CFG.model : 'demo data';
  $('#barSupabase').textContent = SB.ready ? 'Đã kết nối — dữ liệu được lưu' : 'Chưa cấu hình (chỉ lưu trên máy)';
  $('#barGemini').textContent = gem ? `Đã bật — ${CFG.model}` : 'Chưa cấu hình — chạy chế độ demo';

  if (!gem) {
    const banner = $('#demoBanner');
    if (banner) banner.style.display = 'block';
  }

  state.sessionId = await SB.startSession();
  setupGestures();

  // wiring
  $('#btnCamera').addEventListener('click', async () => {
    if (state.streaming) stopCamera(); else await ensureCamera();
  });

  $('#btnDetect').addEventListener('click', () => detectNow());

  $('#btnAuto').addEventListener('click', async () => {
    state.autoDetect = !state.autoDetect;
    updateDock();
    if (state.autoDetect) {
      if (!state.streaming) await ensureCamera();
      await detectNow({ silent: true });
      state.autoTimer = setInterval(() => detectNow({ silent: true }), 6000);
      toast('Tự động nhận diện mỗi 6 giây', 'ok');
    } else {
      clearInterval(state.autoTimer);
      state.autoTimer = null;
      toast('Đã tắt tự động nhận diện', '');
    }
  });

  $('#btnLongPress').addEventListener('click', () => {
    state.longPressMode = !state.longPressMode;
    if (state.longPressMode) state.circleMode = false;
    showGestureHint();
    updateDock();
  });

  $('#btnCircle').addEventListener('click', () => {
    state.circleMode = !state.circleMode;
    if (state.circleMode) state.longPressMode = false;
    showGestureHint();
    updateDock();
  });

  $('#btnLog').addEventListener('click', openLog);
  $('#btnSettings').addEventListener('click', () => openSheet('sheetSettings'));
  $('#btnUpload').addEventListener('click', () => $('#fileInput').click());

  $('#fileInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    let img = $('#stageImage');
    if (!img) {
      img = document.createElement('img');
      img.id = 'stageImage';
      img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1';
      $('#stage').insertBefore(img, $('#overlay'));
    }
    img.src = url;
    img.style.display = 'block';
    $('#video').classList.add('hidden');
    $('#stageBg').classList.add('hidden');
    setStatus(CFG.gemini ? 'live' : 'demo', 'Ảnh đã tải lên');
    toast('Đã tải ảnh — nhấn Nhận diện', '');
    state.objects = [];
    render();
  });

  // notes
  $('#noteSubmit').addEventListener('click', () => {
    const body = $('#noteInput').value.trim();
    if (!body || !state.selected) return;
    saveNote(state.selected, body);
    actionNote(state.selected);
  });

  // timers
  $$('#sheetTimer .pill[data-min]').forEach((pill) => {
    pill.addEventListener('click', () => {
      const min = Number(pill.dataset.min);
      if (state.selected) startTimer(state.selected, min);
    });
  });

  // ask
  $('#askSend').addEventListener('click', () => submitAsk($('#askInput').value));
  $('#askInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitAsk($('#askInput').value);
    }
  });
  $$('#sheetAsk .pill[data-q]').forEach((pill) => {
    pill.addEventListener('click', () => submitAsk(pill.dataset.q));
  });

  // settings: clear scene
  $('#btnClear').addEventListener('click', () => {
    state.objects = [];
    state.timers = [];
    state.selected = null;
    render();
    closeSheet('sheetSettings');
    toast('Đã xoá scene trên thiết bị', '');
  });

  $('#btnMirror').addEventListener('click', (e) => {
    $('#video').classList.toggle('mirrored');
    e.currentTarget.classList.toggle('on');
  });

  window.addEventListener('resize', () => render());

  // seed a hint once
  setTimeout(() => {
    if (!state.objects.length) {
      toast('Nhấn "Nhận diện" để bắt đầu — hoặc bật Tự động', '');
    }
  }, 1200);
}

function showGestureHint() {
  $$('.gesture-hint').forEach((n) => n.remove());
  if (!state.longPressMode && !state.circleMode) return;
  const hint = document.createElement('div');
  hint.className = 'gesture-hint';
  hint.textContent = state.longPressMode
    ? 'Nhấn giữ ~0,5s lên vật thể để đăng ký thủ công'
    : 'Khoanh một vòng quanh vật thể để đăng ký thủ công';
  $('#stage').append(hint);
  setTimeout(() => hint.remove(), 5000);
}

document.addEventListener('DOMContentLoaded', boot);
