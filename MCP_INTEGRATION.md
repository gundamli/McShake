# MCP 接入说明

本文记录本项目接入麦当劳中国官方 MCP（`https://mcp.mcd.cn`）的完整方式，以及**用真实 Token 实测得到的接口契约**。

官方仓库公开了工具名与描述，但**未公开参数 schema**，且部分响应格式与常规 JSON 差异很大。以下结论均来自实测，已固化进测试用例（`test-integration.js`）防回归。

---

## 1. 接入配置

### 端点与鉴权

| 项 | 值 |
|---|---|
| 端点 | `https://mcp.mcd.cn` |
| 协议 | MCP Streamable HTTP |
| 协议版本 | `2025-06-18` |
| 鉴权 | `Authorization: Bearer <MCP_TOKEN>` |
| 限流 | 600 次 / 分钟 |

### MCP 客户端配置示例

```json
{
  "mcpServers": {
    "mcd": {
      "type": "streamablehttp",
      "url": "https://mcp.mcd.cn",
      "headers": {
        "Authorization": "Bearer <MCP_TOKEN>"
      }
    }
  }
}
```

本项目未使用任何 MCP SDK，而是**从零实现了 Streamable HTTP 客户端**（`src/mcp-client.js`，零第三方依赖），覆盖：

- SSE（`text/event-stream`）与 JSON 双响应格式解析
- `Mcp-Session-Id` 握手与会话保持
- 600 次/分钟令牌桶限流（对齐官方配额）
- 401 / 429 错误码处理与容错重试

### 本项目中的配置方式

```bash
# 方式一：环境变量（推荐，服务启动时自动连接）
MCD_MCP_TOKEN=<你的Token> node server.js

# 方式二：页面顶部「连接 MCP」处填写（Token 仅驻留于服务进程内存，不写入磁盘）
```

**预约时段（仅演示/测试用）**：菜单按餐段返回，随心配只在午市与夜市上架。想在早餐时段看到 1+1 的完整链路，可以在选门店时带一个午餐时间：

```bash
curl -X POST http://127.0.0.1:8787/api/store/select \
  -H 'Content-Type: application/json' \
  -d '{"storeCode":"1450034","reservationDate":"2026-10-21 12:00"}'
```

正常使用**不要传** `reservationDate`——官方说明是「预约场景必传，非预约场景不传」，非预约场景带了它会被按预约处理（早期版本自动填当天日期，结果菜单直接返回空）。

---

## 2. 工具清单（实测 35 个）

官方 README 列出 30 个，实际 `tools/list` 返回 **35 个**。以下为完整清单及必填参数：

