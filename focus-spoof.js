// フォーカスspoof preload（ページスクリプトより先に実行される）
// このアプリではウィンドウを常時「フォーカスあり」とみなし、フォーカス喪失を艦これ本体に伝えない。
// （実測: ゲーム本体はwindow blurイベントでは反応せず、画面切替・更新ボタン等の非同期
//   チェックポイントでフォーカス状態を直接見ている。OSキーボードがアクティベーションを
//   奪った状態だと、入力確定後にゲームが自分でinputをblurさせるため、その時点で
//   hasFocus=falseとなりグレーアウトする。従って条件付きでなく常時spoofする）
//
// - blur系（window blur / focusout）はゲーム本体に届けない
// - focus系（window focus / focusin）はそのまま届ける（本来常に「フォーカスあり」状態なので無害）
// - document.hasFocus() は常時 true
//
// 前提: メインワールドで走らせるため contextIsolation: false が必要
//       （isolated worldだとゲーム本体とAPIを共有できないため）。
(function() {
  // ── アプリブリッジ（このスクリプトはプレロード＝自前のrequireが使える唯一の場所。
  //    同じワールド（テストスタブ等）からのみ呼べる。sandboxの実構成では世界の壁があるため、
  //    実際の発火はコンソール中継（[KB-REQ] → メイン側 console-message）が主経路）──
  if (typeof require === 'function' && !window.__kbHoverClearRequest) {
    try {
      var kbIpc = require('electron').ipcRenderer;
      window.__kbHoverClearRequest = function() {
        try { kbIpc.send('kb-hover-clear'); } catch (e) {}
      };
    } catch (e) {}
  }

  // （診断ログ・IPC報告は役目を終え削除。spoof機構自体は維持）
  if (typeof window.__kbFocusSpoofCleanup === 'function') {
    window.__kbFocusSpoofCleanup();
  }

  // フォーカス喪失系（window blur / focusout）と可視性変更は伝えない（常時フォーカスあり扱い）
  // 獲得系（focus / focusin）はそのまま届ける（常にフォカ斯あり状態なので無害）
  function shouldDeliver(e) {
    if (e.type === 'blur' || e.type === 'focusout') {
      return false;
    }
    if (e.type === 'visibilitychange') {
      return false;
    }
    return true;
  }

  var nativeAdd = EventTarget.prototype.addEventListener;
  var nativeRemove = EventTarget.prototype.removeEventListener;
  var nativeHasFocus = Document.prototype.hasFocus;

  // --- window/documentレベルの focus|blur|focusin|focusout|visibilitychange のラップ ---
  // ゲーム本体の登録は本スクリプトより後なので必ずここを通る
  // （focusout＝DOMフォーカス喪失もフォカ斯喪失の合図なので伝えない。focus/focusinはそのまま）
  var WRAPPED_TYPES = ['blur', 'focus', 'focusout', 'focusin', 'visibilitychange'];
  var wrappers = new WeakMap(); // 原fn -> {type: wrapperFn}
  var active = []; // 清理用のアクティブ登録 [{type, wrapper}]

  function wrapperFor(fn, type) {
    var m = wrappers.get(fn);
    if (!m) {
      m = {};
      wrappers.set(fn, m);
    }
    if (!m[type]) {
      m[type] = function(e) {
        if (!shouldDeliver(e)) return;
        return typeof fn === 'function' ? fn.call(this, e) : fn.handleEvent(e);
      };
      m[type]._kbWrapped = true;
    }
    return m[type];
  }

  EventTarget.prototype.addEventListener = function(type, fn, opts) {
    if (WRAPPED_TYPES.indexOf(type) === -1 || typeof fn !== 'function') {
      return nativeAdd.apply(this, arguments);
    }
    if (this !== window && this !== document) {
      return nativeAdd.apply(this, arguments);
    }
    var w = wrapperFor(fn, type);
    active.push({ type: type, wrapper: w, listener: fn });
    return nativeAdd.call(this, type, w, opts);
  };

  EventTarget.prototype.removeEventListener = function(type, fn, opts) {
    var m = (this === window || this === document) ? wrappers.get(fn) : null;
    if (!m || !m[type]) {
      return nativeRemove.apply(this, arguments);
    }
    return nativeRemove.call(this, type, m[type], opts);
  };

  // --- document.hasFocus() ---
  // 常時trueと報告する（このアプリではウィンドウを常時フォーカスありとみなす）
  Document.prototype.hasFocus = function() {
    return true;
  };

  // --- document.visibilityState / hidden / activeElement の直接読み --- ---
  // 非同期チェックポイント（画面切替・更新ボタン等）での直接読みに対しては
  // 喪失を報告しない（OSキーボードがアクティベーションを奪っている状態でも「正常」とみなす）
  var descVis = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
  var descHidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
  var descActive = Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement');

  Object.defineProperty(Document.prototype, 'visibilityState', {
    configurable: true,
    get: function() { return 'visible'; }
  });
  Object.defineProperty(Document.prototype, 'hidden', {
    configurable: true,
    get: function() { return false; }
  });

  // ゲーム本体がフォーカスした入力要素（OSキーボードにアクティベーションを奪われる側）は、
  // 直接読み取りでも「まだフォーカスされたまま」とみなす
  var trustedFocused = null;
  Object.defineProperty(Document.prototype, 'activeElement', {
    configurable: true,
    get: function() {
      var real = descActive && descActive.get ? descActive.get.call(this) : null;
      var tag = real && real.tagName ? String(real.tagName).toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea') {
        trustedFocused = real;
        return real;
      }
      if (trustedFocused && document.contains(trustedFocused)) {
        return trustedFocused;
      }
      return real;
    }
  });

  // --- window.onblur / onfocus プロパティ代入型 ---
  // 原生のイベントディスパッチはBlink内部のアクセサに格納されたハンドラを直接呼ぶため、
  // setterで受け取ったらラッパーを経由してaddEventListener経路に登録する。
  // 注意: onblur/onfocusはwindowのownアクセサなのでdeleteで消すと原生側が死ぬ。
  //       安装前のデスクリプタを保存し、清理ではそれで復元する。
  function trapHandlerProp(propName, eventType, nativeDesc) {
    var handler = null; // ゲーム本体のハンドラ（読み出し時はこれを返す）
    var wrapper = null; // 実際に登録されるラッパー
    Object.defineProperty(window, propName, {
      configurable: true,
      get: function() { return handler; },
      set: function(fn) {
        if (wrapper) {
          nativeRemove.call(window, eventType, wrapper, false);
          wrapper = null;
        }
        handler = typeof fn === 'function' ? fn : null;
        if (handler) {
          wrapper = function(e) {
            if (!shouldDeliver(e)) return;
            handler.call(window, e);
          };
          nativeAdd.call(window, eventType, wrapper, false);
        }
      },
      _kbNativeDesc: nativeDesc // （cleanup用。definePropertyは無視する）
    });
    return nativeDesc;
  }
  var descBlur = Object.getOwnPropertyDescriptor(window, 'onblur');
  var descFocus = Object.getOwnPropertyDescriptor(window, 'onfocus');
  trapHandlerProp('onblur', 'blur', descBlur);
  trapHandlerProp('onfocus', 'focus', descFocus);

  function restoreProp(propName, nativeDesc) {
    try {
      if (nativeDesc) {
        Object.defineProperty(window, propName, nativeDesc);
      } else {
        delete window[propName]; // もともとownでなくプロトタイプ由来なら影を剥がすだけ
      }
    } catch (e) {}
  }

  // --- 清理（再適用・解除用） ---
  window.__kbFocusSpoofCleanup = function() {
    for (var i = 0; i < active.length; i++) {
      nativeRemove.call(window, active[i].type, active[i].wrapper, false);
    }
    active = [];
    // onfocusに先に代入されていたハンドラを復元するため順序に注意（読み出し状態は保存した
    // デスクリプタ基準なので、代入済みハンドラは反映されない＝原生状態に戻す）
    restoreProp('onblur', descBlur);
    restoreProp('onfocus', descFocus);
    EventTarget.prototype.addEventListener = nativeAdd;
    EventTarget.prototype.removeEventListener = nativeRemove;
    Document.prototype.hasFocus = nativeHasFocus;
    if (descVis) Object.defineProperty(Document.prototype, 'visibilityState', descVis);
    if (descHidden) Object.defineProperty(Document.prototype, 'hidden', descHidden);
    if (descActive) Object.defineProperty(Document.prototype, 'activeElement', descActive);
    trustedFocused = null;
    window.__kbFocusSpoofCleanup = null;
  };
})();
