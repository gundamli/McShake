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
| 9 | `create-order` | `storeCode`, `orderType`, `beType`, `takeWayCode`, `items` | ✅ 一键下单（双重人工确认后才调用） |
| 10 | `query-order` | `orderId` | ✅ 付款状态轮询 |
| 11 | `order-list` | — | ⭕ 可调用（未接入主流程） |
| 12 | `cancel-order` | `orderId`, `cancelReasonCode` | ✅ 显式取消订单 |
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
> 当前版本实际进入主流程的是 8 个工具：`list-nutrition-foods`、`query-nearby-stores`、`query-meals`、`query-meal-detail`、`calculate-price`（读链路），以及 `create-order`、`query-order`、`cancel-order`（写链路，必须经过人工确认，见第 11 节）。优惠券不参与计算——两件及以上的组合优惠由 `calculate-price` 服务端自动给出，无需传券码。

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
| 15 | 套餐 `rounds[].choices` 里混着买不到的子件 | 分区列表里存在不代表当下可售：实测同一家店的粉区饮品有 4 件单独试算回 `60006 商品已售罄或不可售`。直接拿 choices 当候选池会让用户摇到买不了的组合，入池前必须做一次可售性预检 |
| 16 | 部分分区子件不在门店菜单里 | 套餐专属子件（如「可乐中杯」）只存在于套餐 `rounds` 中，`query-meals` 查不到。它们是合法餐品、能下单、也有营养数据，只是查无此菜——需要用 choices 里的名称兜底，否则会被显示成一串数字 |

---

## 8. 计价失败的降级设计（本项目实现）

整单计价只要其中一件不可售就会被整体拒绝。本项目做了三层处理：

1. **识别业务失败**：优先判断 `success:false`，原样保留 `code` 与 `message`，不再掩盖为"未返回金额"
2. **逐件降级**：整单被拒后自动为每件商品单独试算，返回各自的可售状态与单价，前端明确指出"哪一件买不了"
3. **装载前预检**：老虎机加载滚轮时并行预检每个符号的可售性与单价，结果缓存 5 分钟

实测效果：预检后 13/13 符号全部可售且均取得真实单价；连续 5 次开奖全部拿到真实价格（¥63.50 – ¥105.00）。

---

## 9. 安全边界

写操作按「有没有能力撤销」分成两类，边界不一样：

**有条件调用**（一次性、可关单、金额可见）：

| 工具 | 前置条件 | 兜底 |
|---|---|---|
| `create-order` | 用户先在弹窗看见金额与门店、选堂食/外带、勾选确认语，服务端再复核一次金额才建单 | 15 分钟未付款自动关单；页面提供「取消订单」，也可在麦当劳 APP「我的订单」里处理 |
| `query-order` | 只读 | — |
| `cancel-order` | 用户显式点「取消订单」或支付超时 | 重复取消回 `600064`，按已取消处理 |

**永不调用**：

| 工具 | 原因 |
|---|---|
| `mall-create-order` / `party-order-create` | 商城与团餐下单链路未经实测，不拿用户账号冒险 |
| `draw-lottery` | 服务端原子扣减积分/次数且**不可撤销**，官方明确要求展示消耗后取得明确确认才能调用；本项目零奖励诉求，没必要动它 |
| `delivery-create-address` | 涉及收货地址与手机号等隐私信息 |
| `auto-bind-coupons` | 会变更账号券状态，且计价已由服务端自动选最优，无需此步 |

> `create-order` 之所以从「永不调用」移进「有条件调用」，是因为本项目把它做成了**等待人工付款**的半程链路：MCP 只负责把购物车变成待支付订单，付款永远由人在手机上完成（第 11 节）。没有这层确认 UI，它就仍然属于不该碰的工具。

Token 仅在服务进程内存中保存，不写入磁盘；`.gitignore` 已排除所有可能含凭证的调试产物。

## 10. 公网试玩：为什么用快照而不是内置 Token

线上试玩地址：<https://mcshake.app.workbuddy.host/?sharecode=AMBVYTIUXU>

把服务部署到公网后，最直接的做法是把自己的 `MCD_MCP_TOKEN` 塞进服务端环境变量，让所有访问者共享。这件事**不能做**：

