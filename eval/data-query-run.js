// data-query agent EvalSuite —— 用共用 framework。每題 prepare() 建一個真實 SQLite db，
// agent 用 list_tables/describe_table/sql_query 查出答案，answerMatch 判定。
// node eval/data-query-run.js
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { loadModel } from '../src/app/providers.js';
import { createDataQueryPack } from '../src/packs/data-query/index.js';
import { runSuite, answerMatch } from './framework.js';

// 在 dir/data.db 建一個小商店資料庫
const seed = (dir) => {
  const sql = `
    CREATE TABLE users(id INTEGER, name TEXT, city TEXT);
    INSERT INTO users VALUES (1,'Amy','Taipei'),(2,'Bob','Tokyo'),(3,'Cara','Taipei'),(4,'Dan','Osaka');
    CREATE TABLE orders(id INTEGER, user_id INTEGER, amount INTEGER);
    INSERT INTO orders VALUES (1,1,100),(2,1,50),(3,2,200),(4,3,30),(5,3,30),(6,4,500);
  `;
  spawnSync('sqlite3', [join(dir, 'data.db'), sql], { encoding: 'utf8' });
};

const tasks = [
  { id: 'count', goal: '資料庫有幾位使用者？只回答數字。', prepare: seed, score: answerMatch('4') },
  { id: 'group', goal: '哪個城市的使用者最多？只回答城市名。', prepare: seed, score: answerMatch('Taipei') },
  { id: 'join-sum', goal: '哪位使用者的訂單總金額最高？只回答名字。', prepare: seed, score: answerMatch('Dan') },
  { id: 'agg', goal: '所有訂單的總金額是多少？只回答數字。', prepare: seed, score: answerMatch('910') },
];

const { model, getApiKey } = loadModel();
await runSuite({ name: 'xitto-kernel · data-query agent（真實 SQLite）', pack: (dir) => createDataQueryPack({ cwd: dir }), tasks, model, getApiKey, sandbox: false });
process.exit(0);