| # | 工具 | 必填参数 | 本项目是否调用 |
|---|---|---|---|
| 1 | `query-nearby-stores` | `beType`, `searchType` | ✅ 门店定位 |
| 2 | `query-meals` | `storeCode`, `orderType`, `beType` | ✅ 菜单编码 |
| 3 | `query-meal-detail` | `storeCode`, `orderType`, `beType`, `code` | ✅ 名称与图片 |
| 4 | `calculate-price` | `storeCode`, `orderType`, `beType` | ✅ 计价 / 逐件降级 / 可售性预检 |
| 5 | `list-nutrition-foods` | — | ✅ 160 条营养数据 |
| 6 | `query-my-coupons` | — | ⭕ 已实现加载器，当前版本未接入主流程 |
| 7 | `query-store-coupons` | `orderType`, `beType`, `storeCode` | ⭕ 已实现加载器，当前版本未接入主流程 |
| 8 | `available-coupons` | — | ⭕ 已实现加载器，当前版本未接入主流程 |
| 9 | `create-order` | `storeCode`, `orderType`, `beType` | ❌ 有意不调用（产生真实支付链接） |
| 10 | `query-order` | `orderId` | ⭕ 可调用（未接入主流程） |
| 11 | `order-list` | — | ⭕ 可调用（未接入主流程） |
| 12 | `cancel-order` | `orderId`, `cancelReasonCode` | ⭕ 可调用（未接入主流程） |
| 13 | `query-my-account` | — | ⭕ 可调用（未接入主流程） |
| 14 | `query-lottery-info` | — | ⭕ 只读查询过，未抽奖 |
| 15 | `draw-lottery` | — | ❌ 有意不调用（原子扣减且不可撤销） |
| 16 | `query-my-prizes` | — | ⭕ 可调用（未接入主流程） |
| 17 | `mall-points-products` | — | ⭕ 可调用（未接入主流程） |
| 18 | `mall-product-detail` | `spuId` | ⭕ 可调用（未接入主流程） |
| 19 | `mall-create-order` | `skuId`, `spuCategory` | ❌ 有意不调用 |
| 20 | `mall-order-list` | — | ⭕ 可调用（未接入主流程） |
| 21 | `mall-order-detail` | `orderId` | ⭕ 可调用（未接入主流程） |
| 22 | `query-party-city` | `spuId` | ⭕ 可调用（未接入主流程） |
| 23 | `query-party-store` | `code` | ⭕ 可调用（未接入主流程） |
| 24 | `query-party-store-date` | `spuId`, `storeCode` | ⭕ 可调用（未接入主流程） |
| 25 | `query-party-store-session` | `spuId`, `storeCode`, `dateStr` | ⭕ 可调用（未接入主流程） |
| 26 | `party-order-create` | `partyType` | ❌ 有意不调用 |
| 27 | `delivery-query-addresses` | — | ⭕ 可调用（未接入主流程） |
| 28 | `delivery-create-address` | `address`, `addressDetail`, `city`, `contactName`, `phone` | ❌ 涉及隐私，未调用 |
| 29 | `delivery-query-stores` | `beType`, `addressId` | ⭕ 可调用（未接入主流程） |
| 30 | `auto-bind-coupons` | — | ⭕ 可调用（未接入主流程） |
| 31 | `query-promotions` | `storeCode`, `orderType`, `beType` | ⭕ 可调用（未接入主流程） |
| 32 | `query-meal-assistance` | `storeCode` | ⭕ 可调用（未接入主流程） |
| 33 | `query-survey-coupon` | `orderId` | ⭕ 可调用（未接入主流程） |
| 34 | `campaign-calendar` | — | ⭕ 可调用（未接入主流程） |
| 35 | `now-time-info` | — | ⭕ 可调用（未接入主流程） |

> ⭕ 表示未进入当前版本的主流程；其中 `POST /api/mcp/call` 可透传调用全部 35 个工具，用于排障与试参数。
>
> 当前版本实际进入主流程的是 5 个工具：`list-nutrition-foods`、`query-nearby-stores`、`query-meals`、`query-meal-detail`、`calculate-price`。优惠券不参与计算——两件及以上的组合优惠由 `calculate-price` 服务端自动给出，无需传券码。

---

## 3. 关键枚举

```text
beType:    1-到店取餐   2-麦乐送到家   5-得来速   6-企业团餐
orderType: 1-到店（含到店自取 + 得来速）  2-外送（含麦乐送 + 团餐）
searchType: 1-搜索收藏餐厅   2-按位置搜索
```

门店标识是 `storeCode`（**不是** `storeId`），外送场景（`beType` 为 2/5/6）还需配 `beCode`。

---

## 4. 调用流程与业务价值

### 4.1 一次开奖背后的完整调用链

```text
① 连接          tools/call → initialize → Mcp-Session-Id 会话保持
                     │
② 加载营养库     list-nutrition-foods         → 160 条营养记录（一次性）
                     │
③ 定位门店       query-nearby-stores          → storeCode / beCode / 营业状态
                     │   （city 与 keyword 分离，候选组重试）
④ 拉菜单         query-meals                  → 分类 + 餐品编码（只有编码）
                     │
⑤ 补详情         query-meal-detail × N        → 名称 + 官方图片 URL（滚轮素材）
                     │
⑥ 预检           calculate-price × N（并行）   → 单品单价 + 可售性，缓存 5 分钟
                     │
⑦ 开奖           本地概率表决定结果 → 驱动滚轮停位
                     │
⑧ 出账           calculate-price（整单）       → 实付 + 优惠 + productList 分摊
                     └─ 整单被拒 → 逐件试算，指出哪一件不可售
                     │
⑨ 拼 1+1         query-meal-detail（套餐 rounds，装载时缓存）
                 calculate-price（roundList 套餐价）→ 与单点合计比较，更便宜才展示
```

