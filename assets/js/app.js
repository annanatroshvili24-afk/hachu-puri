/* ============================================================================
   app.js – корзина и оформление заказа «Хачу Пури». Ванильный JS, без библиотек.
   ----------------------------------------------------------------------------
   Для программиста WordPress:
   - данные блюд берутся из window.HP_MENU (assets/js/menu-data.js), в WP их отдаст WooCommerce;
   - отправка заказа – функция sendOrder(): укажите CONFIG.orderEndpoint, сейчас заказ имитируется;
   - оплата – экран «pay»: сюда встраивается переход на ЮKassa (CONFIG.paymentUrl);
   - окна: «Заказ принят» (done), «Оплата не прошла» (payerror), «Заказ не отправился» (senderror);
   - логи – HPLogger: debug/info/warn/error, транспорт меняется через HPLogger.setTransport(fn),
     например для Sentry. Имя, телефон и адрес клиента в лог НЕ пишутся.
   ========================================================================== */
(function () {
  "use strict";

  /* ------------------------------------------------------------ настройки --- */
  var CONFIG = {
    // ДЕМО-цифры: заказчик пришлёт настоящие. null в deliveryFee – «по тарифу, сообщит оператор»
    deliveryFee: 150,       // стоимость доставки, ₽
    freeFrom: 1500,         // бесплатная доставка от суммы, ₽
    minOrder: 600,          // минимальная сумма заказа на доставку, ₽
    orderEndpoint: null,    // URL приёма заказа (WP REST); null – демо-режим
    paymentUrl: null,       // URL оплаты (ЮKassa); null – демо-экран оплаты
    deliveryTime: "60–90 минут",
    pickupTime: "20–30 минут",
    pickupPlace: "фудкорт ТРЦ, 1 этаж, ул. Весенняя, 56"
  };

  /* ---------------------------------------------------------- логирование --- */
  var HPLogger = (function () {
    var LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
    var min = LEVELS.info;
    var session = Math.random().toString(36).slice(2, 10);
    var transport = function (entry) {
      var fn = entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : "log";
      if (window.console) console[fn]("[hp]", entry.msg, entry);
    };
    function write(level, msg, data, err) {
      if (LEVELS[level] < min) return;
      // пример записи: { ts, level, msg, session, page, requestId?, fn?, ...data, error?: { message, stack } }
      var entry = { ts: new Date().toISOString(), level: level, msg: msg, session: session, page: location.pathname };
      for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) entry[k] = data[k];
      if (err) entry.error = { message: String(err.message || err), stack: err.stack || null };
      try { transport(entry); } catch (e) { /* лог не должен ронять сайт */ }
    }
    return {
      debug: function (m, d) { write("debug", m, d || {}); },
      info: function (m, d) { write("info", m, d || {}); },
      warn: function (m, d) { write("warn", m, d || {}); },
      error: function (m, err, d) { write("error", m, d || {}, err); },
      setLevel: function (l) { if (LEVELS[l]) min = LEVELS[l]; },
      setTransport: function (fn) { if (typeof fn === "function") transport = fn; }
    };
  })();
  window.HPLogger = HPLogger;
  window.addEventListener("error", function (e) { HPLogger.error("uncaught", e.error || new Error(e.message), { fn: "window.onerror", src: e.filename, line: e.lineno }); });
  window.addEventListener("unhandledrejection", function (e) { HPLogger.error("unhandled promise", e.reason || new Error("rejection"), { fn: "unhandledrejection" }); });

  /* ------------------------------------------------------------ помощники --- */
  var ROOT = document.body.getAttribute("data-root") || "";
  var MENU = (window.HP_MENU && window.HP_MENU.items) || {};
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  var rub = function (n) { return n.toLocaleString("ru-RU").replace(/\s/g, " ") + " ₽"; };
  var plural = function (n, a, b, c) { var m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
  var num = function (n) { return String(Math.round(n * 10) / 10).replace(".", ","); };
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* приватный режим – работаем без сохранения */ } }
  };
  var ICON = {
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>',
    card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10.5h18M7 15h4"/></svg>'
  };

  /* -------------------------------------------------------------- корзина --- */
  // ключ строки: "раздел/блюдо" или "раздел/блюдо@индекс_объёма"
  var cart = store.get("hp-cart", {});
  var sel = {}; // выбранный объём напитка: { id: индекс }
  Object.keys(cart).forEach(function (k) { if (!MENU[k.split("@")[0]] || !(cart[k] > 0)) delete cart[k]; });
  var keyFor = function (id) { return MENU[id] && MENU[id].sizes ? id + "@" + (sel[id] || 0) : id; };
  function lineInfo(key) {
    var p = key.split("@"), it = MENU[p[0]], s = p[1] != null ? it.sizes[+p[1]] : null;
    return { id: p[0], it: it, price: s ? s.price : it.price, name: it.name + (s ? ", " + s.v : ""), unit: it.unit };
  }
  function totals() {
    var lines = 0, sum = 0;
    Object.keys(cart).forEach(function (k) { lines++; sum += cart[k] * lineInfo(k).price; });
    var pickup = typeof form !== "undefined" && form.how === "pickup";
    var fee = !pickup && CONFIG.deliveryFee != null && !(CONFIG.freeFrom && sum >= CONFIG.freeFrom) ? CONFIG.deliveryFee : 0;
    return { lines: lines, sum: sum, fee: fee, total: sum + fee };
  }
  function changeQty(key, d) {
    var info = lineInfo(key), min = info.it.min || 1, n = cart[key] || 0;
    n = d > 0 ? (n ? n + d : min) : n + d;   // первое нажатие у хинкали – сразу 3 шт.
    if (n < min) delete cart[key]; else cart[key] = Math.min(n, 50);
    store.set("hp-cart", cart);
    HPLogger.debug("cart change", { fn: "changeQty", item: key, qty: cart[key] || 0 });
  }

  /* --------------------------------------- кнопки «+» и счётчики в карточках --- */
  function buyHTML(id, wide) {
    var it = MENU[id], key = keyFor(id), n = cart[key] || 0;
    if (!n) {
      return '<button class="add' + (wide ? " add--wide" : "") + '" type="button" data-add="' + id + '" aria-label="В корзину: ' + esc(it.name) + '">' + ICON.plus + (wide ? "В корзину" : "") + "</button>";
    }
    return '<span class="step" role="group" aria-label="' + esc(it.name) + ', количество">' +
      '<button type="button" data-dec="' + id + '" aria-label="Убрать одну">' + ICON.minus + "</button>" +
      '<output aria-live="polite">' + n + (it.unit ? " " + it.unit : "") + "</output>" +
      '<button type="button" data-add="' + id + '" aria-label="Добавить ещё одну">' + ICON.plus + "</button></span>";
  }
  function paintBuy(id) {
    $$('[data-buy="' + id + '"]').forEach(function (el) { el.innerHTML = buyHTML(id, el.hasAttribute("data-wide")); });
  }
  function paintAll() { Object.keys(MENU).forEach(function (id) { if ($('[data-buy="' + id + '"]')) paintBuy(id); }); }

  // переключатель объёма: меняет цену, КБЖУ и счётчик
  function pickSize(id, i) {
    sel[id] = i;
    var it = MENU[id], s = it.sizes[i];
    $$('[data-sizes="' + id + '"] button').forEach(function (b) { b.setAttribute("aria-pressed", String(+b.getAttribute("data-size") === i)); });
    $$('[data-price="' + id + '"]').forEach(function (el) { el.textContent = rub(s.price); });
    var k = $('[data-kbju="' + id + '"]');
    if (k && s.kbju) $$("dd", k).forEach(function (dd, j) { dd.textContent = j === 3 ? Math.round(s.kbju[3]) : num(s.kbju[j]); });
    paintBuy(id);
  }

  /* ------------------------------------------------- плашка и счётчик в шапке --- */
  var bar = $("[data-cartbar]");
  function refresh() {
    var t = totals();
    $("[data-sum]").textContent = rub(t.sum);
    $("[data-qty]").textContent = t.lines + " " + plural(t.lines, "позиция", "позиции", "позиций");
    $$("[data-count]").forEach(function (b) { b.textContent = t.lines ? t.lines : ""; });
    bar.classList.toggle("is-on", t.lines > 0 && !sheet.open);
    if (sheet.open && view === "cart") renderCart();
  }
  function bump() { bar.classList.remove("bump"); void bar.offsetWidth; bar.classList.add("bump"); }

  /* ------------------------------------------------------- окно корзины --- */
  var sheet = $("[data-sheet]"), ticket = $("[data-ticket]"), view = "cart", order = null, busy = false;
  var form = store.get("hp-form", { how: "delivery", name: "", phone: "", street: "", apt: "", entr: "", floor: "", when: "asap", time: "", pay: "online", change: "", comment: "" });
  if (!form.how) form.how = "delivery";
  form.consent = false;

  var top = function (title, sub) {
    return '<div class="ticket__top"><div><h2>' + title + "</h2>" + (sub ? "<small>" + sub + "</small>" : "") + '</div><button class="x" type="button" data-close aria-label="Закрыть">' + ICON.x + "</button></div>";
  };
  var PAY = { online: "Онлайн картой", card: "Картой при получении", cash: "Наличными" };

  function slots() {
    var out = [], d = new Date(); d.setSeconds(0, 0);
    d.setMinutes(Math.ceil((d.getMinutes() + 90) / 30) * 30);
    for (var i = 0; i < 16; i++) {
      if (d.getHours() >= 10 && (d.getHours() < 22 || (d.getHours() === 22 && d.getMinutes() === 0))) out.push(("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2));
      d.setMinutes(d.getMinutes() + 30);
    }
    return out.length ? out : ["10:30", "11:00", "11:30", "12:00"];
  }
  function radio(name, val, label) {
    return '<label><input type="radio" name="' + name + '" value="' + val + '"' + (form[name] === val ? " checked" : "") + "><span>" + label + "</span></label>";
  }
  function field(name, label, attrs, err) {
    return '<label class="fld"><span>' + label + '</span><input name="' + name + '" value="' + esc(form[name]) + '" ' + (attrs || "") + ">" + (err ? '<em data-err="' + name + '"></em>' : "") + "</label>";
  }

  function renderCart() {
    var t = totals();
    if (!t.lines) {
      ticket.innerHTML = top("Ваш заказ") + '<div class="empty"><p>В корзине пока пусто. Добавьте блюда кнопкой «+» в меню.</p><a class="v-btn" href="' + ROOT + '#menu" data-close>Открыть меню</a></div>';
      return;
    }
    var lines = Object.keys(cart).map(function (k) {
      var li = lineInfo(k), n = cart[k];
      return '<div class="line"><div><h4>' + esc(li.name) + "</h4><small>" + n + (li.unit ? " " + li.unit : "") + " × " + rub(li.price) + "</small></div>" +
        '<span class="price">' + rub(n * li.price) + "</span>" +
        '<span class="step" role="group" aria-label="' + esc(li.name) + ', количество"><button type="button" data-ldec="' + k + '" aria-label="Убрать одну">' + ICON.minus + "</button><output>" + n + "</output>" +
        '<button type="button" data-ladd="' + k + '" aria-label="Добавить ещё">' + ICON.plus + "</button></span></div>";
    }).join("");
    var pickup = form.how === "pickup";
    var feeTxt = pickup ? "самовывоз, бесплатно" : CONFIG.deliveryFee == null ? "по тарифу, сообщит оператор" : t.fee ? rub(t.fee) : "бесплатно";
    var short = !pickup && CONFIG.minOrder && t.sum < CONFIG.minOrder;
    var freeHint = !pickup && t.fee && CONFIG.freeFrom ? "<div><span>До бесплатной доставки</span><b>" + rub(CONFIG.freeFrom - t.sum) + "</b></div>" : "";
    var times = slots().map(function (s) { return "<option" + (form.time === s ? " selected" : "") + ">" + s + "</option>"; }).join("");
    ticket.innerHTML = top("Ваш заказ", "Доставка по Волгодонску или самовывоз") +
      '<div class="lines">' + lines + "</div>" +
      '<div class="sumrows"><div><span>Блюда</span><b>' + rub(t.sum) + "</b></div><div><span>Доставка</span><b>" + feeTxt + "</b></div>" + freeHint + "</div>" +
      '<div class="total"><span>Итого</span><b>' + rub(t.total) + "</b></div>" +
      '<form class="form" data-form novalidate>' +
        "<h3>Как получить</h3>" +
        '<div class="fld"><div class="seg">' + radio("how", "delivery", "Доставка") + radio("how", "pickup", "Самовывоз") + "</div></div>" +
        (pickup ? '<p class="note" style="text-align:left">Заберёте на стойке: ' + CONFIG.pickupPlace + ". Приготовим за " + CONFIG.pickupTime + ".</p>" : "") +
        field("name", "Имя", 'autocomplete="given-name" required', true) +
        field("phone", "Телефон – позвоним, чтобы подтвердить заказ", 'type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 900 000-00-00" required', true) +
        (pickup ? "" : field("street", "Улица и дом", 'autocomplete="address-line1" placeholder="Например: Ленина, 10" required', true) +
        '<div class="fld-row">' + field("apt", "Квартира", 'inputmode="numeric"') + field("entr", "Подъезд", 'inputmode="numeric"') + field("floor", "Этаж", 'inputmode="numeric"') + "</div>") +
        '<div class="fld"><span>' + (pickup ? "Когда заберёте" : "Когда привезти") + '</span><div class="seg">' + radio("when", "asap", "Как можно скорее") + radio("when", "time", "Ко времени") + "</div></div>" +
        '<label class="fld" data-time' + (form.when === "time" ? "" : " hidden") + '><span>Ко скольки</span><select name="time">' + times + "</select></label>" +
        '<div class="fld"><span>Оплата</span><div class="seg seg--3">' + radio("pay", "online", "Онлайн картой") + radio("pay", "card", "Картой при получении") + radio("pay", "cash", "Наличными") + "</div></div>" +
        '<label class="fld" data-change' + (form.pay === "cash" ? "" : " hidden") + '><span>С какой суммы приготовить сдачу</span><input name="change" inputmode="numeric" value="' + esc(form.change) + '" placeholder="Например: 5000"></label>' +
        '<label class="fld"><span>Комментарий</span><textarea name="comment" placeholder="Например: домофон не работает, позвоните">' + esc(form.comment) + "</textarea></label>" +
        '<label class="check" data-consent><input type="checkbox" name="consent"' + (form.consent ? " checked" : "") + '><span>Согласен на обработку персональных данных по <a href="' + ROOT + 'politika/" target="_blank">политике</a> и принимаю условия <a href="' + ROOT + 'oferta/" target="_blank">оферты</a></span></label>' +
        '<button class="v-btn" type="submit"' + (short ? " disabled" : "") + ">" + (form.pay === "online" ? "Перейти к оплате – " : "Отправить заказ – ") + rub(t.total) + "</button>" +
        (short ? '<p class="note">Минимальная сумма заказа на доставку – ' + rub(CONFIG.minOrder) + ". Добавьте ещё блюд на " + rub(CONFIG.minOrder - t.sum) + ".</p>" : '<p class="note">После заказа оператор позвонит для подтверждения.</p>') +
      "</form>";
  }

  function readForm(f) {
    ["name", "phone", "street", "apt", "entr", "floor", "change", "comment"].forEach(function (n) { if (f[n]) form[n] = f[n].value.trim(); });
    form.how = f.how.value;
    form.when = f.when.value; form.pay = f.pay.value; form.time = f.time ? f.time.value : ""; form.consent = f.consent.checked;
    var keep = {}; for (var k in form) if (k !== "consent") keep[k] = form[k];
    store.set("hp-form", keep);
  }

  function validate(f) {
    var bad = null;
    var setErr = function (name, msg) {
      var inp = f[name], er = $('[data-err="' + name + '"]', ticket);
      inp.setAttribute("aria-invalid", "true"); if (er) er.textContent = msg; bad = bad || inp;
    };
    if (!form.name) setErr("name", "Напишите имя – так к вам обратится оператор");
    if (form.phone.replace(/\D/g, "").length < 10) setErr("phone", "Нужен номер из 10–11 цифр, например +7 900 000-00-00");
    if (form.how === "delivery" && !form.street) setErr("street", "Укажите улицу и дом");
    if (!form.consent) { $("[data-consent]", ticket).setAttribute("aria-invalid", "true"); bad = bad || f.consent; }
    if (bad) { bad.focus(); HPLogger.warn("checkout invalid", { fn: "validate" }); }
    return !bad;
  }

  // Отправка заказа. В WordPress: POST на CONFIG.orderEndpoint, ответ { number }.
  function sendOrder(o) {
    var requestId = "o-" + Date.now().toString(36);
    HPLogger.info("order send", { fn: "sendOrder", requestId: requestId, lines: o.items.length, total: o.total, payment: o.payment });
    if (!CONFIG.orderEndpoint) {
      return new Promise(function (res) { setTimeout(function () { res({ number: 100 + Math.floor(Math.random() * 900) }); }, 700); });
    }
    return fetch(CONFIG.orderEndpoint, { method: "POST", headers: { "Content-Type": "application/json", "X-Request-Id": requestId }, body: JSON.stringify(o) })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .catch(function (e) { HPLogger.error("order send failed", e, { fn: "sendOrder", requestId: requestId }); throw e; });
  }

  function submit() {
    var t = totals();
    order = {
      items: Object.keys(cart).map(function (k) { var li = lineInfo(k), p = k.split("@"); return { id: li.id, size: p[1] != null ? MENU[li.id].sizes[+p[1]].v : null, qty: cart[k], price: li.price }; }),
      customer: { name: form.name, phone: form.phone },
      method: form.how,
      address: form.how === "pickup" ? null : { street: form.street, apt: form.apt, entrance: form.entr, floor: form.floor },
      when: form.when === "time" ? form.time : "asap", payment: form.pay, change: form.change, comment: form.comment,
      sum: t.sum, delivery: t.fee, total: t.total, paid: false, number: null
    };
    busy = true;
    var btn = $('[type="submit"]', ticket); if (btn) { btn.disabled = true; btn.textContent = "Отправляем…"; }
    sendOrder(order).then(function (res) {
      busy = false; order.number = res.number;
      show(order.payment === "online" ? "pay" : "done");
    }, function () { busy = false; show("senderror"); });
  }

  function recapHTML() {
    var when = order.when === "asap" ? "как можно скорее" : "к " + order.when;
    var pay = order.payment === "online" ? (order.paid ? "оплачен онлайн" : "онлайн картой") : PAY[order.payment].toLowerCase();
    return '<div class="recap"><div><span>Сумма</span><b>' + rub(order.total) + "</b></div><div><span>Оплата</span><b>" + pay + "</b></div>" +
      "<div><span>" + (order.address ? "Адрес" : "Получение") + "</span><b>" + (order.address ? esc(order.address.street) + (order.address.apt ? ", кв. " + esc(order.address.apt) : "") : "самовывоз") + "</b></div><div><span>Когда</span><b>" + when + "</b></div></div>";
  }

  function show(v) {
    view = v;
    if (v === "cart") { renderCart(); }
    else if (v === "pay") {
      ticket.innerHTML = top("Оплата", "Заказ №" + order.number) +
        '<div class="pay"><div class="done__icon">' + ICON.card + "</div><h3>Оплатите заказ картой</h3>" +
        "<p>Сейчас откроется защищённая страница оплаты. После оплаты вернём вас на сайт.</p>" +
        '<div class="paybox">К оплате<b>' + rub(order.total) + "</b></div>" +
        '<button class="v-btn" type="button" data-pay>Оплатить ' + rub(order.total) + "</button>" +
        '<p class="demo-hint">Демо: здесь будет переход на ЮKassa. Посмотреть окна: <button type="button" data-demo="payerror">ошибка оплаты</button> или <button type="button" data-demo="senderror">сбой отправки</button>.</p></div>';
    }
    else if (v === "done") {
      ticket.innerHTML = top("Заказ принят", order.address ? "Доставка по Волгодонску" : "Самовывоз") +
        '<div class="done"><div class="done__n">№' + order.number + "</div><h3>Начинаем готовить</h3>" +
        "<p>Оператор позвонит на " + esc(order.customer.phone) + " в течение 5 минут и подтвердит заказ. " + (order.address ? "Привезём примерно через " + CONFIG.deliveryTime + "." : "Приготовим за " + CONFIG.pickupTime + ", заберите на стойке: " + CONFIG.pickupPlace + ".") + "</p>" +
        recapHTML() + '<button class="v-btn" type="button" data-close data-finish>Вернуться в меню</button></div>';
      HPLogger.info("order done", { fn: "show", number: order.number, payment: order.payment, paid: order.paid });
    }
    else if (v === "payerror") {
      ticket.innerHTML = top("Оплата не прошла", "Заказ №" + order.number) +
        '<div class="done"><div class="done__icon">' + ICON.alert + "</div><h3>Деньги не списались</h3>" +
        "<p>Банк отклонил платёж. Проверьте данные карты и попробуйте ещё раз или оплатите при получении – заказ сохранён.</p>" +
        '<button class="v-btn" type="button" data-pay-retry>Оплатить ещё раз</button>' +
        '<button class="v-btn v-btn--ghost" type="button" data-pay-courier>Оплачу при получении</button></div>';
      HPLogger.warn("payment failed", { fn: "show", number: order.number });
    }
    else if (v === "senderror") {
      ticket.innerHTML = top("Заказ не отправился") +
        '<div class="done"><div class="done__icon">' + ICON.alert + "</div><h3>Нет связи с сервером</h3>" +
        "<p>Заказ до нас не дошёл, деньги не списывались. Корзина сохранена: отправьте ещё раз или позвоните – примем заказ по телефону.</p>" +
        '<button class="v-btn" type="button" data-resend>Отправить ещё раз</button>' +
        '<a class="v-btn v-btn--ghost" href="tel:+79064164585">Позвонить +7 906 416-45-85</a></div>';
    }
    var f = $("button, input, a", ticket); if (f) f.focus({ preventScroll: true });
  }

  function openSheet() {
    show("cart");
    if (typeof sheet.showModal === "function") sheet.showModal(); else sheet.setAttribute("open", "");
    bar.classList.remove("is-on");
    document.documentElement.style.overflow = "hidden";
    closeNav();
    HPLogger.debug("cart open", { fn: "openSheet", lines: totals().lines });
  }
  function closeSheet() {
    if (typeof sheet.close === "function" && sheet.open) sheet.close(); else { sheet.removeAttribute("open"); onClosed(); }
  }
  function onClosed() {
    document.documentElement.style.overflow = "";
    if (view === "done") { cart = {}; store.set("hp-cart", cart); form.comment = ""; paintAll(); view = "cart"; }
    refresh();
  }
  sheet.addEventListener("close", onClosed);

  /* ---------------------------------------------------------- события ------ */
  document.addEventListener("click", function (e) {
    var t = e.target, a;
    if ((a = t.closest("[data-add]"))) {
      var id = a.getAttribute("data-add"), keep = document.activeElement === a;
      changeQty(keyFor(id), 1); paintBuy(id); refresh(); bump();
      if (keep) refocus(id, "data-add");
      HPLogger.info("cart add", { fn: "click", item: keyFor(id) });
    } else if ((a = t.closest("[data-dec]"))) {
      var id2 = a.getAttribute("data-dec");
      changeQty(keyFor(id2), -1); paintBuy(id2); refresh();
      refocus(id2, cart[keyFor(id2)] ? "data-dec" : "data-add");
    } else if ((a = t.closest("[data-ladd]")) || (a = t.closest("[data-ldec]"))) {
      var k = a.getAttribute("data-ladd") || a.getAttribute("data-ldec");
      changeQty(k, a.hasAttribute("data-ladd") ? 1 : -1); paintBuy(k.split("@")[0]); refresh();
    } else if ((a = t.closest("[data-size]"))) {
      var g = a.closest("[data-sizes]"); if (g) pickSize(g.getAttribute("data-sizes"), +a.getAttribute("data-size"));
    }
    if (t.closest("[data-open-cart]")) openSheet();
    if (t.closest("[data-pay]")) { order.paid = true; show("done"); }
    if (t.closest("[data-pay-retry]")) show("pay");
    if (t.closest("[data-pay-courier]")) { order.payment = "card"; show("done"); }
    if (t.closest("[data-resend]") && !busy) { show("cart"); submit(); }
    if ((a = t.closest("[data-demo]"))) show(a.getAttribute("data-demo"));
    if (t.closest("[data-close]")) closeSheet();
    if (t.closest("[data-burger]")) toggleNav();
    if (t.closest("#nav a")) closeNav();
    if (t.closest("[data-cookie-ok]")) { store.set("hp-cookie", 1); $("[data-cookie]").hidden = true; }
  });
  function refocus(id, attr) {
    var el = document.querySelector("main [" + attr + '="' + id + '"]');
    if (el) el.focus({ preventScroll: true });
  }

  ticket.addEventListener("input", function (e) {
    var f = e.target.form; if (!f) return; readForm(f);
    if (e.target.getAttribute("aria-invalid")) { e.target.removeAttribute("aria-invalid"); var er = $('[data-err="' + e.target.name + '"]', ticket); if (er) er.textContent = ""; }
  });
  ticket.addEventListener("change", function (e) {
    var f = e.target.form; if (!f) return; readForm(f);
    if (e.target.name === "how") { renderCart(); var r = $('[name="how"]:checked', ticket); if (r) r.focus(); return; }
    if (e.target.name === "when") $("[data-time]", ticket).hidden = form.when !== "time";
    if (e.target.name === "pay") { $("[data-change]", ticket).hidden = form.pay !== "cash"; var b = $('[type="submit"]', ticket); b.textContent = (form.pay === "online" ? "Перейти к оплате – " : "Отправить заказ – ") + rub(totals().total); }
    if (e.target.name === "consent") $("[data-consent]", ticket).removeAttribute("aria-invalid");
  });
  ticket.addEventListener("submit", function (e) {
    e.preventDefault(); if (busy) return; readForm(e.target);
    if (validate(e.target)) submit();
  });

  /* ------------------------------------------------ шапка, меню, категории --- */
  var hdr = $("[data-bar]"), burger = $("[data-burger]");
  function toggleNav() { var on = !hdr.classList.contains("is-open"); hdr.classList.toggle("is-open", on); burger.setAttribute("aria-expanded", String(on)); }
  function closeNav() { hdr.classList.remove("is-open"); if (burger) burger.setAttribute("aria-expanded", "false"); }
  var onScroll = function () { hdr.classList.toggle("is-scrolled", scrollY > 40); };
  addEventListener("scroll", onScroll, { passive: true }); onScroll();

  // главная: подсветка текущего раздела в ленте категорий
  var chipsRow = $("[data-chips]");
  if (chipsRow && $("[data-chip]") && "IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (en) {
        if (!en.isIntersecting) return;
        var cid = en.target.getAttribute("data-cat");
        $$("[data-chip]").forEach(function (c) {
          var on = c.getAttribute("data-chip") === cid;
          c.classList.toggle("is-on", on);
          if (on) chipsRow.scrollTo({ left: c.offsetLeft - 16, behavior: "smooth" });
        });
      });
    }, { rootMargin: "-40% 0px -55% 0px" });
    $$("[data-cat]").forEach(function (s) { io.observe(s); });
  }
  // страница раздела: текущий раздел виден в ленте
  var cur = $(".chips [aria-current]"); if (cur && chipsRow) chipsRow.scrollLeft = cur.offsetLeft - 16;

  if (!store.get("hp-cookie", 0)) $("[data-cookie]").hidden = false;

  paintAll();
  refresh();
  if (window.Vibe) window.Vibe.mount(document.querySelector(".v-page"));
  HPLogger.info("page ready", { fn: "init", items: Object.keys(MENU).length, cartLines: totals().lines });
})();
