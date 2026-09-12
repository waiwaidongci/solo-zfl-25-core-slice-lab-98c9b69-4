/* 岩芯样品制备与质量追踪系统 — 前端逻辑 */
const state = {
  token: localStorage.getItem("labtoken") || "",
  me: null,
  users: [],
  stages: [],
  defectLevels: [],
  batches: [],
  audit: [],
  openForm: null, // "action|batchId|sliceId"
  openHistory: new Set(),
};

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTime = iso => iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "";

function toast(msg, isErr) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast" + (isErr ? " err" : "");
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 4200);
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) { logout(false); throw new Error("会话已过期，请重新登录"); }
  if (!res.ok) throw new Error(data.message || data.error || `请求失败（${res.status}）`);
  return data;
}

function logout(callApi = true) {
  if (callApi && state.token) api("/api/logout", { method: "POST" }).catch(() => {});
  state.token = ""; state.me = null;
  localStorage.removeItem("labtoken");
  render();
}

async function boot() {
  if (state.token) {
    try { state.me = await api("/api/me"); } catch { state.token = ""; localStorage.removeItem("labtoken"); }
  }
  if (state.me) await reload();
  render();
}

async function reload() {
  const [meta, users, batches, audit] = await Promise.all([
    api("/api/meta"), api("/api/users"), api("/api/batches"), api("/api/audit"),
  ]);
  state.stages = meta.stages;
  state.defectLevels = meta.defectLevels;
  state.users = users;
  state.batches = batches;
  state.audit = audit;
}

/* ---------- 渲染 ---------- */
function render() {
  $("#login-view").hidden = !!state.me;
  $("#app-view").hidden = !state.me;
  if (!state.me) return;
  $("#me-chip").textContent = `${state.me.name}（${state.me.role === "admin" ? "管理员，可操作全部样品" : "技师，仅可操作本人负责样品"}）`;
  renderOwnerOptions();
  renderStats();
  renderBatches();
  renderAudit();
}

function renderOwnerOptions() {
  const sel = $("#batch-form [name=owner]");
  const keep = sel.value;
  sel.innerHTML = state.users.map(u => `<option value="${esc(u.username)}">${esc(u.name)}（${esc(u.username)}）</option>`).join("");
  sel.value = keep || state.me.username;
}

function renderStats() {
  const slices = state.batches.flatMap(b => b.slices);
  const stats = [
    ["批次总数", state.batches.length, ""],
    ["切片总数", slices.length, ""],
    ["退回中切片", slices.filter(s => s.status === "退回中").length, "warn"],
    ["已交付切片", slices.filter(s => s.delivered).length, ""],
  ];
  $("#stats").innerHTML = stats.map(([label, n, cls]) =>
    `<div class="stat ${cls}"><span>${label}</span><strong>${n}</strong></div>`).join("");
}

const canOperate = batch => state.me.role === "admin" || batch.owner === state.me.username;
const pillOf = batch => batch.status === "已交付" ? "done" : batch.status === "待交付" ? "ready" : "wip";

function stepperHtml(slice) {
  return `<div class="stepper">${state.stages.map((st, i) => {
    let cls = "";
    if (i < slice.stageIndex) cls = "done";
    else if (i === slice.stageIndex) cls = slice.status === "退回中" ? "current rework" : (slice.delivered ? "done" : "current");
    return `<div class="step ${cls}">${esc(st)}</div>`;
  }).join("")}</div>`;
}

function sliceInfoHtml(slice) {
  const parts = [];
  if (slice.observation) parts.push(`<div class="info-box obs"><b>观察记录：</b>${esc(slice.observation)}</div>`);
  if (slice.status === "退回中" && slice.activeReturn) {
    const r = slice.activeReturn;
    parts.push(`<div class="info-box ret"><b>退回中（缺陷等级：${esc(r.level)}）</b> — 退回工序「${esc(r.toStage)}」，原因：${esc(r.reason)}（${esc(r.by)}，${fmtTime(r.at)}）。退回期间不能交付，返工完成观察后须复检。</div>`);
  }
  if (slice.reinspection) {
    const r = slice.reinspection;
    parts.push(`<div class="info-box rei"><b>复检${r.passed ? "通过" : "不通过"}</b>${r.note ? ` — ${esc(r.note)}` : ""}（${esc(r.by)}，${fmtTime(r.at)}）</div>`);
  }
  if (slice.delivered) parts.push(`<div class="info-box del"><b>已交付</b> — ${esc(slice.deliveredBy)}，${fmtTime(slice.deliveredAt)}</div>`);
  else if (!slice.deliverable && slice.deliverBlockReason) parts.push(`<div class="muted">交付条件未满足：${esc(slice.deliverBlockReason)}</div>`);
  return parts.join("");
}

