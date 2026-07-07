// 共用輸出規範（shared/prompt.js）— withBaseRules 併接 + 每個 pack 都注入。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withBaseRules, BASE_OUTPUT_RULES } from '../src/packs/shared/prompt.js';
import { createGeneralPack } from '../src/packs/general/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';
import { createDevopsPack } from '../src/packs/devops/index.js';
import { createDataQueryPack } from '../src/packs/data-query/index.js';
import { createDeepResearchPack } from '../src/packs/deep-research/index.js';
import { createPatentPack } from '../src/packs/patent/index.js';
import { createDocgenPack } from '../src/packs/docgen/index.js';
import { createNotesPack } from '../src/packs/notes/index.js';
import { createUiuxPack } from '../src/packs/uiux/index.js';

test('withBaseRules：把共用規範以 bullet 併到 pack prompt 末尾（保留原文）', () => {
  const out = withBaseRules('你是某某 agent。\n- 做 A');
  assert.match(out, /你是某某 agent。/);
  assert.match(out, /- 做 A/);
  assert.ok(BASE_OUTPUT_RULES.length > 0);
  for (const r of BASE_OUTPUT_RULES) assert.ok(out.includes('- ' + r), `應含規則：${r}`);
  assert.match(out, /輸出避免使用 emoji/);
});

test('withBaseRules：容錯 null/空字串', () => {
  assert.equal(typeof withBaseRules(null), 'string');
  assert.match(withBaseRules(''), /輸出避免使用 emoji/);
});

test('所有 pack 的 systemPrompt 都注入了共用輸出規範', () => {
  const packs = {
    general: createGeneralPack, coding: createCodingPack, devops: createDevopsPack,
    'data-query': createDataQueryPack, 'deep-research': createDeepResearchPack, patent: createPatentPack,
    docgen: createDocgenPack, notes: createNotesPack, uiux: createUiuxPack,
  };
  for (const [name, mk] of Object.entries(packs)) {
    let p; try { p = mk({ cwd: '/tmp' }); } catch { p = mk(); }
    assert.equal(typeof p.systemPrompt, 'string', `${name} 應有字串 systemPrompt`);
    assert.match(p.systemPrompt, /輸出避免使用 emoji/, `${name} 應注入 emoji 規則`);
  }
});
