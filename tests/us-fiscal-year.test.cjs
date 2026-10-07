const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('MRVL February annual reports use the fiscal year supplied by Eastmoney', () => {
    const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
    const context = vm.createContext({
        console: { log() {}, error() {} },
        document: { getElementById() { return {
            value: '', style: {}, classList: { add() {}, remove() {} }, addEventListener() {}
        }; } },
        window: { addEventListener() {} },
        localStorage: { getItem() { return null; } }
    });
    vm.runInContext(html.split('<script>')[1].split('</script>')[0], context);
    const year = (date, label) => vm.runInContext(
        `getAnnualReportTargetYear(${JSON.stringify(date)}, ${JSON.stringify(label)})`, context);
    assert.equal(year('2025-02-01', '2024/FY'), 2024);
    assert.equal(year('2020-02-01', '2019/FY'), 2019);
    assert.equal(year('2026-01-31', '2025/FY'), 2025);
    assert.equal(year('2024-02-03', null), 2023);
});
