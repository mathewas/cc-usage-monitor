/**
 * ble.js — Shared BLE connection module
 * Exposes global: BLE.connect(), BLE.disconnect(), BLE.sendEpd(), BLE.sendRxtx(), BLE.isConnected()
 */

const BLE = (() => {
    const EPD_SERVICE  = '13187b10-eba9-a3ba-044e-83d3217d9a38';
    const EPD_CHAR_UUID = '4b646063-6264-f3a7-8941-e65356ea82fe';
    const RXTX_SERVICE = '00001f10-0000-1000-8000-00805f9b34fb';
    const RXTX_CHAR_UUID = '00001f1f-0000-1000-8000-00805f9b34fb';

    let _device = null;
    let _gatt   = null;
    let _epd    = null;
    let _rxtx   = null;
    let _reconnectTries = 0;

    // ── Callbacks (overridable by page scripts) ──────────────────────────────
    let _onLog         = (msg) => console.log('[BLE]', msg);
    let _onStateChange = (_connected) => {};

    function setLogCallback(fn)    { _onLog = fn; }
    function setStateCallback(fn)  { _onStateChange = fn; }

    function _log(msg) { _onLog(msg); }

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function isConnected() {
        return _epd !== null && !!_device?.gatt?.connected;
    }

    function _reset() {
        _gatt = null;
        _epd  = null;
        _rxtx = null;
    }

    function _onDisconnect() {
        _reset();
        _log('Đã ngắt kết nối.');
        _onStateChange(false);
    }

    async function _connectRxtx() {
        const svc = await _gatt.getPrimaryService(RXTX_SERVICE);
        _log('> Đã tìm thấy dịch vụ RxTx');
        _rxtx = await svc.getCharacteristic(RXTX_CHAR_UUID);
        _log('> Đã kết nối đặc tính RxTx');
    }

    async function _connectInner() {
        _log('Đang kết nối: ' + _device.name);
        _onStateChange('connecting');
        _gatt = await _device.gatt.connect();
        _log('> Đã tìm thấy máy chủ GATT');

        await _connectRxtx();

        try {
            const epdSvc = await _gatt.getPrimaryService(EPD_SERVICE);
            _log('> Đã tìm thấy dịch vụ EPD');
            _epd = await epdSvc.getCharacteristic(EPD_CHAR_UUID);
            _log('> Đã kết nối đặc tính EPD');
            await _epd.startNotifications();
            _epd.addEventListener('characteristicvaluechanged', (e) => {
                const hex = Array.from(new Uint8Array(e.target.value.buffer))
                    .map(b => b.toString(16).padStart(2, '0')).join('');
                _log(`> [Từ màn hình]: ${hex}`);
            });
        } catch {
            _log('> Không tìm thấy dịch vụ EPD, dùng RxTx thay thế');
            _epd = _rxtx;
        }

        _onStateChange(true);
    }

    async function _handleError(err) {
        console.error(err);
        _reset();
        if (!_device) return;
        if (_reconnectTries < 5) {
            _reconnectTries++;
            _log(`Thử kết nối lại (${_reconnectTries}/5)...`);
            try { await _connectInner(); } catch (e) { await _handleError(e); }
        } else {
            _log('Không thể kết nối, hủy bỏ.');
            _reconnectTries = 0;
            _onStateChange(false);
        }
    }

    // ── Public API ───────────────────────────────────────────────────────────

    async function connect() {
        if (isConnected()) {
            _device.gatt.disconnect();
            return;
        }
        _reconnectTries = 0;
        _onStateChange('scanning');
        try {
            _device = await navigator.bluetooth.requestDevice({
                acceptAllDevices: true,
                optionalServices: [
                    '0000221f-0000-1000-8000-00805f9b34fb',
                    RXTX_SERVICE,
                    EPD_SERVICE,
                ],
            });
            _device.addEventListener('gattserverdisconnected', _onDisconnect);
        } catch (e) {
            _onStateChange(false);
            _log('Hủy quét hoặc lỗi: ' + e.message);
            return;
        }
        try {
            await _connectInner();
        } catch (e) {
            await _handleError(e);
        }
    }

    async function disconnect() {
        if (_device?.gatt?.connected) _device.gatt.disconnect();
    }

    /** Write to EPD characteristic, with response. */
    async function sendEpd(data) {
        if (!_epd) throw new Error('Chưa kết nối BLE');
        await _epd.writeValueWithResponse(
            data instanceof Uint8Array ? data : new Uint8Array(data)
        );
    }

    /** Write to RxTx characteristic, with response. */
    async function sendRxtx(data) {
        if (!_rxtx) throw new Error('Chưa kết nối BLE');
        await _rxtx.writeValueWithResponse(
            data instanceof Uint8Array ? data : new Uint8Array(data)
        );
    }

    /** Write to RxTx, no response (E2 trên Windows ổn định hơn). */
    async function sendRxtxNoResponse(data) {
        if (!_rxtx) throw new Error('Chưa kết nối BLE');
        await _rxtx.writeValueWithoutResponse(
            data instanceof Uint8Array ? data : new Uint8Array(data)
        );
    }

    return {
        connect, disconnect, isConnected,
        sendEpd, sendRxtx, sendRxtxNoResponse, delay,
        setLogCallback, setStateCallback,
    };
})();
