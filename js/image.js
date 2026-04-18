/**
 * image.js — Dithering, canvas-to-bytes, BLE upload
 * Used by both the image transfer tab and the editor tab (send directly).
 */

// ── Utility ──────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

function hexToBytes(hex) {
    const bytes = [];
    for (let c = 0; c < hex.length; c += 2)
        bytes.push(parseInt(hex.substr(c, 2), 16));
    return new Uint8Array(bytes);
}
function bytesToHex(arr) {
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}
function intToHex(n, byteLen = 4) {
    return n.toString(16).padStart(byteLen * 2, '0');
}

// ── Screen size map ───────────────────────────────────────────────────────────

const SCREEN_SIZES = {
    '4.2':   { w: 400, h: 300, label: '4.2" Truyền ảnh' },
    '4.2sm': { w: 280, h: 100, label: '4.2" Lịch nhỏ' },
    '7.5':   { w: 800, h: 480, label: '7.5" Truyền ảnh' },
    '7.5sm': { w: 400, h: 180, label: '7.5" Lịch nhỏ' },
    '2.9':   { w: 296, h: 128, label: '2.9" Truyền ảnh' },
    '2.13':  { w: 212, h: 128, label: '2.13" Truyền ảnh' },
    '2.13hd':{ w: 250, h: 128, label: '2.13" HD' },
};

// ── Canvas → bytes (mirrors index_vi.html canvas2bytes / canvas2bytes_bw) ────

function canvas2bytes(canvas, type = 'bw') {
    const ctx = canvas.getContext('2d');
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const arr = [];
    let buf = [];
    for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
            const i = (canvas.width * y + x) * 4;
            const bit = type !== 'bwr'
                ? (d[i] > 0 && d[i+1] > 0 && d[i+2] > 0 ? 1 : 0)
                : (d[i] > 0 && d[i+1] === 0 && d[i+2] === 0 ? 1 : 0);
            buf.push(bit);
            if (buf.length === 8) { arr.push(parseInt(buf.join(''), 2)); buf = []; }
        }
    }
    return arr;
}

// Rotated scan order for 2.9" display
function canvas2bytes_bw(canvas, type = 'bw') {
    const ctx = canvas.getContext('2d');
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const arr = [];
    let buf = [];
    for (let x = canvas.width - 1; x >= 0; x--) {
        for (let y = 0; y < canvas.height; y++) {
            const i = (canvas.width * y + x) * 4;
            const bit = type !== 'bwr'
                ? (d[i] > 0 && d[i+1] > 0 && d[i+2] > 0 ? 1 : 0)
                : (d[i] > 0 && d[i+1] === 0 && d[i+2] === 0 ? 1 : 0);
            buf.push(bit);
            if (buf.length === 8) { arr.push(parseInt(buf.join(''), 2)); buf = []; }
        }
    }
    return arr;
}

// ── Image adjustments ─────────────────────────────────────────────────────────

function applyAdjustments(canvas, { brightness, contrast, saturation }) {
    const ctx = canvas.getContext('2d');
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = id.data;
    for (let i = 0; i < data.length; i += 4) {
        let r = data[i], g = data[i+1], b = data[i+2];
        if (brightness !== 0) {
            const f = brightness / 100;
            r = clamp(r + 255 * f, 0, 255);
            g = clamp(g + 255 * f, 0, 255);
            b = clamp(b + 255 * f, 0, 255);
        }
        if (contrast !== 100) {
            const f = (contrast + 100) / 100;
            const adj = (1 - f) * 128;
            r = clamp(r * f + adj, 0, 255);
            g = clamp(g * f + adj, 0, 255);
            b = clamp(b * f + adj, 0, 255);
        }
        if (saturation !== 100) {
            const f = saturation / 100;
            const gray = 0.299 * r + 0.587 * g + 0.114 * b;
            r = clamp(gray + (r - gray) * f, 0, 255);
            g = clamp(gray + (g - gray) * f, 0, 255);
            b = clamp(gray + (b - gray) * f, 0, 255);
        }
        data[i] = r; data[i+1] = g; data[i+2] = b;
    }
    ctx.putImageData(id, 0, 0);
}

// ── Dithering ─────────────────────────────────────────────────────────────────

