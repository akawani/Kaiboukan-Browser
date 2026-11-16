const { app, BrowserWindow, Menu, powerMonitor, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let Store; // グローバルに宣言
let store;

// （廃止: Shift_JISオーバーライド → 出力をUTF-8に統一。ターミナル側もUTF-8で
//   表示すること。Windows Terminalなら既定で正しく表示されます）

const TARGET_URL = 'https://play.games.dmm.com/game/kancolle';

// 艦これ本体はクロスオリジンiframe（osapi.dmm.com/gadgets…）で動く（実機プローブで確認）。
// 実測: 注入先をそのURLマッチフレームに絞っていたが、実操作のポインターイベントは
// その文書を通らない（＝実キャンバスは入れ子のさらに深い子フレームにある＝DOMイベントは
// documentsを跨がない）。よってルート以外の全フレームに注入する。スクリプトはすべて冪等。
const INJECT_SCRIPTS = ['focusSpoof', 'touchHover', 'inputPolicy'];

// レンダラーログをターミナルに流す（touchhoverの動作ログ＝実機構観察のため。UTF-8出力）。
app.commandLine.appendSwitch('enable-logging', 'stderr');

const BOOKMARKLET_CODE = `
(($, _) => {
  try {
    const html = $.documentElement;
    const gf = $.getElementById('game_frame');

    if (!gf) {
      console.warn('game_frame要素が見つかりません');
      return false;
    }

    const gs = gf.style;
    const gw = gf.offsetWidth;
    const gh = gw * 0.6;
    const frameHeight = gf.offsetHeight;
    const bottomPadding = frameHeight - gh;

    let vp = $.querySelector('meta[name=viewport]');
    let t = 0;

    if (!vp) {
      vp = $.createElement('meta');
      vp.name = 'viewport';
      $.querySelector('head').appendChild(vp);
    }

    vp.content = 'width=' + gw;

    if ('orientation' in _ && html.webkitRequestFullscreen) {
      html.webkitRequestFullscreen();
    }

    html.style.overflow = 'hidden';
    html.style.backgroundColor = '#000';
    $.body.style.cssText = 'min-width:0;overflow:hidden;margin:0;background-color:#000';

    const ntgnavi = $.querySelector('.dmm-ntgnavi');
    if (ntgnavi) ntgnavi.style.display = 'none';

    const naviapp = $.querySelector('.area-naviapp');
    if (naviapp) naviapp.style.display = 'none';

    const recommend = $.getElementById('ntg-recommend');
    if (recommend) recommend.style.display = 'none';

    // 黒地（レターボックス）: game_frame以外の領域を黒で覆う固定バックグラウンド
    let backdrop = $.getElementById('kb-black-backdrop');
    if (!backdrop) {
      backdrop = $.createElement('div');
      backdrop.id = 'kb-black-backdrop';
      backdrop.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background-color:#000;z-index:2147483000';
      $.body.appendChild(backdrop);
    }

    gs.position = 'fixed';
    gs.right = '0';
    gs.zIndex = '2147483100';
    gs.backgroundColor = '#000';  // game_frame内の余白部分（下部など）も黒に

    // 下部の不要部分（bottomPadding）をクリップして黒地（バックドロップ）が見えるようにする
    gs.clipPath = bottomPadding > 0 ? 'inset(0 0 ' + bottomPadding + 'px 0)' : 'none';

    gs.top = '50%';
    gs.left = '50%';
    gs.transformOrigin = '50% 0';

    if (!_.kancolleFit) {
      const k = () => {
        const w = html.clientWidth;
        const h = _.innerHeight;
        let scale;

        if (w / h < gw / gh) {
          scale = w / gw;
        } else {
          scale = h / gh;
        }

        const visibleHeight = gh * scale;
        const topOffset = (h - visibleHeight) / 2;

        gs.transform = 'translate(-50%, 0) scale(' + scale + ')';
        gs.top = topOffset + 'px';
        gs.left = '50%';
      };
      _.addEventListener('resize', () => {
        clearTimeout(t);
        t = setTimeout(k, 10);
      });
      _.kancolleFit = k;
    }
    kancolleFit();
    return true;
  } catch (error) {
    return { success: false, errorMessage: String(error.message || error) };
  }
})(document, window);
`;

// 放置復帰時のマウスガード: レジューム/ロック解除時にシステムが合成する
// 「ホバー系」マウスイベント（勝手にフォーカスが当たる原因）のみ短时间遮断する。
// クリック・ボタン押下は明示的なマウス操作なので対象外。タッチ操作も許容する。
// ※スクリプト本体は mouseguard.js（テストハーネスが同ファイルを読む。1000ms埋め込み）
const MOUSEGUARD_MS = 1000; // ※ mouseguard.js 内の値と同期させること
const MOUSEGUARD_CODE = fs.readFileSync(path.join(__dirname, 'mouseguard.js'), 'utf8');

// タッチ操作時のホバー抑止（常設、v2）: スクリプト本体は touchhover.js。
//   実マウス運用（カーソル表示あり）のホバーは许容。タッチ運用（カーソル非表示状態）では
//   ホバーを由来を問わず抑止し、実マウス→タッチの切り替え時とタッチ操作終了時に
//   古いホバー状態（当たり判定）を out/leave 合成で解除する。操作そのものは许容。
const TOUCHHOVER_CODE = fs.readFileSync(path.join(__dirname, 'touchhover.js'), 'utf8');

// ゲームフレーム注入用スクリプト内容（単一の源＝ファイル。focus-spoofはトップフレームには
// プリロードとして読み込まれる）。スクリプトはすべて冪等（再適用=自前クリーンアップ）。
const SCRIPT_CONTENTS = {
  focusSpoof: fs.readFileSync(path.join(__dirname, 'focus-spoof.js'), 'utf8'),
  touchHover: TOUCHHOVER_CODE,
  inputPolicy: fs.readFileSync(path.join(__dirname, 'input-policy.js'), 'utf8'),
  mouseGuard: MOUSEGUARD_CODE,
};

// フレームツリー全体（E28-safe: frame.frames の再帰。framesInSubtree は v30+ で存在しない）
function walkFrames(root) {
  const out = [root];
  const kids = root.frames || [];
  for (const k of kids) {
    out.push(...walkFrames(k));
  }
  return out;
}

// ルート以外の全フレームに注入（ルートは既存の実行経路が既にカバー済み。
//  子フレームはDOMイベントが文書を跨がないため、ここに注入しなければイベントが見えない）。
//  実行自体は再走させても安全（スクリプト冪等）。ログはフレームごとに初回のみ。
const injectedLogged = new Set();
let noChildLogged = false;
function injectIntoGameFrames(win) {
  if (isExiting || win.isDestroyed()) {
    return;
  }
  try {
    const frames = walkFrames(win.webContents.mainFrame).slice(1);
    if (frames.length === 0) {
      if (!noChildLogged) {
        noChildLogged = true;
        console.log('子フレーム未検出（ルートのみ）');
      }
      return;
    }
    for (const f of frames) {
      const short = (f.url || '(URL未確定)').split('#')[0].slice(0, 100);
      if (!injectedLogged.has(short)) {
        injectedLogged.add(short);
        console.log('フレーム検出（初回）→ 注入: ' + INJECT_SCRIPTS.join(',') + ' @ ' + short);
      }
      for (const key of INJECT_SCRIPTS) {
        f.executeJavaScript(SCRIPT_CONTENTS[key]).catch(() => {});
      }
    }
  } catch (e) {
    console.error('フレームスキャンエラー:', e);
  }
}

let escPressTime = null;
const ESC_TIMEOUT = 5000;
let escTimeoutTimer = null;
let isExiting = false;
let mainWindow = null;

function createWindow() {
  Menu.setApplicationMenu(null);

  const savedBounds = store.get('windowBounds');
  const defaultBounds = {
    width: 1600,
    height: 900,
    x: undefined,
    y: undefined
  };

  const bounds = savedBounds || defaultBounds;

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    frame: true,
    fullscreen: store.get('wasFullscreen', true),
    skipTaskbar: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      // フォーカスspoof（focus-spoof.js）はメインワールドでページスクリプトより先に走る必要があるため
      // contextIsolation は false（このアプリにcontextBridge利用箇所はない）
      contextIsolation: false,
      preload: path.join(__dirname, 'focus-spoof.js'),
      webviewTag: false,
      devTools: true
    }
  });

  mainWindow = win;

  // コンソール中継: sandboxワールドではプレロードと注入スクリプトのグローバルが共有できない
  // ため、ワールド側の要求はコンソールが唯一確実に跨れる経路（機構そのもの・silent）。
  // 動作の証左は trustedHoverClear 側が実行時（またはエラー時）に1行だけ出す。
  win.webContents.on('console-message', (event, level, message) => {
    if (typeof message === 'string' && message.indexOf('[KB-REQ]') === 0) {
      trustedHoverClear();
    }
  });

  if (process.env.NODE_ENV === 'development') {
    win.webContents.openDevTools();
  }

  win.loadURL(TARGET_URL);

  win.on('resize', () => {
    if (!win.isFullScreen()) {
      store.set('windowBounds', win.getBounds());
    }
  });

  win.on('move', () => {
    if (!win.isFullScreen()) {
      store.set('windowBounds', win.getBounds());
    }
  });

  win.on('enter-full-screen', () => {
    store.set('wasFullscreen', true);
  });

  win.on('leave-full-screen', () => {
    store.set('wasFullscreen', false);
  });

  win.on('close', () => {
    if (!win.isFullScreen()) {
      store.set('windowBounds', win.getBounds());
    }
    store.set('wasFullscreen', win.isFullScreen());
  });

  win.webContents.on('did-finish-load', () => {
    console.log('ページ読み込み完了 - ブックマークレット実行');
    executeBookmarklet(win);

    disableTouchKeyboard(win);

    applyTouchHoverFilter(win);

    // ゲーム本体ワールド（クロスオリジンiframe）にも同一スクリプトを注入
    injectIntoGameFrames(win);

    setTimeout(() => {
      console.log('起動後3秒経過 - ブックマークレット実行');
      executeBookmarklet(win);
      injectIntoGameFrames(win);
    }, 3000);

    setTimeout(() => {
      console.log('起動後10秒経過 - ブックマークレット実行');
      executeBookmarklet(win);
      injectIntoGameFrames(win);
    }, 10000);

    showFullscreenHint(win);
  });

  setInterval(() => {
    console.log('定期実行 - ブックマークレット実行');
    executeBookmarklet(win);
  }, 60000);

  // ゲームフレーム（艦これ本体ワールド）が後から生成・导航された場合の取りこぼし防止
  // （frame-created は v30+。E28では did-frame-navigate が実働のフック）
  win.webContents.on('frame-created', () => {
    setTimeout(() => injectIntoGameFrames(win), 3000);
  });
  win.webContents.on('did-frame-navigate', () => {
    //  navigation 確定直後のフレームはURLが確定していない場合があるため少し待つ
    setTimeout(() => injectIntoGameFrames(win), 500);
  });
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown') {

      if (isExiting) {
        event.preventDefault();
        return;
      }

      if (input.key === 'Escape') {
        event.preventDefault();
        handleEscapeKey(win);
        return;
      }

      if (escPressTime !== null && input.key === ' ' && !isExiting) {
        event.preventDefault();
        resetEscapeState(win);
        return;
      }

      const isF11 = input.key === 'F11';
      const isCtrlSpace = input.control && input.key === ' ';

      if (isF11 || isCtrlSpace) {
        event.preventDefault();
        toggleFullscreen(win);
      }
    }
  });
}

