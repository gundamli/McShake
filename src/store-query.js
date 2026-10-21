'use strict';

/**
 * 门店查询的参数构造。
 *
 * 单独成文件是因为这里是纯函数，可直接在 test.js 里覆盖——
 * 门店搜不出来这件事跟网络无关，纯粹是参数形态问题，必须有回归测试兜底。
 *
 * query-nearby-stores 的实测约束：
 *   1. searchType=2 时 city 与 keyword 都是必填，缺任一个返回 code 600058；
 *   2. city 必须是服务端认可的城市名 / 区名。把「杭州三里亭餐厅」这种整句
 *      塞进 city 会静默返回 0 家——这就是部分门店死活搜不出来的原因；
 *      只传 keyword 不传 city 同样拿不到结果；
 *   3. 无分页参数，每次固定按距离返回最近的 5 家。
 */

/**
 * 常见城市名 / 区名（用于把整句拆成 city + keyword）。
 * 运行时按长度降序，保证「乌鲁木齐」不会被「乌」这类短名截断。
 */
const CITY_NAMES = [
  '北京', '上海', '天津', '重庆',
  '广州', '深圳', '杭州', '南京', '武汉', '成都', '西安', '苏州', '宁波', '青岛', '大连',
  '厦门', '长沙', '郑州', '济南', '合肥', '福州', '无锡', '佛山', '东莞', '南昌', '昆明',
  '贵阳', '南宁', '太原', '石家庄', '哈尔滨', '沈阳', '长春', '兰州', '海口', '乌鲁木齐',
  '呼和浩特', '银川', '西宁', '拉萨', '温州', '珠海', '中山', '惠州', '泉州', '徐州',
  '常州', '南通', '烟台', '潍坊', '洛阳', '唐山', '保定', '廊坊', '绍兴', '嘉兴', '台州',
  '金华', '湖州', '扬州', '盐城', '镇江', '泰州', '淮安', '连云港', '芜湖', '赣州', '漳州',
  '桂林', '柳州', '三亚', '绵阳', '宜昌', '襄阳', '株洲', '衡阳', '汕头', '湛江', '江门',
  '肇庆', '清远', '揭阳', '潮州', '咸阳', '宝鸡', '榆林', '大同', '包头', '鄂尔多斯', '鞍山',
  '吉林', '大庆', '齐齐哈尔', '牡丹江', '淄博', '济宁', '临沂', '威海', '东营', '泰安',
  '德州', '聊城', '菏泽', '枣庄', '日照', '安阳', '新乡', '南阳', '许昌', '周口', '商丘',
  '信阳', '驻马店', '岳阳', '常德', '湘潭', '郴州', '衡水', '邯郸', '秦皇岛', '沧州',
  '邢台', '张家口', '承德', '运城', '临汾', '晋中', '长治', '遵义', '六盘水', '安顺',
  '玉溪', '曲靖', '大理', '茂名', '梅州', '汕尾', '河源', '韶关', '云浮',
  '松江', '浦东', '静安', '徐汇', '长宁', '普陀', '虹口', '杨浦', '黄浦', '闵行', '宝山',
  '嘉定', '青浦', '奉贤', '金山', '崇明',
].sort((a, b) => b.length - a.length);

/**
 * 把用户输入拆成 {city, keyword}。
 *
 * 例：「麦当劳杭州三里亭餐厅」→ {city:'杭州', keyword:'三里亭'}
 *     「杭州三里亭」          → {city:'杭州', keyword:'三里亭'}
 *     「三里亭」              → {city:'', keyword:'三里亭'}（无城市前缀，交给调用方降级）
 */
function splitCityKeyword(input) {
  let s = String(input || '').trim();
  if (!s) return { city: '', keyword: '' };
  // 抹掉门店名里必然出现的品牌词与后缀，剩下的更接近「城市 + 地标」
  s = s.replace(/^麦当劳/, '').replace(/麦当劳/g, '').replace(/餐厅$/, '').trim();
  for (const city of CITY_NAMES) {
    if (s.startsWith(city)) {
      const rest = s.slice(city.length).trim();
      // keyword 不能为空：实测只传 city 会返回 code 600058
      return { city, keyword: rest || city };
    }
  }
  return { city: '', keyword: s };
}

/**
 * 生成门店查询的参数候选组，按命中概率从高到低排列，由调用方依次尝试。
 *
 * 多组重试是因为接口对 city 的校验很严格，而用户输入的形态千差万别：
 * 有人填「杭州 三里亭」，有人直接粘门店全名，也有人只填「松江」这种区名。
 */
function buildStoreQueries(input, explicitCity) {
  const raw = String(input || '').trim();
  const plans = [];
  const push = (city, keyword, label) => {
    const c = String(city || '').trim();
    const k = String(keyword || '').trim();
    if (!c || !k) return;
    if (plans.some((p) => p.city === c && p.keyword === k)) return;
    plans.push({ city: c, keyword: k, label });
  };

  // 用户显式填了城市：优先用它
  if (String(explicitCity || '').trim()) push(explicitCity, raw || explicitCity, '指定城市');
  // 从整句里剥离城市前缀
  const s = splitCityKeyword(raw);
  if (s.city) push(s.city, s.keyword, '自动拆分');
  // 兜底：把整串同时当 city 和 keyword（对「松江」「静安」这类区名有效）
  push(raw, raw, '整串匹配');
  return plans;
}

module.exports = { CITY_NAMES, splitCityKeyword, buildStoreQueries };
