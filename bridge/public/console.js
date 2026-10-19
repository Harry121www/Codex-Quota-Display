import { DEFAULT_THEME, normalizeTheme, paletteHex } from './theme-utils.js';
import { SIDE, encode565, decode565, fitRect } from './image-utils.js';

const $ = id => document.getElementById(id);
let draft = { ...DEFAULT_THEME }, saved = null, model = null;
let saving = false, loading = false, connected = false, serverOffset = 0;
let bitmap = null, imageName = '', imageBusy = false, modeBusy = false, selectionVersion = 0;
let savedImageRevision = '', savedImageData = null, imageLoadRevision = '';
let draftImageBytes = null, draftImageData = null, draftImageKey = '';
let displayMutation = 0;
const imageCanvas = document.createElement('canvas'); imageCanvas.width = imageCanvas.height = SIDE;

function same(a, b) { return a && b && a.accent === b.accent && a.background === b.background; }
function validInputs() { return ['accent', 'background'].every(key => /^[0-9a-f]{6}$/i.test($(key + 'Hex').value)); }
function message(text, error = false) { $('saveMessage').textContent = text; $('saveMessage').classList.toggle('error', error); }

function updateControls(syncFields = true) {
  if (syncFields) for (const key of ['accent', 'background']) {
    $(key + 'Picker').value = draft[key];
    $(key + 'Hex').value = draft[key].slice(1);
    $(key + 'Hex').setAttribute('aria-invalid', 'false');
  }
  for (const button of document.querySelectorAll('.preset')) button.setAttribute('aria-pressed', String(button.dataset.color === draft.accent));
  const valid = validInputs();
  const dirty = saved && (!same(draft, saved) || !valid);
  $('draftBadge').textContent = !saved ? '正在读取' : !valid ? '格式有误' : dirty ? '未保存' : '已保存';
  $('draftBadge').classList.toggle('dirty', Boolean(dirty));
  $('saveButton').disabled = saving || !saved || !dirty || !validInputs();
  $('saveLabel').textContent = saving ? '正在保存…' : '保存并同步';
  $('colorError').textContent = validInputs() ? '' : '请输入 6 位十六进制颜色，例如 FFFF00。';
  renderPreview();
}

