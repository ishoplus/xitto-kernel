// 自足迷你 benchmark（SWE-bench 風格）：每題一個 bug/feature + 隱藏測試（agent 看不到）。
// 純 node --test、零外部依賴，故任何機器可跑、不需 Docker。
const T = (id, setup, problem, verify) => ({ id, setup, problem, verify });

export const TASKS = [
  T('sum-bug',
    {
      'sum.js': 'export function sum(a, b) {\n  return a - b;\n}\n',
      'sum.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { sum } from './sum.js';\ntest('sum', () => { assert.equal(sum(2, 3), 5); assert.equal(sum(10, 5), 15); });\n",
    },
    'sum.js 的 sum(a, b) 應該回傳兩數之和，但目前回傳相減，導致結果錯誤。請修正 sum.js。',
    'node --test sum.test.js'),

  T('pi-constant',
    {
      'calc.js': 'export const PI = 3;\nexport function area(r) { return PI * r * r; }\n',
      'calc.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { area } from './calc.js';\ntest('area', () => { assert.ok(Math.abs(area(2) - 12.566) < 0.01, 'area(2) should be ~12.566'); });\n",
    },
    'calc.js 把圓周率 PI 寫成 3，使 area() 不準確。請改用正確的圓周率，讓 area(2) 約等於 12.566。',
    'node --test calc.test.js'),

  T('reverse-feature',
    {
      'str.js': 'export function reverse(s) {\n  return s; // TODO: implement\n}\n',
      'str.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { reverse } from './str.js';\ntest('reverse', () => { assert.equal(reverse('abc'), 'cba'); assert.equal(reverse(''), ''); });\n",
    },
    'str.js 的 reverse(s) 應該回傳反轉後的字串，但目前原樣回傳。請實作字串反轉。',
    'node --test str.test.js'),

  T('multi-file-import',
    {
      'src/math.js': 'export function double(x) { return x + x; }\n',
      'src/index.js': "import { double } from './math.js';\nexport function quad(x) { return double(x); }\n",
      'index.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { quad } from './src/index.js';\ntest('quad', () => { assert.equal(quad(3), 12); });\n",
    },
    'quad(x) 應該回傳 x 的四倍，但目前只有兩倍（quad(3) 得到 6，應為 12）。請修正讓 quad 正確回傳四倍（可改 src/index.js 或 src/math.js）。',
    'node --test index.test.js'),
];
