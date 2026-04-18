/**
 * clock.js — Logic cho trang Lịch / Đồng hồ
 *
 * Commands (RxTx characteristic):
 *   DD + unix(4B BE) + year(2B) + month(1B) + day(1B) + weekday(1B)  → sync time
 *   E1 01  → calendar mode  (+ E2)
 *   E1 02  → clock mode     (+ E2)
 *   E2     → force refresh
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

function hexToBytes(hex) {
    const bytes = [];
    for (let c = 0; c < hex.length; c += 2)
        bytes.push(parseInt(hex.substr(c, 2), 16));
    return new Uint8Array(bytes);
}

function intToHex(n, byteLen = 4) {
    return n.toString(16).padStart(byteLen * 2, '0');
}

// ── Time helpers ─────────────────────────────────────────────────────────────

/**
 * Returns current local time shifted by hourOffset, plus calendar fields.
 * Mirrors getUnixTime() from index_vi.html.
 */
function getAdjustedTime(hourOffset) {
    const offset = parseInt(hourOffset) || 0;
    const unixNow = Math.round(Date.now() / 1000)
        + offset * 3600
        - new Date().getTimezoneOffset() * 60;
    const d = new Date((unixNow + new Date().getTimezoneOffset() * 60) * 1000);
    return {
        unixNow,
        displayStr: d.toLocaleTimeString('vi-VN') + '  ' + d.toLocaleDateString('vi-VN'),
        year:  d.getFullYear(),
        month: d.getMonth() + 1,
        day:   d.getDate(),
        week:  d.getDay() || 7,   // 1=Mon … 7=Sun
    };
}

// ── BLE commands ─────────────────────────────────────────────────────────────

async function cmdSyncTime() {
    const offset = document.getElementById('hour-offset')?.value ?? 0;
    const t = getAdjustedTime(offset);

    const hex = 'dd'
        + intToHex(t.unixNow, 4)
        + intToHex(t.year,    2)
        + intToHex(t.month,   1)
        + intToHex(t.day,     1)
        + intToHex(t.week,    1);

    addLog(`Đồng bộ: ${t.displayStr}`);
    addLog(`Bytes: ${hex}`);
    await BLE.sendRxtx(hexToBytes(hex));
    await BLE.delay(100);
    await BLE.sendRxtx(hexToBytes('e2'));
    addLog('> Xong');
}

async function cmdSetMode(modeByte) {
    const names = { '01': 'Lịch', '02': 'Đồng hồ' };
    addLog(`Chuyển sang chế độ: ${names[modeByte] ?? modeByte}`);
    await BLE.sendRxtx(hexToBytes('e1' + modeByte));
    await BLE.delay(300);
    await BLE.sendRxtx(hexToBytes('e2'));
    addLog('> Xong');
}

async function cmdRefresh() {
    addLog('Làm mới màn hình...');
    await BLE.sendRxtx(hexToBytes('e2'));
    addLog('> Xong');
}

// ── UI helpers ────────────────────────────────────────────────────────────────

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
    if (state === 'scanning' || state === 'connecting') {
        btn.textContent = state === 'scanning' ? 'Đang quét...' : 'Đang kết nối...';
        btn.disabled = true;
        if (dot) dot.className = 'dot dot-gray';
    } else if (state === true) {
        btn.textContent = 'Ngắt kết nối';
        btn.disabled = false;
        if (dot) dot.className = 'dot dot-green';
        addLog('Kết nối thành công.');
        startClock();
    } else {
        btn.textContent = 'Kết nối thiết bị';
        btn.disabled = false;
        if (dot) dot.className = 'dot dot-red';
        stopClock();
    }
}

// ── Live clock preview ────────────────────────────────────────────────────────

let _clockTimer = null;

function startClock() {
    if (_clockTimer) return;
    _clockTimer = setInterval(updateClockPreview, 1000);
    updateClockPreview();
}

function stopClock() {
    clearInterval(_clockTimer);
    _clockTimer = null;
}

function updateClockPreview() {
    const offset = parseInt(document.getElementById('hour-offset')?.value) || 0;
    const t = getAdjustedTime(offset);
    const el = document.getElementById('clock-preview');
    if (el) el.textContent = t.displayStr;
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    BLE.setLogCallback(addLog);
    BLE.setStateCallback(updateConnectBtn);

    document.getElementById('connect-btn')
        ?.addEventListener('click', () => BLE.connect());

    document.getElementById('sync-btn')
        ?.addEventListener('click', async () => {
            if (!BLE.isConnected()) { addLog('Chưa kết nối BLE!'); return; }
            const btn = document.getElementById('sync-btn');
            btn.disabled = true;
            try { await cmdSyncTime(); }
            catch (e) { addLog('Lỗi: ' + e.message); }
            finally { btn.disabled = false; }
        });

    document.getElementById('mode-calendar-btn')
        ?.addEventListener('click', async () => {
            if (!BLE.isConnected()) { addLog('Chưa kết nối BLE!'); return; }
            try { await cmdSetMode('01'); }
            catch (e) { addLog('Lỗi: ' + e.message); }
        });

    document.getElementById('mode-clock-btn')
        ?.addEventListener('click', async () => {
            if (!BLE.isConnected()) { addLog('Chưa kết nối BLE!'); return; }
            try { await cmdSetMode('02'); }
            catch (e) { addLog('Lỗi: ' + e.message); }
        });

    document.getElementById('refresh-btn')
        ?.addEventListener('click', async () => {
            if (!BLE.isConnected()) { addLog('Chưa kết nối BLE!'); return; }
            try { await cmdRefresh(); }
            catch (e) { addLog('Lỗi: ' + e.message); }
        });

    // Update preview when offset changes
    document.getElementById('hour-offset')
        ?.addEventListener('input', updateClockPreview);

    updateConnectBtn(false);
    updateClockPreview();
    startClock();   // preview chạy ngay cả khi chưa kết nối
});
