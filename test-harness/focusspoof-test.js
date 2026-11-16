// フォーカスspoof（focus-spoof.js）検証テスト
// preloadスクリプトをスタブページで「ページスクリプトより先」に実行し、
// ゲーム本体側の登録（spoof適用後に登録される）に何が届く/届かないを実測する
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SPOOF = fs.readFileSync(path.join(__dirname, '..', 'focus-spoof.js'), 'utf8');

const PAGE = `<!doctype html><html><head></head><body style="margin:0">
<input id="dyn1">
<script>
window.__fired = [];
function mark(name) { return function() { window.__fired.push(name); }; }

// spoof適用後の登録＝ゲーム本体側の登録の位置（正常系はそのまま届く）
window.__gameListenerCount = 0;
window.addEventListener('blur', function(e) { window.__gameListenerCount++; });
window.addEventListener('focus', function() { window.__gameListenerCount += 10; });

window.__fire = function(type) { window.dispatchEvent(new Event(type)); return 'ok'; };
window.__focusIn = function() { document.getElementById('dyn1').focus(); return 'ok'; };
window.__focusOut = function() { document.getElementById('dyn1').blur(); return 'ok'; };
window.__hasFocus = function() { return document.hasFocus(); };
window.__setProp = function(prop, name) {
  window[prop] = mark(name);
  return 'ok';
};
window.__unsetProp = function(prop) { window[prop] = null; return 'ok'; };
window.__removeGame = function() {
  // 同名関数で削除できないので、削除経路自体は別途確認する（hereではスキップ）
  return 'skip';
};
</script>
</body></html>`;

