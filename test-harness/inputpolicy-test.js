// タッチキーボード抑止（属性のみ）検証テスト
// input-policy.js（スクリプト本体）をスタブページで実行し挙動を実測する
// 期待: inputmode=noneは全input/textarea（既存・動的追加）に適用されるが、
//       フォーカスは奪われない（アクティブ要素のまま）＝グレーアウト要因消除。readonlyは付与しない。
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'input-policy.js'), 'utf8');

const PAGE = `<!doctype html><html><head></head><body style="margin:0">
<input id="static1"><textarea id="static2"></textarea>
<script>
window.__addDyn = function() {
  const i = document.createElement('input');
  i.id = 'dyn1';
  document.body.appendChild(i);
  return 'added';
};
window.__state = function(id) {
  const el = document.getElementById(id);
  return {
    inputmode: el.getAttribute('inputmode'),
    readonly: el.getAttribute('readonly'),
    active: document.activeElement === el
  };
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

const settle = () => new Promise(r => setTimeout(r, 300));

app.whenReady().then(async () => {
  setTimeout(() => { console.log('TIMEOUT'); app.exit(2); }, 90000).unref?.();

  const win = new BrowserWindow({
    width: 800, height: 600, show: false,
    webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true }
  });
  await win.loadURL('data:text/html;base64,' + Buffer.from(PAGE).toString('base64'));

  let allPass = true;

  await js(win, CODE);
  await settle();

  // 既存要素にはインストール時点で適用
  let s = await js(win, "window.__state('static1')");
  allPass &= check('既存input: inputmode=none', s.inputmode, 'none');
  allPass &= check('既存input: readonlyは付与しない（物理キーボード入力可）', s.readonly, null);

  let s2 = await js(win, "window.__state('static2')");
  allPass &= check('既存textarea: inputmode=none', s2.inputmode, 'none');

  // 動的追加要素にはMutationObserver経由で適用
  await js(win, 'window.__addDyn()');
  await settle();
  s = await js(win, "window.__state('dyn1')");
  allPass &= check('動的追加input: inputmode=none', s.inputmode, 'none');
  allPass &= check('動的追加input: readonlyは付与しない', s.readonly, null);

  // フォーカスは奪われない: ゲーム本体がinputをフォーカスした状態を再現
  await js(win, "document.getElementById('dyn1').focus()");
  await settle();
  s = await js(win, "window.__state('dyn1')");
  allPass &= check('フォーカス解除されない（アクティブ要素のまま＝グレーアウトしない）', s.active, true);

  await js(win, "document.getElementById('static1').focus()");
  await settle();
  s = await js(win, "window.__state('static1')");
  allPass &= check('既存inputへのフォーカスも解除されない', s.active, true);

  // 再適用（ページ再読込で二重に走る経路）で例外が出ないこと
  await js(win, CODE);
  await settle();
  s = await js(win, "window.__state('static1')");
  allPass &= check('再適用後も状態は同一', s.inputmode, 'none');

  console.log(JSON.stringify({ overall: allPass ? 'ALL PASS' : 'FAIL' }));
  app.exit(allPass ? 0 : 1);
});
