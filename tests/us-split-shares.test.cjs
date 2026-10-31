const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function app() {
    const elements = new Map();
    const context = vm.createContext({
        console: { log() {}, error() {} }, setTimeout, clearTimeout,
        localStorage: { getItem: () => null },
        document: { getElementById(id) {
            if (!elements.has(id)) elements.set(id, {
                value: '', style: {}, classList: { add() {}, remove() {} }, addEventListener() {}
            });
            return elements.get(id);
        } },
        window: { addEventListener() {} }
    });
    const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
    vm.runInContext(html.split('<script>')[1].split('</script>')[0], context);
    vm.runInContext(`currentStock = {code:'CRWD',secId:'105.CRWD',name:'CrowdStrike'};`, context);
    return { context, run: code => vm.runInContext(code, context) };
}

// CRWD 2026-07-02 做了 4:1 拆股：原始价 772.74 → 193.98。
// 东财年报股数仍是拆股前口径（FY2026 = 250,576,000），当前总股本已是拆股后（1,026,129,839）。
const CRWD_SPLIT = `[{date:'2026-07-02',ratio:4,source:'Yahoo 拆股事件'}]`;
const CRWD_RAW_SHARES = `[
    {date:'2024-01-31',shares:238637000},
    {date:'2025-01-31',shares:244750000},
    {date:'2026-01-31',shares:250576000}
]`;

function approx(actual, expected, tolerance = 1e-6) {
    assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * tolerance,
        `期望 ${expected}，实际 ${actual}`);
}

test('拆股前的年报股数换算到最新口径，倍数与价格回溯一致', () => {
    const { run } = app();
    const records = run(`
        currentSplitEvents = ${CRWD_SPLIT};
        normalizeHistoricalShareRecords(${CRWD_RAW_SHARES}, '东财美股年报', true, currentSplitEvents)
    `);
    assert.equal(records.length, 3);
    // 三条记录都在拆股日前，全部 ×4。
    approx(records[0].shares, 238637000 * 4);
    approx(records[1].shares, 244750000 * 4);
    approx(records[2].shares, 250576000 * 4);
});

test('拆股后披露的股本不再重复放大', () => {
    const { run } = app();
    const records = run(`
        currentSplitEvents = ${CRWD_SPLIT};
        normalizeHistoricalShareRecords([
            {date:'2026-01-31',shares:250576000},
            {date:'2027-01-31',shares:1015000000}
        ], '测试', true, currentSplitEvents)
    `);
    approx(records[0].shares, 250576000 * 4);
    approx(records[1].shares, 1015000000);
});

test('CRWD 4:1 拆股后市值不再出现 4 倍跳变', () => {
    const { run } = app();
    run(`
        currentSplitEvents = ${CRWD_SPLIT};
        currentTotalShares = 1026129839;
        currentHistoricalShares = normalizeHistoricalShareRecords(${CRWD_RAW_SHARES}, '东财美股年报', true, currentSplitEvents);
        globalData = repairRawSplitKline([
            {date:'2025-12-30',price:475.63},
            {date:'2025-12-31',price:468.76},
            {date:'2026-01-02',price:453.58},
            {date:'2026-06-30',price:770.00},
            {date:'2026-07-02',price:193.98},
            {date:'2026-10-30',price:250.43}
        ], 'Sina US raw', currentSplitEvents);
        calculate({
            2025:{year:2025,rev:4e9,prof:5e8,source:'real'},
            2026:{year:2026,rev:5e9,prof:7e8,source:'real'}
        });
    `);
    const rows = run('globalData');
    const cap = date => rows.find(r => r.date === date).mktCap / 1e8;

    // 拆股日前后：价格 770→193.98（÷4），股本不变，市值只能跟真实涨跌走。
    assert.ok(cap('2026-07-02') / cap('2026-06-30') < 1.05);
    // 跨年（2026-01-01）不得凭空跳级。
    assert.ok(cap('2026-01-02') / cap('2025-12-31') < 1.05);
    // 拆股前的市值按拆股后口径换算：468.76/4 × (244,750,000×4) = 1147 亿。
    approx(cap('2025-12-31'), 1147.4, 0.01);
    // 最新交易日用当前总股本，与行情软件口径一致。
    approx(cap('2026-10-30'), 250.43 * 1026129839 / 1e8, 0.01);
});

test('IPO 造成的股数倍增不会被误判为拆股', () => {
    const { run } = app();
    const records = run(`
        currentSplitEvents = [];
        normalizeHistoricalShareRecords([
            {date:'2018-01-31',shares:41876000},
            {date:'2019-01-31',shares:44863000},
            {date:'2020-01-31',shares:148062000}
        ], '东财美股年报', true, [])
    `);
    // 2019 年上市带来的 3.3 倍增长是真实增发，不是 3:1 拆股，股本必须原样保留。
    assert.equal(records[0].shares, 41876000);
    assert.equal(records[1].shares, 44863000);
    assert.equal(records[2].shares, 148062000);
});