function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
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
    webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: false }
  });
  await win.loadURL('data:text/html;base64,' + Buffer.from(PAGE).toString('base64'));

  let allPass = true;

  // stub内スクリプトが先に登録 → その後spoof（=実際のpreloadの位置）をここで適用する。
  // 本来のpreloadではspoofが先に走るため、ゲーム本体の登録は必ずラップ経路に乗る。
  // ここでは「spoof適用前の登録」はラップ対象外＝そのまま届くことも確認できる。
  // （ゲーム本体の登録はspoofより後なので、挙動は下の「プロパティ代入型」経路で検証する）

  // --- apply spoof ---
  await js(win, SPOOF);

  // （診断ログは機構ごと削除済みのため、このテストは挙動のみを検証する）

  // 入力中（input focusあり）のblur = OSキーボード由来 → 届かない
  await js(win, "window.__focusIn()");
  await js(win, "window.__fire('blur')");
  // スタブ側の元登録はspoof前なので素通りする → ここでは到達を観測し、
  // ラップ経路（spoof後の登録）はプロパティ代入型で検証する
  let fired = await js(win, "window.__fired.slice()");
  let game = await js(win, "window.__gameListenerCount");
  allPass &= check('spoof前登録: 入力中blurも素通り（仕様: ラップは適用後登録のみ）', game, 1);

  // hasFocus: 入力中はtrueと報告（オフスクリーン=原生はfalse）
  let hf = await js(win, "window.__hasFocus()");
  allPass &= check('hasFocus(): 入力中はtrueと報告', hf, true);

  await js(win, "window.__focusOut()");
  hf = await js(win, "window.__hasFocus()");
  allPass &= check('hasFocus(): 常時true（常時フォーカスあり扱い）', hf, true);

  // --- visibility経路（ゲーム本体の直接読み／visibilitychange登録） ---
  let vs = await js(win, "document.visibilityState");
  allPass &= check('visibilityState: 常時visible', vs, 'visible');
  let hid = await js(win, "document.hidden");
  allPass &= check('hidden: 常時false', hid, false);
  await js(win, "window.__vcFired = 0; document.addEventListener('visibilitychange', function(){ window.__vcFired++; }); 'ok'");
  await js(win, "document.dispatchEvent(new Event('visibilitychange')); 'ok'");
  let vc = await js(win, "window.__vcFired");
  allPass &= check('visibilitychangeはゲーム本体に届けない', vc, 0);

  // activeElement: 入力要素は「フォーカスされたまま」とみなす
  await js(win, "document.getElementById('dyn1').focus()");
  let ae = await js(win, "document.activeElement === document.getElementById('dyn1')");
  allPass &= check('activeElement: 入力要素フォーカス中はそのまま', ae, true);
  await js(win, "document.getElementById('dyn1').blur()");
  ae = await js(win, "document.activeElement === document.getElementById('dyn1')");
  allPass &= check('activeElement: 原生値がbodyに戻っても入力要素扱い', ae, true);

  // --- プロパティ代入型（spoof後の代入＝ゲーム本体がこの方式だった場合） ---
  await js(win, "window.__setProp('onblur', 'blurProp')");
  await js(win, "window.__setProp('onfocus', 'focusProp')");

  // 入力中のblur → 届かない
  await js(win, "window.__focusIn()");
  await js(win, "window.__fire('blur')");
  fired = await js(win, "window.__fired.slice()");
  allPass &= check('代入型onblur: 入力中のblurは届かない（グレーアウトしない）', fired.length, 0);

  // 入力中のfocus（キーボードから戻った）→ 届く（正常な復帰動作）
  await js(win, "window.__fire('focus')");
  fired = await js(win, "window.__fired.slice()");
  allPass &= check('代入型onfocus: focusはそのまま届く', fired, ['focusProp']);

  // 入力状態解除後のblur → 常時フォーカスあり扱いなのでやはり届かない
  await js(win, "window.__focusOut()");
  await js(win, "window.__fire('blur')");
  fired = await js(win, "window.__fired.slice()");
  allPass &= check('代入型onblur: 入力状態以外でも届かない（常時spoof）', fired, ['focusProp']);

  // 代入値の読み出しは代入された関数のまま（fidelity）
  let same = await js(win, "typeof window.onblur === 'function'");
  allPass &= check('代入したハンドラの読み出し型', same, true);

  // 代入解除（null）後は呼ばれない（＋そもそもblurは常時遮断なので追加はない）
  await js(win, "window.__unsetProp('onblur')");
  await js(win, "window.__focusIn()");
  await js(win, "window.__fire('blur')");
  await js(win, "window.__focusOut()");
  await js(win, "window.__fire('blur')");
  fired = await js(win, "window.__fired.slice()");
  allPass &= check('代入解除のハンドラは呼ばれない', fired, ['focusProp']);

  // --- focusout/focusin（documentレベル・spoof適用後の登録＝ゲーム本体の登録位置） ---
  // 更新ボタン押下時、ゲームは入力確定後に自分でinputをblurさせる → focusoutが発生する。
  // これがゲーム本体に届くと「フォーカス喪失」判定でグレーアウトになる（今回のバグ修正箇所）。
  // ※オフスクリーンページではプログラム focus()/blur() はイベントを発火しないため、
  //   経路検証は dispatchEvent（bubbles）で行う
  await js(win, "window.__docFired = [];"
    + "document.addEventListener('focusout', function(){ window.__docFired.push('focusOut'); });"
    + "document.addEventListener('focusin', function(){ window.__docFired.push('focusIn'); });");
  await js(win, "document.getElementById('dyn1').dispatchEvent(new Event('focusout', {bubbles:true})); 'ok'");
  let df = await js(win, "window.__docFired.slice()");
  allPass &= check('document-level focusout（喪失）はゲーム本体に届けない', df, []);
  await js(win, "document.getElementById('dyn1').dispatchEvent(new Event('focusin', {bubbles:true})); 'ok'");
  df = await js(win, "window.__docFired.slice()");
  allPass &= check('document-level focusin（獲得）は届ける', df, ['focusIn']);

  // --- 清理（再適用）後 ---
  await js(win, "window.__kbFocusSpoofCleanup()");
  // 清理後のdocument登録は原生経路 → focusoutも届く（spoof適用中の登録は清理で解除済み）
  await js(win, "document.addEventListener('focusout', function(){ window.__docFired.push('focusOutNative'); });");
  await js(win, "document.getElementById('dyn1').dispatchEvent(new Event('focusout', {bubbles:true})); 'ok'");
  df = await js(win, "window.__docFired.slice()");
  allPass &= check('清理後: focusoutも届く（spoof解除）', df, ['focusIn', 'focusOutNative']);
  // 清理後は代入→原生プロパティにそのまま格納されるので原生ディスパッチで呼ばれる＝届く
  await js(win, "window.__setProp('onblur', 'blurNative')");
  await js(win, "window.__focusIn()");
  await js(win, "window.__fire('blur')");
  fired = await js(win, "window.__fired.slice()");
  allPass &= check('清理後: 代入型は原生ディスパッチで届く（spoof解除）', fired, ['focusProp', 'blurNative']);

  await js(win, "window.__unsetProp('onfocus')");

  console.log(JSON.stringify({ overall: allPass ? 'ALL PASS' : 'FAIL' }));
  app.exit(allPass ? 0 : 1);
});