关键点：**③ 到 ⑥ 是一次性预加载，⑦ 和 ⑧ 才是每次开奖的实时成本**。因此一局游戏只消耗 1 次计价请求，远低于 600 次/分钟的配额；营养匹配与折扣分摊全部在本地完成，不额外打接口。

### 4.2 业务价值

| 价值 | 说明 |
|---|---|
| 把三套割裂的接口变成一个决策 | 菜单（`query-meals`）、营养（`list-nutrition-foods`）、价格（`calculate-price`）原本没有共同的关联键，本项目用「餐品名称相似度 + 编码」把三者对齐，用户只需摇一次 |
| 让「营养」第一次和「价格」同时出现在一屏 | 官方 MCP 的营养库与计价互不相干；合起来才能回答"这顿贵不贵、值不值" |
| 消除"看起来对"的错误信息 | 业务失败原样透传 + 套餐不猜营养 + 字段校验，避免用户被假数字误导 |
| 零成本分发 | 零第三方依赖、单文件前端、无构建步骤，`git clone` 后 `node server.js` 即可运行，适合作为 MCP 接入的教学样例 |
| 可复用的接入经验 | 参数三级降级、SSE/JSON 双解析、表格格式解析器等，均已抽成独立模块并有测试覆盖 |

---

## 5. 响应结构

统一为 `{success, code, message, datetime, traceId, data}`，业务数据在 `data` 层。

但有两个必须注意的例外：

### 5.1 营养库是自定义表格格式，不是 JSON

`list-nutrition-foods` 的 `data` 字段是紧凑表格序列化：

```text
[160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:
  巨无霸,null,2146,513,27,26,42,961,171
  中薯条,null,1345,289,4,15,36,190,12
```

`[160]` 是记录数，花括号内是列名，其后每行一条逗号分隔数据，`null` 表示空值。
**用标准 JSON 解析会直接失败**，需专用解析器（已实现 `parseTableFormat()`，见 `src/mcp-client.js`）。

### 5.2 业务失败时没有 data 层

```json
{
  "success": false,
  "code": 60006,
  "message": "商品已售罄或不可售，换一个商品或检查orderType/beType",
  "datetime": "2026-10-20 20:58:57",
  "traceId": "d03997b2"
}
```

若不加判断直接去 `data` 层取字段，会把错误响应体当成业务数据，最终只得到"未返回金额"这种**掩盖真实原因**的提示。必须先检查 `success`。

### 5.3 content 是「说明文字 + JSON + 说明文字」的混合体

`tools/call` 返回的 `content` 数组常包含 markdown 说明，其中会出现 `data[].storeName` 这类片段。**用朴素的首括号截取会误命中空数组**，必须用括号平衡扫描，并优先匹配带 `success` 字段的业务响应对象（见 `extractJsonBalanced()`）。

---

## 6. 可复现调用示例

以下示例用环境变量引用 Token，可直接复制执行。

```bash
export MCD_MCP_TOKEN='<你的Token>'
```

### 6.1 握手，取 Session ID

```bash
curl -s -i -X POST https://mcp.mcd.cn \
  -H "Authorization: Bearer $MCD_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0", "id": 1, "method": "initialize",
    "params": {
      "protocolVersion": "2025-06-18",
      "capabilities": { "tools": {} },
      "clientInfo": { "name": "mcd-demo", "version": "1.0.0" }
    }
  }'
```

从响应头取 `mcp-session-id`，后续请求需在头中回传。

### 6.2 列出工具

```bash
curl -s -X POST https://mcp.mcd.cn \
  -H "Authorization: Bearer $MCD_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

### 6.3 查询门店（city 只认城市名，city 与 keyword 都必填）

```bash
curl -s -X POST https://mcp.mcd.cn \
  -H "Authorization: Bearer $MCD_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0", "id": 3, "method": "tools/call",
    "params": {
      "name": "query-nearby-stores",
      "arguments": { "beType": 1, "searchType": 2, "city": "上海", "keyword": "上海" }
    }
  }'
