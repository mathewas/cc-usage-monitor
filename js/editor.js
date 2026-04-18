/**
 * editor.js — Canvas template editor
 * Ported from index_vi.html tab-editor.
 * Requires image.js (applyDithering, uploadCanvas, addImgLog) and ble.js.
 */

// ── Built-in templates ───────────────────────────────────────────────────────

const BUILT_IN_ICONS = {
    icon1:  '😊', icon2:  '🌟', icon3:  '💡', icon4:  '❤️', icon5:  '⭐',
    icon6:  '📱', icon7:  '🚀', icon8:  '🎨', icon9:  '📝', icon10: '🔧',
    icon11: '📊', icon12: '🎯', icon13: '💎', icon14: '📈', icon15: '🔒',
    icon16: '🎵', icon17: '🎮', icon18: '🏠', icon19: '✏️', icon20: '🔍',
    icon21: '💬', icon22: '📷', icon23: '🎁', icon24: '🏆', icon25: '⚡',
};

const BUILT_IN_BG = {
    none:      { type: 'color',    color: '#ffffff' },
    gradient1: { type: 'gradient', stops: ['#667eea', '#764ba2'] },
    gradient2: { type: 'gradient', stops: ['#f093fb', '#f5576c'] },
    gradient3: { type: 'gradient', stops: ['#4facfe', '#00f2fe'] },
};

// ── Editor state ─────────────────────────────────────────────────────────────

const edState = {
    elements: [],
    selectedElementIndex: -1,
    selectedColor: '#000000',
    selectedBgTemplate: 'none',
    selectedImageTemplate: 'icon1',
    bgColor: '#ffffff',
    textStyles: { bold: false, italic: false, underline: false },
    shapeParams: { sides: 5, ratio: 0.5 },
    isDragging: false,
    dragStartX: 0, dragStartY: 0,
    dragElementOffsetX: 0, dragElementOffsetY: 0,
    uploadedBg: null,
    uploadedIcons: {},
    nextIconId: 100,
};

// ── Canvas refs (set in DOMContentLoaded) ────────────────────────────────────

let edCanvas, edCtx;

// ── Drawing helpers ──────────────────────────────────────────────────────────

function drawStar(ctx, cx, cy, spikes, outerR, innerR) {
    let rot = Math.PI / 2 * 3;
    const step = Math.PI / spikes;
    ctx.beginPath();
    ctx.moveTo(cx, cy - outerR);
    for (let i = 0; i < spikes; i++) {
        ctx.lineTo(cx + Math.cos(rot) * outerR, cy + Math.sin(rot) * outerR);
        rot += step;
        ctx.lineTo(cx + Math.cos(rot) * innerR, cy + Math.sin(rot) * innerR);
        rot += step;
    }
    ctx.lineTo(cx, cy - outerR);
    ctx.closePath();
}

