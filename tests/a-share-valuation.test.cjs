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
    vm.runInContext(`currentStock = {code:'601899',secId:'1.601899',name:'紫金矿业'};`, context);
    return { context, run: code => vm.runInContext(code, context) };
}

test('Zijin 2016 low-base qfq regression: use actual closes and effective shares', () => {
    const { run } = app();
    assert.equal(run(`normalizeAdjustedKline([
        {date:'2016-01-27',price:0.29},{date:'2016-01-28',price:0.13}
    ], 'old qfq').length`), 0);
    run(`currentHistoricalShares = [{date:'2015-01-01',shares:100000000}];
        useAShareRawKline([{date:'2016-01-27',price:2.87},{date:'2016-01-28',price:2.71}], 'raw');
        calculate({2016:{year:2016,rev:100000000,prof:10000000,source:'real'}});`);
    assert.equal(run('globalData.length'), 2);
    assert.equal(run('globalData[1].pe'), 27.1);
    assert.equal(run('globalData[1].ps'), 2.71);
});

test('actual 2:1 split pairs halved price with doubled shares on effective date', () => {
    const { run } = app();
    run(`currentHistoricalShares = normalizeHistoricalShareRecords([
        {date:'2020-01-01',shares:100},{date:'2020-06-01',shares:200}
    ], 'raw shares', false);
    useAShareRawKline([{date:'2020-05-29',price:20},{date:'2020-06-01',price:10}], 'raw');
    calculate({2020:{year:2020,rev:1000,prof:100,shares:200,source:'real'}});`);
    assert.equal(run('globalData[0].shares'), 100);
    assert.equal(run('globalData[1].shares'), 200);
    assert.equal(run('globalData[0].pe'), 20);
    assert.equal(run('globalData[1].pe'), 20);
    assert.equal(run('globalData[0].ps'), 2);
    assert.equal(run('globalData[1].ps'), 2);
});

test('missing effective shares leave estimates empty rather than use future/current shares', () => {
    const { run } = app();
    run(`currentTotalShares = 999;
        currentHistoricalShares = [{date:'2020-06-01',shares:200}];
        useAShareRawKline([{date:'2020-05-29',price:20}], 'raw');
        calculate({2020:{year:2020,rev:1000,prof:100,shares:200,source:'real'}});`);
    assert.equal(run('globalData[0].pe'), null);
    assert.equal(run('globalData[0].ps'), null);
    assert.equal(run('globalData[0].mktCap'), null);
});

test('existing adjusted-market split rejection and repair still operate', () => {
    const { run } = app();
    run(`var splitRows = [{date:'2020-05-29',price:20},{date:'2020-06-01',price:10}];`);
    assert.equal(run(`normalizeAdjustedKline(splitRows,'adjusted').length`), 0);
    assert.equal(run(`normalizeAdjustedKline(repairRawSplitKline(splitRows,'HK'),'HK').length`), 2);
});

test('A-share Tencent pagination explicitly requests raw day and covers prior pages', async () => {
    const { run, context } = app();
    const calls = [];
    context.fetchTencentKlinePage = async (symbol, end, timeout, adjustment) => {
        calls.push({symbol, end, adjustment});
        return {code:0,data:{sh601899:{day: calls.length === 1
            ? [['2016-01-28','2.86','2.71']]
            : [['2016-01-27','2.96','2.87']]}}};
    };
    assert.equal(await run(`fetchTencentAdjustedKline('20160127','20160128','1.601899','601899')`), true);
    assert.deepEqual(calls.map(c => c.adjustment), ['', '']);
    assert.equal(calls[1].end, '2016-01-27');
    assert.equal(run('globalData[0].price'), 2.87);
});

test('failed second page cannot pass as a complete history', async () => {
    const { run, context } = app();
    let count = 0;
    context.fetchTencentKlinePage = async () => ++count === 1
        ? {code:0,data:{sh601899:{day:[['2016-01-28','2.86','2.71']]}}} : null;
    assert.equal(await run(`fetchTencentAdjustedKline('20160101','20160128','1.601899','601899')`), false);
    assert.equal(run('globalData.length'), 0);
});

test('A-share fallback requests fqt=0 and never substitutes Yahoo split-adjusted close', async () => {
    const { run, context } = app();
    const urls = [];
    context.fetchTencentAdjustedKline = async () => false;
    context.fetchYahooAdjustedKline = async () => { throw new Error('Wrong price basis'); };
    context.apiFetch = async url => {
        urls.push(url);
        return {data:{klines:['2016-01-28,2.86,2.71,2.88,2.70,751807']}};
    };
    await run(`fetchKline('20160101','20160128')`);
    assert.equal(urls.length, 2);
    assert.ok(urls.every(url => new URL(url).searchParams.get('fqt') === '0'));
    assert.equal(run('globalData[0].price'), 2.71);
    context.apiFetch = async () => null;
    await assert.rejects(run(`fetchKline('20160101','20160128')`), /未复权历史股价/);
});

test('A-share report primary sorts by REPORTDATE and extracts annual rows', async () => {
    const { run, context } = app();
    context.apiFetch = async url => {
        assert.equal(new URL(url).searchParams.get('sortColumns'), 'REPORTDATE');
        return {result:{data:[{REPORTDATE:'2016-12-31',TOTAL_OPERATE_INCOME:100,PARENT_NETPROFIT:10,BASIC_EPS:1}]}};
    };
    const reports = await run('fetchHistoricalFinancials(currentStock)');
    assert.equal(reports[2016].rev, 100);
    assert.equal(reports[2016].prof, 10);
});
