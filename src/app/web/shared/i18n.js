// 極簡 i18n 執行期（無第三方庫）。三語字典由 shared/i18n/<lang>.js 一律全載入到 window.__I18N_DICTS__。
// 設計：切換語言在瀏覽器記憶體完成（換 DICT + 重跑 applyI18n），不需重新整理頁面。
// 缺鍵一律 fallback：目前語言缺 → 回 zh-Hant（canonical 完整表）→ 再無則回呼叫端傳入的原文，永不顯示空白或 key。
(function () {
  const STORE_KEY = 'xitto.uiLang';
  const LANGS = ['zh-Hant', 'zh-Hans', 'en'];

  function getLang() {
    try {
      const saved = localStorage.getItem(STORE_KEY);
      if (saved && LANGS.indexOf(saved) !== -1) return saved;
    } catch (_) { /* localStorage 不可用時忽略，走部署預設 */ }
    const deployDefault = (window.__XITTO__ && window.__XITTO__.lang) || 'zh-Hant';
    return LANGS.indexOf(deployDefault) !== -1 ? deployDefault : 'zh-Hant';
  }

  function t(key, fallback) {
    const DICTS = window.__I18N_DICTS__ || {};
    const cur = DICTS[window.__LANG__] || {};
    if (Object.prototype.hasOwnProperty.call(cur, key)) return cur[key];
    const canon = DICTS['zh-Hant'] || {};
    if (Object.prototype.hasOwnProperty.call(canon, key)) return canon[key];
    return fallback != null ? fallback : key;
  }

  // 掃描 data-i18n* 屬性就地填入（textContent／title／aria-label／placeholder／tooltip）。
  function applyI18n(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n'), el.textContent); });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.getAttribute('data-i18n-title'), el.title); });
    root.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'), el.getAttribute('aria-label'))); });
    root.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.getAttribute('data-i18n-ph'), el.placeholder); });
    root.querySelectorAll('[data-i18n-tip]').forEach((el) => { el.setAttribute('data-tooltip', t(el.getAttribute('data-i18n-tip'), el.getAttribute('data-tooltip'))); });
  }

  // 切換語言：換 window.__LANG__、記住偏好、重跑 applyI18n，並廣播事件讓頁面自有的動態文字（例如錄音按鈕狀態文案）在下次重繪時跟進新語言。
  function setLang(lang) {
    if (LANGS.indexOf(lang) === -1) return;
    window.__LANG__ = lang;
    try { localStorage.setItem(STORE_KEY, lang); } catch (_) { /* 不可用就不記住，仍即時切換這次畫面 */ }
    applyI18n(document);
    document.querySelectorAll('[data-lang-switch]').forEach((el) => { el.value = lang; });
    window.dispatchEvent(new CustomEvent('xitto:langchange', { detail: { lang } }));
  }

  window.t = t;
  window.applyI18n = applyI18n;
  window.setLang = setLang;
  window.getLang = getLang;
  window.__LANG__ = getLang();
  document.addEventListener('DOMContentLoaded', () => {
    applyI18n();
    document.querySelectorAll('[data-lang-switch]').forEach((el) => { el.value = window.__LANG__; });
  });
})();
