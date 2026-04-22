/**
 * dashboard.js — Dashboard page logic
 * Mirrors epaper_otel_dashboard.py: build_native_payload + upload sequence
 * Payload: 139 bytes, cmd 0x06
 */

// ── Helpers (mirrors Python _fmt_tok / _tok8) ────────────────────────────────

function fmtTok(n) {
    if (n === null || n === undefined || n === '') return '-';
    n = parseInt(n) || 0;
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
    return String(n);
}

/** Encode string to 8-byte ASCII null-padded (max 7 chars). */
function tok8(s) {
    const enc = new TextEncoder();
    const bytes = new Uint8Array(8);
    const src = enc.encode(String(s).slice(0, 7));
    bytes.set(src);
    return bytes;
}

/** Encode string to fixed-length null-padded ASCII bytes. */
function strBytes(s, len) {
    const enc = new TextEncoder();
    const out = new Uint8Array(len);
    const src = enc.encode(String(s || '').slice(0, len - 1));
    out.set(src);
    return out;
}

/** Clamp integer to uint8 range. */
function u8(v) { return Math.max(0, Math.min(255, Math.round(parseFloat(v) || 0))); }

// ── Payload builder (139 bytes, mirrors build_native_payload) ────────────────

/**
 * @param {object} f - form fields:
 *   pct5h, pct7d, costUsd,
 *   requests, sessions,
 *   tokIn, tokOut, tokCacheR, tokCacheW,
 *   battPct (number|null),
 *   email, reset5h, reset7d
 * @returns {Uint8Array} 139-byte payload
 */
function buildPayload(f) {
    const buf = new ArrayBuffer(139);
    const view = new DataView(buf);
    const u8arr = new Uint8Array(buf);

    let off = 0;

    // [0] cmd
    view.setUint8(off++, 0x06);
    // [1] 5h pct
    view.setUint8(off++, u8(f.pct5h));
    // [2] 7d pct
    view.setUint8(off++, u8(f.pct7d));
    // [3..6] cost float32 LE
    view.setFloat32(off, parseFloat(f.costUsd) || 0, true);
    off += 4;
    // [7..14] requests fmt char[8]
    u8arr.set(tok8(fmtTok(f.requests)), off); off += 8;
    // [15..22] sessions fmt char[8]
    u8arr.set(tok8(fmtTok(f.sessions)), off); off += 8;
    // [23..30] tokens_input char[8]
    u8arr.set(tok8(fmtTok(f.tokIn)), off); off += 8;
    // [31..38] tokens_output char[8]
    u8arr.set(tok8(fmtTok(f.tokOut)), off); off += 8;
    // [39..46] tokens_cache_read char[8]
    u8arr.set(tok8(fmtTok(f.tokCacheR)), off); off += 8;
    // [47..54] tokens_cache_write char[8]
    u8arr.set(tok8(fmtTok(f.tokCacheW)), off); off += 8;
    // [55] batt_pct (0xFF = unknown)
    view.setUint8(off++, f.battPct !== null && f.battPct !== undefined ? u8(f.battPct) : 0xFF);
    // [56..87] email char[32]
    u8arr.set(strBytes(f.email, 32), off); off += 32;
    // [88..104] last_sync char[17] "YYYY-MM-DD HH:MM"
    const syncStr = toLocalInput(new Date()).replace('T', ' ');
    u8arr.set(strBytes(syncStr, 17), off); off += 17;
    // [105..121] reset_5h char[17]
    u8arr.set(strBytes(f.reset5h, 17), off); off += 17;
    // [122..138] reset_7d char[17]
    u8arr.set(strBytes(f.reset7d, 17), off); off += 17;

    if (off !== 139) throw new Error(`Payload length error: ${off}`);
    return u8arr;
}

// ── BLE send sequence (mirrors upload_native) ────────────────────────────────

async function sendNativeDashboard(fields) {
    const payload = buildPayload(fields);
    addLog(`Gửi 0x06 (${payload.length} bytes)...`);
    await BLE.sendEpd(payload);
    addLog('> Đã gửi 0x06');

    await BLE.delay(50);

    addLog('Gửi E1 03 (chế độ dashboard)...');
    await BLE.sendRxtx([0xE1, 0x03]);
    addLog('> Đã gửi E1 03');

    await BLE.delay(300);

    addLog('Gửi E2 (force refresh)...');
    await BLE.sendRxtxNoResponse([0xE2]);
    addLog('> Xong!');
}

