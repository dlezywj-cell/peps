const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const STOCK = { code: '601899', secId: '1.601899', name: '紫金矿业' };

// 极简 DOM 替身：只实现被测代码用到的部分，重点是把 innerHTML 原文留住，
// 这样既能断言生成的标记，又能在保存时把输入值塞回去。
const makeInput = value => ({ value, focus() {} });

function makeElement(tag) {
  const inputs = {};
  const el = {
    tagName: tag, dataset: {}, style: {}, className: '', textContent: '', value: '',
    children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    appendChild(child) { el.children.push(child); return child; }
  };
  const read = (html, cls) => {
    const match = html.match(new RegExp(`class="${cls}"[^>]*value="([^"]*)"`));
    return makeInput(match ? match[1] : '');
  };
  el.querySelector = selector => {
    if (!inputs[selector]) inputs[selector] = makeInput('');
    return inputs[selector];
  };
  el.querySelectorAll = () => [];
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => html,
    set: value => {
      html = String(value);
      inputs['.in-rev'] = read(html, 'in-rev');
      inputs['.in-prof'] = read(html, 'in-prof');
    }
  });
  return el;
}

function app(seedDb = {}, stock = STOCK) {
  const elements = new Map();
  const store = new Map();
  const created = [];
  if (seedDb) store.set('stock_valuation_db_v2', JSON.stringify(seedDb));
  const toastMessages = [];

  const context = vm.createContext({
    console: { log() {}, error() {} },
    setTimeout, clearTimeout,
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); }
    },
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeElement('div'));
        return elements.get(id);
      },
      createElement(tag) {
        const el = makeElement(tag);
        created.push(el);
        return el;
      },
      querySelectorAll(selector) {
        if (selector.includes('.fw-input-row')) return created.filter(el => el.className === 'fw-input-row');
        return [];
      }
    },
    window: { addEventListener() {} }
  });

  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  vm.runInContext(html.split('<script>')[1].split('</script>')[0], context);
  // 浏览器里 window 就是全局对象；这里补齐，否则 window.xxx = ... 的函数在全局取不到。
  vm.runInContext('Object.assign(globalThis, window);', context);
  vm.runInContext(`currentStock = ${JSON.stringify(stock)};`, context);
  context.__toastLog = toastMessages;
  // 渲染、提示与联网不是这些用例的验证对象，替换掉以免触碰 canvas / 计时器 / 网络。
  vm.runInContext(`
    __originalRunAnalysis = runAnalysis;
    showToast = msg => __toastLog.push(msg);
    setProgress = () => {};
    drawChart = () => {};
    renderForecastHistoryChart = () => {};
    renderTable = () => {};
    runAnalysis = async () => {};
  `, context);

  return {
    context, toastMessages, created,
    run: code => vm.runInContext(code, context),
    rows: () => created.filter(el => el.className === 'fw-input-row'),
    db: () => JSON.parse(store.get('stock_valuation_db_v2') || '{}'),
    // 需要真实主流程（含缺报弹窗判定）的用例用这个还原。
    restoreRunAnalysis: () => { context.runAnalysis = context.__originalRunAnalysis; }
  };
}

test('FW 年度口径以最新已披露年报为基准，不受手工录入影响', () => {
  const { run } = app();
  run(`latestReportedYear = getLatestReportedYear({
      2023: { source: 'real', rev: 1, prof: 1 },
      2025: { source: 'real', rev: 1, prof: 1 },
      2026: { source: 'manual', rev: 1, prof: 1 }
  });`);
  // 跨 vm 上下文的对象要转成当前 realm 的字面量再比较，否则原型不同会被判不等。
  assert.deepEqual(JSON.parse(JSON.stringify(run('getForwardYearSet()'))), { fw1: 2026, fw2: 2027, fw3: 2028 });
});

test('没有任何真实年报时不把手工年份当成基准年', () => {
  const { run } = app();
  assert.equal(run(`getLatestReportedYear({ 2026: { source: 'manual', rev: 1, prof: 1 } })`), null);
  assert.equal(run(`getLatestReportedYear({ __rawAnnualReports: [] })`), null);
});

