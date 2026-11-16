// タッチ操作時のホバー抑止（常設、v4）※全フレームで実行される
//   - 実マウス運用（カーソル表示あり）: ホバーは通常どおり许容する
//   - タッチ運用（カーソル非表示状態）: ホバー系イベントは由来を問わず抑止する
//     （カーソル非表示時のmouse*はOS合成＝実カーソル由来ではないため）
//   - 実マウス→タッチへ切り替わった時 / タッチ操作の終了時に、ホバー状態を解除する。
//     解除の実行はメインプロセス経由（CDPのtrusted入力）で行う。
//     実測: 当スクリプトの判定・要求自体は正しく動く（実機ログで確認済み）が、
//     dispatchEvent由来のJS合成イベントではゲームは反応しない（ trusted入力のみ聞く ）。
//     → 要求をIPCでメインプロセスに送り、CDPで「本物のマウス移動」として打つ（v4）。
//     DOM合成経路はフォールバックとして残す。
// 操作イベントそのもの（pointerdown/up/click/touch*）とクリック・ボタン押下は许容する。
(function() {
  if (typeof window.__kbTouchHoverCleanup === 'function') {
    window.__kbTouchHoverCleanup();
  }
  var lastPointerType = null;
  var lastMouseHoverTarget = null; // 実マウス運用時にホバーしていた要素（切り替え時に解除対象）
  var lastMousePos = null;
  // 観察するイベント（操作系もホバー系も。単一ハンドラで二重処理を防ぐ）
  var LISTEN_TYPES = ['pointerdown', 'pointermove', 'pointerover', 'pointerenter',
                      'pointerleave', 'pointerout', 'pointerup', 'pointercancel',
                      'mousemove', 'mouseover', 'mouseenter', 'mouseleave', 'mouseout'];
  // 抑止対象（ホバー系）の判定。操作系は抑止しない
  var BLOCK_SET = {};
  ['pointermove', 'pointerover', 'pointerenter', 'pointerleave', 'pointerout',
   'mousemove', 'mouseover', 'mouseenter', 'mouseleave', 'mouseout'].forEach(function(t) { BLOCK_SET[t] = true; });

  function isSynthetic(e) { return !!e._kbSynthetic; }

  function updateOrigin(e) {
    if (e.pointerType !== undefined) {
      lastPointerType = e.pointerType;
      return e.pointerType;
    }
    // マウス系イベントは直前ポインター種別で判定（タッチ操作時はタップ由来の合成扱い）
    return lastPointerType;
  }

  // 要素の領域外（＝ゲーム内容の外＝レターボックス側の何もない所）の座標
  function outsideRect(el) {
    var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (!r || !r.width || !r.height) return { x: -10, y: -10 };
    return { x: Math.max(r.left - 20, -10), y: r.bottom + 20 };
  }

  // ホバー解除: 内部マウス位置を何もない所へ動かしてから退去する（座標付きの合成）。
  // 移動→退去の順。ゲーム本体側のリスナーに届くよう、元の対象要素にディスパッチする。
  function targetTag(t) {
    return t && t.tagName ? String(t.tagName).toLowerCase() : String(t);
  }

  // ホバー解除の実行: 実測で「ゲームはJS合成（dispatchEvent）イベントに反応しない」ため、
  // 本体はメインプロセスへの要求（＝CDPによるtrusted入力）として発火する。
  // 経路: テスト用シンク（__kbHoverClearRequest）→ require（プレロード適用済みフレーム）
  //       → コンソール中継（[KB-REQ]＝世界の壁を跨げる唯一の実経路・機構そのもの）
  //       → 最終フォールバック＝DOM合成（効かないことまで実測済み）
  function requestClear(target) {
    if (typeof window.__kbHoverClearRequest === 'function') {
      try { window.__kbHoverClearRequest(); return; } catch (e) {}
    }
    if (typeof require === 'function') {
      try { require('electron').ipcRenderer.send('kb-hover-clear'); return; } catch (e) {}
    }
    try { console.log('[KB-REQ] hover-clear 対象=' + targetTag(target)); return; } catch (e) {}
    synthesizeClear(target);
  }

  function synthesizeClear(target) {
    var p = outsideRect(target);
    var base = { clientX: p.x, clientY: p.y, screenX: p.x, screenY: p.y };
    var mv = new MouseEvent('mousemove', Object.assign({ bubbles: true, cancelable: true }, base));
    mv._kbSynthetic = true;
    target.dispatchEvent(mv);
    var mo = new MouseEvent('mouseout', Object.assign({ bubbles: true, cancelable: true }, base));
    mo._kbSynthetic = true;
    target.dispatchEvent(mo);
    var ml = new MouseEvent('mouseleave', base);
    ml._kbSynthetic = true;
    target.dispatchEvent(ml);
    var pmv = new PointerEvent('pointermove', Object.assign({ bubbles: true, cancelable: true, pointerType: 'touch' }, base));
    pmv._kbSynthetic = true;
    target.dispatchEvent(pmv);
    var po = new PointerEvent('pointerout', Object.assign({ bubbles: true, cancelable: true, pointerType: 'touch' }, base));
    po._kbSynthetic = true;
    target.dispatchEvent(po);
    var pl = new PointerEvent('pointerleave', Object.assign({ pointerType: 'touch' }, base));
    pl._kbSynthetic = true;
    target.dispatchEvent(pl);
  }

  // 押し位置（ドラッグ検知用）: 押下位置から動かずに離されたものが「タップ」。
  // 動かされたものは「ドラッグ」＝ゲーム自身の離され処理（ドロップ判定）が完結すべきで、
  // ここから割り込んでマウス位置を動かすとドロップ先が列表本体＝レシピ消去になる（実測）
  var DRAG_THRESHOLD = 10; // px
  var lastPressPos = null;

  function observe(e) {
    var prev = lastPointerType; // このイベント「前」の状態（切り替え検知用）
    var origin = updateOrigin(e);
    if (origin === 'mouse') {
      lastMouseHoverTarget = e.target;
      lastMousePos = { x: e.clientX, y: e.clientY };
    } else if (origin === 'touch' && prev === 'mouse' && lastMouseHoverTarget) {
      // 実マウス→タッチへの切り替え: 古いホバー状態（当たり判定）を解除する
      var old = lastMouseHoverTarget;
      setTimeout(function() { requestClear(old); }, 0);
    }
    if (e.type === 'pointerdown') {
      lastPressPos = { x: e.clientX, y: e.clientY };
    }
    if ((e.type === 'pointerup' || e.type === 'pointercancel') && origin === 'touch') {
      var moved = lastPressPos &&
        (Math.abs(e.clientX - lastPressPos.x) > DRAG_THRESHOLD || Math.abs(e.clientY - lastPressPos.y) > DRAG_THRESHOLD);
      if (moved) {
        return; // ドラッグ（動かれた）＝ゲーム自身の離され処理に任せる（何もしない）
      }
      var target = e.target;
      if (target && target.nodeType === 1) {
        setTimeout(function() { requestClear(target); }, 0);
      }
    }
  }

  function handler(e) {
    if (isSynthetic(e)) return; // ホバー解除用イベントは通過させる
    observe(e);
    if (!BLOCK_SET[e.type]) return; // 操作系（pointerdown/up/click等）は许容
    if (updateOrigin(e) !== 'touch') return; // 実マウス（カーソル表示あり）のホバーは许容
    // ボタンが押まれている＝ドラッグの操作パイプライン（操作でありホバーではない）→ 什么都许容。
    // （ドラッグは press→move→release の列で完結する。ここでmove/overを止めると
    //   ゲームAS3のドラッグ機構が壊れ、ドロップ先が列表本体＝「レシピ消去」になる＝実測の不具合）
    if (e.buttons !== undefined && e.buttons > 0) return;
    e.stopImmediatePropagation();
    if (e.cancelable) {
      e.preventDefault();
    }
  }

  function cleanup() {
    for (var i = 0; i < LISTEN_TYPES.length; i++) {
      document.removeEventListener(LISTEN_TYPES[i], handler, true);
    }
    window.__kbTouchHoverCleanup = null;
  }
  window.__kbTouchHoverCleanup = cleanup;
  for (var i = 0; i < LISTEN_TYPES.length; i++) {
    document.addEventListener(LISTEN_TYPES[i], handler, true);
  }
})();