function handleEscapeKey(win) {
  const now = Date.now();

  if (escPressTime === null) {
    escPressTime = now;
    showExitWarning(win);
    console.log('ESC 1回目 - 終了警告表示（5秒以内に再度ESCで終了、Spaceで解除）');

    escTimeoutTimer = setTimeout(() => {
      if (escPressTime !== null) {
        resetEscapeState(win);
        console.log('ESC状態タイムアウト - 自動リセット');
      }
    }, ESC_TIMEOUT);

  } else if (now - escPressTime < ESC_TIMEOUT) {
    console.log('ESC 2回目 - アプリ終了');

    isExiting = true;

    if (escTimeoutTimer) {
      clearTimeout(escTimeoutTimer);
    }

    removePopup(win, 'exit-warning');

    if (!win.isDestroyed()) {
      win.hide();
    }

    setTimeout(() => {
      app.quit();
    }, 100);
  }
}

function resetEscapeState(win) {
  escPressTime = null;

  if (escTimeoutTimer) {
    clearTimeout(escTimeoutTimer);
    escTimeoutTimer = null;
  }

  if (!win.isDestroyed()) {
    removePopup(win, 'exit-warning');
  }

  console.log('ESC状態リセット（Space押下または自動） - 通常画面に戻る');
}

function toggleFullscreen(win) {
  if (win.isFullScreen()) {
    console.log('全画面解除 → ウィンドウモード');
    win.setFullScreen(false);
    win.setSize(1600, 900);
    win.center();

    Menu.setApplicationMenu(null);

    showFullscreenHintForced(win);

    executeBookmarklet(win);

    setTimeout(() => {
      console.log('画面切り替え後3秒経過 - ブックマークレット実行');
      executeBookmarklet(win);
    }, 3000);

    setTimeout(() => {
      console.log('画面切り替え後10秒経過 - ブックマークレット実行');
      executeBookmarklet(win);
    }, 10000);

  } else {
    console.log('ウィンドウモード → 全画面');
    win.setFullScreen(true);

    Menu.setApplicationMenu(null);

    showFullscreenHintForced(win);

    executeBookmarklet(win);

    setTimeout(() => {
      console.log('画面切り替え後3秒経過 - ブックマークレット実行');
      executeBookmarklet(win);
    }, 3000);

    setTimeout(() => {
      console.log('画面切り替え後10秒経過 - ブックマークレット実行');
      executeBookmarklet(win);
    }, 10000);
  }
}