function actionButtonsHtml(batch, slice) {
  const allowed = canOperate(batch);
  const noPerm = 'disabled title="权限不足：不能操作他人样品"';
  const btn = (action, label, cls = "ghost") =>
    `<button type="button" class="${cls} small" data-form="${action}|${batch.id}|${slice.id}" ${allowed ? "" : noPerm}>${label}</button>`;
  const btns = [];
  if (!slice.delivered && slice.stageIndex < state.stages.length - 1) btns.push(btn("advance", `推进到「${state.stages[slice.stageIndex + 1]}」`));
  if (!slice.delivered && slice.stageIndex === state.stages.length - 1) btns.push(btn("observe", "记录观察"));
  if (!slice.delivered) btns.push(btn("return", "退回", "ghost"));
  if (!slice.delivered && slice.status === "退回中" && slice.stageIndex === state.stages.length - 1) btns.push(btn("reinspect", "复检"));
  if (!slice.delivered && slice.stageIndex === state.stages.length - 1) btns.push(btn("deliver", "交付", ""));
  btns.push(`<button type="button" class="ghost small" data-history="${batch.id}|${slice.id}">历史</button>`);
  return `<div class="slice-actions">${btns.join("")}</div>`;
}

function actionFormHtml(batch, slice) {
  const key = a => `${a}|${batch.id}|${slice.id}`;
  const nextStage = state.stages[slice.stageIndex + 1];
  if (state.openForm === key("advance")) {
    return `<form class="action-form" data-submit="advance" data-batch="${batch.id}" data-slice="${slice.id}">
      <div class="muted">推进切片 ${esc(slice.id)}：「${esc(slice.stage)}」→「${esc(nextStage)}」（须依次推进，跳步/回退/重复将被拒绝）</div>
      <input type="hidden" name="toStage" value="${esc(nextStage)}">
      <label>依据（必填）</label><input name="basis" required placeholder="如：粗切完成，厚度 3mm，符合制片规程">
      ${nextStage === "观察" ? '<label>观察记录（可稍后补录，为空不能交付）</label><textarea name="observation" placeholder="镜下矿物组成、结构构造等"></textarea>' : ""}
      <div class="btns"><button type="submit">确认推进</button><button type="button" class="ghost" data-cancel>取消</button></div>
    </form>`;
  }
  if (state.openForm === key("observe")) {
    return `<form class="action-form" data-submit="observe" data-batch="${batch.id}" data-slice="${slice.id}">
      <label>观察记录（必填，为空不能交付）</label>
      <textarea name="observation" required placeholder="镜下观察结果">${esc(slice.observation)}</textarea>
      <div class="btns"><button type="submit">保存观察</button><button type="button" class="ghost" data-cancel>取消</button></div>
    </form>`;
  }
  if (state.openForm === key("return")) {
    const stageOpts = state.stages.slice(0, slice.stageIndex + 1)
      .map(s => `<option ${s === slice.stage ? "selected" : ""}>${esc(s)}</option>`).join("");
    return `<form class="action-form" data-submit="return" data-batch="${batch.id}" data-slice="${slice.id}">
      <div class="muted">判定不合格并退回返工：记录缺陷等级、退回工序与原因；退回期间不能交付，复检通过才能提交。</div>
      <div class="row">
        <div><label>缺陷等级</label><select name="level">${state.defectLevels.map(l => `<option>${esc(l)}</option>`).join("")}</select></div>
        <div><label>退回工序</label><select name="toStage">${stageOpts}</select></div>
      </div>
      <label>退回原因（必填）</label><input name="reason" required placeholder="如：磨片厚度不均，需重新研磨">
      <div class="btns"><button type="submit" class="danger">确认退回</button><button type="button" class="ghost" data-cancel>取消</button></div>
    </form>`;
  }
  if (state.openForm === key("reinspect")) {
    return `<form class="action-form" data-submit="reinspect" data-batch="${batch.id}" data-slice="${slice.id}">
      <div class="row">
        <div><label>复检结果</label><select name="passed"><option value="true">通过</option><option value="false">不通过</option></select></div>
        <div><label>备注</label><input name="note" placeholder="复检说明"></div>
      </div>
      <div class="btns"><button type="submit">提交复检</button><button type="button" class="ghost" data-cancel>取消</button></div>
    </form>`;
  }
  if (state.openForm === key("deliver")) {
    return `<form class="action-form" data-submit="deliver" data-batch="${batch.id}" data-slice="${slice.id}">
      <div class="muted">${slice.deliverable ? "确认交付该切片？交付后不可再修改。" : `当前不能交付：${esc(slice.deliverBlockReason || "")}`}</div>
      <div class="btns"><button type="submit" ${slice.deliverable ? "" : "disabled"}>确认交付</button><button type="button" class="ghost" data-cancel>取消</button></div>
    </form>`;
  }
  return "";
}

