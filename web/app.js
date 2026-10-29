// Общий код экранов. Опрос сервера раз в 2 с; звук — локальный файл /alarm.wav.
(function () {
  const role = document.body.dataset.role;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtTs = (s) => s ? new Date(s).toLocaleString("ru-RU", { timeZone: "UTC", hour12: false }) + " UTC" : "—";
  const fmtNum = (v) => v === null || v === undefined ? "—" : Math.abs(v) >= 100 ? v.toFixed(1) : v.toPrecision(4);
  const ago = (s, now) => { if (!s || !now) return ""; const m = Math.round((new Date(now) - new Date(s)) / 60000);
    return m < 60 ? `${m} мин назад` : m < 2880 ? `${Math.round(m / 60)} ч назад` : `${Math.round(m / 1440)} сут назад`; };
  // Пометки М2, которые стоит показать оператору (служебные вроде state_derived скрыты).
  const FLAG_TITLES = { outlier: "выброс", nonphysical: "нефизичное", non_numeric: "нечисловое", gap: "пропуск",
    restored: "восстановлено", downtime: "простой", zero_flow_pressure: "давление при нулевом расходе", excluded: "исключено" };
  const shownFlags = (f) => (f || "").split(";").filter((x) => FLAG_TITLES[x]).map((x) => FLAG_TITLES[x]).join(", ");
  let reasons = {}, soundOn = false, playedFor = null, ackFor = null;
  const audio = $("#alarm-sound");
  // Состояние форм решения переживает опрос сервера: черновики по id события, отправки в работе,
  // ошибки отправки. Строки уведомлений не пересоздаются, пока событие не изменилось.
  const drafts = new Map(), pending = new Set(), errors = new Map();
  const storedUser = () => { try { return localStorage.getItem("ft-user") || ""; } catch (e) { return ""; } };

  // Тема: системная, светлая или тёмная (атрибут data-theme на <html>), выбор помнится в браузере.
  const themeBtn = $("#theme-toggle");
  const THEMES = { "": "Тема: как в системе", light: "Тема: светлая", dark: "Тема: тёмная" };
  function applyTheme(t) {
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    if (themeBtn) themeBtn.textContent = THEMES[t];
  }
  let theme = ""; try { theme = localStorage.getItem("ft-theme") || ""; } catch (e) {}
  applyTheme(THEMES[theme] ? theme : "");
  if (themeBtn) themeBtn.addEventListener("click", () => {
    theme = theme === "" ? "light" : theme === "light" ? "dark" : "";
    applyTheme(theme); try { localStorage.setItem("ft-theme", theme); } catch (e) {}
  });

  const soundBtn = $("#sound-toggle");
  soundBtn.addEventListener("click", () => {
    soundOn = !soundOn;
    soundBtn.textContent = soundOn ? "Звук включён" : "Включить звук";
    soundBtn.classList.toggle("primary", soundOn);
    if (soundOn) { audio.play().then(() => audio.pause()).catch(() => {}); audio.currentTime = 0; }
  });
  const ackBtn = $("#sound-ack");
  if (ackBtn) ackBtn.addEventListener("click", () => { ackFor = playedFor; audio.pause(); audio.loop = false; });

  function reasonOptions(selected) {
    return Object.entries(reasons).map(([k, v]) =>
      `<option value="${esc(k)}"${k === selected ? " selected" : ""}>${esc(v)}</option>`).join("");
  }
  function decideForm(e, where) {
    if (e.decision) return `<div class="decided"><span class="badge ${e.decision === "confirm" ? "ok" : "neutral"}">${e.decision === "confirm" ? "подтверждено" : "отклонено"}</span>
      <span class="muted">${esc(reasons[e.reason_code] || e.reason_code)} · ${esc(e.decided_by)}</span></div>`;
    const d = drafts.get(e.id) || {}, busy = pending.has(e.id), err = errors.get(e.id);
    const id = `${where}-${e.id}`;
    return `<form class="decide" data-id="${e.id}"${busy ? ' aria-busy="true"' : ""}>
      <label class="sr" for="${id}-reason">Причина</label>
      <select id="${id}-reason" name="reason_code" required><option value="">Причина…</option>${reasonOptions(d.reason_code)}</select>
      <label class="sr" for="${id}-user">ФИО</label>
      <input id="${id}-user" name="user_name" placeholder="ФИО" required autocomplete="name" value="${esc(d.user_name ?? storedUser())}">
      <label class="sr" for="${id}-comment">Комментарий</label>
      <input id="${id}-comment" name="comment" placeholder="Комментарий" value="${esc(d.comment || "")}">
      <span class="actions">
        <button type="submit" name="decision" value="confirm" class="primary"${busy ? " disabled" : ""}>Подтвердить</button>
        <button type="submit" name="decision" value="reject" class="secondary"${busy ? " disabled" : ""}>Отклонить</button>
      </span>
      <span class="status${err ? " error" : ""}" role="status" aria-live="polite">${busy ? "Сохраняю…" : esc(err || "")}</span>
    </form>`;
  }
  // Черновик формы: всё, что человек ввёл, — по id события; восстанавливается при пересоздании строки.
  function saveDraft(f) {
    const fd = new FormData(f);
    drafts.set(+f.dataset.id, { reason_code: fd.get("reason_code"), user_name: fd.get("user_name"), comment: fd.get("comment") });
  }
  document.addEventListener("input", (ev) => { const f = ev.target.closest("form.decide"); if (f) saveDraft(f); });
  document.addEventListener("change", (ev) => { const f = ev.target.closest("form.decide"); if (f) saveDraft(f); });
  // Запоминаем нажатую кнопку: ev.submitter есть не во всех браузерах.
  document.addEventListener("click", (ev) => {
    const b = ev.target.closest("form.decide button[name=decision]"); if (b) b.form.dataset.decision = b.value;
  });
  function setFormState(f, busy, msg) {
    f.querySelectorAll("button").forEach((b) => { b.disabled = busy; });
    f.toggleAttribute("aria-busy", busy);
    const s = f.querySelector(".status");
    s.textContent = busy ? "Сохраняю…" : msg || "";
    s.classList.toggle("error", !busy && !!msg);
  }
  document.addEventListener("submit", async (ev) => {
    const f = ev.target.closest("form.decide"); if (!f) return;
    ev.preventDefault();
    const id = +f.dataset.id;
    if (pending.has(id)) return;                     // повторный клик, пока сохраняется
    saveDraft(f);
    const fd = new FormData(f);
    const body = { event_id: id, decision: (ev.submitter && ev.submitter.value) || f.dataset.decision || "confirm",
      reason_code: fd.get("reason_code"), user_name: (fd.get("user_name") || "").trim(), role, comment: fd.get("comment") || null };
    try { localStorage.setItem("ft-user", body.user_name); } catch (e) {}
    pending.add(id); errors.delete(id); setFormState(f, true);
    let msg = null;
    try {
      const r = await fetch("/api/decision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) {
        let detail = ""; try { detail = (await r.json()).detail; } catch (e) {}
        msg = `Не сохранено: ${typeof detail === "string" && detail ? detail : "сервер ответил " + r.status}`;
      }
    } catch (e) { msg = "Не сохранено: нет связи с сервером. Проверьте связь и нажмите ещё раз."; }
    pending.delete(id);
    if (msg) { errors.set(id, msg); document.querySelectorAll(`form.decide[data-id="${id}"]`).forEach((x) => setFormState(x, false, msg)); return; }
    drafts.delete(id);
    if (playedFor === id) { audio.pause(); audio.loop = false; }
    refresh();
  });

  function srcBadge(e) {
    return e.source === "asu" ? `<span class="badge src-asu">АСУ ТП</span>` : `<span class="badge src-twin">Двойник</span>`;
  }
  // Подпись события: если она не изменилась, строку не трогаем (в ней может идти ввод).
  const signature = (e) => [e.ts, e.code, e.message, e.shadow, e.decision, e.reason_code, e.decided_by].join("\u0001");
  function rowHtml(e, withForm) {
    return `<td class="num ts">${fmtTs(e.ts)}</td><td class="code">${srcBadge(e)} <b>${esc(e.code)}</b>
      ${e.shadow ? '<span class="badge shadow">теневой режим</span>' : ""}</td>
      <td class="msg">${esc(e.message)}${withForm && e.source !== "asu" ? decideForm(e, "ev") : ""}</td>`;
  }
  function syncRows(tbody, list, withForm) {
    if (!tbody) return;
    if (!list.length) {
      if (!tbody.querySelector("td.empty")) tbody.innerHTML = `<tr><td colspan="3" class="empty">нет</td></tr>`;
      return;
    }
    const empty = tbody.querySelector("td.empty"); if (empty) empty.parentElement.remove();
    const existing = new Map([...tbody.children].map((tr) => [tr.dataset.key, tr]));
    list.forEach((e, i) => {
      const key = `${e.source}:${e.id}`, sig = signature(e);
      let tr = existing.get(key);
      if (tr) existing.delete(key);
      if (!tr) { tr = document.createElement("tr"); tr.dataset.key = key; }
      if (tr.dataset.sig !== sig) { tr.dataset.sig = sig; tr.innerHTML = rowHtml(e, withForm); }
      // Переставляем узел, только если он не на своём месте: перенос сбрасывает фокус.
      if (tbody.children[i] !== tr) tbody.insertBefore(tr, tbody.children[i] || null);
    });
    existing.forEach((tr) => { if (!tr.contains(document.activeElement)) tr.remove(); });
  }

  function renderAlert(st) {
    const box = $("#alert"); if (!box) return;
    const e = st.events.find((x) => x.id === st.sound_event_id);
    if (!e) { if (box.dataset.sig) { box.classList.remove("on"); box.innerHTML = ""; box.dataset.sig = ""; } return; }
    const sig = `${e.id}\u0001${signature(e)}`;
    if (box.dataset.sig !== sig) {
      box.dataset.sig = sig;
      box.classList.add("on");
      const delay = e.delay_s != null ? ` · от первого срабатывания модели ${Math.round(e.delay_s / 60)} мин` : "";
      box.innerHTML = `<h2>Предупреждение: гидраты в абсорбере ${esc(e.object_id)}</h2>
        <p class="meta">${esc(fmtTs(e.ts))}${delay}</p><p><b>Действия:</b> ${esc(e.actions)}</p>${decideForm(e, "alert")}`;
    }
    if (soundOn && playedFor !== e.id && ackFor !== e.id) { audio.loop = true; audio.currentTime = 0; audio.play().catch(() => {}); playedFor = e.id; }
  }

  function renderSnapshot(snap) {
    $("#now").textContent = snap ? "Время данных: " + fmtTs(snap.now) : "Нет данных: цикл двойника ещё не запускался";
    if (!snap) return;
    $("#groups").innerHTML = (snap.groups[role] || []).map((g) => `<h3>${esc(g.title)}</h3><table>
      <tr><th>Объект</th><th>Параметр</th><th class="num">Значение</th><th>Время</th></tr>
      ${g.rows.map((r) => `<tr><td>${esc(r.object_id)}</td><td>${esc(r.title)}</td>
        <td class="num">${fmtNum(r.value)} <span class="muted">${esc(r.unit)}</span>
        ${shownFlags(r.flags) ? `<div class="flags">${esc(shownFlags(r.flags))}</div>` : ""}</td>
        <td class="muted">${ago(r.ts, snap.now)}</td></tr>`).join("")}</table>`).join("");
    $("#freshness").innerHTML = `<tr><th>Поток</th><th>Состояние</th><th>Последнее значение</th></tr>` +
      snap.freshness.map((f) => `<tr><td>${esc(f.title)}</td>
        <td>${f.stale ? '<span class="badge stale">устарел</span>' : '<span class="badge ok">свежий</span>'}</td>
        <td class="muted">${fmtTs(f.last_ts)} (${ago(f.last_ts, snap.now)})</td></tr>`).join("");
    const g = snap.geotech;
    $("#geotech").innerHTML = `<tr><th>Пункт</th><th>Состояние</th><th class="num">Осадка, мм/год</th><th>Последний радар</th></tr>` +
      g.objects.map((o) => `<tr><td>${esc(o.object_id)}</td><td><span class="badge ${o.color}">${esc(o.title)}</span></td>
        <td class="num">${o.rate_mm_per_year == null ? "—" : o.rate_mm_per_year.toFixed(1)}</td>
        <td class="muted">${o.last_radar ? fmtTs(o.last_radar) : "нет (зимой радара нет)"}</td></tr>`).join("");
    const lm = snap.last_measurements;
    $("#last").innerHTML = `<tr><th>Что</th><th>Последний замер</th></tr>` +
      `<tr><td>Спутниковый радар (основания)</td><td>${fmtTs(lm.geotech_radar)}</td></tr>` +
      Object.entries(lm.ecp).map(([k, v]) => `<tr><td>ЭХЗ ${esc(k)} (ручной замер)</td><td>${fmtTs(v)} <span class="muted">${ago(v, snap.now)}</span></td></tr>`).join("") +
      Object.entries(lm.pipelines_survey).map(([k, v]) => `<tr><td>Обследование газопровода ${esc(k)}</td><td>${fmtTs(v)}</td></tr>`).join("");
    const hy = $("#hydrates");
    if (hy) hy.innerHTML = snap.hydrates ? snap.hydrates.map((h) => `<tr><td>${esc(h.object_id)}</td>
      <td class="num">${(h.proba * 100).toFixed(0)} %</td><td class="num">${h.positives_20min}</td></tr>`).join("")
      : `<tr><td colspan="3" class="empty">модель гидратов не обучена</td></tr>`;
  }

  async function refresh() {
    try {
      const r = await fetch(`/api/state?role=${role}`); const st = await r.json();
      reasons = st.reasons;
      renderSnapshot(st.snapshot);
      renderAlert(st);
      const twin = st.events.filter((e) => !(e.id === st.sound_event_id));
      syncRows($("#events"), twin, true);
      syncRows($("#asu"), st.asu_alarms, false);
      $("#conn").textContent = ""; $("#conn").hidden = true;
    } catch (e) { $("#conn").textContent = "нет связи с сервером"; $("#conn").hidden = false; }
  }
  refresh();
  setInterval(refresh, 2000);
})();