function showExitWarning(win) {
  const warningCode = `
    if (!document.getElementById('exit-warning')) {
      const warning = document.createElement('div');
      warning.id = 'exit-warning';
      warning.style.cssText = \`
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(220, 38, 38, 0.95);
        color: white;
        padding: 30px 50px;
        border-radius: 12px;
        font-size: 24px;
        font-family: sans-serif;
        font-weight: bold;
        z-index: 2147483646;
        box-shadow: 0 8px 16px rgba(0,0,0,0.5);
        animation: pulse 0.5s ease-in-out;
        text-align: center;
      \`;
      warning.innerHTML = '⚠️ 再度ESCを押すと終了します（Spaceで解除）';
      document.body.appendChild(warning);

      if (!document.getElementById('exit-warning-style')) {
        const style = document.createElement('style');
        style.id = 'exit-warning-style';
        style.textContent = \`
          @keyframes pulse {
            0%, 100% { transform: translate(-50%, -50%) scale(1); }
            50% { transform: translate(-50%, -50%) scale(1.05); }
          }
        \`;
        document.head.appendChild(style);
      }
    }
  `;
  win.webContents.executeJavaScript(warningCode).catch(() => {});
}

function showFullscreenHint(win) {
  const hintCode = `
    const existingHint = document.getElementById('fullscreen-hint');
    if (existingHint) existingHint.remove();

    const hint = document.createElement('div');
    hint.id = 'fullscreen-hint';
    hint.style.cssText = \`
      position: fixed;
      top: 20px;
      right: 20px;
      background: rgba(0, 0, 0, 0.85);
      color: white;
      padding: 15px 25px;
      border-radius: 8px;
      font-size: 18px;
      font-family: sans-serif;
      z-index: 2147483647;
      box-shadow: 0 4px 6px rgba(0,0,0,0.3);
      animation: fadeIn 0.3s ease-in;
    \`;
    hint.innerHTML = '<strong>F11</strong> or <strong>Ctrl+Space</strong>で全画面切替';
    document.body.appendChild(hint);

    setTimeout(() => {
      hint.style.animation = 'fadeOut 0.3s ease-out';
      setTimeout(() => hint.remove(), 300);
    }, 3000);

    if (!document.getElementById('hint-animation-style')) {
      const style = document.createElement('style');
      style.id = 'hint-animation-style';
      style.textContent = \`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes fadeOut {
          from { opacity: 1; }
          to { opacity: 0; }
        }
      \`;
      document.head.appendChild(style);
    }
  `;
  win.webContents.executeJavaScript(hintCode).catch(() => {});
}

