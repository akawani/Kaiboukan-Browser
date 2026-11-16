    (function() {
      // タッチキーボード抑止関数（属性のみ・フォーカスは奪わない）
      // 艦これ本体が入力用のinputにフォーカスすること自体は入力機構そのものなので、
      // ここからblurを返すと「フォーカスを失った」扱いになり画面がグレーアウトする。
      // OSのタッチキーボードはinputmode=noneで非表示に抑止する（物理キーボード入力は可）。
      function preventTouchKeyboard(element) {
        if (!element) return;
        if (element.getAttribute('data-kb-kbd-suppressed') === '1') return;
        element.setAttribute('data-kb-kbd-suppressed', '1');

        // inputmodeをnoneに固定（OSタッチキーボード抑止。属性のみなのでフォーカスは保たれる）
        element.setAttribute('inputmode', 'none');
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
    })();