function drawElementWithRotation(el) {
    const ctx = edCtx;
    ctx.save();
    let cx = 0, cy = 0;
    if (el.type === 'line') {
        cx = (el.x1 + el.x2) / 2; cy = (el.y1 + el.y2) / 2;
    } else if (el.type === 'circle') {
        cx = el.x; cy = el.y;
    } else if (el.type === 'text') {
        const fw = el.bold ? 'bold' : 'normal', fs = el.italic ? 'italic' : 'normal';
        ctx.font = `${fw} ${fs} ${el.size}px ${el.fontFamily || 'Arial'}`;
        cx = el.x + ctx.measureText(el.content).width / 2;
        cy = el.y - el.size / 2;
    } else {
        cx = el.x + (el.width || el.outerRadius * 2 || 0) / 2;
        cy = el.y + (el.height || el.outerRadius * 2 || 0) / 2;
    }
    if (el.rotation) {
        ctx.translate(cx, cy);
        ctx.rotate(el.rotation * Math.PI / 180);
        ctx.translate(-cx, -cy);
    }
    ctx.fillStyle = el.color || edState.selectedColor;
    switch (el.type) {
        case 'rect':
            ctx.fillRect(el.x, el.y, el.width, el.height);
            break;
        case 'circle':
            ctx.beginPath();
            ctx.arc(el.x, el.y, el.radius, 0, Math.PI * 2);
            ctx.fill();
            break;
        case 'triangle':
            ctx.beginPath();
            ctx.moveTo(el.x, el.y);
            ctx.lineTo(el.x + (el.width||30), el.y + (el.height||30));
            ctx.lineTo(el.x - (el.width||30), el.y + (el.height||30));
            ctx.closePath();
            ctx.fill();
            break;
        case 'line':
            ctx.strokeStyle = el.color || edState.selectedColor;
            ctx.lineWidth = el.thickness || 2;
            ctx.beginPath();
            ctx.moveTo(el.x1, el.y1);
            ctx.lineTo(el.x2, el.y2);
            ctx.stroke();
            break;
        case 'star':
            drawStar(ctx, el.x, el.y, el.spikes||5, el.outerRadius||20, el.innerRadius||10);
            ctx.fill();
            break;
        case 'text': {
            const fw = el.bold ? 'bold' : 'normal', fs = el.italic ? 'italic' : 'normal';
            ctx.font = `${fw} ${fs} ${el.size}px ${el.fontFamily || 'Arial'}`;
            ctx.fillStyle = el.color || edState.selectedColor;
            ctx.fillText(el.content, el.x, el.y);
            if (el.underline) {
                const tw = ctx.measureText(el.content).width;
                ctx.beginPath();
                ctx.moveTo(el.x, el.y + 2);
                ctx.lineTo(el.x + tw, el.y + 2);
                ctx.strokeStyle = el.color || edState.selectedColor;
                ctx.lineWidth = 1;
                ctx.stroke();
            }
            break;
        }
        case 'image': {
            const img = edState.uploadedIcons[el.iconId];
            if (img) {
                ctx.drawImage(img, el.x, el.y, el.width, el.height);
            } else {
                const emoji = BUILT_IN_ICONS[el.iconId];
                if (emoji) {
                    ctx.font = `${(el.height||40) * 0.6}px Arial`;
                    ctx.fillStyle = el.color || '#000000';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(emoji, el.x + (el.width||40)/2, el.y + (el.height||40)/2);
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'alphabetic';
                }
            }
            break;
        }
    }
    ctx.restore();
}

function drawSelectionBox(el) {
    const ctx = edCtx;
    ctx.save();
    if (el.rotation) {
        let cx, cy;
        if (el.type === 'circle') { cx = el.x; cy = el.y; }
        else if (el.type === 'text') { cx = el.x; cy = el.y - el.size/2; }
        else { cx = el.x + (el.width||0)/2; cy = el.y + (el.height||0)/2; }
        ctx.translate(cx, cy);
        ctx.rotate(el.rotation * Math.PI / 180);
        ctx.translate(-cx, -cy);
    }
    ctx.strokeStyle = '#4CAF50';
    ctx.lineWidth = 2;
    if (el.type === 'rect' || el.type === 'image') {
        ctx.strokeRect(el.x, el.y, el.width, el.height);
    } else if (el.type === 'circle') {
        ctx.beginPath(); ctx.arc(el.x, el.y, el.radius, 0, Math.PI*2); ctx.stroke();
    } else if (el.type === 'text') {
        const fw = el.bold ? 'bold' : 'normal', fs = el.italic ? 'italic' : 'normal';
        ctx.font = `${fw} ${fs} ${el.size}px ${el.fontFamily||'Arial'}`;
        const tw = ctx.measureText(el.content).width;
        ctx.strokeRect(el.x - 2, el.y - el.size, tw + 4, el.size + 4);
    } else if (el.type === 'line') {
        ctx.setLineDash([5, 3]);
        ctx.beginPath(); ctx.moveTo(el.x1, el.y1); ctx.lineTo(el.x2, el.y2); ctx.stroke();
        ctx.setLineDash([]);
    }
    ctx.restore();
}

