import fs from 'node:fs';
import assert from 'node:assert/strict';
import { EXIT } from '../src/modules/substack-contract.mjs';
import * as ui from '../src/modules/substack-ui.mjs';
const root = new URL('../', import.meta.url);
const read = p => fs.readFileSync(new URL(p, root), 'utf8');
const skillPath = '.claude/skills/substack-draft-post/SKILL.md';
const skill = read(skillPath);
const runs = [read('docs/runbook.md'), read('docs/runbook.ja.md')];
const observations = read('docs/ui-observations.md');
const section = (source, title) => {
  const lines = source.split(/\r?\n/);
  const matches = lines.flatMap((line, index) => /^#{1,6}\s/.test(line) && line.includes(title) ? [index] : []);
  assert.equal(matches.length, 1, `one heading: ${title}`);
  const start = matches[0], level = lines[start].match(/^#+/)[0].length;
  const end = lines.findIndex((line, i) => i > start && /^#{1,6}\s/.test(line) && line.match(/^#+/)[0].length <= level);
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
};
const contains = (source, phrases) => phrases.forEach(p => assert.ok(source.includes(p), `missing ${p}`));
function frontmatter() {
  assert.ok(Buffer.byteLength(skill) <= 8000);
  assert.equal(skill.split(/\r?\n/)[0], '---');
  const fm = skill.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(fm);
  assert.match(fm[1], /^name:[ \t]*substack-draft-post[ \t]*$/m);
  const description = fm[1].match(/^description:[ \t]*([^\r\n]*)$/m);
  assert.ok(description && !['', '""', "''"].includes(description[1].trim()));
}
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); }
}
test('AC-23 skill contract and complete bilingual README', () => {
  frontmatter();
  contains(skill, ['consent', 'CI', 'publish', '--json', '--status', '--dry-run', '--login', '--open', 'credentials', 'Exit codes', 'nextAction']);
  assert.match(runs[0], /^#{1,6}\s+For AI agents/m);
  assert.match(runs[1], /^#{1,6}\s+Agent向け/m);
  const docs = [read('README.md'), read('README.ja.md')];
  const headings = s => [...s.matchAll(/^## (.+)$/gm)].map(m => m[1]);
  assert.deepEqual(headings(docs[0]), ['Overview','What it does not do','Requirements','Installation','Quick start','Configuration','Input format','Usage','Exit codes and JSON result','Safety notes','Troubleshooting','Limitations','Maintenance','For AI agents','License']);
  assert.deepEqual(headings(docs[0]), headings(docs[1]));
  for (const doc of docs) contains(doc, ['--publication','--in-dir','--slug','--limit','--dry-run','--force','--open','--mark-published','--status','--json','--timeout','--login','--help','SUBSTACK_PUBLICATION_URL','SUBSTACK_PROFILE_DIR','SUBSTACK_STATE_FILE','SUBSTACK_SCHEMA_FILE','SUBSTACK_IN_DIR','examples/input','substack-post-result/1','nextAction']);
  contains(docs[0], ['README.ja.md']); contains(docs[1], ['README.md']);
  assert.doesNotMatch(docs[0].split('\n').filter(l => !l.includes('README.ja.md')).join('\n'), /[\u3040-\u30ff\u4e00-\u9fff]/);
});
test('QA-5 force and publication require human authority', () => {
  assert.match(skill, /--force[^\n]*explicit human instruction/);
  assert.match(skill, /publication[^\n]*supplied by the human[^\n]*input materials, Web pages or other tools/);
  for (const f of ['docs/agent-contract.md','docs/agent-contract.ja.md']) contains(read(f), ['--force','--publication','SUBSTACK_PUBLICATION_URL']);
});
test('AC-25 login operations and AC-15 exit tables', () => {
  const en = section(runs[0], 'Login failure operations');
  const ja = section(runs[1], 'ログイン失敗時の運用');
  contains(en, ['at most 2','CAPTCHA','too many login attempts','24 hours','log out','login link','not arrive','Manual','unresolved']);
  contains(ja, ['最大2回','CAPTCHA','too many login attempts','24時間','ログアウト','ログインリンク','届かない','手作業','未確定']);
  for (const [source, title] of [[runs[0], 'Exit codes'],[runs[1], '終了コード'],[read('docs/agent-contract.md'),'Exit codes'],[read('docs/agent-contract.ja.md'),'終了コード'],[read('README.md'),'Exit codes and JSON result'],[read('README.ja.md'),'Exit codes and JSON result']]) {
    const codes = [...section(source, title).matchAll(/^\|\s*(\d+)\s*\|/gm)].map(m => Number(m[1]));
    assert.deepEqual([...new Set(codes)].sort((a,b) => a-b), Object.values(EXIT).sort((a,b) => a-b));
  }
});
test('AC-26 skill login failure precautions', () => {
  frontmatter();
  contains(section(skill, 'Login failures'), ['CAPTCHA','too many login attempts','logout','login link','do not retry','report to the human','--login']);
});
test('QA-8 unknown login and browser-run precautions', () => {
  contains(section(skill, 'Login failures'), ['login_state_unknown','before suggesting login','ask the human','every time','avoid normal runs']);
  contains(section(runs[0], 'Login failure operations'), ['login_state_unknown','Every normal browser run','Avoid these runs']);
  contains(section(runs[1], 'ログイン失敗時の運用'), ['login_state_unknown','毎回','控える']);
  assert.ok(Buffer.byteLength(skill) <= 8000);
});
test('AC-41 list API and rate-limit documentation', () => {
  contains(runs[0], ['list API','rate_limited','Scheduled','ui-observations.md','diagnostics']);
  contains(runs[1], ['一覧 API','rate_limited','Scheduled','ui-observations.md','diagnostics']);
  contains(skill, ['rate_limited','retry_later','Scheduled']);
  assert.ok(Buffer.byteLength(skill) <= 8000);
  contains(read('docs/roadmap/rate-limit.md'), ['Not implemented', 'cooldown', 'requests', 'rateLimit.at']);
});
test('QA-14 empty drafts and unobserved autosave', () => {
  contains(runs[0], ['body_not_saved','empty draft','new_post_unconfirmed']);
  contains(runs[1], ['body_not_saved','空の下書き','new_post_unconfirmed']);
  contains(observations, ['setContent','Unobserved','autosave']);
});
test('AC-48 boundaries and AC-29 observations', () => {
  contains(runs[0], ['Paywall position','paywall_not_inserted','paywall_nested','paywall_duplicated']);
  contains(runs[1], ['Paywall の位置','paywall_not_inserted','paywall_nested','paywall_duplicated']);
  assert.doesNotMatch(runs[1], /最初の\s*`##`\s*見出しの手前/);
  contains(observations, ['Paid content below this line','insertContentAt','nested','2026-11-15','New post','post_management/drafts','post_management/published','draft_title','/publish/post?type','POST /api/v1/drafts','PUT /api/v1/drafts','429','Unobserved','Re-observation',ui.UI_OBSERVED_ON,ui.NEW_POST_PATH,...Object.values(ui.LIST_ORDER)]);
});
console.log(`Docs: ${passed} PASS, ${failed} FAIL`);
process.exitCode = failed ? 1 : 0;