1. **凭据泄漏面**：`/api/mcp/call` 是通用工具代理，谁拿到这个站点就能用你的 Token 调任意工具；
2. **配额**：600 次/分钟的令牌桶是账号级的，公开站点几秒就能刷穿；
3. **条款**：麦当劳 MCP 授权是「个人非商业用途」，把 Token 挂到公网供他人使用不符合授权范围。

因此线上版把**一场真实会话**抓成快照，用快照重放：

| 快照字段 | 来源工具 | 说明 |
|---|---|---|
| `menu`（116 项） | `query-meals` + 逐件 `query-meal-detail` | 含名称、分类、官方餐品图 URL、是否有 `rounds` |
| `nutrition` | `list-nutrition-foods` | 官方原始响应，服务端照旧解析 |
| `prices`（32 项） | 逐件 `calculate-price` | 滚轮符号 + 1+1 子件的真实单价 |
| `triples`（286 组） | 三件一起 `calculate-price` | 11 个符号的全部三元组合，**保留真实优惠与 `productList` 逐件分摊** |
| `combos`（2 套） | `query-meal-detail` 的 `rounds` + 套餐价试算 | 含分区/子件/差价，`baseFen` 为套餐基础价 |

`src/demo-mcp.js` 实现 `callTool` / `getToolSchema` / `callToolWithFallback` 三个与 `McpClient` 同签名的方法，直接替换 `session.mcp`，**业务逻辑零改动**。几条硬约束：

- 快照中命中的三连，逐分返回抓取时的真实响应（`test.js` 里有对账断言）；
- 快照里没有的组合按真实单价合成，`discount` 只可能是 0，绝不编造优惠；
- 套餐价按 `baseFen + Σ diffFen` 计算，`build-demo-snapshot.js` 会用另外两组真实子件验算，不成立就放弃该套餐；
- 未覆盖的工具（如 `draw-lottery`）直接抛错。

抓取时的两个坑：

- **并发打太密会被上游回 `508 太火爆了`**：286 组里有 19 组失败，改成串行小步重试后全部补齐；
- **`query-nearby-stores` 的 `searchType=1` 是「收藏门店」**，按位置搜必须 `searchType=2`，否则列表为空、门店中文名会退化成编号。

## 11. 一键下单：MCP 能建单，不能付款

实测结论：**35 个工具里没有任何支付能力**（无 `pay` / `refund` / `confirm-payment` / 小程序跳转）。全链路只到「建单 + 付款链接」：

```text
calculate-price（取 takeWayList / 金额）
  → create-order（takeWayCode 必传）
  → { orderId, payId, payH5Url: https://m.mcd.cn/mcp/scanToPay?orderId=... }
  → query-order 轮询（无 webhook、无回调）
  → cancel-order（关单）
```

`payH5Url` 是移动端 H5 收银台（HTTP 200，带微信 JSSDK），**只能由人扫码或在微信里打开**。本项目把它渲染成二维码（`public/qrcode.js`，零依赖编码器，48 组用例经 OpenCV 解码验证），页面倒计时 15 分钟并轮询 `query-order`，用户付款后状态自动刷新。

必须处理的契约细节：

| 项 | 实测行为 | 处理方式 |
|---|---|---|
| `takeWayCode` | 到店场景**必传**，缺了回 `600010 检查必填参数` | 只接受 `calculate-price` 返回的 `takeWayList[]`（`eat-in` 堂食 / `take-in-store` 外带），前端传值必须过白名单 |
| 金额单位 | `calculate-price` 给**分**（`price: 2690`），`create-order` 回**元的字符串**（`realTotalAmount: "26.9"`） | 统一在 `src/order.js` 里转成数字元输出 |
| 促销 | 服务端自动挑最优，不需要传券；实测该店 `query-store-coupons` 返回 0 张 | 不传 `couponId`，直接展示回包的优惠金额 |
| 套餐下单 | 必须带 `roundList`（每个分区选中的子件），回包 `orderProductList[].comboItemList` 会列出子件 | `buildOrderItems()` 发「套餐项 + 没进套餐的剩余单品」 |
| 支付窗口 | `expirePayTime` = 创建时间 + **15 分钟**，过期自动关单 | 前端倒计时，到点提示已过期 |
| 状态码 | `10` 待支付 / `60` 已取消；重复取消回 `600064 订单已经取消` | `describeStatus()` 归一出 `waiting / paid / cancelled` |
| 每日上限 | 同一账号当天建到第 4 单被拒：`今日下单数已经上限` | 原样把错误文案回给用户，不重试 |