// ── Canvas init & render ─────────────────────────────────────────────────────

function initEdCanvas() {
    const ctx = edCtx;
    ctx.clearRect(0, 0, edCanvas.width, edCanvas.height);
    if (edState.uploadedBg) {
        ctx.drawImage(edState.uploadedBg, 0, 0, edCanvas.width, edCanvas.height);
        return;
    }
    const bg = BUILT_IN_BG[edState.selectedBgTemplate] || BUILT_IN_BG.none;
    if (bg.type === 'gradient') {
        const g = ctx.createLinearGradient(0, 0, edCanvas.width, edCanvas.height);
        g.addColorStop(0, bg.stops[0]);
        g.addColorStop(1, bg.stops[1]);
        ctx.fillStyle = g;
    } else {
        ctx.fillStyle = edState.bgColor;
    }
    ctx.fillRect(0, 0, edCanvas.width, edCanvas.height);
}

function renderElements() {
    initEdCanvas();
    edState.elements.forEach((el, i) => {
        drawElementWithRotation(el);
        if (i === edState.selectedElementIndex) drawSelectionBox(el);
    });
}

// ── Hit testing ──────────────────────────────────────────────────────────────

function isPointInRotatedRect(px, py, x, y, w, h, rot) {
    if (!rot) return px>=x && px<=x+w && py>=y && py<=y+h;
    const cx=x+w/2, cy=y+h/2, a=-rot*Math.PI/180;
    const dx=px-cx, dy=py-cy;
    const rx=dx*Math.cos(a)-dy*Math.sin(a);
    const ry=dx*Math.sin(a)+dy*Math.cos(a);
    return Math.abs(rx)<=w/2 && Math.abs(ry)<=h/2;
}

function isPointInElement(px, py, el) {
    switch (el.type) {
        case 'rect': case 'image':
            return isPointInRotatedRect(px, py, el.x, el.y, el.width, el.height, el.rotation);
        case 'circle':
            return (px-el.x)**2 + (py-el.y)**2 <= el.radius**2;
        case 'triangle':
            return isPointInRotatedRect(px, py, el.x-(el.width||30), el.y, (el.width||30)*2, el.height||30, el.rotation);
        case 'line': {
            const A=px-el.x1, B=py-el.y1, C=el.x2-el.x1, D=el.y2-el.y1;
            const dot=A*C+B*D, lenSq=C*C+D*D;
            const t=lenSq!==0 ? Math.max(0, Math.min(1, dot/lenSq)) : 0;
            return (px-(el.x1+t*C))**2 + (py-(el.y1+t*D))**2 < 100;
        }
        case 'star':
            return (px-el.x)**2+(py-el.y)**2 <= (el.outerRadius||20)**2;
        case 'text': {
            const fw=el.bold?'bold':'normal', fs=el.italic?'italic':'normal';
            edCtx.font=`${fw} ${fs} ${el.size}px ${el.fontFamily||'Arial'}`;
            const tw=edCtx.measureText(el.content).width;
            return isPointInRotatedRect(px, py, el.x, el.y-el.size, tw, el.size, el.rotation);
        }
        default: return false;
    }
}

function getCanvasPos(clientX, clientY) {
    const r = edCanvas.getBoundingClientRect();
    return {
        x: (clientX - r.left) * (edCanvas.width / r.width),
        y: (clientY - r.top)  * (edCanvas.height / r.height),
    };
}

// ── Drag ─────────────────────────────────────────────────────────────────────

