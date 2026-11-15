const { app, BrowserWindow, Menu } = require('electron');

//const TARGET_URL = 'https://www.dmm.com/netgame/social/-/gadgets/=/app_id=854854/';
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
    const gw = gf.offsetWidth;  // 1200
    const gh = gw * 0.6;        // 720（実際のゲーム画面高さ）
    const frameHeight = gf.offsetHeight;  // 860（フレーム全体の高さ）
    const bottomPadding = frameHeight - gh;  // 140（下部の不要部分）
    
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
    $.body.style.cssText = 'min-width:0;overflow:hidden;margin:0';
    
    const ntgnavi = $.querySelector('.dmm-ntgnavi');
    if (ntgnavi) ntgnavi.style.display = 'none';
    
    const naviapp = $.querySelector('.area-naviapp');
    if (naviapp) naviapp.style.display = 'none';
    
    const recommend = $.getElementById('ntg-recommend');
    if (recommend) recommend.style.display = 'none';
    
    gs.position = 'fixed';
    gs.right = '0';
    gs.zIndex = '100';
    
    // ★修正：下部140pxを隠すための配置
    gs.top = '50%';
    gs.left = '50%';
    gs.transformOrigin = '50% 0';  // 上端を基準に
    
    if (!_.kancolleFit) {
      const k = () => {
        const w = html.clientWidth;
        const h = _.innerHeight;
        let scale;
        
        // 実際のゲーム画面（720px）を基準にスケール計算
        if (w / h < gw / gh) {
          scale = w / gw;
        } else {
          scale = h / gh;
        }
        
        // ★修正：下部140pxを画面外に押し出す
        // 上部720pxを中央に配置し、下部140pxは見えなくする
        const visibleHeight = gh * scale;  // 表示される720px部分の実際の高さ
        const topOffset = (h - visibleHeight) / 2;  // 上下中央配置のためのオフセット
        
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
    console.error('ブックマークレット実行エラー:', error);
    return false;
  }
})(document, window);
`;

// ESC押下の状態管理
let escPressTime = null;
const ESC_TIMEOUT = 5000; // 5秒
let escTimeoutTimer = null;
let isExiting = false; // 終了処理中フラグ

function createWindow() {
  // アプリ全体のメニューバーを削除
  Menu.setApplicationMenu(null);
  
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    frame: true,
    fullscreen: true,
    skipTaskbar: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: false
    }
  });

  win.loadURL(TARGET_URL);

  win.webContents.on('did-finish-load', () => {
    console.log('ページ読み込み完了 - ブックマークレット実行');
    executeBookmarklet(win);
    
    setTimeout(() => {
      console.log('起動後3秒経過 - ブックマークレット実行');
      executeBookmarklet(win);
    }, 3000);
    
    setTimeout(() => {
      console.log('起動後10秒経過 - ブックマークレット実行');
      executeBookmarklet(win);
    }, 10000);
    
    // 起動時にポップアップ表示
    showFullscreenHint(win);
  });

  setInterval(() => {
    console.log('定期実行 - ブックマークレット実行');
    executeBookmarklet(win);
  }, 60000);

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown') {
      
      // 終了処理中は全てのキー入力を無視
      if (isExiting) {
        event.preventDefault();
        return;
      }
      
      if (input.key === 'Escape') {
        event.preventDefault();
        handleEscapeKey(win);
        return;
      }
      
      // Spaceキーが押された場合のみリセット（終了処理中でない場合のみ）
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
    // 1回目のESC押下
    escPressTime = now;
    showExitWarning(win);
    console.log('ESC 1回目 - 終了警告表示（5秒以内に再度ESCで終了、Spaceで解除）');
    
    // 5秒後に自動リセット
    escTimeoutTimer = setTimeout(() => {
      // 終了処理中でもポップアップは消す
      if (escPressTime !== null) {
        resetEscapeState(win);
        console.log('ESC状態タイムアウト - 自動リセット');
      }
    }, ESC_TIMEOUT);
    
  } else if (now - escPressTime < ESC_TIMEOUT) {
    // 5秒以内の2回目のESC押下
    console.log('ESC 2回目 - アプリ終了');
    
    // 終了処理中フラグを立てる
    isExiting = true;
    
    // タイマーをクリアしてポップアップを消す
    if (escTimeoutTimer) {
      clearTimeout(escTimeoutTimer);
    }
    
    // ポップアップを即座に削除
    removePopup(win, 'exit-warning');
    
    // ウィンドウを即座に非表示にする
    if (!win.isDestroyed()) {
      win.hide();
    }
    
    // 少し待ってから終了（クリーンアップのため）
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
  
  // ウィンドウが破棄されていなければポップアップを削除
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
    
    // メニューバーを非表示
    Menu.setApplicationMenu(null);
    
    // 即座にポップアップ表示
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
    
    // メニューバーを非表示
    Menu.setApplicationMenu(null);
    
    // 即座にポップアップ表示
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
        z-index: 999999;
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
  win.webContents.executeJavaScript(warningCode);
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
      z-index: 999999;
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
  win.webContents.executeJavaScript(hintCode);
}

function showFullscreenHintForced(win) {
  const hintCode = `
    (function() {
      // 既存のヒントを削除
      const existingHint = document.getElementById('fullscreen-hint');
      if (existingHint) existingHint.remove();
      
      // 新しいヒントを作成
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
      
      // 確実にbodyの最後に追加
      document.body.appendChild(hint);
      
      console.log('全画面切替ヒント表示（即座）');
      
      // 4秒後にフェードアウトして削除
      setTimeout(() => {
        hint.style.animation = 'fadeOut 0.5s ease-out';
        setTimeout(() => {
          if (hint.parentNode) {
            hint.remove();
            console.log('全画面切替ヒント削除');
          }
        }, 500);
      }, 4000);
      
      // アニメーション用スタイルを追加（まだ存在しない場合）
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
    .catch(err => {
      console.error('全画面切替ヒント実行エラー:', err);
    });
}

function removePopup(win, popupId) {
  // ウィンドウが破棄されていないか確認
  if (win.isDestroyed()) {
    return;
  }
  
  const removeCode = `
    (function() {
      const popup = document.getElementById('${popupId}');
      if (popup) {
        popup.remove();
        console.log('ポップアップ削除: ${popupId}');
      }
    })();
  `;
  
  win.webContents.executeJavaScript(removeCode)
    .catch(err => {
      // エラーを無視（終了処理中の場合は正常）
      console.log('ポップアップ削除スキップ（ウィンドウ終了中）');
    });
}

function executeBookmarklet(win) {
  // 終了処理中またはウィンドウが破棄されている場合は何もしない
  if (isExiting || win.isDestroyed()) {
    return;
  }
  
  const checkCode = `
    (function() {
      const gameFrame = document.getElementById('game_frame');
      if (!gameFrame) {
        console.warn('game_frame要素が見つかりません');
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
        return;
      }
      
      return win.webContents.executeJavaScript(BOOKMARKLET_CODE);
    })
    .then(result => {
      if (result !== undefined) {
        console.log('ブックマークレット実行成功');
      }
    })
    .catch(err => {
      // 終了処理中の場合はエラーを無視
      if (!isExiting) {
        console.error('ブックマークレット実行エラー:', err);
        setTimeout(() => {
          console.log('エラー後の再試行');
          executeBookmarklet(win);
        }, 3000);
      }
    });
}

app.whenReady().then(() => {
  createWindow();

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
