import http from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "labdb.json");
const publicDir = join(__dirname, "public");
const port = Number(process.env.PORT || 3025);

// 切片工序：必须严格按此顺序推进
const STAGES = ["取样", "切割", "研磨", "染色", "观察"];
const LAST_STAGE = STAGES.length - 1;
const DEFECT_LEVELS = ["轻微", "一般", "严重", "致命"];

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => { throw new ApiError(status, code, message); };

// ---------- 用户与口令 ----------
function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return { salt, hash: scryptSync(password, salt, 32).toString("hex") };
}
function passwordMatches(password, user) {
  const candidate = Buffer.from(scryptSync(password, user.salt, 32).toString("hex"), "hex");
  const stored = Buffer.from(user.hash, "hex");
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

// ---------- 领域模型 ----------
function newSlice(input) {
  return {
    id: input.id,
    method: input.method || "未指定",
    stageIndex: 0,          // 当前所处工序（STAGES 下标），登记时进入「取样」
    status: "在制",          // 在制 | 退回中
    observation: "",        // 观察记录，为空不能交付
    everReturned: false,    // 是否曾被退回（决定交付前是否必须复检通过）
    activeReturn: null,     // 最近一次退回 { level, toStage, reason, by, at }
    reinspection: null,     // 最近一次复检 { passed, by, at, note }
    delivered: false,
    deliveredAt: null,
    deliveredBy: null,
  };
}

function logEvent(db, actor, action, batch, slice, summary, detail = {}) {
  db.events.push({
    id: ++db.seq.event,
    at: new Date().toISOString(),
    actor,
    action,
    batchId: batch ? batch.id : null,
    sliceId: slice ? slice.id : null,
    summary,
    detail,
  });
}

function receiveBatch(db, input, actor) {
  const fields = { project: "项目", borehole: "钻孔", coreBox: "箱号", depth: "深度", owner: "负责人", plannedDate: "计划日期" };
  for (const [key, label] of Object.entries(fields)) {
    if (!String(input[key] ?? "").trim()) fail(400, "missing_field", `缺少必填字段：${label}`);
  }
  if (!db.users.some(u => u.username === String(input.owner).trim())) {
    fail(400, "unknown_owner", "负责人必须是已注册用户");
  }
  if (!Array.isArray(input.slices) || input.slices.length === 0) {
    fail(400, "no_slices", "批次至少登记一片切片");
  }
  const seen = new Set();
  for (const s of input.slices) {
    const id = String(s.id ?? "").trim();
    if (!id) fail(400, "missing_slice_id", "切片编号不能为空");
    if (seen.has(id)) fail(400, "duplicate_slice", `批次内切片编号重复：${id}`);
    if (db.batches.some(b => b.slices.some(x => x.id === id))) fail(409, "duplicate_slice", `切片编号已存在：${id}`);
    seen.add(id);
  }
  const batch = {
    id: `B${new Date().getFullYear()}-${String(++db.seq.batch).padStart(3, "0")}`,
    project: String(input.project).trim(),
    borehole: String(input.borehole).trim(),
    coreBox: String(input.coreBox).trim(),
    depth: String(input.depth).trim(),
    owner: String(input.owner).trim(),
    plannedDate: String(input.plannedDate).trim(),
    createdBy: actor,
    createdAt: new Date().toISOString(),
    slices: input.slices.map(s => newSlice({ id: String(s.id).trim(), method: String(s.method ?? "").trim() || "未指定" })),
  };
  db.batches.unshift(batch);
  logEvent(db, actor, "接收登记", batch, null,
    `接收批次 ${batch.id}（${batch.project} / ${batch.borehole} / ${batch.coreBox}），登记切片 ${batch.slices.length} 片，负责人 ${batch.owner}，计划 ${batch.plannedDate}`,
    { plannedDate: batch.plannedDate, sliceCount: batch.slices.length });
  for (const slice of batch.slices) {
    logEvent(db, actor, "切片登记", batch, slice, `切片 ${slice.id} 登记，进入工序「取样」`, { method: slice.method });
  }
  return batch;
}

// 交付前置条件；返回 null 表示可交付，否则返回阻塞原因
function deliverBlock(slice) {
  if (slice.delivered) return "切片已交付，不能重复交付";
  if (slice.stageIndex !== LAST_STAGE) return `尚未完成观察工序（当前：${STAGES[slice.stageIndex]}）`;
  if (!slice.observation.trim()) return "观察记录为空，不能交付";
  if (slice.status === "退回中") return "切片退回期间不能交付";
  if (slice.everReturned && !(slice.reinspection && slice.reinspection.passed)) return "曾被退回，复检通过前不能交付";
  return null;
}

function sliceView(s) {
  const block = deliverBlock(s);
  return { ...s, stage: STAGES[s.stageIndex], deliverable: !block, deliverBlockReason: block };
}
function batchView(b) {
  const slices = b.slices.map(sliceView);
  let status = "在制";
  if (slices.length && slices.every(s => s.delivered)) status = "已交付";
  else if (slices.length && slices.every(s => s.deliverable)) status = "待交付";
  return {
    ...b,
    slices,
    status,
    deliveredCount: slices.filter(s => s.delivered).length,
    returnedCount: slices.filter(s => s.status === "退回中").length,
  };
}

function seedDb() {
  const db = { users: [], batches: [], events: [], seq: { batch: 0, event: 0 } };
  const mk = (username, name, role, pw) => ({ username, name, role, ...hashPassword(pw) });
  db.users.push(mk("admin", "系统管理员", "admin", "admin123"));
  db.users.push(mk("陆川", "陆川", "tech", "pass123"));
  db.users.push(mk("陈岩", "陈岩", "tech", "pass123"));
  receiveBatch(db, {
    project: "东岭铜矿薄片", borehole: "ZK-17", coreBox: "BX-09", depth: "128.4-128.8m",
    owner: "陆川", plannedDate: "2026-09-20",
    slices: [{ id: "DL-01", method: "茜素红染色" }, { id: "DL-02", method: "未染色" }],
  }, "admin");
  return db;
}

// ---------- 持久化（JSON 文件，原子写入；重启后数据保留） ----------
let db;
async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    db = seedDb();
    await saveDb();
    return;
  }
  db = JSON.parse(await readFile(dbPath, "utf8"));
}
async function saveDb() {
  const tmp = `${dbPath}.tmp`;
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, dbPath);
}
// 变更串行队列：所有写操作排队执行，保证“检查-修改-落盘”原子完成，
// 并发请求（如两人同时推进同一切片）只会有一个成功。
let queue = Promise.resolve();
function mutate(fn) {
  const run = queue.then(async () => {
    const result = await fn();
    await saveDb();
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

// ---------- 会话 ----------
const sessions = new Map(); // token -> { username, createdAt }
function authUser(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const session = token && sessions.get(token);
  if (!session) return null;
  return db.users.find(u => u.username === session.username) || null;
}
const canOperate = (user, batch) => user.role === "admin" || batch.owner === user.username;
function requireOperate(user, batch) {
  if (!canOperate(user, batch)) fail(403, "forbidden", "权限不足：不能操作他人样品");
}

// ---------- 路由 ----------
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const rx = new RegExp("^" + pattern.replace(/:[^/]+/g, m => { keys.push(m.slice(1)); return "([^/]+)"; }) + "$");
  routes.push({ method, rx, keys, handler, auth: opts.auth !== false, mutating: !!opts.mutating });
}
const findBatch = bid => db.batches.find(b => b.id === bid) || fail(404, "batch_not_found", `批次不存在：${bid}`);
const findSlice = (batch, sid) => batch.slices.find(s => s.id === sid) || fail(404, "slice_not_found", `切片不存在：${sid}`);
const text = v => String(v ?? "").trim();

route("POST", "/api/login", async ({ body }) => {
  const user = db.users.find(u => u.username === text(body.username));
  if (!user || !passwordMatches(text(body.password), user)) fail(401, "bad_credentials", "用户名或密码错误");
  const token = randomUUID();
  sessions.set(token, { username: user.username, createdAt: Date.now() });
  return { token, user: { username: user.username, name: user.name, role: user.role } };
}, { auth: false });

route("POST", "/api/logout", async ({ token }) => { sessions.delete(token); return { ok: true }; });
route("GET", "/api/me", async ({ user }) => ({ username: user.username, name: user.name, role: user.role }));
route("GET", "/api/meta", async () => ({ stages: STAGES, defectLevels: DEFECT_LEVELS }));
route("GET", "/api/users", async () => db.users.map(u => ({ username: u.username, name: u.name, role: u.role })));
route("GET", "/api/batches", async () => db.batches.map(batchView));
route("GET", "/api/batches/:bid", async ({ params }) => {
  const batch = findBatch(params.bid);
  return { ...batchView(batch), events: db.events.filter(e => e.batchId === batch.id).slice().reverse() };
});

route("POST", "/api/batches", async ({ user, body }) => batchView(receiveBatch(db, body, user.username)), { mutating: true });

route("POST", "/api/batches/:bid/slices", async ({ user, params, body }) => {
  const batch = findBatch(params.bid);
  requireOperate(user, batch);
  const id = text(body.id);
  if (!id) fail(400, "missing_slice_id", "切片编号不能为空");
  if (db.batches.some(b => b.slices.some(x => x.id === id))) fail(409, "duplicate_slice", `切片编号已存在：${id}`);
  const slice = newSlice({ id, method: text(body.method) || "未指定" });
  batch.slices.push(slice);
  logEvent(db, user.username, "切片登记", batch, slice, `切片 ${id} 补登，进入工序「取样」`, { method: slice.method });
  return batchView(batch);
}, { mutating: true });

route("POST", "/api/batches/:bid/slices/:sid/advance", async ({ user, params, body }) => {
  const batch = findBatch(params.bid);
  requireOperate(user, batch);
  const slice = findSlice(batch, params.sid);
  const toStage = text(body.toStage);
  const target = STAGES.indexOf(toStage);
  if (target === -1) fail(400, "unknown_stage", `未知工序：${toStage || "(空)"}`);
  if (slice.delivered) fail(409, "delivered", "切片已交付，不能再推进");
  const current = STAGES[slice.stageIndex];
  if (target === slice.stageIndex) fail(409, "duplicate_advance", `重复推进被拒绝：切片已处于「${current}」工序`);
  if (target < slice.stageIndex) fail(409, "rollback", `回退被拒绝：不能从「${current}」回退到「${toStage}」（须走退回流程）`);
  if (target > slice.stageIndex + 1) fail(409, "skip_stage", `跳步被拒绝：必须从「${current}」推进到「${STAGES[slice.stageIndex + 1]}」，不能跳到「${toStage}」`);
  const basis = text(body.basis);
  if (!basis) fail(400, "missing_basis", "推进必须填写依据");
  slice.stageIndex = target;
  let obsNote = "";
  if (target === LAST_STAGE) {
    const obs = text(body.observation);
    if (obs) { slice.observation = obs; obsNote = "，并记录观察"; }
  }
  logEvent(db, user.username, "工序推进", batch, slice,
    `${slice.id}：${current} → ${toStage}${obsNote}（依据：${basis}）`,
    { from: current, to: toStage, basis });
  return batchView(batch);
}, { mutating: true });

route("POST", "/api/batches/:bid/slices/:sid/observe", async ({ user, params, body }) => {
  const batch = findBatch(params.bid);
  requireOperate(user, batch);
  const slice = findSlice(batch, params.sid);
  if (slice.delivered) fail(409, "delivered", "切片已交付，不能再记录观察");
  if (slice.stageIndex !== LAST_STAGE) fail(409, "not_observing", `切片尚未进入观察工序（当前：${STAGES[slice.stageIndex]}）`);
  const obs = text(body.observation);
  if (!obs) fail(400, "empty_observation", "观察记录不能为空");
  slice.observation = obs;
  logEvent(db, user.username, "观察记录", batch, slice, `${slice.id} 记录观察：${obs}`, { observation: obs });
  return batchView(batch);
}, { mutating: true });

route("POST", "/api/batches/:bid/slices/:sid/return", async ({ user, params, body }) => {
  const batch = findBatch(params.bid);
  requireOperate(user, batch);
  const slice = findSlice(batch, params.sid);
  if (slice.delivered) fail(409, "delivered", "切片已交付，不能退回");
  const level = text(body.level);
  if (!DEFECT_LEVELS.includes(level)) fail(400, "bad_level", `缺陷等级须为：${DEFECT_LEVELS.join(" / ")}`);
  const toStage = text(body.toStage);
  const target = STAGES.indexOf(toStage);
  if (target === -1) fail(400, "unknown_stage", `未知退回工序：${toStage || "(空)"}`);
  if (target > slice.stageIndex) fail(400, "bad_return_stage", `退回工序不能晚于当前工序「${STAGES[slice.stageIndex]}」`);
  const reason = text(body.reason);
  if (!reason) fail(400, "missing_reason", "必须填写退回原因");
  const from = STAGES[slice.stageIndex];
  slice.stageIndex = target;
  slice.status = "退回中";
  slice.everReturned = true;
  slice.activeReturn = { level, toStage, reason, by: user.username, at: new Date().toISOString() };
  slice.reinspection = null;
  logEvent(db, user.username, "质量退回", batch, slice,
    `${slice.id} 判定不合格（缺陷等级：${level}）：从「${from}」退回「${toStage}」，原因：${reason}`,
    { level, from, to: toStage, reason });
  return batchView(batch);
}, { mutating: true });

route("POST", "/api/batches/:bid/slices/:sid/reinspect", async ({ user, params, body }) => {
  const batch = findBatch(params.bid);
  requireOperate(user, batch);
  const slice = findSlice(batch, params.sid);
  if (slice.delivered) fail(409, "delivered", "切片已交付，不能复检");
  if (slice.status !== "退回中") fail(409, "not_returned", "切片未处于退回状态，无需复检");
  if (slice.stageIndex !== LAST_STAGE) fail(409, "rework_incomplete", `返工尚未重新完成观察工序（当前：${STAGES[slice.stageIndex]}），不能复检`);
  const passed = body.passed === true;
  const note = text(body.note);
  slice.reinspection = { passed, by: user.username, at: new Date().toISOString(), note };
  if (passed) slice.status = "在制";
  logEvent(db, user.username, "复检", batch, slice,
    `${slice.id} 复检${passed ? "通过" : "不通过"}${note ? `：${note}` : ""}`, { passed, note });
  return batchView(batch);
}, { mutating: true });

route("POST", "/api/batches/:bid/slices/:sid/deliver", async ({ user, params }) => {
  const batch = findBatch(params.bid);
  requireOperate(user, batch);
  const slice = findSlice(batch, params.sid);
  const blocked = deliverBlock(slice);
  if (blocked) fail(409, "not_deliverable", blocked);
  slice.delivered = true;
  slice.deliveredAt = new Date().toISOString();
  slice.deliveredBy = user.username;
  logEvent(db, user.username, "交付", batch, slice, `${slice.id} 由 ${user.username} 交付`, {});
  return batchView(batch);
}, { mutating: true });

route("GET", "/api/audit", async ({ url }) => {
  let events = db.events.slice().reverse();
  const batchId = url.searchParams.get("batchId");
  const sliceId = url.searchParams.get("sliceId");
  const actor = url.searchParams.get("actor");
  if (batchId) events = events.filter(e => e.batchId === batchId);
  if (sliceId) events = events.filter(e => e.sliceId === sliceId);
  if (actor) events = events.filter(e => e.actor === actor);
  return events.slice(0, 300);
});

route("GET", "/api/health", async () => ({ ok: true, batches: db.batches.length, events: db.events.length }), { auth: false });

// ---------- HTTP 基础设施 ----------
async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail(400, "bad_json", "请求体不是合法 JSON");
  }
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function sendError(res, err) {
  if (err instanceof ApiError) return sendJson(res, err.status, { error: err.code, message: err.message });
  console.error(err);
  sendJson(res, 500, { error: "internal", message: "服务器内部错误" });
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".ico": "image/x-icon",
};
async function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = normalize(join(publicDir, rel));
  if (!filePath.startsWith(publicDir)) return sendJson(res, 403, { error: "forbidden" });
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "not_found", message: "资源不存在" });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!url.pathname.startsWith("/api/")) return await serveStatic(res, url.pathname);
    const matched = routes.find(r => r.method === req.method && r.rx.test(url.pathname));
    if (!matched) return sendJson(res, 404, { error: "not_found", message: "接口不存在" });
    const params = {};
    const m = url.pathname.match(matched.rx);
    matched.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    let user = null;
    if (matched.auth) {
      user = authUser(req);
      if (!user) return sendJson(res, 401, { error: "unauthorized", message: "未登录或会话已过期" });
    }
    const body = req.method === "POST" || req.method === "PUT" ? await parseBody(req) : {};
    const ctx = { user, params, body, url, token };
    const result = matched.mutating ? await mutate(() => matched.handler(ctx)) : await matched.handler(ctx);
    sendJson(res, matched.method === "POST" && url.pathname === "/api/batches" ? 201 : 200, result);
  } catch (err) {
    sendError(res, err);
  }
});

await loadDb();
server.listen(port, () => console.log(`岩芯样品制备与质量追踪系统：http://localhost:${port}`));