function startDrag(e) {
    const clientX = e.clientX || e.touches?.[0].clientX;
    const clientY = e.clientY || e.touches?.[0].clientY;
    const {x, y} = getCanvasPos(clientX, clientY);
    for (let i = edState.elements.length - 1; i >= 0; i--) {
        const el = edState.elements[i];
        if (isPointInElement(x, y, el)) {
            edState.isDragging = true;
            edState.selectedElementIndex = i;
            edState.dragStartX = x; edState.dragStartY = y;
            if (el.type === 'line') {
                edState.dragElementOffsetX = x - el.x1;
                edState.dragElementOffsetY = y - el.y1;
            } else {
                let ex = el.type==='circle' ? el.x : (el.type==='text' ? el.x : el.x+(el.width||0)/2);
                let ey = el.type==='circle' ? el.y : (el.type==='text' ? el.y-el.size/2 : el.y+(el.height||0)/2);
                edState.dragElementOffsetX = x - ex;
                edState.dragElementOffsetY = y - ey;
            }
            syncControlsToElement(el);
            renderElements();
            e.preventDefault();
            return;
        }
    }
    edState.selectedElementIndex = -1;
    renderElements();
}

function drag(e) {
    if (!edState.isDragging) return;
    const clientX = e.clientX || e.touches?.[0].clientX;
    const clientY = e.clientY || e.touches?.[0].clientY;
    const {x, y} = getCanvasPos(clientX, clientY);
    const el = edState.elements[edState.selectedElementIndex];
    if (!el) return;
    const W = edCanvas.width, H = edCanvas.height;
    if (el.type === 'line') {
        const dx=el.x2-el.x1, dy=el.y2-el.y1;
        el.x1 = Math.max(0, Math.min(W, x - edState.dragElementOffsetX));
        el.y1 = Math.max(0, Math.min(H, y - edState.dragElementOffsetY));
        el.x2 = el.x1 + dx; el.y2 = el.y1 + dy;
    } else {
        const ncx = x - edState.dragElementOffsetX;
        const ncy = y - edState.dragElementOffsetY;
        if (el.type === 'circle') {
            el.x = Math.max(el.radius, Math.min(W-el.radius, ncx));
            el.y = Math.max(el.radius, Math.min(H-el.radius, ncy));
        } else if (el.type === 'star') {
            const r = el.outerRadius||20;
            el.x = Math.max(r, Math.min(W-r, ncx));
            el.y = Math.max(r, Math.min(H-r, ncy));
        } else if (el.type === 'text') {
            edCtx.font = `${el.bold?'bold':'normal'} ${el.size}px ${el.fontFamily||'Arial'}`;
            const tw = edCtx.measureText(el.content).width;
            el.x = Math.max(0, Math.min(W-tw, ncx - tw/2));
            el.y = Math.max(el.size, Math.min(H, ncy + el.size/2));
        } else {
            el.x = Math.max(0, Math.min(W-(el.width||0), ncx - (el.width||0)/2));
            el.y = Math.max(0, Math.min(H-(el.height||0), ncy - (el.height||0)/2));
        }
    }
    renderElements();
    e.preventDefault();
}

function endDrag() { edState.isDragging = false; }

// ── Element operations ────────────────────────────────────────────────────────