function addErr(data, idx, err, f) {
    data[idx]   = clamp(data[idx]   + err * f, 0, 255);
    data[idx+1] = clamp(data[idx+1] + err * f, 0, 255);
    data[idx+2] = clamp(data[idx+2] + err * f, 0, 255);
}
function addColorErr(data, idx, rE, gE, bE, f) {
    data[idx]   = clamp(data[idx]   + rE * f, 0, 255);
    data[idx+1] = clamp(data[idx+1] + gE * f, 0, 255);
    data[idx+2] = clamp(data[idx+2] + bE * f, 0, 255);
}

// BW dithering algorithms
const BW_ALGOS = {
    none(ctx, w, h, thr) {
        const id = ctx.getImageData(0, 0, w, h);
        const d = id.data;
        for (let i = 0; i < d.length; i += 4) {
            const v = (0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2]) < thr ? 0 : 255;
            d[i] = d[i+1] = d[i+2] = v;
        }
        ctx.putImageData(id, 0, 0);
    },
    floydsteinberg(ctx, w, h, thr, diff) {
        const id = ctx.getImageData(0, 0, w, h); const d = id.data;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const idx = (y*w+x)*4;
            const gray = 0.299*d[idx] + 0.587*d[idx+1] + 0.114*d[idx+2];
            const nv = gray < thr ? 0 : 255;
            const err = (gray - nv) * diff;
            d[idx] = d[idx+1] = d[idx+2] = nv;
            if (x+1 < w) addErr(d, idx+4, err, 7/16);
            if (y+1 < h) {
                if (x-1 >= 0) addErr(d, idx+w*4-4, err, 3/16);
                addErr(d, idx+w*4, err, 5/16);
                if (x+1 < w) addErr(d, idx+w*4+4, err, 1/16);
            }
        }
        ctx.putImageData(id, 0, 0);
    },
    atkinson(ctx, w, h, thr, diff) {
        const id = ctx.getImageData(0, 0, w, h); const d = id.data;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const idx = (y*w+x)*4;
            const gray = 0.299*d[idx] + 0.587*d[idx+1] + 0.114*d[idx+2];
            const nv = gray < thr ? 0 : 255;
            const err = (gray - nv) * diff;
            d[idx] = d[idx+1] = d[idx+2] = nv;
            if (x+1 < w) addErr(d, idx+4, err, 1/8);
            if (x+2 < w) addErr(d, idx+8, err, 1/8);
            if (y+1 < h) {
                if (x-1 >= 0) addErr(d, idx+w*4-4, err, 1/8);
                addErr(d, idx+w*4, err, 1/8);
                if (x+1 < w) addErr(d, idx+w*4+4, err, 1/8);
            }
            if (y+2 < h) addErr(d, idx+w*8, err, 1/8);
        }
        ctx.putImageData(id, 0, 0);
    },
    bayer(ctx, w, h, thr, diff) {
        const map = [[15,135,45,165],[195,75,225,105],[60,180,30,150],[240,120,210,90]];
        const id = ctx.getImageData(0, 0, w, h); const d = id.data;
        for (let i = 0; i < d.length; i += 4) {
            const x = (i/4)%w, y = Math.floor((i/4)/w);
            const t = clamp(thr*(1+(map[x%4][y%4]-128)/128*diff), 0, 255);
            const v = (0.299*d[i]+0.587*d[i+1]+0.114*d[i+2]) < t ? 0 : 255;
            d[i] = d[i+1] = d[i+2] = v;
        }
        ctx.putImageData(id, 0, 0);
    },
    stucki(ctx, w, h, thr, diff) {
        const id = ctx.getImageData(0, 0, w, h); const d = id.data;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const idx = (y*w+x)*4;
            const gray = 0.299*d[idx]+0.587*d[idx+1]+0.114*d[idx+2];
            const nv = gray < thr ? 0 : 255; const err = (gray-nv)*diff;
            d[idx] = d[idx+1] = d[idx+2] = nv;
            if (x+1<w) addErr(d,idx+4,err,8/42); if (x+2<w) addErr(d,idx+8,err,4/42);
            if (y+1<h) {
                if (x-2>=0) addErr(d,idx+w*4-8,err,2/42); if (x-1>=0) addErr(d,idx+w*4-4,err,4/42);
                addErr(d,idx+w*4,err,8/42);
                if (x+1<w) addErr(d,idx+w*4+4,err,4/42); if (x+2<w) addErr(d,idx+w*4+8,err,2/42);
            }
            if (y+2<h) {
                if (x-2>=0) addErr(d,idx+w*8-8,err,1/42); if (x-1>=0) addErr(d,idx+w*8-4,err,2/42);
                addErr(d,idx+w*8,err,4/42);
                if (x+1<w) addErr(d,idx+w*8+4,err,2/42); if (x+2<w) addErr(d,idx+w*8+8,err,1/42);
            }
        }
        ctx.putImageData(id, 0, 0);
    },
    jarvis(ctx, w, h, thr, diff) {
        const id = ctx.getImageData(0, 0, w, h); const d = id.data;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const idx = (y*w+x)*4;
            const gray = 0.299*d[idx]+0.587*d[idx+1]+0.114*d[idx+2];
            const nv = gray < thr ? 0 : 255; const err = (gray-nv)*diff;
            d[idx] = d[idx+1] = d[idx+2] = nv;
            if (x+1<w) addErr(d,idx+4,err,7/48); if (x+2<w) addErr(d,idx+8,err,5/48);
            if (y+1<h) {
                if (x-2>=0) addErr(d,idx+w*4-8,err,3/48); if (x-1>=0) addErr(d,idx+w*4-4,err,5/48);
                addErr(d,idx+w*4,err,7/48);
                if (x+1<w) addErr(d,idx+w*4+4,err,5/48); if (x+2<w) addErr(d,idx+w*4+8,err,3/48);
            }
            if (y+2<h) {
                if (x-2>=0) addErr(d,idx+w*8-8,err,1/48); if (x-1>=0) addErr(d,idx+w*8-4,err,3/48);
                addErr(d,idx+w*8,err,5/48);
                if (x+1<w) addErr(d,idx+w*8+4,err,3/48); if (x+2<w) addErr(d,idx+w*8+8,err,1/48);
            }
        }
        ctx.putImageData(id, 0, 0);
    },
};

