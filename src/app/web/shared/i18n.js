// 極簡 i18n 執行期（無第三方庫）。字典由 shared/i18n/<lang>.js 同步載入到 window.__I18N__。
// 設計：繁體原文留在 HTML／JS 內當 fallback，缺鍵一律回退原文——故 zh-Hant 表可留空，
// 只有 zh-Hans／en 需要條目，且未翻譯的鍵優雅降級回繁體，永不顯示空白或 key。
(function () {
  const DICT = window.__I18N__ || {};
  // t(key, fallback)：查表；無鍵回退 fallback（呼叫端傳的原文），再無則回 key 本身。
  const t = (key, fallback) => (Object.prototype.hasOwnProperty.call(DICT, key) ? DICT[key] : (fallback != null ? fallback : key));
  // 掃描 data-i18n* 屬性就地填入（textContent／title／aria-label／placeholder）。
  // fallback 取元素現值（＝內嵌繁體原文），所以 zh-Hant 空表時畫面不變。
  function applyI18n(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n'), el.textContent); });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.getAttribute('data-i18n-title'), el.title); });
    root.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'), el.getAttribute('aria-label'))); });
    root.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.getAttribute('data-i18n-ph'), el.placeholder); });
    root.querySelectorAll('[data-i18n-tip]').forEach((el) => { el.setAttribute('data-tooltip', t(el.getAttribute('data-i18n-tip'), el.getAttribute('data-tooltip'))); });
  }
  window.t = t;
  window.applyI18n = applyI18n;
  window.__LANG__ = (window.__XITTO__ && window.__XITTO__.lang) || 'zh-Hant';
  document.addEventListener('DOMContentLoaded', () => applyI18n());
})();
