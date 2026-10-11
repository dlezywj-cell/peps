const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// 十字光标停在图上时，纵轴上要显示当前数值（"PE 12.30" / "PS 1.23"）。
// 这段逻辑曾经只认标签名恰好是 PE（右轴） / PS（左轴） 的那一条线，
// 于是图例按条切换后，只留 FW2 / FW3 时轴还在、数值却读不出来。
function makeElement(tag) {
  return {
    tagName: tag, dataset: {}, style: {}, className: '', textContent: '', value: '',
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    querySelector: () => makeElement('input'),
    querySelectorAll: () => []
  };
}

function makeCtx(recorded) {
  return {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, textAlign: '', textBaseline: '',
    save() {}, restore() {},
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
    setLineDash() {}, roundRect() {},
    measureText: text => ({ width: String(text).length * 6 }),
    fillText(text) { recorded.push(String(text)); }
  };
}

// 只实现被测代码用到的部分：chartArea、scales、tooltip、可见性开关。
function makeChart(datasets, visibility) {
  return {
    width: 760,
    height: 320,
    chartArea: { left: 40, right: 700, top: 10, bottom: 300 },
    data: { labels: ['2026-06-15'], datasets },
    scales: {
      y_ps: { options: { display: true }, getValueForPixel: () => 1.23 },
      y_pe: { options: { display: true }, getValueForPixel: () => 12.3 }
    },
    tooltip: { _active: [{ element: { x: 300 }, index: 0 }] },
    $crosshair: { x: 300, y: 150 },
    isDatasetVisible: index => visibility[index]
  };
}

const valuationDatasets = () => ([
  { label: '股价', data: [30], yAxisID: 'y_price' },
  { label: 'PE（右轴）', data: [23.1], yAxisID: 'y_pe' },
  { label: 'PS（左轴）', data: [2], yAxisID: 'y_ps' },
  { label: 'FW2 PE', data: [15.8], yAxisID: 'y_pe' },
  { label: 'FW2 PS', data: [1.7], yAxisID: 'y_ps' },
  { label: 'FW3 PE', data: [13], yAxisID: 'y_pe' },
  { label: 'FW3 PS', data: [1.4], yAxisID: 'y_ps' }
]);

function loadContext() {
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
  return context;
}

// 返回这一组可见线下，十字光标实际画出来的轴数值标签。
function tagsFor(visibleLabels) {
  const context = loadContext();
  const datasets = valuationDatasets();
  const visibility = datasets.map(d => visibleLabels.includes(d.label));
  const chart = makeChart(datasets, visibility);
  const recorded = [];
  chart.ctx = makeCtx(recorded);
  context.__chart = chart;
  vm.runInContext('crosshairPlugin.afterDraw(__chart);', context);
  return recorded.filter(text => /^(PE|PS) /.test(text));
}

const AXES = ['y_pe', 'y_ps'];

test('轴上的线全部可见时，PE 与 PS 的数值都显示', () => {
  const tags = tagsFor(valuationDatasets().map(d => d.label));
  assert.deepEqual(tags, ['PS 1.23', 'PE 12.30']);
});

test('只留 FW2 或只留 FW3 时，轴数值照常显示', () => {
  for (const only of [['FW2'], ['FW3'], ['FW2', 'FW3']]) {
    const visible = ['股价', 'FW1（当年）', ...only.flatMap(tag => [`${tag} PE`, `${tag} PS`])];
    // 当年那两条线的标签是 PE（右轴） / PS（左轴），只在 FW1 场景里出现。
    const tags = tagsFor(visible.filter(label => label !== 'FW1（当年）'));
    assert.deepEqual(tags, ['PS 1.23', 'PE 12.30'],
      `只留 ${only.join(' + ')} 时应该照常显示轴数值，实际：${JSON.stringify(tags)}`);
  }
});

test('只有一根轴上还有线时，另一根的数值不显示', () => {
  const tags = tagsFor(['FW3 PE']);
  assert.deepEqual(tags, ['PE 12.30']);
});

test('轴被隐藏时不画数值标签', () => {
  const context = loadContext();
  const datasets = valuationDatasets();
  const chart = makeChart(datasets, datasets.map(() => true));
  chart.scales.y_ps.options.display = false;
  const recorded = [];
  chart.ctx = makeCtx(recorded);
  context.__chart = chart;
  vm.runInContext('crosshairPlugin.afterDraw(__chart);', context);
  assert.deepEqual(recorded.filter(text => /^PS /.test(text)), []);
});

test('hasVisibleDatasetOnAxis 只看轴上有没有可见的线，不看是哪一条', () => {
  const context = loadContext();
  const datasets = valuationDatasets();
  const visibility = datasets.map(d => d.label === 'FW3 PE');
  context.__chart = makeChart(datasets, visibility);
  // 只剩 FW3 一条时，y_pe 仍算"有可见数据"，y_ps 没有。
  assert.equal(vm.runInContext('hasVisibleDatasetOnAxis(__chart, "y_pe")', context), true);
  assert.equal(vm.runInContext('hasVisibleDatasetOnAxis(__chart, "y_ps")', context), false);
  assert.deepEqual(
    JSON.parse(vm.runInContext(`JSON.stringify(${JSON.stringify(AXES)}.map(id => hasVisibleDatasetOnAxis(__chart, id)))`, context)),
    [true, false]
  );
});
