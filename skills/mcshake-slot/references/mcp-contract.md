# 麦当劳 MCP 契约与坑（技能速查版）

完整版见仓库根目录 `MCP_INTEGRATION.md`。这里只留「不看就会踩」的部分。

## 链路

```text
query-nearby-stores (searchType=2 按位置 / searchType=1 收藏)
  → query-meals            # 菜单，按餐段返回
  → query-meal-detail      # 套餐的 rounds[]，单品没有价格
  → calculate-price        # 唯一可信的价格来源，单位「分」
  → create-order           # takeWayCode 必传
  → query-order 轮询       # 没有 webhook
  → cancel-order
```

## 六个必知

1. **金额单位不一致。** `calculate-price` 的 `price` 是**分**（`2690`），
   `create-order` 回的 `realTotalAmount` 是**元的字符串**（`"26.9"`）。混用必错。

2. **`takeWayCode` 必传。** 值只能来自 `calculate-price` 的 `data.takeWayList[]`，
   缺失回 `600010 检查必填参数`。不同门店取值可能不同（实测有 `eat-in` / `take-in-store`，
   也有门店给 `locker-in`），所以永远拿去白名单里挑，别硬编码。

3. **促销自动应用。** 不用传 `couponId`，服务端自己选最优。实测一笔 ¥34.00 的单
   自动减 ¥7.10。

4. **没有支付工具。** 35 个工具里没有 `pay` / `refund` / `confirm-payment`，
   也没有唤起小程序或 URL Scheme 的能力。付款只到 `payH5Url`（`https://m.mcd.cn/mcp/scanToPay?orderId=...`），
   必须由人扫码。

5. **15 分钟支付窗口。** `expirePayTime` = 创建时间 +15min，过期自动关单。
   状态码：`10` 待支付、`60` 已取消；重复取消回 `600064 订单已经取消`。

6. **每日建单上限。** 同账号当天建到第 N 单会被拒（`今日下单数已经上限`）。
   这是硬限制，不要重试。

## 玩法相关的三个坑

1. **1+1 套餐要用 `roundList` 计价与下单。**
   `items: [{productCode, quantity, roundList: [{round, comboItemList: [{code, quantity}]}]}]`。
   套餐价 = `baseFen + Σ diffFen`（人气经典 ¥14.90 / 精选超值 ¥13.90）。
   `diffPrice` 是字符串（形如 `- ¥1`），解析要先取符号再取数字。

2. **多件任务里不可售的子件会被静默剔除**，`success` 仍是 `true`。
   所以「省了多少」必须逐件取单价自己算，不能信一个总数。

3. **并发过密上游回 `508 太火爆了`**，需要串行小步重试；否则部分组合抓不到价格
   （快照里 `failed` 的三连就是这么来的）。

## 门店查询

`city` 只能是城市名，门店全名要塞 `keyword`，混在一起搜不到。
按位置搜索必须 `searchType=2`；`searchType=1` 是「收藏门店」，它不看关键词。