test('FW3 用 y+2 年度的收入与利润计算 PE / PS，且不影响 FW1 / FW2', () => {
  const { run } = app({
    '601899': {
      __forecast: {
        2027: { rev: 4e10, prof: 4e9, ts: 1 },
        2028: { rev: 8e10, prof: 8e9, ts: 1 }
      },
      __forecastHistory: {
        2027: [{ day: '2026-01-01', rev: 4e10, prof: 4e9, ts: 1 }],
        2028: [{ day: '2026-01-01', rev: 8e10, prof: 8e9, ts: 1 }]
      }
    }
  });
  run(`currentHistoricalShares = [{ date: '2015-01-01', shares: 1e9 }];
       useAShareRawKline([{ date: '2026-06-01', price: 100 }], 'raw');
       calculate({ 2025: { year: 2025, rev: 1e10, prof: 1e9, shares: 1e9, source: 'real' } });`);

  const row = JSON.parse(JSON.stringify(run('globalData[0]')));
  const mktCap = 100 * 1e9;
  // FW1 的 2026 年没有数据，不应被预测值顶替。
  assert.equal(row.pe, null);
  assert.equal(row.fw2year, 2027);
  assert.equal(row.fw3year, 2028);
  assert.equal(row.fw2rev, 4e10);
  assert.equal(row.fw3rev, 8e10);
  assert.equal(row.fw3prof, 8e9);
  assert.equal(row.fw2pe, mktCap / 4e9);
  assert.equal(row.fw3pe, mktCap / 8e9);
  assert.equal(row.fw2ps, mktCap / 4e10);
  assert.equal(row.fw3ps, mktCap / 8e10);
});

test('历史交易日的 FW3 回落到真实年报，不套用未来预测值', () => {
  const { run } = app({
    '601899': {
      __forecast: { 2028: { rev: 8e10, prof: 8e9, ts: 1 } },
      __forecastHistory: { 2028: [{ day: '2026-01-01', rev: 8e10, prof: 8e9, ts: 1 }] }
    }
  });
  run(`currentHistoricalShares = [{ date: '2015-01-01', shares: 1e9 }];
       useAShareRawKline([{ date: '2016-06-01', price: 10 }], 'raw');
       calculate({
           2016: { year: 2016, rev: 1e10, prof: 1e9, source: 'real' },
           2017: { year: 2017, rev: 2e10, prof: 2e9, source: 'real' },
           2018: { year: 2018, rev: 3e10, prof: 3e9, source: 'real' }
       });`);

  const row = JSON.parse(JSON.stringify(run('globalData[0]')));
  assert.equal(row.year, 2016);
  assert.equal(row.fw2year, 2017);
  assert.equal(row.fw3year, 2018);
  assert.equal(row.fw3rev, 3e10);
  assert.equal(row.fw3pe, (10 * 1e9) / 3e9);
});

test('前瞻年度不再触发历史缺报补录弹窗', async () => {
  const { run, context, toastMessages, restoreRunAnalysis } = app();
  restoreRunAnalysis();
  const captured = [];
  context.openBatchModal = async years => { captured.push(...years); return null; };

  context.fetchShares = async () => { run('currentTotalShares = 1e9'); };
  context.fetchKline = async () => {
    run(`useAShareRawKline([
        { date: '2016-06-01', price: 10 },
        { date: '2020-06-01', price: 20 },
        { date: '2025-06-01', price: 30 },
        { date: '2026-06-01', price: 40 }
    ], 'raw')`);
    return true;
  };
  context.fetchHistoricalFinancials = async () => ({
    2016: { year: 2016, rev: 1e10, prof: 1e9, source: 'real' },
    2024: { year: 2024, rev: 2e10, prof: 2e9, source: 'real' }
  });
  context.fetchDirectHistoricalShares = async () => [{ date: '2015-01-01', shares: 1e9 }];

  await run('runAnalysis(false)');

  // 2020 年缺真实财报仍要补录；2025 / 2026 属于 FW 前瞻年度，不再走这个弹窗。
  assert.deepEqual(captured, [2020]);
  assert.equal(run('latestReportedYear'), 2024);
  assert.ok(
    toastMessages.some(msg => typeof msg === 'string' && msg.includes('业绩录入')),
    `期望提示指向业绩录入，实际：${JSON.stringify(toastMessages)}`
  );
});

test('录入弹窗把 FW1 / FW2 / FW3 三行放在一起，并预填已录入值', () => {
  const harness = app({
    '601899': {
      __forecast: { 2027: { rev: 4e10, prof: 4e9, ts: 2 } },
      __forecastHistory: { 2027: [{ day: '2026-05-01', rev: 4e10, prof: 4e9, ts: 2 }] }
    }
  });
  const { run, rows } = harness;
  run('latestReportedYear = 2025; openForecastModal();');

  const list = rows();
  assert.equal(list.length, 3);
  assert.deepEqual(list.map(row => row.dataset.year), ['2026', '2027', '2028']);
  assert.deepEqual(list.map(row => row.dataset.kind), ['fw1', 'fw2', 'fw3']);

  const markup = list.map(row => row.innerHTML);
  assert.ok(markup[0].includes('fw-badge fw1') && markup[0].includes('2026 年'));
  assert.ok(markup[1].includes('fw-badge fw2') && markup[1].includes('2027 年'));
  assert.ok(markup[2].includes('fw-badge fw3') && markup[2].includes('2028 年'));
  markup.forEach(html => {
    assert.ok(html.includes('收入（亿）') && html.includes('净利润（亿）'));
    assert.match(html, /class="in-rev"/);
    assert.match(html, /class="in-prof"/);
  });
  // FW2 的 2027 已有预测值 400 亿 / 40 亿，FW1 与 FW3 尚未录入。
  assert.match(markup[0], /class="in-rev"[^>]*value=""/);
  assert.match(markup[1], /class="in-rev"[^>]*value="400"/);
  assert.match(markup[1], /class="in-prof"[^>]*value="40"/);
  assert.match(markup[2], /class="in-rev"[^>]*value=""/);
  assert.equal(run('document.getElementById("forecastInputModal").style.display'), 'flex');
  assert.ok(run('document.getElementById("forecastInputBase").textContent').includes('2025'));
});