function formatWindow(minutes, index) {
  if (!minutes) return index === 0 ? 'Primary' : 'Secondary';
  if (minutes % 10080 === 0) return `${minutes / 10080}w window`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d window`;
  if (minutes % 60 === 0) return `${minutes / 60}h window`;
  return `${minutes}m window`;
}

function resetText(reset) {
  if (!reset) return 'Reset: unknown';
  const seconds = reset - (Date.now() + serverOffset) / 1000;
  if (seconds <= 0) return 'Awaiting refresh';
  const minutes = Math.ceil(seconds / 60);
  return minutes >= 1440 ? `Reset: ${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h` : `Reset: ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function renderPreview() {
  const palette = paletteHex(draft), screen = $('screen');
  for (const [key, color] of Object.entries({ accent: palette.accent, 'screen-bg': palette.background, 'screen-muted': palette.muted, track: palette.track })) screen.style.setProperty('--' + key, color);
  const showImage = Boolean(bitmap || model?.display?.mode === 'image');
  screen.classList.toggle('image-mode', showImage);
  $('imagePreview').hidden = !showImage;
  if (showImage) {
    if (bitmap) {
      const key = `${selectionVersion}:${$('imageFit').value}:${draft.background}`;
      if (draftImageKey !== key) {
        const ctx = imageCanvas.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = draft.background; ctx.fillRect(0, 0, SIDE, SIDE);
        const rect = fitRect(bitmap.width, bitmap.height, $('imageFit').value);
        ctx.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height);
        draftImageBytes = encode565(ctx.getImageData(0, 0, SIDE, SIDE).data);
        draftImageData = new ImageData(decode565(draftImageBytes), SIDE, SIDE);
        draftImageKey = key;
      }
    }
    const ctx = $('imagePreview').getContext('2d');
    const data = bitmap ? draftImageData : savedImageData;
    if (data) ctx.putImageData(data, 0, 0);
    else { ctx.fillStyle = palette.background; ctx.fillRect(0, 0, SIDE, SIDE); ctx.fillStyle = palette.muted; ctx.font = '12px sans-serif'; ctx.fillText('正在读取已保存图片…', 48, 120); }
    $('previewCaption').textContent = bitmap ? '图片尚未上传。确认适配效果后，点击“上传并显示”。' : '当前保存的图片 · 全屏显示，切回额度可恢复额度界面。';
    return;
  }
  $('previewCaption').textContent = '预览会即时变化，保存后才会应用到小屏幕。';
  const quota = model?.quota, windows = quota?.windows ?? [];
  $('previewCards').replaceChildren();
  $('previewEmpty').hidden = windows.length > 0;
  $('previewEmpty').textContent = !connected ? '等待额度服务连接…' : '等待额度数据';
  windows.forEach((window, index) => {
    const card = document.createElement('div'); card.className = 'quota-card';
    const remaining = Math.max(0, Math.min(100, window.remainingPercent));
    card.style.setProperty('--quota-color', remaining <= 10 ? palette.danger : remaining <= 30 ? palette.warning : palette.accent);
    for (const [className, text] of [['quota-label', formatWindow(window.windowMinutes, index)], ['quota-value', Math.floor(remaining) + '%']]) {
      const element = document.createElement('div'); element.className = className; element.textContent = text; card.append(element);
    }
    const track = document.createElement('div'); track.className = 'quota-track';
    const fill = document.createElement('div'); fill.className = 'quota-fill'; fill.style.width = remaining + '%'; track.append(fill); card.append(track);
    const reset = document.createElement('div'); reset.className = 'quota-reset'; reset.textContent = resetText(window.resetsAt); card.append(reset);
    $('previewCards').append(card);
  });
  const footer = !windows.length ? 'Waiting for data' : !connected || quota.status !== 'ok' ? 'STALE - last known' : 'LIVE - remaining';
  $('previewFooter').textContent = footer;
  $('previewFooter').style.color = quota?.status === 'ok' && connected ? palette.accent : palette.warning;
}

function setStatus(id, text, state) {
  const element = $(id);
  element.className = 'status-value ' + state;
  const dot = document.createElement('i'); dot.className = 'status-dot';
  element.replaceChildren(dot, document.createTextNode(text));
}

function renderStatus() {
  const live = connected && model?.quota.status === 'ok';
  setStatus('serviceStatus', !connected ? '连接中断' : live ? '额度已更新' : model?.quota.status === 'stale' ? '显示上次数据' : '等待额度', live ? 'online' : 'warn');
  const device = model?.device;
  const recent = connected && device?.lastSeenAt && Date.now() - device.lastSeenAt < 45000;
  setStatus('deviceStatus', recent ? device.supportsImages ? '已连接' : '需要更新程序' : '等待设备', recent && device.supportsImages ? 'online' : 'warn');
  $('deviceHint').textContent = recent && device.supportsImages ? '屏幕已支持图片与主题同步，等待下一次自动更新。' : recent ? '屏幕正在连接。请更新一次屏幕程序，以启用图片显示。' : '请保持屏幕通电，并与电脑连接到互通的 Wi-Fi。图片功能需要更新一次屏幕程序。';
}

function imageMessage(text, error = false) { $('imageMessage').textContent = text; $('imageMessage').classList.toggle('error', error); }
function renderImageControls() {
  const ready = connected && model?.display;
  const busy = imageBusy || modeBusy;
  $('imageFile').disabled = !ready || busy;
  $('imageFit').disabled = busy || !bitmap;
  $('quotaMode').disabled = !ready || busy;
  $('imageMode').disabled = !ready || busy || !model?.display?.image;
  $('uploadImage').disabled = !ready || busy || !bitmap;
  $('uploadImage').firstElementChild.textContent = imageBusy ? '正在处理…' : '上传并显示';
  $('cancelImage').hidden = !bitmap;
  $('cancelImage').disabled = busy;
  for (const mode of ['quota', 'image']) $(mode + 'Mode').setAttribute('aria-pressed', String(model?.display?.mode === mode));
  $('displayBadge').textContent = bitmap ? '待上传' : !ready ? '未连接' : model.display.mode === 'image' ? '图片模式' : '额度模式';
  $('displayBadge').classList.toggle('previewing', Boolean(bitmap));
  $('imageInfo').textContent = bitmap ? `${imageName} · ${bitmap.width} × ${bitmap.height} → 240 × 240` : model?.display?.image ? '已保存一张图片，可随时切换显示或上传替换。' : '自动适配 240 × 240，支持静态图片。';
}

async function loadSavedImage(display) {
  const revision = display?.image?.revision;
  if (!revision || revision === savedImageRevision || revision === imageLoadRevision) return;
  imageLoadRevision = revision;
  try {
    const response = await fetch('/api/console/image?revision=' + revision, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('无法读取图片');
    const data = new ImageData(decode565(new Uint8Array(await response.arrayBuffer())), SIDE, SIDE);
    if (model?.display?.image?.revision === revision) { savedImageRevision = revision; savedImageData = data; renderPreview(); }
  } catch { if (model?.display?.mode === 'image') imageMessage('已保存图片的预览读取失败，稍后自动重试。', true); }
  finally { if (imageLoadRevision === revision) imageLoadRevision = ''; }
}

async function loadStatus() {
  if (loading || saving || modeBusy || imageBusy) return;
  loading = true;
  const mutationAtStart = displayMutation;
  try {
    const response = await fetch('/api/console', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('无法读取控制台');
    const next = await response.json();
    // An older in-flight status response must not undo a successful upload or mode change.
    if (mutationAtStart !== displayMutation && model) next.display = model.display;
    const untouched = !saved || same(draft, saved) && validInputs();
    saved = normalizeTheme(next.theme);
    if (untouched) draft = { ...saved };
    model = next; connected = true;
    void loadSavedImage(next.display);
    serverOffset = next.quota.serverTime * 1000 - Date.now();
    $('settingsFields').disabled = false;
    if (!validInputs()) message('请补全颜色值后保存。');
    else if (!same(draft, saved)) message('预览尚未保存，点击下方按钮应用。');
    else if (!same(draft, DEFAULT_THEME)) message('主题已保存，可随时修改。');
    else message('选择颜色并保存，小屏幕会自动更新。');
    updateControls(untouched);
  } catch {
    connected = false;
    message('连接失败，请确认电脑端额度服务正在运行。', true);
    renderPreview();
  } finally { loading = false; renderStatus(); renderImageControls(); }
}

function clearSelection() {
  bitmap?.close(); bitmap = null; imageName = ''; draftImageKey = ''; draftImageBytes = null; draftImageData = null;
  $('imageFile').value = ''; selectionVersion++;
}
$('imageFile').addEventListener('change', async () => {
  const file = $('imageFile').files[0];
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 12 * 1024 * 1024) {
    $('imageFile').value = ''; imageMessage('请选择不超过 12 MB 的 PNG、JPG 或 WebP 静态图片。', true); return;
  }
  imageBusy = true; renderImageControls();
  try {
    const next = await createImageBitmap(file);
    if (next.width * next.height > 40000000) { next.close(); throw new Error('图片像素过大，请缩小后重试'); }
    bitmap?.close(); bitmap = next; imageName = file.name; selectionVersion++; draftImageKey = '';
    imageMessage('预览已就绪，上传后会自动切换到图片模式。'); renderPreview();
  } catch (error) { imageMessage('无法打开图片：' + error.message, true); }
  finally { imageBusy = false; renderImageControls(); }
});
$('imageFit').addEventListener('change', renderPreview);
$('cancelImage').addEventListener('click', () => { clearSelection(); renderImageControls(); renderPreview(); imageMessage('已取消选择，屏幕显示内容未改变。'); });
$('uploadImage').addEventListener('click', async () => {
  if (!bitmap || imageBusy || modeBusy) return;
  renderPreview();
  imageBusy = true; renderImageControls();
  displayMutation++;
  try {
    const response = await fetch('/api/console/image', {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Console-Request': '1' },
      body: draftImageBytes, signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? '上传失败');
    model.display = result.display; savedImageRevision = result.display.image.revision; savedImageData = draftImageData;
    clearSelection(); renderPreview();
    imageMessage(model.device?.supportsImages ? '已上传并保存，屏幕通常在 15 秒内显示。' : '已上传并保存，请更新一次屏幕程序以显示图片。');
  } catch (error) { imageMessage('上传失败：' + error.message, true); }
  finally { imageBusy = false; renderImageControls(); }
});
for (const mode of ['quota', 'image']) $(mode + 'Mode').addEventListener('click', async () => {
  if (imageBusy || modeBusy || !model) return;
  modeBusy = true; renderImageControls();
  displayMutation++;
  try {
    const response = await fetch('/api/display', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Console-Request': '1' },
      body: JSON.stringify({ mode }), signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? '切换失败');
    model.display = result.display; clearSelection(); void loadSavedImage(result.display); renderPreview();
    imageMessage(`已切换到${mode === 'quota' ? '额度' : '图片'}模式，屏幕通常在 15 秒内更新。`);
  } catch (error) { imageMessage('切换失败：' + error.message, true); }
  finally { modeBusy = false; renderImageControls(); }
});

for (const key of ['accent', 'background']) {
  $(key + 'Picker').addEventListener('input', event => {
    draft[key] = event.target.value.toUpperCase();
    message('预览尚未保存，点击下方按钮应用。'); updateControls();
  });
  $(key + 'Hex').addEventListener('input', event => {
    const valid = /^[0-9a-f]{6}$/i.test(event.target.value);
    event.target.setAttribute('aria-invalid', String(!valid));
    if (valid) { draft[key] = '#' + event.target.value.toUpperCase(); $(key + 'Picker').value = draft[key]; }
    message(valid ? '预览尚未保存，点击下方按钮应用。' : '请补全颜色值后保存。'); updateControls(false);
  });
}

$('presets').addEventListener('click', event => {
  const button = event.target.closest('button[data-color]');
  if (!button) return;
  draft.accent = button.dataset.color;
  message('预览尚未保存，点击下方按钮应用。'); updateControls();
});
$('resetButton').addEventListener('click', () => {
  draft = { ...DEFAULT_THEME }; message('默认黄色已载入，点击保存后应用。'); updateControls();
});
$('themeForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (saving || !saved || !validInputs() || same(draft, saved)) return;
  saving = true; $('settingsFields').disabled = true; updateControls(false);
  try {
    const response = await fetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Console-Request': '1' },
      body: JSON.stringify(draft), signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? '保存失败');
    saved = normalizeTheme(result.theme); draft = { ...saved };
    message('已保存，屏幕将在下一次同步时应用（通常 15 秒内）。');
  } catch (error) { message(error.message === 'TimeoutError' ? '保存超时，请重试。' : '保存失败：' + error.message, true); }
  finally { saving = false; $('settingsFields').disabled = false; updateControls(); }
});

updateControls();
void loadStatus();
setInterval(loadStatus, 5000);
setInterval(() => { if (model) { renderPreview(); renderStatus(); } }, 1000);
