/**
 * 端到端验证脚本
 * 用法：
 *   node scripts/verify.mjs            —— 跑完整流程（接收/登记/推进/退回/复检/交付/审计/越权/并发）
 *   node scripts/verify.mjs persist <runId>  —— 服务器重启后验证数据保留
 */
const BASE = process.env.BASE_URL || "http://localhost:3025";
const mode = process.argv[2] || "run";
const runId = process.argv[3] || Date.now().toString(36);

let passed = 0, failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.error(`  ✘ ${name} ${extra}`); }
}
function section(title) { console.log(`\n== ${title} ==`); }

async function req(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const login = async (username, password) => req("POST", "/api/login", { body: { username, password } });

async function main() {
  if (mode === "persist") return persistCheck();

  console.log(`目标：${BASE}  运行标识：${runId}`);

  section("0. 健康检查与认证");
  const health = await req("GET", "/api/health");
  check("服务健康", health.status === 200 && health.data.ok === true);

  const noAuth = await req("GET", "/api/batches");
  check("未登录访问被拒绝（401）", noAuth.status === 401);

  const badLogin = await login("陆川", "wrong-password");
  check("错误密码登录被拒绝（401）", badLogin.status === 401);

  const admin = (await login("admin", "admin123")).data.token;
  const lu = (await login("陆川", "pass123")).data.token;
  const chen = (await login("陈岩", "pass123")).data.token;
  check("三个账号登录成功", !!(admin && lu && chen));

  section("1. 接收与批量登记");
  const P = `验证项目-${runId}`;
  const s1 = `SL-${runId}-01`, s2 = `SL-${runId}-02`, s3 = `SL-${runId}-03`;
  const reg = await req("POST", "/api/batches", {
    token: lu,
    body: {
      project: P, borehole: "ZK-08", coreBox: "BX-21", depth: "210.5-215.0m",
      owner: "陆川", plannedDate: "2026-09-30",
      slices: [{ id: s1, method: "茜素红染色" }, { id: s2, method: "未染色" }, { id: s3, method: "荧光染色" }],
    },
  });
  check("批量登记成功（201）", reg.status === 201, JSON.stringify(reg.data));
  const batch = reg.data;
  const bid = batch.id;
  check("批次字段完整（项目/钻孔/箱号/深度/负责人/计划日期）",
    batch.project === P && batch.borehole === "ZK-08" && batch.coreBox === "BX-21" &&
    batch.depth === "210.5-215.0m" && batch.owner === "陆川" && batch.plannedDate === "2026-09-30");
  check("一次登记 3 片切片且初始工序为「取样」",
    batch.slices.length === 3 && batch.slices.every(s => s.stage === "取样" && s.status === "在制"));

  const missing = await req("POST", "/api/batches", { token: lu, body: { project: "x", owner: "陆川", plannedDate: "2026-10-01", slices: [{ id: "A-1" }] } });
  check("缺字段登记被拒绝（400）", missing.status === 400);
  const badOwner = await req("POST", "/api/batches", { token: lu, body: { project: "x", borehole: "ZK", coreBox: "BX", depth: "1m", owner: "不存在的人", plannedDate: "2026-10-01", slices: [{ id: "A-1" }] } });
  check("负责人非注册用户被拒绝（400）", badOwner.status === 400);
  const dupSlice = await req("POST", "/api/batches", { token: lu, body: { project: "x", borehole: "ZK", coreBox: "BX", depth: "1m", owner: "陆川", plannedDate: "2026-10-01", slices: [{ id: s1 }] } });
  check("重复切片编号被拒绝（409）", dupSlice.status === 409);

  const auditCount = async (sliceId) => (await req("GET", `/api/audit?batchId=${bid}&sliceId=${sliceId}`, { token: lu })).data.length;

  section("2. 工序推进规则（跳步/回退/重复拒绝，且失败不写历史）");
  const before = await auditCount(s1);
  const skip = await req("POST", `/api/batches/${bid}/slices/${s1}/advance`, { token: lu, body: { toStage: "研磨", basis: "试图跳步" } });
  check("跳步（取样→研磨）被拒绝（409）", skip.status === 409 && skip.data.error === "skip_stage");
  const dup = await req("POST", `/api/batches/${bid}/slices/${s1}/advance`, { token: lu, body: { toStage: "取样", basis: "试图重复" } });
  check("重复推进（取样→取样）被拒绝（409）", dup.status === 409 && dup.data.error === "duplicate_advance");
  const noBasis = await req("POST", `/api/batches/${bid}/slices/${s1}/advance`, { token: lu, body: { toStage: "切割" } });
  check("缺少依据被拒绝（400）", noBasis.status === 400);
  check("失败操作不写历史", (await auditCount(s1)) === before, `期望 ${before} 条`);

  const adv = async (slice, toStage, extra = {}, token = lu) =>
    req("POST", `/api/batches/${bid}/slices/${slice}/advance`, { token, body: { toStage, basis: `完成${toStage}`, ...extra } });

  for (const st of ["切割", "研磨", "染色"]) {
    const r = await adv(s1, st);
    check(`正常推进到「${st}」`, r.status === 200 && r.data.slices.find(s => s.id === s1).stage === st);
  }
  const back = await req("POST", `/api/batches/${bid}/slices/${s1}/advance`, { token: lu, body: { toStage: "研磨", basis: "试图回退" } });
  check("回退（染色→研磨）被拒绝（409）", back.status === 409 && back.data.error === "rollback");
  const toObs = await adv(s1, "观察", { observation: "石英脉发育，黄铁矿化明显" });
  check("推进到「观察」并记录观察", toObs.status === 200 && toObs.data.slices.find(s => s.id === s1).observation.includes("黄铁矿化"));

  section("3. 观察为空不能交付");
  for (const st of ["切割", "研磨", "染色", "观察"]) await adv(s2, st);
  const emptyDeliver = await req("POST", `/api/batches/${bid}/slices/${s2}/deliver`, { token: lu });
  check("观察为空交付被拒绝（409）", emptyDeliver.status === 409 && emptyDeliver.data.message.includes("观察记录为空"));
  const obs = await req("POST", `/api/batches/${bid}/slices/${s2}/observe`, { token: lu, body: { observation: "碳酸盐化，见细脉状方解石" } });
  check("补录观察记录", obs.status === 200);
  const deliver2 = await req("POST", `/api/batches/${bid}/slices/${s2}/deliver`, { token: lu });
  check("补录后交付成功", deliver2.status === 200 && deliver2.data.slices.find(s => s.id === s2).delivered === true);
  const redeliver = await req("POST", `/api/batches/${bid}/slices/${s2}/deliver`, { token: lu });
  check("重复交付被拒绝（409）", redeliver.status === 409);

  section("4. 退回 → 返工 → 复检 → 交付");
  for (const st of ["切割", "研磨", "染色"]) await adv(s3, st);
  const ret = await req("POST", `/api/batches/${bid}/slices/${s3}/return`, {
    token: lu, body: { level: "严重", toStage: "研磨", reason: "磨片厚度不均，需重新研磨" },
  });
  const s3after = ret.data.slices?.find(s => s.id === s3) || {};
  check("退回登记成功（缺陷等级/退回工序/原因）",
    ret.status === 200 && s3after.status === "退回中" && s3after.stage === "研磨" &&
    s3after.activeReturn?.level === "严重" && s3after.activeReturn?.reason.includes("厚度不均"));
  const retBad = await req("POST", `/api/batches/${bid}/slices/${s3}/return`, { token: lu, body: { level: "致命", toStage: "观察", reason: "x" } });
  check("退回工序晚于当前工序被拒绝（400）", retBad.status === 400);

  await adv(s3, "染色");
  await adv(s3, "观察", { observation: "返工后镜下均匀" });
  const d1 = await req("POST", `/api/batches/${bid}/slices/${s3}/deliver`, { token: lu });
  check("退回未复检交付被拒绝（409）", d1.status === 409 && /退回|复检/.test(d1.data.message || ""), d1.data.message);
  const reiFail = await req("POST", `/api/batches/${bid}/slices/${s3}/reinspect`, { token: lu, body: { passed: false, note: "边缘仍有崩缺" } });
  check("复检不通过，仍为退回中", reiFail.status === 200 && reiFail.data.slices.find(s => s.id === s3).status === "退回中");
  const d2 = await req("POST", `/api/batches/${bid}/slices/${s3}/deliver`, { token: lu });
  check("复检不通过交付仍被拒绝（409）", d2.status === 409);
  const reiPass = await req("POST", `/api/batches/${bid}/slices/${s3}/reinspect`, { token: lu, body: { passed: true, note: "返工合格" } });
  check("复检通过，解除退回状态", reiPass.status === 200 && reiPass.data.slices.find(s => s.id === s3).status === "在制");
  const d3 = await req("POST", `/api/batches/${bid}/slices/${s3}/deliver`, { token: lu });
  check("复检通过后交付成功", d3.status === 200 && d3.data.slices.find(s => s.id === s3).delivered === true);

  const d1ok = await req("POST", `/api/batches/${bid}/slices/${s1}/deliver`, { token: lu });
  check("XL-01 正常交付", d1ok.status === 200);
  const batchDone = (await req("GET", `/api/batches/${bid}`, { token: lu })).data;
  check("全部切片交付后批次状态为「已交付」", batchDone.status === "已交付");

  section("5. 越权操作被拒绝");
  const P2 = `越权验证-${runId}`;
  const sx = `SL-${runId}-X`;
  const reg2 = await req("POST", "/api/batches", {
    token: lu,
    body: { project: P2, borehole: "ZK-09", coreBox: "BX-30", depth: "100.0-101.0m", owner: "陆川", plannedDate: "2026-10-05", slices: [{ id: sx, method: "未染色" }] },
  });
  const bid2 = reg2.data.id;
  const chenAdv = await req("POST", `/api/batches/${bid2}/slices/${sx}/advance`, { token: chen, body: { toStage: "切割", basis: "越权尝试" } });
  check("陈岩推进陆川的切片被拒绝（403）", chenAdv.status === 403);
  const chenRet = await req("POST", `/api/batches/${bid2}/slices/${sx}/return`, { token: chen, body: { level: "一般", toStage: "取样", reason: "越权" } });
  check("陈岩退回陆川的切片被拒绝（403）", chenRet.status === 403);
  const chenDel = await req("POST", `/api/batches/${bid2}/slices/${sx}/deliver`, { token: chen });
  check("陈岩交付陆川的切片被拒绝（403）", chenDel.status === 403);
  const adminAdv = await req("POST", `/api/batches/${bid2}/slices/${sx}/advance`, { token: admin, body: { toStage: "切割", basis: "管理员代操作" } });
  check("管理员可操作任意样品", adminAdv.status === 200);
  const sxAfter = (await req("GET", `/api/batches/${bid2}`, { token: chen })).data.slices.find(s => s.id === sx);
  check("越权失败未改变状态（仍为「切割」，仅管理员那次生效）", sxAfter.stage === "切割");

  section("6. 并发重复推进（仅一次成功）");
  const sc = `SL-${runId}-C`;
  const reg3 = await req("POST", "/api/batches", {
    token: lu,
    body: { project: `并发验证-${runId}`, borehole: "ZK-10", coreBox: "BX-31", depth: "50.0-51.0m", owner: "陆川", plannedDate: "2026-10-06", slices: [{ id: sc, method: "未染色" }] },
  });
  const bid3 = reg3.data.id;
  await req("POST", `/api/batches/${bid3}/slices/${sc}/advance`, { token: lu, body: { toStage: "切割", basis: "准备并发测试" } });
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) =>
    req("POST", `/api/batches/${bid3}/slices/${sc}/advance`, { token: lu, body: { toStage: "研磨", basis: `并发提交 ${i + 1}` } })
  ));
  const okCount = results.filter(r => r.status === 200).length;
  const conflictCount = results.filter(r => r.status === 409).length;
  check("5 个并发推进中恰好 1 个成功", okCount === 1, `实际成功 ${okCount} 个`);
  check("其余 4 个以 409 重复推进拒绝", conflictCount === 4, `实际 409 共 ${conflictCount} 个`);
  const cEvents = (await req("GET", `/api/audit?batchId=${bid3}&sliceId=${sc}`, { token: lu })).data
    .filter(e => e.action === "工序推进" && e.detail?.to === "研磨");
  check("审计中「切割→研磨」推进仅记录一次", cEvents.length === 1, `实际 ${cEvents.length} 条`);

  section("7. 审计日志完整性");
  const audit = (await req("GET", `/api/audit?batchId=${bid}`, { token: lu })).data;
  const actions = new Set(audit.map(e => e.action));
  for (const a of ["接收登记", "切片登记", "工序推进", "观察记录", "质量退回", "复检", "交付"]) {
    check(`审计包含「${a}」`, actions.has(a));
  }
  check("每条审计都有操作人和时间", audit.every(e => e.actor && e.at));
  const retEvent = audit.find(e => e.action === "质量退回" && e.sliceId === s3);
  check("退回事件含缺陷等级/退回工序/原因",
    retEvent && retEvent.detail.level === "严重" && retEvent.detail.to === "研磨" && retEvent.detail.reason.includes("厚度不均"));

  section("结果");
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log(`RUN_ID=${runId}`);
  process.exit(failed ? 1 : 0);
}

async function persistCheck() {
  console.log(`重启后持久化检查：${BASE}  RUN_ID=${runId}`);
  const lu = (await login("陆川", "pass123")).data.token;
  check("重启后可重新登录", !!lu);
  const batches = (await req("GET", "/api/batches", { token: lu })).data;
  const mine = batches.find(b => b.project === `验证项目-${runId}`);
  check("重启后批次数据仍在", !!mine);
  check("交付状态保留（3 片均已交付）", mine && mine.deliveredCount === 3 && mine.status === "已交付");
  const s3 = mine?.slices.find(s => s.id.endsWith("-03"));
  check("退回/复检记录保留", !!(s3 && s3.everReturned && s3.reinspection?.passed));
  const audit = (await req("GET", `/api/audit?batchId=${mine?.id}`, { token: lu })).data;
  check("审计历史保留", audit.length > 10);
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error("验证脚本异常：", err); process.exit(1); });
