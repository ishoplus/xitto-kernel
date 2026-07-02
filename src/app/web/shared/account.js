/**
 * 帳號 chip（SSO）：三頁共用、自足（不依賴 app.js / 頁面 markup）。
 * 打 /v1/me → SSO 且已登入才在右上角顯示「👤 名字 · 角色 · 登出」；非 SSO / 未登入不顯示，維持現況。
 * 同時把身分掛到 window.__XITTO_ME__，供頁面（如 room.html）沿用真實身份。
 */
(function () {
  var escAttr = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  };
  var ROLE_ZH = { admin: "管理員", member: "成員", readonly: "唯讀" };

  function mount(me) {
    if (document.getElementById("xk-account")) return;
    var role = ROLE_ZH[me.role] || "";
    var el = document.createElement("div");
    el.id = "xk-account";
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", "已登入帳號");
    el.innerHTML =
      '<span class="xk-acc-ic" aria-hidden="true">👤</span>' +
      '<span class="xk-acc-name" title="' + escAttr(me.email || me.name) + '">' + escAttr(me.name || me.email) + "</span>" +
      (role ? '<span class="xk-acc-role">' + role + "</span>" : "") +
      '<a class="xk-acc-out" href="/auth/logout" title="登出">登出</a>';
    document.body.appendChild(el);
  }

  function run() {
    fetch("/v1/me", { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (me) {
        if (!me || !me.ssoActive || !me.authenticated) return;
        window.__XITTO_ME__ = me;
        if (document.body) mount(me);
        else document.addEventListener("DOMContentLoaded", function () { mount(me); });
      })
      .catch(function () {});
  }
  run();
})();
