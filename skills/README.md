# WorkBuddy 技能

这里放**能装进对话里跑的 McShake**。目前只有一个：

| 技能 | 触发词 | 作用 |
|---|---|---|
| [`mcshake-slot`](mcshake-slot/SKILL.md) | 麦当劳、麦门、摇一摇、摇个饭、1+1 随心配、这顿多少卡 | 摇三个餐品 → 营养账本 → 真实计价与折扣 → 1+1 拼单判断 → （可选）建一笔待支付订单 |

网页版和技能版跑的是**同一份业务代码**：技能不直连 MCP，而是把仓库里的 `server.js` 拉起来打 HTTP 接口。所以同一个组合，浏览器上算出 ¥37.40，对话里也一定是 ¥37.40。原因写在 [`MCP_INTEGRATION.md` 第 12 节](../MCP_INTEGRATION.md#12-把-mcp-能力交给对话workbuddy-技能形态)。

## 30 秒验证

在仓库根目录，不需要 Token、不需要 `npm install`：

```bash
node skills/mcshake-slot/scripts/mcshake.js spin
```

没 Token 会自动进演示模式（用 `demo/demo-snapshot.json` 的官方数据快照），输出会标明「非实时」。想看真价格就带上 Token：

```bash
MCD_MCP_TOKEN=<你的Token> node skills/mcshake-slot/scripts/mcshake.js spin
```

## 装进 WorkBuddy

**方式一：跟着仓库用**（无需配置，脚本自己向上找到仓库根）

```bash
node skills/mcshake-slot/scripts/mcshake.js spin
```

**方式二：装成用户级技能**（任意目录都能唤起）

```bash
cp -r skills/mcshake-slot ~/.workbuddy/skills/
# 然后二选一，让技能找到仓库：
echo '{"home":"<McShake 仓库绝对路径>"}' > ~/.workbuddy/skills/mcshake-slot/config.json
# 或
export MCSHAKE_HOME=<McShake 仓库绝对路径>
```

`config.json` 含本机绝对路径，已在 `.gitignore` 里排除。

## 目录

```text
skills/
├── README.md                     # 本文件
└── mcshake-slot/
    ├── SKILL.md                  # 技能说明：触发条件、命令、三条硬规矩
    ├── scripts/
    │   ├── mcshake.js            # 全部命令的入口（spin / order / stores / use / serve / status）
    │   └── lib/
    │       ├── root.js           # 定位仓库根（四个来源依次尝试，找不到就报错不瞎猜）
    │       ├── service.js        # 临时服务生命周期：起 → 办事 → 关
    │       ├── http.js           # 零依赖 JSON 请求
    │       └── render.js         # 终端排版（中文按两格宽算，避免表格歪）
    └── references/
        ├── mcp-contract.md       # 不看就会踩的 MCP 契约（6 个必知 + 3 个玩法坑）
        └── cli-usage.txt         # 命令速查，`-h` / `--help` / 无参数都会打印
```

## 三个值得记住的设计选择

1. **一条命令一个临时服务**，不做常驻后台——常驻进程会被执行环境连进程树回收，留下指向死端口的状态文件只会制造假故障。只有 `serve` 才常驻，给人用浏览器玩。
2. **`order create` 不带 `--yes` 一律不建单**，退出码 `2`，只打印金额和门店。建单会在账号里留一笔真实待支付订单，必须先把话说清楚。
3. **不宣称已付款**。MCP 的 35 个工具里没有任何支付能力，只能拿到 `payH5Url`（H5 收银台），付款必须由人扫码，15 分钟内不付自动关单。说话兜着点，别把人骗到店里干等。

技能可用性有 11 项断言（`test.js` 的 [11] 组），随主测试一起跑：`node test.js`。命令忘了就 `node scripts/mcshake.js -h`。