```

> ⚠️ 两个坑：`city` 必须是**城市名或区名**（`杭州`、`上海市`、`松江` 都可用），但把**门店全名**塞进 `city` 会**静默返回 0 家**（不报错）；`searchType=2` 时 `city` 与 `keyword` 缺任一则直接回 `600058 城市名或者关键词不能为空`。正确做法是把「杭州三里亭餐厅」拆成 `city=杭州` + `keyword=三里亭`。

### 6.4 查询菜单（只返回编码）

```bash
curl -s -X POST https://mcp.mcd.cn \
  -H "Authorization: Bearer $MCD_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0", "id": 4, "method": "tools/call",
    "params": {
      "name": "query-meals",
      "arguments": { "storeCode": "1450684", "orderType": 1, "beType": 1 }
    }
  }'
```

返回形如 `{categories:[{name, meals:[{code, tags}]}]}`——**只有编码，没有名称和价格**。

### 6.5 查询餐品详情（拿名称与图片）

```bash
curl -s -X POST https://mcp.mcd.cn \
  -H "Authorization: Bearer $MCD_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0", "id": 5, "method": "tools/call",
    "params": {
      "name": "query-meal-detail",
      "arguments": { "storeCode": "1450684", "orderType": 1, "beType": 1, "code": "1406" }
    }
  }'
```

`image` 字段形如 `https://menu-img.mcd.cn/pcm/prod/menu/.../MS_1406_600.png`（透明底 PNG，**无防盗链**），本项目老虎机的滚轮素材即来源于此。

### 6.6 计价试算（金额单位是「分」）

```bash
curl -s -X POST https://mcp.mcd.cn \
  -H "Authorization: Bearer $MCD_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0", "id": 6, "method": "tools/call",
    "params": {
      "name": "calculate-price",
      "arguments": {
        "storeCode": "1450684", "orderType": 1, "beType": 1,
        "items": [
          { "productCode": "1406", "quantity": 1 },
          { "productCode": "4810", "quantity": 1 }
        ]
      }
    }
  }'
```

返回 `data.price = 3750` 表示 **¥37.50**。组合优惠由服务端自动计算，无需传券码。

---

### 6.7 1+1 随心配：套餐必带 roundList

套餐的 detail 不给价格，只给分区与子件（`rounds[].choices[]`，每项带 `diffPrice` 文案 `+ ¥0` / `- ¥1`）：

```bash
curl -s -X POST https://mcp.mcd.cn \
  -H "Authorization: Bearer $MCD_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0", "id": 7, "method": "tools/call",
    "params": {
      "name": "query-meal-detail",
      "arguments": { "storeCode": "1450034", "orderType": 1, "beType": 1, "code": "9900013304" }
    }
  }'
```

计价必须把每个分区选了哪件一起传下去，**只传套餐码会回 `60006 商品已售罄或不可售`**：

```bash
curl -s -X POST https://mcp.mcd.cn \
  -H "Authorization: Bearer $MCD_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0", "id": 8, "method": "tools/call",
    "params": {
      "name": "calculate-price",
      "arguments": {
        "storeCode": "1450034", "orderType": 1, "beType": 1,
        "items": [{
          "productCode": "9900013304", "quantity": 1,
          "roundList": [
            { "round": "1", "comboItemList": [{ "code": "521156", "quantity": 1 }] },
            { "round": "2", "comboItemList": [{ "code": "4437",  "quantity": 1 }] }
          ]
        }]
      }
    }
  }'
```

实测返回 `price: 1390`（¥13.90）：基础价 1490 减去蓝区 `那么大鸡排` 的 `diffPrice: -¥1`。同样两件单点合计 ¥27.00，所以这一拼省 ¥13.10。套餐与普通单品可以放在**同一次** `items` 里（实测 1490 + 2350 = 3840），拼单不必拆成两笔。

---

