// タッチホバー抑止フィルタ（v5）検証テスト
// touchhover.js（スクリプト本体）をスタブページで実行し「何が届く/届かない/何が要求されるか」を実測する
//
// v5の設計（v4からの追加）:
//  - ボタンが押まれている（buttons>0）＝ドラッグの操作パイプライン → 什么都许容
//    （press→move→release の列で完結する。move/overを止めるとゲームAS3のドラッグが壊れ、
//      ドロップ先が列表本体＝レシピ消去になる＝実測の不具合）
//  - 操作終了時の解除要求は「動かずに離されたタップ」のみ。動かされたドラッグは
//    ゲーム自身の離され処理に任せる（閾値10px）
//  v4から不変:
//  1. タッチ運用（直前ポインターがtouch）のホバー（ボタン非押下）は由来を問わず遮断
//  2. 実マウス→タッチ切り替え時の解除要求。実行はCDP trusted入力（判定と要求だけを担当）
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

// スクリプト本体（単一の源）
const FILTER = fs.readFileSync(path.join(__dirname, '..', 'touchhover.js'), 'utf8');

const PAGE = `<!doctype html><html><head></head><body style="margin:0">
<div id="target" style="width:400px;height:400px;background:#eee"></div>
<script>
window.__counts = { native: {}, synth: {} };
window.__clearRequests = 0;
window.__kbHoverClearRequest = function() { window.__clearRequests++; };
var TYPES = ['pointerdown','pointerup','pointermove','pointerover','pointerenter','pointerleave','pointerout',
             'mousemove','mouseover','mouseenter','mouseleave','mouseout','mousedown','mouseup','click'];
var t = document.getElementById('target');
TYPES.forEach(function(type) {
  t.addEventListener(type, function(e) {
    var bucket = e._kbSynthetic ? 'synth' : 'native';
    window.__counts[bucket][type] = (window.__counts[bucket][type] || 0) + 1;
  });
});
window.__dispP = function(type, pt, x, y, buttons) {
  document.getElementById('target').dispatchEvent(
    new PointerEvent(type, { bubbles: true, pointerType: pt, clientX: x, clientY: y, buttons: buttons || 0 }));
};
window.__dispM = function(type, x, y) {
  document.getElementById('target').dispatchEvent(
    new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
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

const settle = () => new Promise(r => setTimeout(r, 200));

app.whenReady().then(async () => {
  setTimeout(() => { console.log('TIMEOUT'); app.exit(2); }, 90000).unref?.();

  const win = new BrowserWindow({
    width: 800, height: 600, show: false,
    webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: false }
  });
  await win.loadURL('data:text/html;base64,' + Buffer.from(PAGE).toString('base64'));

  let allPass = true;
  const native = async (type) => JSON.parse(await js(win, "JSON.stringify(window.__counts.native)"))[type];
  const clearRequests = async () => await js(win, 'window.__clearRequests');

  // --- フィルタ適用 ---
  await js(win, FILTER);

  // --- 実マウス運用: ホバーは许容。このホバーが「古い状態」の元になる ---
  await js(win, "window.__dispP('pointerover','mouse',100,200)");
  await js(win, "window.__dispP('pointermove','mouse',100,200)");
  await settle();
  allPass &= check('マウス運用: pointerover/pointermoveは届く', await native('pointerover'), 1);
  allPass &= check('同: pointermove', await native('pointermove'), 1);
  allPass &= check('マウス運用中は解除要求しない（要求0）', await clearRequests(), 0);

  // --- タッチ引き継ぎ: 最初のタッチイベントで古いホバー状態の解除を要求する ---
  await js(win, "window.__dispP('pointerdown','touch',120,240)");
  await settle();
  allPass &= check('操作(pointerdown)は许容', await native('pointerdown'), 1);
  allPass &= check('切り替えで解除要求（v4: CDP経由）', await clearRequests(), 1);

  // --- タッチ運用中の「ホバー」（ボタン非押下）は由来を問わず遮断 ---
  await js(win, "window.__dispP('pointerover','touch',100,200)");
  await js(win, "window.__dispP('pointermove','touch',100,200)");
  await settle();
  allPass &= check('touch運用中のpointeroverは遮断', await native('pointerover'), 1);
  allPass &= check('同: pointermove', await native('pointermove'), 1);

  // --- 操作終了: 動かずに離されたタップ → 操作対象の解除を要求する ---
  await js(win, "window.__dispP('pointerup','touch',120,240)"); // 押し位置(120,240)から無移動＝タップ
  await settle();
  allPass &= check('操作(pointerup)は许容', await native('pointerup'), 1);
  allPass &= check('タップ終了で解除要求（2回目）', await clearRequests(), 2);

  // --- ドラッグ列（v5の要点）: 押下→移動→領域内要素へover→離す。什么都许容で、要求しない ---
  await js(win, "window.__dispP('pointerdown','touch',100,100,1)"); // 押下（許容）
  await settle();
  allPass &= check('ドラッグ: pointerdownは许容', await native('pointerdown'), 2);
  await js(win, "window.__dispP('pointermove','touch',300,300,1)"); // ボタン押下中の移動＝操作 → 许容
  await js(win, "window.__dispP('pointerover','touch',300,300,1)"); // ボタン押下中のover＝ドラッグ応答 → 许容
  await settle();
  allPass &= check('ドラッグ: ボタン押下中のpointermoveは许容', await native('pointermove'), 2);
  allPass &= check('ドラッグ: ボタン押下中のpointeroverは许容', await native('pointerover'), 2);
  await js(win, "window.__dispP('pointerup','touch',300,300)"); // 押下位置から200px動いた＝ドラッグ完了
  await settle();
  allPass &= check('ドラッグ: pointerupは许容', await native('pointerup'), 2);
  allPass &= check('ドラッグでは解除要求しない（ゲーム自身の離され処理＝要求2のまま）', await clearRequests(), 2);

  // --- 実マウス復帰: 再び许容 ---
  await js(win, "window.__dispP('pointerover','mouse',100,200)");
  await settle();
  allPass &= check('マウス復帰後のpointeroverは许容', await native('pointerover'), 3);

  // クリックは许容
  await js(win, "document.getElementById('target').dispatchEvent(new MouseEvent('click', {bubbles:true})); 'ok'");
  await settle();
  allPass &= check('クリックは许容', await native('click'), 1);

  // --- 再インストールで状態リセット確認 ---
  await js(win, FILTER);
  await js(win, "window.__dispP('pointerover','touch',100,200)");
  await settle();
  allPass &= check('再適用後もtouch由来（ボタン非押下）は遮断（二重登録なし）', await native('pointerover'), 3);

  await js(win, 'window.__kbTouchHoverCleanup();');
  await js(win, "window.__dispP('pointerover','touch',100,200)");
  await settle();
  allPass &= check('クリーンアップ後はtouch由来でも届く', await native('pointerover'), 4);

  console.log(JSON.stringify({ overall: allPass ? 'ALL PASS' : 'FAIL' }));
  app.exit(allPass ? 0 : 1);
});
