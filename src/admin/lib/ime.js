/**
 * テキスト入力の Enter を、IME の変換確定と区別して拾う Svelte アクション。
 *
 * 日本語・中国語・韓国語の入力では、変換候補を確定する Enter がそのまま
 * 送信として扱われてしまう。判定は 3 段構え + 1。
 *  - compositionstart / compositionend で自前に変換中を追う
 *  - evt.isComposing (標準)
 *  - evt.keyCode === 229 (isComposing を立てない古い実装への保険)
 * さらに、変換確定の直後に同じ Enter がもう一度 keydown として届く実装が
 * あるため、確定から次のイベントループまでは無視する。
 * 変換中でも Enter の既定動作は止める (フォーム内の暗黙送信を防ぐため)。
 *
 * wa-input / wa-checkbox は内部の Shadow DOM に本物の <input> を持つが、
 * keydown / composition* はいずれも標準の UI イベントで composed: true
 * (シャドウ境界を越えて外側までバブルする) ため、ホスト要素
 * (<wa-input> 自体) に addEventListener するだけで届く。
 *
 * 使い方: <wa-input use:enterKey={handler}></wa-input>
 */
export function enterKey(node, handler) {
  let composing = false;
  let justComposed = false;
  let justComposedTimer = null;
  let current = handler;

  function onCompositionStart() {
    composing = true;
  }

  function onCompositionEnd() {
    composing = false;
    justComposed = true;
    if (justComposedTimer) clearTimeout(justComposedTimer);
    justComposedTimer = setTimeout(() => {
      justComposed = false;
    }, 0);
  }

  function onKeydown(evt) {
    if (evt.key !== 'Enter') return;
    // 変換中でも既定動作は止める。フォーム内の入力欄では、何もしないと
    // 変換確定の Enter がそのまま暗黙送信になってしまう。
    evt.preventDefault();
    if (composing || justComposed || evt.isComposing || evt.keyCode === 229) return;
    if (current) current();
  }

  node.addEventListener('compositionstart', onCompositionStart);
  node.addEventListener('compositionend', onCompositionEnd);
  node.addEventListener('keydown', onKeydown);

  return {
    update(newHandler) {
      current = newHandler;
    },
    destroy() {
      node.removeEventListener('compositionstart', onCompositionStart);
      node.removeEventListener('compositionend', onCompositionEnd);
      node.removeEventListener('keydown', onKeydown);
      if (justComposedTimer) clearTimeout(justComposedTimer);
    },
  };
}