## 7. 实测踩坑记录

| # | 现象 | 原因与处理 |
|---|---|---|
| 1 | 营养库一条数据都解析不出来 | `data` 不是 JSON，是 `[160]{列名}:` 表格格式，需专用解析器 |
| 2 | `query-meals` 拿不到名称 | 只返回编码。名称要逐个调 `query-meal-detail`，价格只能用 `calculate-price` 试算 |
| 3 | 菜单返回 0 条 | 自动填充了非必填的 `reservationDate`。该字段说明为"非预约场景不传"，填了会按预约场景处理。**非必填字段不要自动套用上下文** |
| 4 | 门店查询返回 0 家 | `searchType` 的 schema 默认值是 1（搜索收藏餐厅）。按位置搜索必须显式传 2 |
| 5 | 某些门店怎么都搜不到（如「杭州三里亭餐厅」） | 门店全名被整体塞进 `city`，接口按城市名校验后**静默返回 0 家**。需拆成 `city=杭州` + `keyword=三里亭` 后重试 |
| 6 | 计价返回 `price=0` 但不报错 | 字段名写错时接口**静默失败**。需校验 `price=0 且 productList 为空` 并标记为可疑 |
| 7 | 金额看起来大了 100 倍 | 单位是「分」，需除以 100 |
| 8 | 价格"接口失效" | 实为商品售罄返回 `success:false` 但无 data 层，早期实现吞掉了真实原因。详见下节 |
| 9 | 套餐营养数据被低估 | 「板烧鸡腿堡三件套」模糊匹配到单品得到完全相同的 391 kcal。改为**套餐一律不返回营养值** |
| 10 | 菜单在不同时间不一样 | 菜单按时段动态返回（同一门店 20:52 与 21:05 分别为 88 项与 70 项）。不可售状态应视为实时状态，不可写死黑名单 |
| 11 | 套餐只传套餐码，回 `60006 商品已售罄或不可售` | 套餐必须用 `items[].roundList` 指定每个分区选了哪件，缺 `roundList` 就被当成无法结算的组合 |
| 12 | 解析 `diffPrice` 时差价符号丢失 | 字段是**字符串**：`+ ¥0`、`- ¥1`，负号与数字之间还隔着货币符号与空格，直接取「第一个数字」会把 `-¥1` 读成 `+1` |
| 13 | 多件一起试算，返回的 `productList` 少了一件 | 不可售子件会被**静默剔除**（实测 1120 + 3050 只回 1120，总额 ¥23.00），`success` 仍为 `true`。算「省了多少」时不能拿合并结果当单点合计，要逐件试算 |
| 14 | 早餐时段查随心配回 `60001 未匹配到商品` | 随心配按餐段供应，当前时段菜单里没有它。这不是编码失效，换时段或改用 `reservationDate` 才能取到 |

---

## 8. 计价失败的降级设计（本项目实现）

整单计价只要其中一件不可售就会被整体拒绝。本项目做了三层处理：

1. **识别业务失败**：优先判断 `success:false`，原样保留 `code` 与 `message`，不再掩盖为"未返回金额"
2. **逐件降级**：整单被拒后自动为每件商品单独试算，返回各自的可售状态与单价，前端明确指出"哪一件买不了"
3. **装载前预检**：老虎机加载滚轮时并行预检每个符号的可售性与单价，结果缓存 5 分钟

实测效果：预检后 13/13 符号全部可售且均取得真实单价；连续 5 次开奖全部拿到真实价格（¥63.50 – ¥105.00）。

---

## 9. 安全边界

以下工具本项目**有意不调用**：

| 工具 | 原因 |
|---|---|
| `create-order` / `mall-create-order` / `party-order-create` | 产生真实支付链接，必须保留人工确认 |
| `draw-lottery` | 服务端原子扣减积分/次数且**不可撤销**，官方明确要求展示消耗后取得明确确认才能调用 |
| `delivery-create-address` | 涉及收货地址与手机号等隐私信息 |

Token 仅在服务进程内存中保存，不写入磁盘；`.gitignore` 已排除所有可能含凭证的调试产物。