// BWR dithering algorithms (preserve red pixels)
const BWR_ALGOS = {
    none(ctx, w, h, thr) {
        const id = ctx.getImageData(0, 0, w, h); const d = id.data;
        for (let i = 0; i < d.length; i += 4) {
            if (d[i] > d[i+1]*1.5 && d[i] > d[i+2]*1.5 && d[i] > thr) {
                d[i]=255; d[i+1]=0; d[i+2]=0; continue;
            }
            const v = (0.299*d[i]+0.587*d[i+1]+0.114*d[i+2]) < thr ? 0 : 255;
            d[i]=d[i+1]=d[i+2]=v;
        }
        ctx.putImageData(id, 0, 0);
    },
    floydsteinberg(ctx, w, h, thr, diff) {
        const id = ctx.getImageData(0, 0, w, h); const d = id.data;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const idx = (y*w+x)*4;
            const [r,g,b] = [d[idx],d[idx+1],d[idx+2]];
            if (r>g*1.5 && r>b*1.5 && r>thr) { d[idx]=255;d[idx+1]=0;d[idx+2]=0; continue; }
            const gray=0.299*r+0.587*g+0.114*b, nv=gray<thr?0:255;
            const [rE,gE,bE]=[r-nv,g-nv,b-nv].map(e=>e*diff);
            d[idx]=d[idx+1]=d[idx+2]=nv;
            if (x+1<w) addColorErr(d,idx+4,rE,gE,bE,7/16);
            if (y+1<h) {
                if (x-1>=0) addColorErr(d,idx+w*4-4,rE,gE,bE,3/16);
                addColorErr(d,idx+w*4,rE,gE,bE,5/16);
                if (x+1<w) addColorErr(d,idx+w*4+4,rE,gE,bE,1/16);
            }
        }
        ctx.putImageData(id, 0, 0);
    },
    atkinson(ctx, w, h, thr, diff) {
        const id = ctx.getImageData(0, 0, w, h); const d = id.data;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const idx = (y*w+x)*4;
            const [r,g,b] = [d[idx],d[idx+1],d[idx+2]];
            if (r>g*1.5 && r>b*1.5 && r>thr) { d[idx]=255;d[idx+1]=0;d[idx+2]=0; continue; }
            const gray=0.299*r+0.587*g+0.114*b, nv=gray<thr?0:255;
            const [rE,gE,bE]=[r-nv,g-nv,b-nv].map(e=>e*diff);
            d[idx]=d[idx+1]=d[idx+2]=nv;
            if (x+1<w) addColorErr(d,idx+4,rE,gE,bE,1/8);
            if (x+2<w) addColorErr(d,idx+8,rE,gE,bE,1/8);
            if (y+1<h) {
                if (x-1>=0) addColorErr(d,idx+w*4-4,rE,gE,bE,1/8);
                addColorErr(d,idx+w*4,rE,gE,bE,1/8);
                if (x+1<w) addColorErr(d,idx+w*4+4,rE,gE,bE,1/8);
            }
            if (y+2<h) addColorErr(d,idx+w*8,rE,gE,bE,1/8);
        }
        ctx.putImageData(id, 0, 0);
    },
    bayer(ctx, w, h, thr, diff) {
        const map=[[15,135,45,165],[195,75,225,105],[60,180,30,150],[240,120,210,90]];
        const id = ctx.getImageData(0, 0, w, h); const d = id.data;
        for (let i = 0; i < d.length; i += 4) {
            const x=(i/4)%w, y=Math.floor((i/4)/w);
            const t=clamp(thr*(1+(map[x%4][y%4]-128)/128*diff),0,255);
            if (d[i]>d[i+1]*1.5 && d[i]>d[i+2]*1.5 && d[i]>t) { d[i]=255;d[i+1]=0;d[i+2]=0; continue; }
            const v=(0.299*d[i]+0.587*d[i+1]+0.114*d[i+2])<t?0:255;
            d[i]=d[i+1]=d[i+2]=v;
        }
        ctx.putImageData(id, 0, 0);
    },
    stucki(ctx, w, h, thr, diff) {
        const id = ctx.getImageData(0, 0, w, h); const d = id.data;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const idx=(y*w+x)*4; const [r,g,b]=[d[idx],d[idx+1],d[idx+2]];
            if (r>g*1.5&&r>b*1.5&&r>thr){d[idx]=255;d[idx+1]=0;d[idx+2]=0;continue;}
            const gray=0.299*r+0.587*g+0.114*b,nv=gray<thr?0:255;
            const [rE,gE,bE]=[r-nv,g-nv,b-nv].map(e=>e*diff);
            d[idx]=d[idx+1]=d[idx+2]=nv;
            if(x+1<w)addColorErr(d,idx+4,rE,gE,bE,8/42);if(x+2<w)addColorErr(d,idx+8,rE,gE,bE,4/42);
            if(y+1<h){if(x-2>=0)addColorErr(d,idx+w*4-8,rE,gE,bE,2/42);if(x-1>=0)addColorErr(d,idx+w*4-4,rE,gE,bE,4/42);
            addColorErr(d,idx+w*4,rE,gE,bE,8/42);if(x+1<w)addColorErr(d,idx+w*4+4,rE,gE,bE,4/42);if(x+2<w)addColorErr(d,idx+w*4+8,rE,gE,bE,2/42);}
            if(y+2<h){if(x-2>=0)addColorErr(d,idx+w*8-8,rE,gE,bE,1/42);if(x-1>=0)addColorErr(d,idx+w*8-4,rE,gE,bE,2/42);
            addColorErr(d,idx+w*8,rE,gE,bE,4/42);if(x+1<w)addColorErr(d,idx+w*8+4,rE,gE,bE,2/42);if(x+2<w)addColorErr(d,idx+w*8+8,rE,gE,bE,1/42);}
        }
        ctx.putImageData(id, 0, 0);
    },
    jarvis(ctx, w, h, thr, diff) {
        const id = ctx.getImageData(0, 0, w, h); const d = id.data;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const idx=(y*w+x)*4; const [r,g,b]=[d[idx],d[idx+1],d[idx+2]];
            if (r>g*1.5&&r>b*1.5&&r>thr){d[idx]=255;d[idx+1]=0;d[idx+2]=0;continue;}
            const gray=0.299*r+0.587*g+0.114*b,nv=gray<thr?0:255;
            const [rE,gE,bE]=[r-nv,g-nv,b-nv].map(e=>e*diff);
            d[idx]=d[idx+1]=d[idx+2]=nv;
            if(x+1<w)addColorErr(d,idx+4,rE,gE,bE,7/48);if(x+2<w)addColorErr(d,idx+8,rE,gE,bE,5/48);
            if(y+1<h){if(x-2>=0)addColorErr(d,idx+w*4-8,rE,gE,bE,3/48);if(x-1>=0)addColorErr(d,idx+w*4-4,rE,gE,bE,5/48);
            addColorErr(d,idx+w*4,rE,gE,bE,7/48);if(x+1<w)addColorErr(d,idx+w*4+4,rE,gE,bE,5/48);if(x+2<w)addColorErr(d,idx+w*4+8,rE,gE,bE,3/48);}
            if(y+2<h){if(x-2>=0)addColorErr(d,idx+w*8-8,rE,gE,bE,1/48);if(x-1>=0)addColorErr(d,idx+w*8-4,rE,gE,bE,3/48);
            addColorErr(d,idx+w*8,rE,gE,bE,5/48);if(x+1<w)addColorErr(d,idx+w*8+4,rE,gE,bE,3/48);if(x+2<w)addColorErr(d,idx+w*8+8,rE,gE,bE,1/48);}
        }
        ctx.putImageData(id, 0, 0);
    },
};