function addNewElement() {
    const type = document.getElementById('ed-element-type').value;
    const color = edState.selectedColor;
    const W = edCanvas.width, H = edCanvas.height;
    let el = {};
    const rx = () => Math.random();
    switch (type) {
        case 'rect':
            el = { type:'rect', x:rx()*(W-100)+20, y:rx()*(H-80)+20, width:60, height:40, color, rotation:0 };
            break;
        case 'circle':
            el = { type:'circle', x:rx()*(W-60)+30, y:rx()*(H-60)+30, radius:25, color, rotation:0 };
            break;
        case 'triangle':
            el = { type:'triangle', x:rx()*(W-80)+40, y:rx()*(H-80)+40, width:30, height:30, color, rotation:0 };
            break;
        case 'line': {
            const x1=rx()*(W-50)+25, y1=rx()*(H-50)+25;
            el = { type:'line', x1, y1, x2:x1+50, y2:y1+50, thickness:2, color, rotation:0 };
            break;
        }
        case 'star': {
            const spikes = parseInt(document.getElementById('ed-param1').value)||5;
            const ratio  = parseFloat(document.getElementById('ed-param2').value)||0.5;
            el = { type:'star', x:rx()*(W-60)+30, y:rx()*(H-60)+30, spikes, outerRadius:25, innerRadius:25*ratio, color, rotation:0 };
            break;
        }
        case 'text':
            el = { type:'text', x:rx()*(W-100)+20, y:rx()*(H-30)+30,
                content: document.getElementById('ed-text-content').value || 'Text',
                fontFamily: document.getElementById('ed-text-font').value,
                size: parseInt(document.getElementById('ed-text-size').value)||16,
                bold: edState.textStyles.bold, italic: edState.textStyles.italic,
                underline: edState.textStyles.underline, color, rotation:0 };
            break;
        case 'image': {
            const sel = document.querySelector('#ed-icon-templates .template-item.selected');
            if (!sel) { alert('Chọn icon trước!'); return; }
            el = { type:'image', x:rx()*(W-80)+20, y:rx()*(H-80)+20, width:40, height:40,
                iconId: sel.dataset.type, isUploaded: sel.dataset.type.startsWith('upload_'),
                isQrcode: sel.dataset.type.startsWith('qrcode_'), rotation:0 };
            break;
        }
    }
    edState.elements.push(el);
    edState.selectedElementIndex = edState.elements.length - 1;
    syncControlsToElement(el);
    renderElements();
}

function deleteSelected() {
    if (edState.selectedElementIndex < 0) { alert('Chọn phần tử trước!'); return; }
    if (confirm('Xóa phần tử?')) {
        edState.elements.splice(edState.selectedElementIndex, 1);
        edState.selectedElementIndex = -1;
        renderElements();
    }
}

function duplicateSelected() {
    if (edState.selectedElementIndex < 0) { alert('Chọn phần tử trước!'); return; }
    const copy = JSON.parse(JSON.stringify(edState.elements[edState.selectedElementIndex]));
    copy.x = (copy.x || 0) + 15;
    copy.y = (copy.y || 0) + 15;
    if (copy.type === 'line') { copy.x1 += 15; copy.y1 += 15; copy.x2 += 15; copy.y2 += 15; }
    edState.elements.push(copy);
    edState.selectedElementIndex = edState.elements.length - 1;
    renderElements();
}

function bringToFront() {
    if (edState.selectedElementIndex < 0) return;
    const el = edState.elements.splice(edState.selectedElementIndex, 1)[0];
    edState.elements.push(el);
    edState.selectedElementIndex = edState.elements.length - 1;
    renderElements();
}

function sendToBack() {
    if (edState.selectedElementIndex < 0) return;
    const el = edState.elements.splice(edState.selectedElementIndex, 1)[0];
    edState.elements.unshift(el);
    edState.selectedElementIndex = 0;
    renderElements();
}

function moveElement(dx, dy) {
    if (edState.selectedElementIndex < 0) return;
    const el = edState.elements[edState.selectedElementIndex];
    if (el.type === 'line') { el.x1+=dx; el.y1+=dy; el.x2+=dx; el.y2+=dy; }
    else { el.x=(el.x||0)+dx; el.y=(el.y||0)+dy; }
    renderElements();
}