test('只查询拆股前区间时，股价与股本仍按同一口径换算', () => {
    const { run } = app();
    const rows = run(`
        currentSplitEvents = ${CRWD_SPLIT};
        currentTotalShares = 1026129839;
        currentHistoricalShares = normalizeHistoricalShareRecords(${CRWD_RAW_SHARES}, '东财美股年报', true, currentSplitEvents);
        globalData = repairRawSplitKline([
            {date:'2025-06-02',price:480.00},
            {date:'2025-06-03',price:485.00}
        ], 'Sina US raw', currentSplitEvents);
        calculate({2025:{year:2025,rev:4e9,prof:5e8,source:'real'}});
        globalData[0]
    `);
    approx(rows.price, 120);
    approx(rows.shares, 244750000 * 4);
    approx(rows.mktCap / 1e8, 1174.8, 0.01);
});

test('当前总股本在拆股后才披露的年份不会被误当作历史股本', () => {
    const { run } = app();
    const value = run(`
        currentSplitEvents = ${CRWD_SPLIT};
        currentTotalShares = 1026129839;
        currentHistoricalShares = normalizeHistoricalShareRecords(${CRWD_RAW_SHARES}, '东财美股年报', true, currentSplitEvents);
        resolveHistoricalSharesForDate(currentHistoricalShares, '2026-06-30')
    `);
    // 6 月 30 日已过 FY2026 报告期，取当前总股本（含此后回购/增发）。
    approx(value, 1026129839);
});

test('股本记录缺失时回落到财报反推股本，而不是 1 亿股占位值', () => {
    const { run } = app();
    const value = run(`
        currentSplitEvents = [];
        currentTotalShares = 0;
        currentHistoricalShares = [];
        resolveHistoricalSharesForDate([], '2026-06-30')
    `);
    assert.equal(value, null);
});

test('数据商混用口径时按已知拆股倍数归一（NVDA 式：2020 年起 4:1、2023 年起 40 倍）', () => {
    const { run } = app();
    const timeline = run(`
        currentSplitEvents = [{date:'2021-07-20',ratio:4,source:'Yahoo 拆股事件'},{date:'2024-06-10',ratio:10,source:'Yahoo 拆股事件'}];
        currentTotalShares = 0;
        buildHistoricalShareTimeline([
            {date:'2019-01-27',shares:608e6},
            {date:'2020-01-26',shares:2439e6},
            {date:'2023-01-29',shares:24870e6},
            {date:'2026-01-25',shares:24359e6}
        ], '东财美股年报', [
            {date:'2026-01-31',shares:24304e6,source:'Yahoo 季度普通股股数'}
        ], currentSplitEvents)
    `);
    const byDate = Object.fromEntries(timeline.map(r => [r.date, r.shares]));
    // 2020 年的 2439M 只回溯了 4:1，2023 年的 24870M 已回溯 40 倍 → 全部拉到最新口径后连续。
    approx(byDate['2019-01-27'], 608e6 * 40, 1e-3);
    approx(byDate['2020-01-26'], 2439e6 * 10, 1e-3);
    approx(byDate['2023-01-29'], 24870e6, 1e-3);
    approx(byDate['2026-01-25'], 24359e6, 1e-3);
    approx(byDate['2026-01-31'], 24304e6, 1e-3);
});

test('Yahoo 报告期股数作为最新口径锚点，同日覆盖东财加权平均', () => {
    const { run } = app();
    const timeline = run(`
        currentSplitEvents = [{date:'2026-07-02',ratio:4,source:'Yahoo 拆股事件'}];
        currentTotalShares = 0;
        buildHistoricalShareTimeline([
            {date:'2025-10-31',shares:252e6},
            {date:'2026-01-31',shares:250.576e6}
        ], '东财美股年报', [
            {date:'2026-01-31',shares:1013.452e6,source:'Yahoo 季度普通股股数'}
        ], currentSplitEvents)
    `);
    const byDate = Object.fromEntries(timeline.map(r => [r.date, r.shares]));
    approx(byDate['2026-01-31'], 1013.452e6, 1e-3);
    assert.equal(timeline.length, 2);
});

test('末端与当前总股本差出整数倍时整体校正，避免历史市值系统性偏差', () => {
    const { run } = app();
    const last = run(`
        currentSplitEvents = [{date:'2026-07-02',ratio:4,source:'Yahoo 拆股事件'}];
        currentTotalShares = 1026129839;
        var t = buildHistoricalShareTimeline([
            {date:'${new Date().toISOString().slice(0, 10)}',shares:250576000}
        ], '东财美股年报', [], currentSplitEvents);
        t[t.length - 1].shares
    `);
    approx(last, 250576000 * 4, 1e-3);
});