function showFullscreenHintForced(win) {
  const hintCode = `
    (function() {
      const existingHint = document.getElementById('fullscreen-hint');
      if (existingHint) existingHint.remove();

      const hint = document.createElement('div');
      hint.id = 'fullscreen-hint';
      hint.style.cssText = \`
        position: fixed !important;
        top: 20px !important;
        right: 20px !important;
        background: rgba(0, 0, 0, 0.95) !important;
        color: white !important;
        padding: 20px 30px !important;
        border-radius: 10px !important;
        font-size: 20px !important;
        font-family: sans-serif !important;
        z-index: 2147483647 !important;
        box-shadow: 0 8px 16px rgba(0,0,0,0.5) !important;
        animation: fadeIn 0.5s ease-in !important;
        pointer-events: none !important;
      \`;
      hint.innerHTML = '<strong>F11</strong> or <strong>Ctrl+Space</strong>で全画面切替';

      document.body.appendChild(hint);

      setTimeout(() => {
        hint.style.animation = 'fadeOut 0.5s ease-out';
        setTimeout(() => {
          if (hint.parentNode) {
            hint.remove();
          }
        }, 500);
      }, 4000);

      if (!document.getElementById('hint-animation-style')) {
        const style = document.createElement('style');
        style.id = 'hint-animation-style';
        style.textContent = \`
          @keyframes fadeIn {
            from { opacity: 0; transform: translateY(-10px); }
            to { opacity: 1; transform: translateY(0); }
          }
          @keyframes fadeOut {
            from { opacity: 1; }
            to { opacity: 0; }
          }
        \`;
        document.head.appendChild(style);
      }
    })();
  `;

  win.webContents.executeJavaScript(hintCode)
    .then(() => {
      console.log('全画面切替ヒント実行成功');
    })
    .catch(() => {});
}

