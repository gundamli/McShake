'use strict';

/**
 * 协议层集成测试
 *
 * 用户尚未提供真实 Token，因此这里启动一个模拟 MCP 服务，
 * 分别以 SSE 与 JSON 两种响应格式验证客户端实现的正确性：
 *   - initialize 握手与 Mcp-Session-Id 回传
 *   - tools/list 解析
 *   - tools/call 的 content[0].text 反序列化
 *   - 401 / 429 错误码
 *   - 限流器行为
 */

const http = require('http');
const { McpClient, parseBody, extractPayload, parseTableFormat, extractJsonBalanced } = require('./src/mcp-client');

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}

const TOOLS = [
  { name: 'list-nutrition-foods', description: '餐品营养信息列表', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'query-meals', description: '查询餐品', inputSchema: { type: 'object', properties: { storeId: { type: 'string' } }, required: ['storeId'] } },
];

function startMock({ format = 'sse', forceStatus = null } = {}) {
  const seenSessionIds = new Set();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msg = JSON.parse(body || '{}');

      if (forceStatus) {
        res.writeHead(forceStatus, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'forced' }));
      }

      // 鉴权校验
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Bearer ') || auth.slice(7).length === 0) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'unauthorized' }));
      }

      // 校验客户端是否回传了会话 ID
      if (msg.method !== 'initialize') {
        const sid = req.headers['mcp-session-id'];
        if (sid) seenSessionIds.add(sid);
      }

      const reply = (result) => {
        const envelope = { jsonrpc: '2.0', id: msg.id ?? null, result };
        if (format === 'sse') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Mcp-Session-Id': 'mock-session-abc123',
          });
          res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ping: 'heartbeat' } })}\n\n`);
          res.write(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`);
          return res.end();
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': 'mock-session-abc123',
        });
        res.end(JSON.stringify(envelope));
      };

      if (msg.method === 'initialize') {
        return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1.0.0' } });
      }
      const replyError = (id, code, message) => {
        const envelope = { jsonrpc: '2.0', id, error: { code, message } };
        if (format === 'sse') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'mock-session-abc123' });
          res.write(`data: ${JSON.stringify(envelope)}\n\n`);
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'mock-session-abc123' });
        return res.end(JSON.stringify(envelope));
      };

      if (msg.method === 'tools/list') return reply({ tools: TOOLS });
      if (msg.method === 'tools/call') {
        const name = msg.params && msg.params.name;
        if (name === 'list-nutrition-foods') {
          return reply({ content: [{ type: 'text', text: JSON.stringify({ foods: [{ name: '巨无霸', energy: 550, protein: 27, fat: 30, carb: 45, sodium: 1020 }] }) }] });
        }
        if (name === 'query-meals') {
          // 模拟真实服务对必填参数的校验：缺 storeId 应报错，
          // 以此验证容错重试确实会切换到下一组候选参数
          const args = (msg.params && msg.params.arguments) || {};
          if (!args.storeId) return replyError(msg.id, -32602, '缺少必填参数: storeId');
          return reply({ content: [{ type: 'text', text: JSON.stringify({ meals: [{ mealCode: 'M1', mealName: '巨无霸', price: 24 }] }) }] });
        }
        return reply({ content: [{ type: 'text', text: 'unknown tool' }] });
      }
      // notification
      res.writeHead(202);
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}`, seenSessionIds });
    });
  });
}

(async () => {
  console.log('\n[1] SSE 响应格式下的完整握手与调用');
  {
    const mock = await startMock({ format: 'sse' });
    const client = new McpClient({ token: 'test-token', endpoint: mock.url });

    await client.connect();
    check('initialize 成功', true);
    check('会话 ID 已保存', client.sessionId === 'mock-session-abc123', `got ${client.sessionId}`);

    const tools = await client.listTools();
    check('tools/list 解析出 2 个工具', tools.length === 2, `got ${tools.length}`);
    check('工具名正确', tools[0].name === 'list-nutrition-foods');

    const foods = await client.callTool('list-nutrition-foods');
    check('tools/call 反序列化嵌套 JSON', foods && foods.foods && foods.foods[0].name === '巨无霸', JSON.stringify(foods).slice(0, 120));

    const meals = await client.callTool('query-meals', { storeId: 'S001' });
    check('带参数调用返回菜单', meals && meals.meals && meals.meals[0].price === 24);

    check('客户端回传了会话 ID', mock.seenSessionIds.has('mock-session-abc123'), [...mock.seenSessionIds].join(','));
    mock.server.close();
  }

  console.log('\n[2] JSON 响应格式');
  {
    const mock = await startMock({ format: 'json' });
    const client = new McpClient({ token: 'test-token', endpoint: mock.url });
    await client.connect();
    const tools = await client.listTools();
    check('JSON 模式解析工具列表', tools.length === 2);
    const foods = await client.callTool('list-nutrition-foods');
    check('JSON 模式调用工具', foods.foods[0].energy === 550);
    mock.server.close();
  }

  console.log('\n[3] 错误处理');
  {
    const mock = await startMock({ forceStatus: 401 });
    const client = new McpClient({ token: 'bad', endpoint: mock.url });
    let err = null;
    try { await client.connect(); } catch (e) { err = e; }
    check('401 抛出可读错误', err && err.code === 401 && /Token/.test(err.message), err && err.message);
    mock.server.close();
  }
  {
    const mock = await startMock({ forceStatus: 429 });
    const client = new McpClient({ token: 't', endpoint: mock.url });
    let err = null;
    try { await client.connect(); } catch (e) { err = e; }
    check('429 抛出限流错误', err && err.code === 429, err && err.message);
    mock.server.close();
  }
  {
    let threw = false;
    try { new McpClient({ token: '', endpoint: 'http://127.0.0.1:1' }); } catch (_) { threw = true; }
    check('空 Token 构造即失败', threw);
  }

  console.log('\n[4] 容错调用与限流器');
  {
    const mock = await startMock({ format: 'json' });
    const client = new McpClient({ token: 't', endpoint: mock.url });
    await client.connect();

    // 第一个候选参数缺 storeId 会失败，第二个带上则成功
    const r = await client.callToolWithFallback('query-meals', [{}, { storeId: 'S1' }]);
    check('候选参数重试命中', r.usedArgs.storeId === 'S1', JSON.stringify(r.usedArgs));

    const before = client.rateLimiter.remaining;
    await client.callTool('list-nutrition-foods');
    check('限流器递减', client.rateLimiter.remaining === before - 1, `${before} -> ${client.rateLimiter.remaining}`);
    mock.server.close();
  }

  console.log('\n[5] 响应解析边界');
  {
    const sseWithNoise = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\n\n: heartbeat\n\ndata: not-json\n\n';
    const parsed = parseBody(sseWithNoise, 'text/event-stream');
    check('SSE 中的非 JSON 行被忽略', parsed && parsed.result && parsed.result.a === 1);

    const wrapped = extractPayload({ content: [{ type: 'text', text: '计算结果如下：{"total":42}元' }] });
    check('从包裹文本中提取 JSON', wrapped && wrapped.total === 42, JSON.stringify(wrapped));

    const plain = extractPayload({ content: [{ type: 'text', text: '无 JSON 内容' }] });
    check('无 JSON 时保留原文', plain && typeof plain._text === 'string');
  }

  console.log('\n[6] 官方表格序列化格式解析');
  {
    // 实测 list-nutrition-foods 的 data 字段并非 JSON，而是紧凑表格格式
    const raw = '[160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:\n'
      + '  猪柳麦满分,null,1288,308,16,16,24,781,213\n'
      + '  巨无霸,null,2146,513,27,26,42,961,171\n';
    const rows = parseTableFormat(raw);
    check('解析出 2 行', rows && rows.length === 2, `got ${rows && rows.length}`);
    check('字段名映射正确', rows[1].productName === '巨无霸', JSON.stringify(rows[1]));
    check('数值自动转数字', rows[1].energyKcal === 513 && rows[1].sodium === 961);
    check('null 转为空值', rows[1].nutritionDescription === null);

    check('非表格文本返回 null', parseTableFormat('{"a":1}') === null);
    check('空数组格式', JSON.stringify(parseTableFormat('[0]{a,b}:')) === '[]');
  }

  console.log('\n[7] 混合文本中的 JSON 提取');
  {
    // 实测门店接口返回「说明文字 + JSON + 说明文字」，且说明中含 data[] 干扰项
    const mixed = '每个门店的基本信息按单行展示：\n'
      + '- **门店名称**: data[].storeName\n'
      + '- **门店编号**: data[].storeCode\n'
      + '{"success":true,"code":200,"message":"请求成功","data":[{"storeCode":"1450684","storeName":"麦当劳上海松江站餐厅"}]}\n'
      + '## 展示结果时，每个门店的 storeCode 必须完整展示\n';
    const v = extractJsonBalanced(mixed);
    check('跳过说明文字中的 data[]', v && v.success === true, JSON.stringify(v).slice(0, 80));
    check('提取到门店数组', v && Array.isArray(v.data) && v.data[0].storeCode === '1450684');

    const wrapped = '结果如下：\n{"success":false,"code":600058,"message":"城市名或者关键词不能为空"}\n## 提示\n';
    const v2 = extractJsonBalanced(wrapped);
    check('提取失败响应', v2 && v2.code === 600058, JSON.stringify(v2));

    // 字符串字面量内的括号不应影响平衡判断
    const tricky = '说明\n{"a":"}","b":[1,2]}\n尾';
    const v3 = extractJsonBalanced(tricky);
    check('正确处理字符串内的括号', v3 && v3.a === '}' && Array.isArray(v3.b), JSON.stringify(v3));
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