/**
 * Apply dithering to canvas in-place.
 * @param {HTMLCanvasElement} canvas
 * @param {string} type  e.g. 'floydsteinberg', 'bwr_bayer', …
 * @param {number} threshold  0-255
 * @param {number} diffusion  0-1
 */
function applyDithering(canvas, type, threshold, diffusion) {
    const ctx = canvas.getContext('2d');
    const { width: w, height: h } = canvas;
    if (type.startsWith('bwr_')) {
        const algo = BWR_ALGOS[type.slice(4)] || BWR_ALGOS.none;
        algo(ctx, w, h, threshold, diffusion);
    } else {
        const algo = BW_ALGOS[type] || BW_ALGOS.none;
        algo(ctx, w, h, threshold, diffusion);
    }
}

// ── BLE upload (mirrors upload_image) ────────────────────────────────────────

const BLE_STEP = 480;

async function sendBufferData(canvas, bytesArr, type) {
    const hex = bytesToHex(bytesArr);
    const code = type === 'bwr' ? '00' : 'ff';
    const cod  = (bytesArr.length === 7000 || bytesArr.length === 18000) ? '04' : '03';
    addImgLog(`Gửi ${type.toUpperCase()} — ${bytesArr.length} bytes, ${Math.ceil(hex.length/BLE_STEP)} khối`);
    for (let i = 0; i < hex.length; i += BLE_STEP) {
        const pos = i / 2;
        await BLE.sendEpd(hexToBytes(cod + code + intToHex(pos, 2) + hex.slice(i, i + BLE_STEP)));
    }
}

