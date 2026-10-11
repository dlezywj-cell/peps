const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// 估值图图例的点击粒度：应该只切换被点的那一条线，
// 而不是把同一根轴上的 PE / PS 整组一起藏掉。
function makeElement(tag) {
  return {
    tagName: tag, dataset: {}, style: {}, className: '', textContent: '', value: '',
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    querySelector: () => makeElement('input'),
    querySelectorAll: () => []
  };
}

// 只保留被测代码真正用到的 chart 行为：可见性开关与轴配置。
function makeChart(datasets) {
  const visibility = datasets.map(() => true);
  const chart = {
    data: { datasets, labels: ['2025-06-02', '2026-06-01'] },
    options: {
      scales: {
        x: {},
        y_price: { display: false },
        y_pe: { display: true },
        y_ps: { display: true }
      }
    },
    isDatasetVisible: index => visibility[index],
    setDatasetVisibility: (index, value) => { visibility[index] = value; },
    update() {},
    visibility
  };
  return chart;
}

const realChartDatasets = () => ([
  { label: '股价', data: [30, 40], yAxisID: 'y_price' },
  { label: 'PE（右轴）', data: [23.1, 17.4], yAxisID: 'y_pe' },
  { label: 'PS（左轴）', data: [2, 2.2], yAxisID: 'y_ps' },
  { label: 'FW2 PE', data: [15.8, 21.1], yAxisID: 'y_pe' },
  { label: 'FW2 PS', data: [1.7, 2.2], yAxisID: 'y_ps' },
  { label: 'FW3 PE', data: [13, 17.4], yAxisID: 'y_pe' },
  { label: 'FW3 PS', data: [1.4, 1.9], yAxisID: 'y_ps' }
]);

function app(datasets = realChartDatasets()) {
  const elements = new Map();
  const context = vm.createContext({
    console: { log() {}, error() {} },
    setTimeout, clearTimeout,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    localStorage: { getItem: () => null, setItem() {} },
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeElement('div'));
        return elements.get(id);
      },
      querySelectorAll: () => []
    },
    window: { addEventListener() {} }
  });

  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  vm.runInContext(html.split('<script>')[1].split('</script>')[0], context);
  // 浏览器里 window 就是全局对象；这里补齐，否则 window.xxx = ... 的函数在全局取不到。
  vm.runInContext('Object.assign(globalThis, window);', context);

  const chart = makeChart(datasets);
  context.__chart = chart;
  vm.runInContext(`
    // refreshValuationAxes 只对当前图表生效，需要把被测图表设为 chartInstance。
    chartInstance = __chart;
    // 与本次行为无关的联动与按钮刷新，替换成空实现。
    updateRangeSelector = () => {};
    scheduleSharedXAxisLayout = () => {};
  `, context);

  return {
    chart,
    click: index => vm.runInContext(
      `handleValuationLegendClick(null, { datasetIndex: ${index} }, { chart: __chart });`,
      context
    ),
    visible: () => chart.visibility.slice(),
    axis: id => vm.runInContext(`chartInstance.options.scales.${id}.display`, context)
  };
}

const labelsOf = datasets => datasets.map(d => d.label);
const visibleLabels = (datasets, visibility) =>
  labelsOf(datasets).filter((_, index) => visibility[index]);

test('点击某一条线只切换那一条，不再牵连同轴的其它年度', () => {
  const datasets = realChartDatasets();
  const { click, visible } = app(datasets);

  click(3); // FW2 PE
  assert.deepEqual(visibleLabels(datasets, visible()),
    ['股价', 'PE（右轴）', 'PS（左轴）', 'FW2 PS', 'FW3 PE', 'FW3 PS']);

  click(5); // FW3 PE
  assert.deepEqual(visibleLabels(datasets, visible()),
    ['股价', 'PE（右轴）', 'PS（左轴）', 'FW2 PS', 'FW3 PS']);
});

test('点击基准线只切换它自己，FW2 / FW3 不受影响', () => {
  const datasets = realChartDatasets();
  const { click, visible } = app(datasets);

  click(1); // PE（右轴）
  assert.deepEqual(visibleLabels(datasets, visible()),
    ['股价', 'PS（左轴）', 'FW2 PE', 'FW2 PS', 'FW3 PE', 'FW3 PS']);

  click(2); // PS（左轴）
  assert.deepEqual(visibleLabels(datasets, visible()),
    ['股价', 'FW2 PE', 'FW2 PS', 'FW3 PE', 'FW3 PS']);
});

test('PE 与 PS 互不牵连', () => {
  const datasets = realChartDatasets();
  const { click, visible, axis } = app(datasets);

  click(3); // 藏 FW2 PE
  click(5); // 藏 FW3 PE
  click(1); // 藏 PE（右轴）
  assert.deepEqual(visibleLabels(datasets, visible()),
    ['股价', 'PS（左轴）', 'FW2 PS', 'FW3 PS']);
  assert.equal(axis('y_pe'), false);
  assert.equal(axis('y_ps'), true);
});

test('同一条线再点一次恢复显示', () => {
  const datasets = realChartDatasets();
  const { click, visible } = app(datasets);

  click(4); // 藏 FW2 PS
  assert.equal(visible()[4], false);
  click(4); // 再点一次显示回来
  assert.deepEqual(visible(), datasets.map(() => true));
});

test('一根轴上的线全部隐藏时该轴收起，重新显示任一条后自动回来', () => {
  const datasets = realChartDatasets();
  const { click, axis, visible } = app(datasets);

  assert.equal(axis('y_pe'), true);
  click(1);
  click(3);
  assert.equal(axis('y_pe'), true, '还剩 FW3 PE 可见时不该收起');
  click(5);
  assert.equal(axis('y_pe'), false, 'PE 三条全部隐藏后轴应收起');
  assert.equal(axis('y_ps'), true);

  click(3);
  assert.equal(axis('y_pe'), true, '重新显示任一条 PE 后轴应回来');
  assert.equal(visible()[3], true);
});

test('股价不占纵轴，点击它同样只切换这一条', () => {
  const datasets = realChartDatasets();
  const { click, visible, axis } = app(datasets);

  click(0);
  assert.equal(visible()[0], false);
  assert.deepEqual(visible().slice(1), datasets.slice(1).map(() => true));
  assert.equal(axis('y_price'), false);
  assert.equal(axis('y_pe'), true);
  assert.equal(axis('y_ps'), true);
});