function historyHtml(batch, slice) {
  if (!state.openHistory.has(`${batch.id}|${slice.id}`)) return "";
  const events = state.audit.filter(e => e.sliceId === slice.id);
  if (!events.length) return '<div class="history"><div class="ev muted">暂无历史记录</div></div>';
  return `<div class="history">${events.map(e =>
    `<div class="ev"><span class="t">${fmtTime(e.at)} · ${esc(e.actor)} · ${esc(e.action)}</span><br>${esc(e.summary)}</div>`
  ).join("")}</div>`;
}

function sliceHtml(batch, slice) {
  const statusPill = slice.delivered ? '<span class="pill done">已交付</span>'
    : slice.status === "退回中" ? '<span class="pill returned">退回中</span>'
    : slice.deliverable ? '<span class="pill ready">待交付</span>'
    : '<span class="pill wip">在制</span>';
  return `<div class="slice">
    <div class="slice-head">
      <div><span class="slice-id">${esc(slice.id)}</span><span class="slice-method">${esc(slice.method)}</span></div>
      ${statusPill}
    </div>
    ${stepperHtml(slice)}
    <div class="slice-info">${sliceInfoHtml(slice)}</div>
    ${actionButtonsHtml(batch, slice)}
    ${actionFormHtml(batch, slice)}
    ${historyHtml(batch, slice)}
  </div>`;
}

function renderBatches() {
  const today = new Date().toISOString().slice(0, 10);
  $("#batches").innerHTML = state.batches.map(batch => {
    const overdue = batch.status !== "已交付" && batch.plannedDate < today;
    const addSlice = canOperate(batch) && batch.status !== "已交付"
      ? `<form class="add-slice" data-submit="addslice" data-batch="${batch.id}">
           <input name="id" placeholder="新切片编号" required><input name="method" placeholder="制片方法"><button type="submit" class="small">补登切片</button>
         </form>` : "";
    return `<article class="batch">
      <div class="batch-head">
        <div>
          <div class="batch-title"><h3>${esc(batch.project)}</h3><span class="pill ${pillOf(batch)}">${batch.status}</span>
            ${batch.returnedCount ? `<span class="pill returned">${batch.returnedCount} 片退回中</span>` : ""}</div>
          <div class="batch-meta">
            批次 ${esc(batch.id)} · 钻孔 ${esc(batch.borehole)} · 箱号 ${esc(batch.coreBox)} · 深度 ${esc(batch.depth)}
            · 负责人 ${esc(batch.owner)} · 计划 <span class="${overdue ? "overdue" : ""}">${esc(batch.plannedDate)}${overdue ? "（已超期）" : ""}</span>
            · 接收 ${esc(batch.createdBy)} ${fmtTime(batch.createdAt)}
          </div>
        </div>
        <div class="progress">交付进度 ${batch.deliveredCount}/${batch.slices.length}</div>
      </div>
      ${batch.slices.map(s => sliceHtml(batch, s)).join("")}
      ${addSlice}
    </article>`;
  }).join("") || '<div class="panel muted">暂无批次，请在左侧登记接收。</div>';
}