三条安全约定：订单只可能建在**填了 Token 的那个人**的账号里；演示模式（快照）下 `/api/order/create` 直接 `403`，按钮文案固定为「演示模式无法下单」；关弹窗不取消订单（用户可能正在扫码），只有显式点取消或超时才关单。

---

## 12. 把 MCP 能力交给对话：WorkBuddy 技能形态

同一个 MCP 集成，本项目给了两种消费方式：**人打开网页玩**，和**对话里说一句话**。后者打包成 WorkBuddy 技能 `mcshake-slot`（随仓库放在 `skills/mcshake-slot/`）。

### 12.1 为什么不直连 MCP

最省事的做法是让技能自己拿 Token、自己调 `calculate-price`。没有这么做，因为**玩法逻辑只有一份**：符号精选、概率表开奖、营养匹配、1+1 分区索引、折扣分摊、下单入参翻译，全在 `src/` 与 `server.js` 里。技能里重写一遍，必然和网页版跑偏——同一个组合，浏览器算 ¥37.40、对话里算出别的数，这种不一致比功能缺失更难解释，也最容易在演示时被抓出来。

所以技能只做编排，不碰业务：

```text
对话 / CLI
   │  ① 定位仓库（MCSHAKE_HOME → config.json → 向上查找 → 扫 ~/WorkBuddy/*/McShake）
   ▼
skills/mcshake-slot/scripts/mcshake.js
   │  ② 起一个临时本地服务（端口 8787 起试 6 个，已跑着的 McShake 则直接复用）
   ▼
server.js  ←── 与网页版完全同一份代码
   │  ③ 打 /api/slot/*、/api/order/*
   ▼
麦当劳官方 MCP（https://mcp.mcd.cn）
```

技能里 `require` 的也是仓库自己的 `src/slot.js` 概率表，**不另写随机逻辑**：否则对话里摇的和网页上摇的分布不一样。

### 12.2 为什么是「一条命令一个临时服务」

第一版做的是常驻后台服务，结果在实际执行环境里被连进程树回收——`serve` 报成功，下一条命令却找不到服务，还留一个指向死端口的状态文件，制造假故障。改成默认自灭：**起服务 → 办完事 → 关掉**（演示模式约 1.7s / 局，实时模式约 5s / 局）。只有用户想看浏览器时才 `serve`。

另一个必须处理的竞态：端口通了不等于能用。`server.js` 在 `listen` 回调里才去连 MCP 或载入快照，此时打 `/api/slot/symbols` 会拿到「尚未连接 MCP 服务」。所以就绪判定是 `health.demo || health.connected`，不是 `health.ok`。

### 12.3 对话场景的三条硬边界

| 边界 | 做法 | 为什么 |
|---|---|---|
| 建单必须显式确认 | `order create` 不带 `--yes` 直接退出码 `2`，只打印金额与门店 | 模型很容易在「帮我点个麦当劳」之后顺手建单。这一条写进了 `test.js` 断言 |
| Token 不进输出 | 只从环境变量读，`--json` 输出里不含 Token，也不落盘 | 对话记录会被保存和转发，凭据进了 transcript 就等于泄漏 |
| 不宣称已完成付款 | 输出里固定写「待支付 + 付款链接 + 15 分钟窗口」 | MCP 没有支付能力，说「已帮你付好」是把人骗到店里干等 |

### 12.4 两种安装方式

| 方式 | 位置 | 定位仓库的方式 |
|---|---|---|
| 跟着仓库 | `skills/mcshake-slot/` | 自动向上查找，无需配置 |
| 装成用户级技能 | `~/.workbuddy/skills/mcshake-slot/` | 环境变量 `MCSHAKE_HOME`，或技能目录写 `config.json`：`{"home":"<仓库绝对路径>"}` |

`config.json` 含本机绝对路径，已列入 `.gitignore`，不入库。

### 12.5 验证

技能自身的可用性有 11 项断言（`test.js` 的 [11] 组）：项目定位（`looksLikeProject` / `resolveProjectRoot`）、开奖判定（三连/两连/全不同）、无参数与 `-h` 都打印用法、`order create` 缺 `--yes` 时拒绝执行且退出码为 `2`。全部测试合计 **212 项**，不需要 Token。