function applySize() {
    if (edState.selectedElementIndex < 0) return;
    const el = edState.elements[edState.selectedElementIndex];
    const nw = parseInt(document.getElementById('ed-width').value)||40;
    const nh = parseInt(document.getElementById('ed-height').value)||40;
    switch (el.type) {
        case 'rect': case 'image': case 'triangle': el.width=nw; el.height=nh; break;
        case 'circle': el.radius=nw/2; break;
        case 'text': el.size=nw; break;
        case 'star':
            el.outerRadius=nw/2;
            el.innerRadius=nw/2*(parseFloat(document.getElementById('ed-param2').value)||0.5);
            el.spikes=parseInt(document.getElementById('ed-param1').value)||5;
            break;
        case 'line': {
            const angle=Math.atan2(el.y2-el.y1, el.x2-el.x1);
            el.x2=el.x1+nw*Math.cos(angle); el.y2=el.y1+nw*Math.sin(angle);
            el.thickness=nh; break;
        }
    }
    renderElements();
}

function updateText() {
    if (edState.selectedElementIndex < 0) return;
    const el = edState.elements[edState.selectedElementIndex];
    if (el.type !== 'text') { alert('Chọn phần tử text!'); return; }
    el.content   = document.getElementById('ed-text-content').value;
    el.fontFamily = document.getElementById('ed-text-font').value;
    el.size       = parseInt(document.getElementById('ed-text-size').value)||16;
    el.bold       = edState.textStyles.bold;
    el.italic     = edState.textStyles.italic;
    el.underline  = edState.textStyles.underline;
    el.color      = edState.selectedColor;
    renderElements();
}

function syncControlsToElement(el) {
    const rot = document.getElementById('ed-rotation');
    const rotVal = document.getElementById('ed-rotation-value');
    if (rot) { rot.value = el.rotation||0; }
    if (rotVal) { rotVal.textContent = `${el.rotation||0}°`; }
    const wEl = document.getElementById('ed-width');
    const hEl = document.getElementById('ed-height');
    if (wEl && hEl) {
        switch (el.type) {
            case 'circle': wEl.value = el.radius*2; hEl.value = el.radius*2; break;
            case 'text':   wEl.value = el.size;     hEl.value = el.size;     break;
            case 'star':   wEl.value = el.outerRadius*2; hEl.value = el.outerRadius*2; break;
            default: wEl.value = el.width||0; hEl.value = el.height||0;
        }
    }
    if (el.type === 'text') {
        document.getElementById('ed-text-content').value = el.content;
        document.getElementById('ed-text-size').value = el.size;
        const tc = document.getElementById('ed-text-controls');
        if (tc) tc.style.display = 'block';
    } else {
        const tc = document.getElementById('ed-text-controls');
        if (tc) tc.style.display = 'none';
    }
}

// ── Background ────────────────────────────────────────────────────────────────

function applyBgColor() {
    edState.uploadedBg = null;
    edState.selectedBgTemplate = 'none';
    edState.bgColor = document.getElementById('ed-bg-color').value;
    renderElements();
}