function renderAudit() {
  const kw = ($("#audit-filter").value || "").trim();
  const rows = state.audit.filter(e => !kw ||
    [e.batchId, e.sliceId, e.actor, e.action, e.summary].some(v => (v || "").includes(kw)));
  $("#audit-body").innerHTML = rows.slice(0, 120).map(e =>
    `<tr><td>${fmtTime(e.at)}</td><td>${esc(e.actor)}</td><td>${esc(e.action)}</td>
     <td>${esc([e.batchId, e.sliceId].filter(Boolean).join(" / "))}</td>
     <td class="sum">${esc(e.summary)}</td></tr>`).join("") ||
    '<tr><td colspan="5" class="muted">暂无审计记录</td></tr>';
}

/* ---------- 交互 ---------- */
async function run(fn) {
  try { await fn(); await reload(); render(); }
  catch (err) { toast(err.message, true); }
}

$("#login-form").addEventListener("submit", e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  run(async () => {
    const data = await api("/api/login", { method: "POST", body: { username: fd.get("username"), password: fd.get("password") } });
    state.token = data.token;
    state.me = data.user;
    localStorage.setItem("labtoken", data.token);
    await reload();
    toast(`欢迎，${data.user.name}`);
  });
});

$("#logout-btn").addEventListener("click", () => logout());
$("#refresh-btn").addEventListener("click", () => run(async () => {}));
$("#audit-refresh").addEventListener("click", () => run(async () => {}));
$("#audit-filter").addEventListener("input", renderAudit);

$("#batch-form").addEventListener("submit", e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const slices = String(fd.get("slices")).split("\n").map(l => l.trim()).filter(Boolean).map(line => {
    const [id, ...rest] = line.split(/[,，]/);
    return { id: id.trim(), method: rest.join(",").trim() };
  });
  run(async () => {
    const batch = await api("/api/batches", {
      method: "POST",
      body: {
        project: fd.get("project"), borehole: fd.get("borehole"), coreBox: fd.get("coreBox"),
        depth: fd.get("depth"), owner: fd.get("owner"), plannedDate: fd.get("plannedDate"), slices,
      },
    });
    e.target.reset();
    $("#batch-form [name=owner]").value = state.me.username;
    toast(`批次 ${batch.id} 接收登记成功，共 ${batch.slices.length} 片切片`);
  });
});

document.addEventListener("click", e => {
  const formBtn = e.target.closest("[data-form]");
  if (formBtn) {
    const key = formBtn.dataset.form;
    state.openForm = state.openForm === key ? null : key;
    render();
    return;
  }
  if (e.target.closest("[data-cancel]")) { state.openForm = null; render(); return; }
  const histBtn = e.target.closest("[data-history]");
  if (histBtn) {
    const key = histBtn.dataset.history;
    state.openHistory.has(key) ? state.openHistory.delete(key) : state.openHistory.add(key);
    render();
  }
});

document.addEventListener("submit", e => {
  const form = e.target.closest("form[data-submit]");
  if (!form) return;
  e.preventDefault();
  const { submit, batch, slice } = form.dataset;
  const fd = new FormData(form);
  const base = `/api/batches/${encodeURIComponent(batch)}`;
  const sliceBase = `${base}/slices/${encodeURIComponent(slice)}`;
  run(async () => {
    if (submit === "advance") {
      await api(`${sliceBase}/advance`, { method: "POST", body: { toStage: fd.get("toStage"), basis: fd.get("basis"), observation: fd.get("observation") || "" } });
      toast("工序推进成功");
    } else if (submit === "observe") {
      await api(`${sliceBase}/observe`, { method: "POST", body: { observation: fd.get("observation") } });
      toast("观察记录已保存");
    } else if (submit === "return") {
      await api(`${sliceBase}/return`, { method: "POST", body: { level: fd.get("level"), toStage: fd.get("toStage"), reason: fd.get("reason") } });
      toast("已登记退回");
    } else if (submit === "reinspect") {
      await api(`${sliceBase}/reinspect`, { method: "POST", body: { passed: fd.get("passed") === "true", note: fd.get("note") || "" } });
      toast("复检结果已记录");
    } else if (submit === "deliver") {
      await api(`${sliceBase}/deliver`, { method: "POST", body: {} });
      toast("切片已交付");
    } else if (submit === "addslice") {
      await api(`${base}/slices`, { method: "POST", body: { id: fd.get("id"), method: fd.get("method") || "" } });
      toast("切片补登成功");
    }
    state.openForm = null;
  });
});

boot();