function removePopup(win, popupId) {
  if (win.isDestroyed()) {
    return;
  }

  const removeCode = `
    (function() {
      const popup = document.getElementById('${popupId}');
      if (popup) {
        popup.remove();
      }
    })();
  `;

  win.webContents.executeJavaScript(removeCode).catch(() => {});
}

function executeBookmarklet(win) {
  if (isExiting || win.isDestroyed()) {
    return;
  }

  const checkCode = `
    (function() {
      const gameFrame = document.getElementById('game_frame');
      if (!gameFrame) {
        return false;
      }
      return true;
    })();
  `;

  win.webContents.executeJavaScript(checkCode)
    .then(isReady => {
      if (!isReady) {
        console.log('ページがまだ準備できていません - 3秒後に再試行');
        setTimeout(() => executeBookmarklet(win), 3000);
        return Promise.resolve();
      }

      return win.webContents.executeJavaScript(`
        (function() {
          const result = ${BOOKMARKLET_CODE};
          if (typeof result === 'object' && result !== null) {
            return {
              success: result.success !== false,
              errorMessage: result.errorMessage || null
            };
          }
          return { success: !!result, errorMessage: null };
        })();
      `);
    })
    .then(result => {
      if (result && result.success) {
        console.log('ブックマークレット実行成功');
      } else if (result && !result.success) {
        console.error('ブックマークレット実行エラー:', result.errorMessage);
      }
    })
    .catch(err => {
      if (!isExiting) {
        const errorMessage = (err && err.message) ? String(err.message) : String(err);
        console.error('ブックマークレット実行エラー:', errorMessage);
        setTimeout(() => {
          console.log('エラー後の再試行');
          executeBookmarklet(win);
        }, 3000);
      }
    });
}