// ── Test data generators ─────────────────────────────────────────────────────

/** "YYYY-MM-DDTHH:MM" string for datetime-local input from a Date object. */
function toLocalInput(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randFloat(min, max, dec) { return parseFloat((Math.random() * (max - min) + min).toFixed(dec)); }

/**
 * Fill form with logically coherent random values.
 * - 5h pct: 0–105  (session can overflow slightly)
 * - 7d pct: 0–100
 * - reset_5h: now + 0..5 hours
 * - reset_7d: now + 0..7 days
 * - cost correlates loosely with token volume
 */
function fillRandom() {
    const now = Date.now();

    const pct5h = randInt(0, 105);
    const pct7d = randInt(0, 100);

    const reset5h = new Date(now + randInt(0, 5 * 60) * 60 * 1000);
    const reset7d = new Date(now + randInt(0, 7 * 24 * 60) * 60 * 1000);

    const tokIn    = randInt(0, 2_000_000);
    const tokOut   = randInt(0, 500_000);
    const tokCacheR = randInt(0, 1_000_000);
    const tokCacheW = randInt(0, 300_000);
    const totalTok = tokIn + tokOut + tokCacheR + tokCacheW;
    const costUsd  = parseFloat((totalTok / 1_000_000 * randFloat(0.5, 3.0, 2)).toFixed(3));

    const requests = randInt(0, 500);
    const sessions = randInt(1, Math.max(1, Math.floor(requests / 10)));

    const users   = ['alice', 'bob', 'carol', 'dave', 'eve', 'frank', 'grace'];
    const domains = ['gmail.com', 'outlook.com', 'test.local', 'example.com'];
    const email = `${users[randInt(0, users.length-1)]}${randInt(10,99)}@${domains[randInt(0, domains.length-1)]}`;

    setField('f-pct5h',   pct5h);
    setField('f-pct7d',   pct7d);
    setField('f-reset5h', toLocalInput(reset5h));
    setField('f-reset7d', toLocalInput(reset7d));
    setField('f-cost',    costUsd);
    setField('f-requests', requests);
    setField('f-sessions', sessions);
    setField('f-tok-in',  tokIn);
    setField('f-tok-out', tokOut);
    setField('f-tok-cr',  tokCacheR);
    setField('f-tok-cw',  tokCacheW);
    setField('f-email',   email);

    // Sync sliders
    syncSliderFromValue('sl-pct5h', 'f-pct5h');
    syncSliderFromValue('sl-pct7d', 'f-pct7d');

    addLog(`Random: 5h=${pct5h}% 7d=${pct7d}% cost=$${costUsd} req=${requests} sess=${sessions}`);
}

/**
 * Bump current form values upward.
 * 5h/7d pct: always increase; wrap to 0 only when exceeding max.
 * All other values: always increase, never decrease.
 */
function bumpValues() {
    // Auto-seed with random data if form is still at defaults
    const isEmpty = parseInt(getField('f-tok-in') || 0) === 0
                 && parseInt(getField('f-requests') || 0) === 0
                 && parseFloat(getField('f-cost') || 0) === 0;
    if (isEmpty) {
        addLog('Form trống — tự động tạo dữ liệu ban đầu...');
        fillRandom();
        return;
    }

    // 5h: +1..3, wrap to 0 if > 105
    let pct5h = parseInt(getField('f-pct5h') || 0) + randInt(1, 3);
    if (pct5h > 105) pct5h = 0;

    // 7d: +1..2, wrap to 0 if > 100
    let pct7d = parseInt(getField('f-pct7d') || 0) + randInt(1, 2);
    if (pct7d > 100) pct7d = 0;

    setField('f-pct5h', pct5h);
    setField('f-pct7d', pct7d);
    syncSliderFromValue('sl-pct5h', 'f-pct5h');
    syncSliderFromValue('sl-pct7d', 'f-pct7d');

    // Always-positive increments for the rest
    const addN = (id, delta) => setField(id, parseInt(getField(id) || 0) + delta);
    const addF = (id, delta) => setField(id, parseFloat(getField(id) || 0) + delta);

    addF('f-cost',     randFloat(0.001, 0.05, 3));
    addN('f-requests', randInt(1, 5));
    addN('f-sessions', 1);
    addN('f-tok-in',   randInt(500, 20_000));
    addN('f-tok-out',  randInt(100, 5_000));
    addN('f-tok-cr',   randInt(100, 10_000));
    addN('f-tok-cw',   randInt(50, 2_000));

    // Normalize float display
    const cost = parseFloat(getField('f-cost'));
    setField('f-cost', isNaN(cost) ? 0 : cost.toFixed(3));

    addLog(`Bump: 5h=${pct5h}% 7d=${pct7d}% cost=$${getField('f-cost')} req=${getField('f-requests')}`);
}

// ── Form field helpers ────────────────────────────────────────────────────────

function setField(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
}
function getField(id) {
    return document.getElementById(id)?.value ?? '0';
}
function syncSliderFromValue(sliderId, numId) {
    const slider = document.getElementById(sliderId);
    const num    = document.getElementById(numId);
    if (slider && num) slider.value = num.value;
}

// ── UI helpers ───────────────────────────────────────────────────────────────

function addLog(msg) {
    const box = document.getElementById('log-output');
    if (!box) return;
    const now = new Date();
    const t = [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map(n => String(n).padStart(2, '0')).join(':');
    box.textContent += `[${t}] ${msg}\n`;
    box.scrollTop = box.scrollHeight;
}

function updateConnectBtn(state) {
    const btn = document.getElementById('connect-btn');
    const dot = document.getElementById('conn-dot');
    if (!btn) return;
    if (state === 'scanning') {
        btn.textContent = 'Đang quét...';
        btn.disabled = true;
        if (dot) { dot.className = 'dot dot-gray'; }
    } else if (state === 'connecting') {
        btn.textContent = 'Đang kết nối...';
        btn.disabled = true;
        if (dot) { dot.className = 'dot dot-gray'; }
    } else if (state === true) {
        btn.textContent = 'Ngắt kết nối';
        btn.disabled = false;
        if (dot) { dot.className = 'dot dot-green'; }
        addLog('Kết nối thành công.');
    } else {
        btn.textContent = 'Kết nối thiết bị';
        btn.disabled = false;
        if (dot) { dot.className = 'dot dot-red'; }
    }
}

function readForm() {
    const g = (id) => document.getElementById(id)?.value ?? '';
    return {
        pct5h:    g('f-pct5h'),
        pct7d:    g('f-pct7d'),
        costUsd:  g('f-cost'),
        requests: g('f-requests'),
        sessions: g('f-sessions'),
        tokIn:    g('f-tok-in'),
        tokOut:   g('f-tok-out'),
        tokCacheR: g('f-tok-cr'),
        tokCacheW: g('f-tok-cw'),
        battPct:  null,
        email:    g('f-email'),
        reset5h:  g('f-reset5h').replace('T', ' '),
        reset7d:  g('f-reset7d').replace('T', ' '),
    };
}

// ── Slider sync ──────────────────────────────────────────────────────────────

function syncSlider(sliderId, numId) {
    const slider = document.getElementById(sliderId);
    const num    = document.getElementById(numId);
    if (!slider || !num) return;
    slider.addEventListener('input', () => { num.value = slider.value; });
    num.addEventListener('input', () => {
        let v = Math.max(0, Math.min(255, parseInt(num.value) || 0));
        slider.value = v;
        num.value = v;
    });
}

// ── Server sync ──────────────────────────────────────────────────────────────

/**
 * Fetch today's aggregated stats from dashboard_server.py and populate the form.
 * Daily stats come from OTel events; rate limits (5h/7d) come from
 * claude_rate_limits.json (written by Claude Code's statusLine).
 */
async function fetchFromServer() {
    const url = (document.getElementById('server-url')?.value || 'http://localhost:4318').replace(/\/+$/, '');
    const endpoint = url + '/api/dashboard';
    addLog(`Lấy dữ liệu từ ${endpoint} ...`);
    const res = await fetch(endpoint, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = await res.json();

    // Daily stats (from OTel events)
    setField('f-cost',     (s.cost_usd || 0).toFixed(3));
    setField('f-requests', s.requests || 0);
    setField('f-sessions', s.sessions || 0);
    setField('f-tok-in',   s.tokens_input || 0);
    setField('f-tok-out',  s.tokens_output || 0);
    setField('f-tok-cr',   s.tokens_cache_read || 0);
    setField('f-tok-cw',   s.tokens_cache_write || 0);
    if (s.user_email) setField('f-email', s.user_email);

    // Rate limits (from claude_rate_limits.json)
    if (typeof s.pct_5h === 'number') {
        setField('f-pct5h', s.pct_5h);
        syncSliderFromValue('sl-pct5h', 'f-pct5h');
    }
    if (typeof s.pct_7d === 'number') {
        setField('f-pct7d', s.pct_7d);
        syncSliderFromValue('sl-pct7d', 'f-pct7d');
    }
    if (s.reset_5h) setField('f-reset5h', s.reset_5h);
    if (s.reset_7d) setField('f-reset7d', s.reset_7d);

    addLog(`✓ OTel: ${s.date} — $${s.cost_usd} · ${s.requests} req · ${s.sessions} sess`);
    if (s.rate_limits_path) {
        addLog(`✓ Rate limits: 5h=${s.pct_5h}% 7d=${s.pct_7d}%`);
    } else {
        addLog('(Không tìm thấy claude_rate_limits.json — 5h/7d = 0)');
    }
    if (!s.requests) addLog('(Chưa có OTel request nào hôm nay.)');
}

// ── Auto sync ────────────────────────────────────────────────────────────────

let autoSyncTimer = null;

async function runAutoSync() {
    if (!BLE.isConnected()) {
        addLog('Auto sync: mất kết nối BLE, dừng lại.');
        stopAutoSync();
        return;
    }
    try {
        await fetchFromServer();
        await sendNativeDashboard(readForm());
    } catch (e) {
        addLog('Auto sync lỗi: ' + e.message);
    }
}

function startAutoSync() {
    if (!BLE.isConnected()) { addLog('Chưa kết nối BLE!'); return; }
    const intervalSec = parseInt(document.getElementById('sync-interval')?.value || 60);
    if (isNaN(intervalSec) || intervalSec < 5) {
        addLog('Thời gian cập nhật tối thiểu 5 giây.');
        return;
    }
    const btn = document.getElementById('auto-sync-btn');
    const input = document.getElementById('sync-interval');
    btn.textContent = '⏹ Stop';
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-ghost');
    input.disabled = true;
    addLog(`Auto sync bắt đầu — mỗi ${intervalSec}s`);
    runAutoSync();
    autoSyncTimer = setInterval(runAutoSync, intervalSec * 1000);
}

function stopAutoSync() {
    if (autoSyncTimer) { clearInterval(autoSyncTimer); autoSyncTimer = null; }
    const btn = document.getElementById('auto-sync-btn');
    const input = document.getElementById('sync-interval');
    if (btn) { btn.textContent = '▶ Start'; btn.classList.remove('btn-ghost'); btn.classList.add('btn-primary'); }
    if (input) input.disabled = false;
    addLog('Auto sync đã dừng.');
}

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    BLE.setLogCallback(addLog);
    BLE.setStateCallback(updateConnectBtn);

    document.getElementById('connect-btn')?.addEventListener('click', () => BLE.connect());
    document.getElementById('random-btn')?.addEventListener('click', fillRandom);
    document.getElementById('bump-btn')?.addEventListener('click', bumpValues);

    document.getElementById('fetch-btn')?.addEventListener('click', async () => {
        const btn = document.getElementById('fetch-btn');
        btn.disabled = true;
        try { await fetchFromServer(); }
        catch (e) { addLog('Lỗi fetch: ' + e.message + ' (server đã chạy chưa?)'); }
        finally { btn.disabled = false; }
    });

    document.getElementById('fetch-send-btn')?.addEventListener('click', async () => {
        if (!BLE.isConnected()) { addLog('Chưa kết nối BLE!'); return; }
        const btn = document.getElementById('fetch-send-btn');
        btn.disabled = true;
        try {
            await fetchFromServer();
            await sendNativeDashboard(readForm());
        } catch (e) {
            addLog('Lỗi: ' + e.message);
        } finally {
            btn.disabled = false;
        }
    });

    document.getElementById('send-btn')?.addEventListener('click', async () => {
        if (!BLE.isConnected()) { addLog('Chưa kết nối BLE!'); return; }
        const btn = document.getElementById('send-btn');
        btn.disabled = true;
        try {
            await sendNativeDashboard(readForm());
        } catch (e) {
            addLog('Lỗi: ' + e.message);
        } finally {
            btn.disabled = false;
        }
    });

    document.getElementById('auto-sync-btn')?.addEventListener('click', () => {
        if (autoSyncTimer) stopAutoSync(); else startAutoSync();
    });

    syncSlider('sl-pct5h', 'f-pct5h');
    syncSlider('sl-pct7d', 'f-pct7d');

    updateConnectBtn(false);
});