test('保存时 FW1 落手工层、FW2 / FW3 落预测层', () => {
  const harness = app();
  const { run, rows } = harness;
  run('latestReportedYear = 2025; openForecastModal();');

  const list = rows();
  [[1500, 130], [1800, 150], [2100, 175]].forEach(([rev, prof], index) => {
    list[index].querySelector('.in-rev').value = String(rev);
    list[index].querySelector('.in-prof').value = String(prof);
  });
  run('closeForecastModal(true)');

  const db = harness.db();
  assert.equal(run('document.getElementById("forecastInputModal").style.display'), 'none');
  assert.equal(db['601899']['2026'].rev, 1500e8);
  assert.equal(db['601899']['2026'].prof, 130e8);
  assert.equal(db['601899'].__manualHistory['2026'][0].rev, 1500e8);
  assert.equal(db['601899'].__forecast['2027'].rev, 1800e8);
  assert.equal(db['601899'].__forecast['2028'].rev, 2100e8);
  assert.equal(db['601899'].__forecastHistory['2027'][0].rev, 1800e8);
  assert.equal(db['601899'].__forecastHistory['2028'][0].rev, 2100e8);
  // 预测年度不得污染手工层，避免和真实年报口径混在一起。
  assert.equal(db['601899']['2027'], undefined);
  assert.equal(db['601899']['2028'], undefined);
});

test('某一年的收入和净利润只填一侧时拦下，不写库', () => {
  const harness = app();
  const { run, rows, toastMessages } = harness;
  run('latestReportedYear = 2025; openForecastModal();');

  rows()[0].querySelector('.in-rev').value = '1500';
  run('closeForecastModal(true)');

  assert.equal(run('document.getElementById("forecastInputModal").style.display'), 'flex');
  assert.deepEqual(harness.db(), {});
  assert.ok(toastMessages.some(msg => typeof msg === 'string' && msg.includes('同时填写')));
});

test('没有变化的年度不重写历史，留空的年度保持原值不动', () => {
  const harness = app({
    '601899': {
      __forecast: { 2027: { rev: 4e10, prof: 4e9, ts: 2 } },
      __forecastHistory: { 2027: [{ day: '2026-05-01', rev: 4e10, prof: 4e9, ts: 2 }] }
    }
  });
  const { run, rows } = harness;
  run('latestReportedYear = 2025; openForecastModal();');

  const list = rows();
  list[2].querySelector('.in-rev').value = '2100';
  list[2].querySelector('.in-prof').value = '175';
  run('closeForecastModal(true)');

  const db = harness.db();
  // FW2 被预填但没改，不应产生新的历史快照。
  assert.equal(db['601899'].__forecast['2027'].rev, 4e10);
  assert.equal(db['601899'].__forecast['2027'].ts, 2);
  assert.equal(db['601899'].__forecastHistory['2027'].length, 1);
  // 留空的 FW1 不写库，改过的 FW3 正常落库。
  assert.equal(db['601899']['2026'], undefined);
  assert.equal(db['601899'].__forecast['2028'].rev, 2100e8);
});

test('原样保存不产生任何历史噪音', () => {
  const harness = app({
    '601899': {
      __forecast: { 2027: { rev: 4e10, prof: 4e9, ts: 2 } },
      __forecastHistory: { 2027: [{ day: '2026-05-01', rev: 4e10, prof: 4e9, ts: 2 }] }
    }
  });
  const { run, toastMessages } = harness;
  run('latestReportedYear = 2025; openForecastModal();');
  run('closeForecastModal(true)');

  const db = harness.db();
  assert.equal(db['601899'].__forecastHistory['2027'].length, 1);
  assert.equal(db['601899'].__forecast['2027'].ts, 2);
  assert.ok(toastMessages.some(msg => typeof msg === 'string' && msg.includes('没有需要保存的变更')));
});