function disableTouchKeyboard(win) {
  const disableCode = fs.readFileSync(path.join(__dirname, 'input-policy.js'), 'utf8');

  win.webContents.executeJavaScript(disableCode)
    .then(() => {
      console.log('タッチキーボード抑止スクリプト実行成功');
    })
    .catch(err => {
      console.error('タッチキーボード抑止スクリプト実行エラー:', err);
    });
}

// ページ読み込みごとにタッチホバー抑止フィルタを適用する（常設）
function applyTouchHoverFilter(win) {
  if (isExiting || win.isDestroyed()) {
    return;
  }

  console.log('タッチホバー抑止（遮断＋ホバー解除）適用');
  win.webContents.executeJavaScript(TOUCHHOVER_CODE).catch(() => {});
}

// 放置復帰/ロック解除時にページへマウスガードを発動する
function applyMouseGuard(trigger) {
  if (isExiting || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  console.log(trigger + ' - マウスガード発動（' + MOUSEGUARD_MS + 'ms間ホバー系イベント遮断）');
  mainWindow.webContents.executeJavaScript(MOUSEGUARD_CODE).catch(() => {});
  // 実操作の起きる文書（入れ子フレーム）にも（スクリプトは冪等）
  try {
    for (const f of walkFrames(mainWindow.webContents.mainFrame).slice(1)) {
      console.log(trigger + ' - マウスガード発動（フレーム @ ' + (f.url || '').split('#')[0].slice(0, 100) + '）');
      f.executeJavaScript(MOUSEGUARD_CODE).catch(() => {});
    }
  } catch (e) {}
}

// —— CDP（trusted入力）によるホバー解除実行 ——
// 実測: ワールド側の判定・要求は実機で動く（[KB]ログで確認）が、JS合成イベントでは
// ゲームは反応しない（trusted入力しか聞かない）。よって要求hereを受けて、
// CDPで「本物のマウス移動」を「何もない所」（ゲーム領域内の左上＝ステージ背景）に打つ。
const cdp = { attached: false, lastAt: 0 };
async function trustedHoverClear() {
  if (!mainWindow || mainWindow.isDestroyed() || isExiting) {
    return;
  }
  const now = Date.now();
  if (now - cdp.lastAt < 300) {
    return; // 要求の連続受信へのスロットル
  }
  cdp.lastAt = now;
  try {
    if (!cdp.attached) {
      // attach()の引数はプロトコルバージョン（'1.3'）。識別子ではない（以前の不具合）
      mainWindow.webContents.debugger.attach('1.3');
      cdp.attached = true;
    }
    // ゲーム領域（#game_frame＝ブックマークレットの操作対象）の画面上矩形
    const rect = await mainWindow.webContents.executeJavaScript(
      "(() => { const g = document.getElementById('game_frame'); if (!g) return null;" +
      " const r = g.getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width, h: r.height }; })()");
    let x, y;
    if (rect && rect.w > 100) {
      x = Math.round(rect.left + 4);
      y = Math.round(rect.top + 4);
    } else {
      const b = mainWindow.getContentBounds();
      x = Math.round(b.width / 2);
      y = 4; // フォールバック: ウィンドウ上端（ゲーム外の何もない所）
    }
    await mainWindow.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y, buttons: 0
    });
    console.log('CDPホバー解除実行: trusted mouseMoved @ ' + x + ',' + y);
  } catch (e) {
    console.error('CDPホバー解除エラー:', e.message || e);
  }
}

// ★修正: dynamic importを使用
app.whenReady().then(async () => {
  // electron-storeを動的にインポート
  const module = await import('electron-store');
  Store = module.default;
  store = new Store();

  // ワールド側スクリプト（touchhover）からのホバー解除要求（プレロードと同じ世界の経路用。
  // 実際のアプリ構成では世界の壁があるため、コンソール中継（console-message）が主経路）
  ipcMain.on('kb-hover-clear', () => {
    trustedHoverClear();
  });

  createWindow();

  // 放置からの復帰・ロック解除: システムが合成するマウスイベントを遮断
  powerMonitor.on('resume', () => {
    applyMouseGuard('放置からの復帰');
  });
  powerMonitor.on('unlock-screen', () => {
    applyMouseGuard('ロック解除');
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
