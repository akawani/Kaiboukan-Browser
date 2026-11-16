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
  setTimeout(cleanup, 1000);
})();
