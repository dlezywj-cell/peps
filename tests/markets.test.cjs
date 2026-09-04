const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function app() {
    const nodes = new Map();
    const storage = new Map();
    const node = () => ({ value: '', style: {}, dataset: {}, classList: { add() {}, remove() {} },
        addEventListener() {}, append() {}, appendChild() {}, replaceChildren() {} });
    const context = vm.createContext({ console: { log() {}, error() {} }, URL, AbortController,
        setTimeout: () => 0, clearTimeout() {},
        localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
        document: { getElementById: id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
            querySelectorAll: () => [], querySelector: () => node(), createElement: node },
        navigator: {}, addEventListener() {} });
    context.window = context;
    const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
    vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
    return { run: code => vm.runInContext(code, context), context, nodes };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('suffixes and exchange-qualified keys avoid Japanese/Taiwanese/Korean/A-share collisions', () => {
    const { run } = app();
    assert.deepEqual(plain(run(`internationalSymbols('7203', 'JP')`)), ['7203.T']);
    assert.deepEqual(plain(run(`internationalSymbols('130A', 'JP')`)), ['130A.T']);
    assert.deepEqual(plain(run(`internationalSymbols('5930', 'KR')`)), ['005930.KS', '005930.KQ']);
    assert.deepEqual(plain(run(`internationalSymbols('2330', 'TW')`)), ['2330.TW', '2330.TWO']);
    assert.deepEqual(plain(run(`internationalSymbols('005930', 'auto')`)), []);
    assert.equal(run(`getInternationalMarket('6488.two')`), 'TW');
    assert.equal(run(`getInternationalMarket('AAPL')`), null);
    assert.throws(() => run(`internationalSymbols('2330.TW', 'JP')`), /不一致/);
});

test('only complete annual financial values are retained, including zero income', () => {
    const { run, context } = app();
    context.fixture = { timeseries: { result: [{ meta: { type: ['annualNetIncome'] }, annualNetIncome: [
        { asOfDate: '2024-12-31', periodType: '12M', currencyCode: 'KRW', reportedValue: { raw: 0 } },
        { asOfDate: '2023-12-31', periodType: '12M', currencyCode: 'KRW', reportedValue: { raw: null } },
        { asOfDate: '2024-09-30', periodType: '3M', currencyCode: 'KRW', reportedValue: { raw: 7 } }
    ] }] } };
    assert.deepEqual(plain(run('parseInternationalSeries(fixture)')), [
        { date: '2024-12-31', annualNetIncome: { value: 0, currency: 'KRW' } }
    ]);
});

test('Yahoo restated share counts are not multiplied by splits twice', () => {
    const { run } = app();
    const shares = run(`internationalShareRecords([
        { date: '2023-03-31', annualOrdinarySharesNumber: { value: 6172487800 } }
    ], { events: { splits: { sony: { date: 1727395200, numerator: 5, denominator: 1 } } }, meta: {} })`);
    assert.equal(shares[0].shares, 6172487800);
});

test('missing FX and incompatible financial currencies never produce an automatic valuation', async () => {
    const { run } = app();
    run(`getInternationalBundle = async () => ({ records: [
        {date:'2025-12-31',annualTotalRevenue:{value:100,currency:'USD'},annualNetIncome:{value:10,currency:'USD'}},
        {date:'2024-12-31',annualTotalRevenue:{value:100,currency:'TWD'},annualNetIncome:{value:10,currency:'USD'}},
        {date:'2023-12-31',annualTotalRevenue:{value:100,currency:'TWD'},annualNetIncome:{value:0,currency:'TWD'}}
    ] }); fetchFxRate = async () => null;`);
    const result = await run(`fetchInternationalFinancials({code:'2330.TW'})`);
    assert.equal(result.__rawAnnualReports.length, 1);
    assert.equal(result.__rawAnnualReports[0].prof, 0);
    assert.equal(result.__rawAnnualReports[0].currency, 'TWD');
});

test('long history requests explicitly ask for daily bars, and use local exchange dates', async () => {
    const { run, context } = app();
    run(`fetchInternationalJSON = async (path, validate) => {
        window.requestPath = path;
        const data = {chart:{result:[{meta:{symbol:'7203.T',instrumentType:'EQUITY',dataGranularity:'1d'},timestamp:[1]}],error:null}};
        if (!validate(data)) throw new Error('invalid fixture'); return data;
    }`);
    await run(`fetchInternationalChart('7203.T')`);
    assert.match(context.requestPath, /period1=0/);
    assert.doesNotMatch(context.requestPath, /range=max/);
    run(`currentStock = {code:'7203.T'}; getInternationalBundle = async () => ({chart:{
        meta:{gmtoffset:32400},timestamp:[Date.parse('2025-01-05T23:00:00Z')/1000],indicators:{quote:[{close:[100]}]}
    }});`);
    await run(`fetchKline('20250106', '20250106')`);
    assert.equal(run('globalData[0].date'), '2025-01-06');
});

test('new-market missing shares are blocked instead of using the old 100-million-share fallback', async () => {
    const { run, nodes } = app();
    run(`currentStock={code:'2330.TW',secId:'YF.2330.TW'};
        fetchShares=async()=>{}; fetchKline=async()=>{globalData=[{date:'2025-01-02',price:100}]};
        fetchHistoricalFinancials=async()=>({2025:{year:2025,rev:1e9,prof:1e8,source:'real'}});
        fetchDirectHistoricalShares=async()=>[];`);
    run(`document.getElementById('startDate').value = '2025-01-01'`);
    nodes.get('endDate').value = '2025-12-31';
    await run('runAnalysis(false)');
    assert.equal(run('currentTotalShares'), 0);
    assert.match(run(`Logger.logs.join(' | ')`), /缺少有效股本/);
    assert.equal(run('analysisInProgress'), false);
});

test('A/HK/US PE/PS and forward calculations retain the same behavior', () => {
    for (const stock of [{code:'600519',secId:'1.600519'}, {code:'00700',secId:'116.00700'}, {code:'AAPL',secId:'105.AAPL'}, {code:'2330.TW',secId:'YF.2330.TW'}]) {
        const { run, context } = app();
        context.stock = stock;
        run(`currentStock=stock;currentTotalShares=1e9;globalData=[{date:'2024-06-03',price:100}];
            calculate({2024:{year:2024,rev:2e10,prof:5e9,shares:8e8,source:'real'},2025:{year:2025,rev:4e10,prof:8e9,source:'real'}})`);
        assert.equal(run('globalData[0].pe'), 16);
        assert.equal(run('globalData[0].ps'), 4);
        assert.equal(run('globalData[0].fw2pe'), 10);
        assert.equal(run('globalData[0].fw2ps'), 2);
    }
});

test('manual/forecast histories and cloud merge isolate international symbols from existing keys', () => {
    const { run } = app();
    run(`saveToDB('005930',2025,100,10,false);saveToDB('005930.KS',2025,200,20,false);
        saveForecastToDB('2330.TW',2026,300,30,false);saveForecastToDB('2330.T',2026,400,40,false);`);
    assert.equal(run(`getFromDB('005930',2025).rev`), 100);
    assert.equal(run(`getFromDB('005930.KS',2025).rev`), 200);
    assert.equal(run(`getForecastLocal('2330.TW')[2026].rev`), 300);
    assert.equal(run(`getForecastLocal('2330.T')[2026].rev`), 400);
    const merged = run(`mergeDatabases(getLocalDB(), {'005930.KS': {__shares:{shares:1e9,ts:1}}})`);
    assert.equal(merged['005930.KS'].__shares.shares, 1e9);
    assert.equal(merged['005930']['2025'].rev, 100);
});
