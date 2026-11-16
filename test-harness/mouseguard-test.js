// マウスガード検証テスト
// mouseguard.js（スクリプト本体）をスタブページで実行し「何が届く/届かない」を実測する
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const GUARD = fs.readFileSync(path.join(__dirname, '..', 'mouseguard.js'), 'utf8');
const GUARD_MS = 1000; // ※ mouseguard.js 内の値と同期させること

const PAGE = `<!doctype html><html><head></head><body style="margin:0">
<div id="target" style="width:400px;height:400px;background:#eee"></div>
<script>
window.__counts = { mousemove: 0, pmMouse: 0, pmTouch: 0, click: 0 };
var t = document.getElementById('target');
t.addEventListener('mousemove', function(){ window.__counts.mousemove++; });
t.addEventListener('pointermove', function(e){
  if (e.pointerType === 'touch') { window.__counts.pmTouch++; } else { window.__counts.pmMouse++; }
});
t.addEventListener('click', function(){ window.__counts.click++; });
</script>
</body></html>`;

function check(label, actual, expected) {
  const pass = actual === expected;
  console.log(JSON.stringify({ check: label, expected, actual, pass }));
  return pass;
}

async function js(win, code) {
  return win.webContents.executeJavaScript(code);
}

app.whenReady().then(async () => {
  setTimeout(() => { console.log('TIMEOUT'); app.exit(2); }, 90000).unref?.();

  const win = new BrowserWindow({
    width: 800, height: 600, show: false,
    webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true }
  });
  await win.loadURL('data:text/html;base64,' + Buffer.from(PAGE).toString('base64'));

  let allPass = true;
  const counts = async () => js(win, 'JSON.stringify(window.__counts)');

  // --- ガード発動中 ---
  await js(win, GUARD); // ガードインストール（テスト用に長めへ差し替え済み: 実行時値=${GUARD_MS}ms）
  await js(win, `document.getElementById('target').dispatchEvent(new MouseEvent('mousemove', {bubbles:true}));`);
  await js(win, `document.getElementById('target').dispatchEvent(new PointerEvent('pointermove', {bubbles:true, pointerType:'mouse'}));`);
  await js(win, `document.getElementById('target').dispatchEvent(new PointerEvent('pointermove', {bubbles:true, pointerType:'touch'}));`);
  await js(win, `document.getElementById('target').dispatchEvent(new MouseEvent('click', {bubbles:true}));`);
  await new Promise(r => setTimeout(r, 200));
  let c = JSON.parse(await counts());
  allPass &= check('ガード中: マウス由来mousemoveは遮断', c.mousemove, 0);
  allPass &= check('ガード中: マウス由来pointermoveは遮断', c.pmMouse, 0);
  allPass &= check('ガード中: タッチ由来pointermoveは许容', c.pmTouch, 1);
  allPass &= check('ガード中: クリックは明示操作なので许容', c.click, 1);

  // --- ガード期間終了後 ---
  await new Promise(r => setTimeout(r, GUARD_MS + 500));
  await js(win, `document.getElementById('target').dispatchEvent(new MouseEvent('mousemove', {bubbles:true}));`);
  await new Promise(r => setTimeout(r, 200));
  c = JSON.parse(await counts());
  allPass &= check('期間終了後: mousemoveは通常通り届く', c.mousemove, 1);

  // --- 再発動（多重インストール）とクリーンアップ ---
  await js(win, GUARD);
  await js(win, `document.getElementById('target').dispatchEvent(new PointerEvent('pointermove', {bubbles:true, pointerType:'mouse'}));`);
  await js(win, `document.getElementById('target').dispatchEvent(new PointerEvent('pointermove', {bubbles:true, pointerType:'touch'}));`);
  await new Promise(r => setTimeout(r, 200));
  c = JSON.parse(await counts());
  allPass &= check('再発動中: マウス由来pointermoveは遮断', c.pmMouse, 0);
  allPass &= check('再発動中: タッチは许容', c.pmTouch, 2);

  await js(win, 'window.__kbMouseGuardCleanup();');
  await js(win, `document.getElementById('target').dispatchEvent(new PointerEvent('pointermove', {bubbles:true, pointerType:'mouse'}));`);
  await new Promise(r => setTimeout(r, 200));
  c = JSON.parse(await counts());
  allPass &= check('手動クリーンアップ後: マウス由来でも届く', c.pmMouse, 1);

  console.log(JSON.stringify({ overall: allPass ? 'ALL PASS' : 'FAIL' }));
  app.exit(allPass ? 0 : 1);
});
