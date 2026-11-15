const { app, BrowserWindow, Menu, powerMonitor } = require('electron');
const iconv = require('iconv-lite');

let Store; // グローバルに宣言
let store;

// console.logをShift_JIS対応版にオーバーライド
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

console.log = function(...args) {
  const message = args.map(arg => String(arg)).join(' ');
  const buffer = iconv.encode(message + '\n', 'Shift_JIS');
  process.stdout.write(buffer);
};

console.warn = function(...args) {
  const message = args.map(arg => String(arg)).join(' ');
  const buffer = iconv.encode('[WARN] ' + message + '\n', 'Shift_JIS');
  process.stdout.write(buffer);
};

console.error = function(...args) {
  const message = args.map(arg => String(arg)).join(' ');
  const buffer = iconv.encode('[ERROR] ' + message + '\n', 'Shift_JIS');
  process.stderr.write(buffer);
};

const TARGET_URL = 'https://play.games.dmm.com/game/kancolle';

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
const MOUSEGUARD_MS = 1000;
const MOUSEGUARD_CODE = `
(function() {
  if (typeof window.__kbMouseGuardCleanup === 'function') {
    window.__kbMouseGuardCleanup();
  }
  var HOVER_TYPES = ['pointermove', 'pointerover', 'pointerenter', 'pointerleave', 'pointerout',
                     'mousemove', 'mouseover', 'mouseenter', 'mouseleave', 'mouseout'];
  function isMouseOrigin(e) {
    // pointerTypeが分かるものはmouse由来だけ遮断（touch/stylus=明示操作なので许容）
    if (e.pointerType !== undefined) {
      return e.pointerType === 'mouse';
    }
    // MouseEventsはガード期間中は復帰時のノイズ扱い
    return true;
  }
  function guardHandler(e) {
    if (!isMouseOrigin(e)) return;
    e.stopImmediatePropagation();
    if (e.cancelable) {
      e.preventDefault();
    }
  }
  function cleanup() {
    for (var i = 0; i < HOVER_TYPES.length; i++) {
      document.removeEventListener(HOVER_TYPES[i], guardHandler, true);
    }
    window.__kbMouseGuardCleanup = null;
  }
  window.__kbMouseGuardCleanup = cleanup;
  for (var i = 0; i < HOVER_TYPES.length; i++) {
    document.addEventListener(HOVER_TYPES[i], guardHandler, true);
  }
  setTimeout(cleanup, ${MOUSEGUARD_MS});
})();
`;

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
      contextIsolation: true,
      webviewTag: false,
      devTools: true
    }
  });

  mainWindow = win;

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

    setTimeout(() => {
      console.log('起動後3秒経過 - ブックマークレット実行');
      executeBookmarklet(win);
    }, 3000);

    setTimeout(() => {
      console.log('起動後10秒経過 - ブックマークレット実行');
      executeBookmarklet(win);
    }, 10000);

    showFullscreenHint(win);
  });

  setInterval(() => {
    console.log('定期実行 - ブックマークレット実行');
    executeBookmarklet(win);
  }, 60000);

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
  const disableCode = `
    (function() {
      // タッチキーボード完全抑止関数
      function preventTouchKeyboard(element) {
        if (!element) return;

        // 1. readonly属性を恒久的に設定
        element.setAttribute('readonly', 'readonly');

        // 2. inputmodeをnoneに固定
        element.setAttribute('inputmode', 'none');

        // 3. フォーカスを即座に解除
        element.addEventListener('focus', function(e) {
          e.preventDefault();
          element.blur();
        }, { capture: true });

        // 4. タッチイベントでフォーカスさせない
        element.addEventListener('touchstart', function(e) {
          e.preventDefault();
        }, { passive: false });

        element.addEventListener('touchend', function(e) {
          e.preventDefault();
          element.blur();
        }, { passive: false });

        // 5. クリックイベントも抑止
        element.addEventListener('click', function(e) {
          e.preventDefault();
          element.blur();
        });

        // 6. ポインターイベントも抑止
        element.addEventListener('pointerdown', function(e) {
          e.preventDefault();
          element.blur();
        }, { passive: false });

        // 7. マウスイベントも念のため抑止
        element.addEventListener('mousedown', function(e) {
          e.preventDefault();
          element.blur();
        }, { passive: false });
      }

      // 既存の全input/textareaに適用
      const inputs = document.querySelectorAll('input, textarea');
      inputs.forEach(preventTouchKeyboard);

      // 動的に追加される要素を監視
      const observer = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
          mutation.addedNodes.forEach(function(node) {
            if (node.nodeType === 1) {
              if (node.matches('input, textarea')) {
                preventTouchKeyboard(node);
              }
              const nestedInputs = node.querySelectorAll('input, textarea');
              nestedInputs.forEach(preventTouchKeyboard);
            }
          });
        });
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });

      // iframe内のコンテンツにも適用
      function applyToIframes() {
        const iframes = document.querySelectorAll('iframe');
        iframes.forEach(function(iframe) {
          try {
            const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
            if (iframeDoc) {
              const iframeInputs = iframeDoc.querySelectorAll('input, textarea');
              iframeInputs.forEach(preventTouchKeyboard);

              const iframeObserver = new MutationObserver(function(mutations) {
                mutations.forEach(function(mutation) {
                  mutation.addedNodes.forEach(function(node) {
                    if (node.nodeType === 1) {
                      if (node.matches('input, textarea')) {
                        preventTouchKeyboard(node);
                      }
                      const nestedInputs = node.querySelectorAll('input, textarea');
                      nestedInputs.forEach(preventTouchKeyboard);
                    }
                  });
                });
              });

              iframeObserver.observe(iframeDoc.body, {
                childList: true,
                subtree: true
              });
            }
          } catch (e) {
            // クロスオリジンの場合はスキップ
          }
        });
      }

      applyToIframes();

      const iframeObserver = new MutationObserver(function() {
        applyToIframes();
      });

      iframeObserver.observe(document.body, {
        childList: true,
        subtree: true
      });

      console.log('タッチキーボード完全抑止機能を適用しました');
    })();
  `;

  win.webContents.executeJavaScript(disableCode)
    .then(() => {
      console.log('タッチキーボード抑止スクリプト実行成功');
    })
    .catch(err => {
      console.error('タッチキーボード抑止スクリプト実行エラー:', err);
    });
}

// 放置復帰/ロック解除時にページへマウスガードを発動する
function applyMouseGuard(trigger) {
  if (isExiting || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  console.log(trigger + ' - マウスガード発動（' + MOUSEGUARD_MS + 'ms間ホバー系イベント遮断）');
  mainWindow.webContents.executeJavaScript(MOUSEGUARD_CODE).catch(() => {});
}

// ★修正: dynamic importを使用
app.whenReady().then(async () => {
  // electron-storeを動的にインポート
  const module = await import('electron-store');
  Store = module.default;
  store = new Store();

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
