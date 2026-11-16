// 暗所黒地（全フレーム注入）: ゲームページ本体（gadget文書）の背景は白で、
// キャンバススケーリングのサブピクセル誤差で下端から1pxほど白が覗く（実測）。
// 外側の黒地（ブックマークレットのバックドロップ）はgame_frameより下なので、
// 文書側の背景を黒にする。トップフレームではブックマークレットが同じことを既にやっている
// （＝同じ処理のフレーム版。冪等・既存の黒設定があれば上書きしない）
(function() {
  if (document.documentElement && document.documentElement.style.backgroundColor !== 'rgb(0, 0, 0)') {
    document.documentElement.style.backgroundColor = '#000';
  }
  if (document.body && document.body.style.backgroundColor !== 'rgb(0, 0, 0)') {
    document.body.style.backgroundColor = '#000';
  }
})();
