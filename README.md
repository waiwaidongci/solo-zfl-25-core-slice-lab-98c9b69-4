# 岩芯样品制备与质量追踪系统

地质实验室用：批次接收登记 → 切片五工序流转 → 质量退回/复检 → 交付，全程审计留痕。

## 运行

```bash
npm start          # http://localhost:3025
```

演示账号：

| 账号 | 密码 | 角色 |
| --- | --- | --- |
| admin | admin123 | 管理员，可操作全部样品 |
| 陆川 | pass123 | 技师，仅可操作本人负责的样品 |
| 陈岩 | pass123 | 技师，同上 |

## 业务规则

- **接收登记**：按批次登记项目、钻孔、箱号、深度、负责人、计划日期，并批量登记切片；切片自「取样」工序开始。
- **工序推进**：切片必须沿 取样 → 切割 → 研磨 → 染色 → 观察 依次推进，每次记录操作人、时间、依据。跳步、回退、重复推进一律返回 409 失败，且不写入历史。
- **交付**：观察记录为空不能交付；退回中的切片不能交付；曾被退回的切片必须复检通过才能交付。
- **退回**：不合格切片登记缺陷等级（轻微/一般/严重/致命）、退回工序与原因，切片回到该工序返工，状态为「退回中」。
- **复检**：返工重新完成观察工序后登记复检结果；通过则解除退回状态，不通过则保持退回中。
- **权限**：所有变更需登录；只能操作本人负责的样品，管理员除外（越权返回 403）。
- **审计**：接收、登记、推进、观察、退回、复检、交付全部记录操作人与时间，失败操作不留痕。
- **持久化**：数据保存在 `data/labdb.json`（原子写入），重启后保留；所有写操作串行执行，并发重复推进只有一个成功。

## 验证

```bash
npm start &                 # 先启动服务
npm run verify              # 端到端全流程验证（含越权与并发用例）
# 重启持久化验证：
node scripts/verify.mjs     # 记下输出末尾的 RUN_ID
# 重启服务后：
node scripts/verify.mjs persist <RUN_ID>
```

## API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | /api/login | 登录，返回 Bearer token |
| GET | /api/batches | 批次与切片列表（含交付可行性） |
| POST | /api/batches | 接收登记批次（含切片清单） |
| POST | /api/batches/:bid/slices | 补登切片 |
| POST | /api/batches/:bid/slices/:sid/advance | 工序推进 `{toStage, basis, observation?}` |
| POST | /api/batches/:bid/slices/:sid/observe | 记录观察 `{observation}` |
| POST | /api/batches/:bid/slices/:sid/return | 退回 `{level, toStage, reason}` |
| POST | /api/batches/:bid/slices/:sid/reinspect | 复检 `{passed, note}` |
| POST | /api/batches/:bid/slices/:sid/deliver | 交付 |
| GET | /api/audit?batchId=&sliceId=&actor= | 审计日志 |