async function uploadCanvas(canvas) {
    const w = canvas.width;
    const t0 = Date.now();
    addImgLog(`Bắt đầu tải lên ${w}×${canvas.height}…`);

    if (w === 296) {
        await sendBufferData(canvas, canvas2bytes_bw(canvas, 'bw'),  'bw');
        await sendBufferData(canvas, canvas2bytes_bw(canvas, 'bwr'), 'bwr');
    } else if (w === 250 || w === 212) {
        await sendBufferData(canvas, canvas2bytes_bw(canvas, 'bw'),  'bw');
    } else {
        await sendBufferData(canvas, canvas2bytes(canvas, 'bw'),  'bw');
        await sendBufferData(canvas, canvas2bytes(canvas, 'bwr'), 'bwr');
    }

    await BLE.delay(300);
    const triggerCmd = (w === 280 || canvas.height === 180) ? 'AA' : '01';
    await BLE.sendEpd(hexToBytes(triggerCmd));
    addImgLog(`Đã gửi trigger 0x${triggerCmd.toUpperCase()} (mode → IMAGE + refresh)`);
    addImgLog(`✓ Hoàn tất trong ${((Date.now()-t0)/1000).toFixed(1)}s`);
}

// ── Shared log (writable by both tabs) ───────────────────────────────────────

function addImgLog(msg) {
    const box = document.getElementById('img-log');
    if (!box) return;
    const now = new Date();
    const t = [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map(n => String(n).padStart(2, '0')).join(':');
    box.textContent += `[${t}] ${msg}\n`;
    box.scrollTop = box.scrollHeight;
}
