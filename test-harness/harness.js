// レターボックス（黒塗り）仕様の検証ハーネス v3
// 修正点: CODEをそのままexecuteJavaScriptに渡す（トップレベル完了値として戻り値を取得）
//        単一ウィンドウで1920x1080 → リサイズで900x1400（アプリ本体のresize経路も通す）
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const m = src.match(/const BOOKMARKLET_CODE = `([\s\S]*?)`;/);
if (!m) { console.log('EXTRACT_FAIL'); app.exit(1); }
const CODE = m[1];

const PAGE = `<!doctype html><html><head></head><body style="margin:0;background:#fff">
<div id="page" style="width:1200px;background:#fff">
<div id="game_frame" style="width:1200px;height:860px;background:#fff">
<div id="game_area" style="height:720px;background:#f00"></div>
<div id="padding_area" style="height:140px;background:#00f"></div>
</div></div></body></html>`;

const PROBE = `(function(){
  window.__probe = function(x, y) {
    const els = document.elementsFromPoint(x, y);
    for (const el of els) {
      if (el.id === 'kb-black-backdrop') return 'BLACK(backdrop)';
      if (el.id === 'game_area' || (el.closest && el.closest('#game_area'))) return 'GAME(red)';
      if (el.id === 'padding_area' || (el.closest && el.closest('#padding_area'))) return 'PADDING(blue)';
    }
    return 'NONE/white';
  };
  window.__state = function() {
    const gf = document.getElementById('game_frame');
    const cs = getComputedStyle(gf);
    const r = gf.getBoundingClientRect();
    return {
      htmlOverflow: document.documentElement.style.overflow || '(unset)',
      htmlBg: document.documentElement.style.backgroundColor || '(unset)',
      bodyBg: document.body.style.backgroundColor || '(unset)',
      backdropExists: !!document.getElementById('kb-black-backdrop'),
      inline: { position: gf.style.position || '(unset)', top: gf.style.top || '(unset)', left: gf.style.left || '(unset)',
                transform: gf.style.transform || '(unset)', zIndex: gf.style.zIndex || '(unset)', clipPath: gf.style.clipPath || '(unset)' },
      computed: { transform: cs.transform, top: cs.top, left: cs.left, zIndex: cs.zIndex, clipPath: cs.clipPath },
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      inner: [window.innerWidth, window.innerHeight]
    };
  };
  return 'ok';
})()`;

async function phase(win, label, points) {
  const out = { label };
  out.bookmarkletReturn = '(see below)';
  out.state = await win.webContents.executeJavaScript('window.__state()');
  out.probes = {};
  for (const p of points) {
    out.probes['p' + p[0] + '_' + p[1]] = await win.webContents.executeJavaScript(`window.__probe(${p[0]}, ${p[1]});`);
  }
  console.log(JSON.stringify(out));
}

app.whenReady().then(async () => {
  setTimeout(() => { console.log('TIMEOUT'); app.exit(2); }, 90000).unref?.();

  try {
    const win = new BrowserWindow({
      width: 1400, height: 700, show: false,
      webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true }
    });
    await win.loadURL('data:text/html;base64,' + Buffer.from(PAGE).toString('base64'));

    // ブックマークレットをそのまま実行 → トップレベル完了値=戻り値を取得
    const ret = await win.webContents.executeJavaScript(CODE);
    console.log(JSON.stringify({ label: 'bookmarklet-return', value: ret === undefined ? 'undefined(!)' : ret }));

    await win.webContents.executeJavaScript(PROBE);

    // 2:1 → 高さ基準拡大・左右に黒帯（境界は x<116 / x>1284）
    await phase(win, 'landscape-1400x700', [
      [700, 350],   // 中央 = ゲーム(赤)
      [50, 350],    // 左黒帯 = 黒
      [1350, 350],  // 右黒帯 = 黒
    ]);

    // リサイズ → アプリ本体のresizeハンドラ経路（デバウンス10ms）
    win.setBounds({ x: 100, y: 100, width: 900, height: 1400 });
    await new Promise(r => setTimeout(r, 800));
    await phase(win, 'portrait-900x1400', [
      [450, 700],   // 上下中央 = ゲーム(赤)
      [450, 100],   // 上レターボックス = 黒
      [450, 1300],  // 下レターボックス = 黒
      [450, 1020],  // 下部不要領域 = 現在青(バグ) / 期待:黒
    ]);
  } catch (e) {
    console.log(JSON.stringify({ error: String((e && e.stack) || e) }));
  }
  app.exit(0);
});