function handleBgUpload(file) {
    const reader = new FileReader();
    reader.onload = e => {
        const img = new Image();
        img.onload = () => { edState.uploadedBg = img; renderElements(); };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

// ── QR Code ───────────────────────────────────────────────────────────────────

function generateQRCode(text) {
    return new Promise((resolve, reject) => {
        try {
            const div = document.createElement('div');
            div.style.cssText = 'position:absolute;left:-9999px;top:-9999px';
            document.body.appendChild(div);
            const qr = new QRCode(div, { text, width:200, height:200,
                colorDark:'#000000', colorLight:'#ffffff', correctLevel: QRCode.CorrectLevel.H });
            setTimeout(() => {
                const img = div.querySelector('img');
                const cv  = div.querySelector('canvas');
                const url = img?.src || cv?.toDataURL('image/png');
                document.body.removeChild(div);
                url ? resolve(url) : reject(new Error('QR render failed'));
            }, 100);
        } catch(e) { reject(e); }
    });
}

async function generateQrcode() {
    const content = document.getElementById('ed-qrcode-content').value.trim();
    if (!content) { alert('Nhập nội dung QR!'); return; }
    try {
        const qrcodeId = `qrcode_${edState.nextIconId++}`;
        const url = await generateQRCode(content);
        const img = new Image();
        img.onload = () => {
            edState.uploadedIcons[qrcodeId] = img;
            addIconToPanel(qrcodeId, img.src, 'QR');
            addImgLog(`Đã tạo QR code: ${content.slice(0,30)}…`);
        };
        img.src = url;
    } catch(e) { alert('Lỗi tạo QR: ' + e.message); }
}

function addIconToPanel(iconId, src, label) {
    const panel = document.getElementById('ed-icon-templates');
    panel.querySelectorAll('.template-item').forEach(i => i.classList.remove('selected'));
    const div = document.createElement('div');
    div.className = 'template-item selected';
    div.dataset.type = iconId;
    div.innerHTML = `<img src="${src}" style="width:100%;height:100%;object-fit:contain;">
        <span class="ed-remove-icon" data-id="${iconId}" title="Xóa">×</span>`;
    panel.appendChild(div);
}

// ── Icon upload ───────────────────────────────────────────────────────────────

function handleIconUpload(files) {
    for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        const reader = new FileReader();
        const id = `upload_${edState.nextIconId++}`;
        reader.onload = e => {
            const img = new Image();
            img.onload = () => { edState.uploadedIcons[id] = img; addIconToPanel(id, img.src, 'Custom'); };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }
}

// ── Send directly to device ───────────────────────────────────────────────────

async function sendEditorDirectly() {
    if (!BLE.isConnected()) { addImgLog('Chưa kết nối BLE!'); return; }

    // Flatten editor canvas to transfer canvas size
    const sizeKey = document.getElementById('ed-screen-size').value;
    const sz = SCREEN_SIZES[sizeKey];
    const transferCanvas = document.createElement('canvas');
    transferCanvas.width  = sz.w;
    transferCanvas.height = sz.h;
    const tCtx = transferCanvas.getContext('2d');
    tCtx.drawImage(edCanvas, 0, 0, sz.w, sz.h);

    // Apply adjustments + dithering
    const dMode = document.getElementById('ed-dithering').value;
    const thr   = parseInt(document.getElementById('ed-threshold').value);
    const diff  = parseInt(document.getElementById('ed-diffusion').value) / 100;
    applyDithering(transferCanvas, dMode, thr, diff);

    addImgLog(`Gửi từ editor → ${sz.w}×${sz.h} [${dMode}]`);
    try {
        await uploadCanvas(transferCanvas);
    } catch(e) {
        addImgLog('Lỗi: ' + e.message);
    }
}

// ── Save canvas ───────────────────────────────────────────────────────────────

function saveEditorCanvas() {
    const a = document.createElement('a');
    a.download = 'template.png';
    a.href = edCanvas.toDataURL('image/png');
    a.click();
}

// ── Apply to image tab ────────────────────────────────────────────────────────

function applyToImageTab() {
    sessionStorage.setItem('editorImage', edCanvas.toDataURL('image/png'));
    window.location.href = 'image.html';
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    edCanvas = document.getElementById('canvas_YS');
    if (!edCanvas) return;
    edCtx = edCanvas.getContext('2d');

    initEdCanvas();

    // Populate built-in icons
    const iconPanel = document.getElementById('ed-icon-templates');
    if (iconPanel) {
        Object.entries(BUILT_IN_ICONS).forEach(([id, emoji], i) => {
            const div = document.createElement('div');
            div.className = 'template-item' + (i === 0 ? ' selected' : '');
            div.dataset.type = id;
            div.innerHTML = `<span style="font-size:18px;line-height:40px;display:block;text-align:center;">${emoji}</span>`;
            iconPanel.appendChild(div);
        });
    }

    // Icon panel click
    iconPanel?.addEventListener('click', e => {
        const item = e.target.closest('.template-item');
        const removeBtn = e.target.closest('.ed-remove-icon');
        if (removeBtn) {
            const id = removeBtn.dataset.id;
            delete edState.uploadedIcons[id];
            removeBtn.closest('.template-item').remove();
            return;
        }
        if (item) {
            iconPanel.querySelectorAll('.template-item').forEach(i => i.classList.remove('selected'));
            item.classList.add('selected');
            edState.selectedImageTemplate = item.dataset.type;
        }
    });

    // Color options
    document.querySelectorAll('#ed-color-palette .color-option').forEach(opt => {
        opt.addEventListener('click', () => {
            document.querySelectorAll('#ed-color-palette .color-option').forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
            edState.selectedColor = opt.dataset.color;
        });
    });

    // Text style toggles
    ['ed-text-bold', 'ed-text-italic', 'ed-text-underline'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', () => {
            const key = id.replace('ed-text-', '');
            edState.textStyles[key] = !edState.textStyles[key];
            document.getElementById(id).classList.toggle('active', edState.textStyles[key]);
        });
    });

    // Rotation slider
    document.getElementById('ed-rotation')?.addEventListener('input', e => {
        document.getElementById('ed-rotation-value').textContent = e.target.value + '°';
        if (edState.selectedElementIndex >= 0)
            edState.elements[edState.selectedElementIndex].rotation = parseInt(e.target.value)||0;
        renderElements();
    });

    // BG color
    document.getElementById('ed-bg-color')?.addEventListener('input', e => {
        edState.bgColor = e.target.value;
    });

    // Buttons
    document.getElementById('ed-add-element')?.addEventListener('click', addNewElement);
    document.getElementById('ed-delete-element')?.addEventListener('click', deleteSelected);
    document.getElementById('ed-duplicate-element')?.addEventListener('click', duplicateSelected);
    document.getElementById('ed-bring-to-front')?.addEventListener('click', bringToFront);
    document.getElementById('ed-send-to-back')?.addEventListener('click', sendToBack);
    document.getElementById('ed-apply-size')?.addEventListener('click', applySize);
    document.getElementById('ed-update-text')?.addEventListener('click', updateText);
    document.getElementById('ed-apply-bg-color')?.addEventListener('click', applyBgColor);
    document.getElementById('ed-move-up')?.addEventListener('click', ()=>moveElement(0,-5));
    document.getElementById('ed-move-down')?.addEventListener('click', ()=>moveElement(0,5));
    document.getElementById('ed-move-left')?.addEventListener('click', ()=>moveElement(-5,0));
    document.getElementById('ed-move-right')?.addEventListener('click', ()=>moveElement(5,0));
    document.getElementById('ed-clear-canvas')?.addEventListener('click', () => {
        if (confirm('Xóa tất cả phần tử?')) {
            edState.elements = []; edState.selectedElementIndex = -1; renderElements();
        }
    });
    document.getElementById('ed-save-canvas')?.addEventListener('click', saveEditorCanvas);
    document.getElementById('ed-generate-qrcode')?.addEventListener('click', generateQrcode);
    document.getElementById('ed-apply-to-image')?.addEventListener('click', applyToImageTab);
    document.getElementById('ed-send-btn')?.addEventListener('click', async () => {
        const btn = document.getElementById('ed-send-btn');
        btn.disabled = true;
        try { await sendEditorDirectly(); }
        catch(e) { addImgLog('Lỗi: ' + e.message); }
        finally { btn.disabled = false; }
    });

    // BG upload
    document.getElementById('ed-bg-upload')?.addEventListener('change', e => {
        if (e.target.files[0]) handleBgUpload(e.target.files[0]);
    });
    // Icon upload
    document.getElementById('ed-icon-upload')?.addEventListener('change', e => {
        if (e.target.files.length) handleIconUpload(e.target.files);
    });

    // Drag
    edCanvas.addEventListener('mousedown', startDrag);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', endDrag);
    edCanvas.addEventListener('touchstart', startDrag, { passive: false });
    document.addEventListener('touchmove', drag, { passive: false });
    document.addEventListener('touchend', endDrag);
});
