import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const at = p => path.join(root, p);
const read = p => fs.readFileSync(at(p), 'utf8');
let failures = 0, passes = 0;
async function test(name, fn) {
  try { await fn(); passes++; console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}: ${e.message}`); }
}
const oldName = ['proto', 'col-j'].join('');
const owner = ['nai', 'masa'].join('');
const email = ['156673+', owner, '@users.', 'noreply.github.com'].join('');
const forbidden = [oldName, ['proto','colj'].join(''), ['proto','col_j'].join(''), ['Proto','col J'].join(''), ['Masa','ki'].join(''), ['Nai','to'].join(''), ['content','blog'].join('/'), ['','Users',''].join('/')];
const flags = ['publication','in-dir','slug','limit','dry-run','force','open','mark-published','status','json','timeout','login','help'].map(s => `--${s}`);
const variables = ['PUBLICATION_URL','PROFILE_DIR','STATE_FILE','SCHEMA_FILE','IN_DIR'].map(s => `SUBSTACK_${s}`);
const japanese = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
function files(dir = root) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => ['node_modules','.git','.substack-poster','check-public.local.json'].includes(e.name) ? [] : e.isDirectory() ? files(path.join(dir,e.name)) : [path.join(dir,e.name)]);
}
async function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poster-test-'));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function dependencies(dir) {
  const output = []; let launches = 0;
  return { output, get launches() { return launches; }, deps: { cwd: dir, repoRoot: root, env: {}, isTTY: true, now: () => 1, out: s => output.push(s), err: () => {}, lockPath: path.join(dir,'lock'), launchBrowser: async () => { launches++; throw new Error('Unexpected browser'); }, request: { get() { throw new Error('Unexpected network'); } } } };
}
await test('AC-68 structure and package contract', async () => {
  for (const p of ['package.json','README.md','README.ja.md','CLAUDE.md','.gitignore','LICENSE','src/cli.mjs','src/probe.mjs','src/modules/','src/diagnostics/','test/','docs/','examples/','.claude/skills/substack-draft-post/SKILL.md']) assert.ok(fs.statSync(at(p)));
  const p = JSON.parse(read('package.json'));
  assert.equal(p.name,'substack-draft-poster'); assert.equal(p.type,'module'); assert.ok(p.bin); assert.ok(p.engines.node);
  assert.match(p.engines.node, /20/);
  for (const key of ['test','check','check:public']) assert.equal(typeof p.scripts[key],'string');
  assert.equal(p.license,'MIT'); assert.deepEqual(Object.keys(p.dependencies),['playwright']);
  for (const key of ['repository','bugs','homepage']) { const v = JSON.stringify(p[key]); assert.ok(v.includes('github.com/')); assert.ok(v.includes(p.name)); }
  assert.match(read('LICENSE'), /MIT License/); assert.match(read('LICENSE'), /Permission is hereby granted/); assert.match(read('LICENSE'), /2026/);
});
await test('AC-69 portable tree contains no private coupling', async () => {
  assert.ok(fs.existsSync(at('src/cli.mjs')));
  for (const absolute of files()) {
    const p = path.relative(root,absolute).split(path.sep).join('/'), content = fs.readFileSync(absolute,'utf8');
    if (!['scripts/check-public.config.json'].includes(p)) {
      for (const line of content.split('\n')) for (const word of forbidden) {
        assert.ok(!line.toLowerCase().includes(word.toLowerCase()), `${p}: forbidden coupling`);
      }
    }
    if (!['LICENSE','package.json','README.md','README.ja.md'].includes(p)) assert.ok(!content.includes(owner), `${p}: owner identity`);
    for (const match of content.matchAll(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi)) assert.ok(/@example\.|noreply/i.test(match[0]), `${p}: personal email`);
  }
});
for (const [label, input] of [['missing',{}], ['http',{flag:'http://example.substack.com'}], ['path',{flag:'https://example.substack.com/path'}], ['query',{flag:'https://example.substack.com/?x=1'}], ['fragment',{flag:'https://example.substack.com/#x'}], ['invalid',{flag:'bad'}], ['empty',{flag:''}]]) {
  await test(`AC-70 publication rejects ${label}`, async () => {
    const { resolvePublication } = await import('../src/modules/substack-contract.mjs');
    assert.throws(() => resolvePublication({env:{},...input}), e => e.exitCode === 64 && e.code === 'invalid_publication' && e.message.includes('--publication') && e.message.includes('SUBSTACK_PUBLICATION_URL'));
  });
}
await test('AC-70 publication flag precedes environment', async () => {
  const { resolvePublication } = await import('../src/modules/substack-contract.mjs');
  assert.equal(resolvePublication({env:{SUBSTACK_PUBLICATION_URL:'https://example.substack.com'}}),'https://example.substack.com');
  assert.equal(resolvePublication({flag:'https://example.org',env:{SUBSTACK_PUBLICATION_URL:'invalid'}}),'https://example.org');
});
await test('AC-70 profile directory: environment override, otherwise the default under home; no other location is consulted', async () => {
  const { resolveProfileDir } = await import('../src/modules/substack-contract.mjs');
  const home = path.join(os.tmpdir(),'synthetic-home'), fresh = path.join(home,'.substack-draft-poster/profile');
  const probes = [];
  const exists = p => { probes.push(p); return true; };
  assert.deepEqual(resolveProfileDir({env:{},home,exists}), {dir:fresh});
  const custom = path.join(home,'custom');
  assert.deepEqual(resolveProfileDir({env:{SUBSTACK_PROFILE_DIR:custom},home,exists}),{dir:custom});
  assert.deepEqual(probes, [], 'resolveProfileDir must not probe the file system');
});
await test('AC-70 paths follow cwd and independent environment overrides', async () => {
  const { resolvePaths } = await import('../src/modules/substack-contract.mjs');
  const cwd = path.join(os.tmpdir(),'synthetic-cwd');
  const defaults = {stateFile:path.join(cwd,'.substack-poster/state.json'),schemaFile:path.join(cwd,'.substack-poster/tiptap-schema.json'),inDir:path.join(cwd,'substack-input')};
  assert.deepEqual(resolvePaths({env:{},cwd}),defaults);
  for (const [variable,key] of [['SUBSTACK_STATE_FILE','stateFile'],['SUBSTACK_SCHEMA_FILE','schemaFile'],['SUBSTACK_IN_DIR','inDir']]) {
    const value = path.join(cwd,'override'); assert.deepEqual(resolvePaths({env:{[variable]:value},cwd}),{...defaults,[key]:value});
  }
});
for (const mode of ['post','login','status','dry-run','mark-published','help']) await test(`AC-70 CLI publication resolution: ${mode}`, async () => {
  const { main } = await import('../src/cli.mjs');
  await fixture(async dir => {
    fs.mkdirSync(path.join(dir,'input')); fs.writeFileSync(path.join(dir,'input/sample-free-preview.html'),'<h1>Sample</h1><p>Body</p>');
    const f = dependencies(dir), args = mode === 'post' ? ['--slug=sample'] : mode === 'mark-published' ? ['--mark-published=sample'] : [`--${mode}`];
    // mark-published は、記録のある記事にだけ有効。記録を用意する
    if (mode === 'mark-published') { fs.mkdirSync(path.join(dir,'.substack-poster')); fs.writeFileSync(path.join(dir,'.substack-poster/state.json'), JSON.stringify({ posts: { sample: { status: 'draft_created' } } })); }
    const code = await main([...args,`--in-dir=${path.join(dir,'input')}`,...(mode === 'help' ? [] : ['--json'])], f.deps);
    assert.equal(f.launches,0);
    if (mode === 'help') { assert.equal(code,0); for (const name of [...flags,...variables]) assert.ok(f.output.join('').includes(name),name); }
    else {
      const result = JSON.parse(f.output.join('')); assert.equal(result.schema,'substack-post-result/1');
      if (['post','login'].includes(mode)) { assert.equal(code,64); assert.ok(result.errors.some(e => e.code === 'invalid_publication')); }
      else { assert.equal(code,0); assert.ok(!result.errors?.some(e => e.code === 'invalid_publication')); }
    }
  });
});
for (const [name, metaJson, freeHtml, expected] of [
  ['meta wins',{title:'Meta',subtitle:'Sub'},'<h1>HTML</h1>',{title:'Meta',subtitle:'Sub',titleSource:'meta_json',subtitleSource:'meta_json'}],
  ['meta title only',{title:'Meta'},'<h1>HTML</h1>',{title:'Meta',subtitle:'',titleSource:'meta_json',subtitleSource:'none'}],
  ['blank subtitle',{title:'Meta',subtitle:'  '},'',{title:'Meta',subtitle:'',titleSource:'meta_json',subtitleSource:'none'}],
  ['first h1',null,'<h1>First</h1><h1>Second</h1>',{title:'First',subtitle:'',titleSource:'h1',subtitleSource:'none'}],
  ['blank title',{title:'  '},'<h1>HTML</h1>',{title:'HTML',subtitle:'',titleSource:'h1',subtitleSource:'none'}],
  ['subtitle with h1',{subtitle:'Sub'},'<h1>HTML</h1>',{title:'HTML',subtitle:'Sub',titleSource:'h1',subtitleSource:'meta_json'}],
  ['missing',null,'<p>Body</p>',{error:'missing_title'}],
  ['blank h1',{title:' ',subtitle:'Sub'},'<h1> </h1>',{error:'missing_title'}],
]) await test(`AC-71 metadata ${name}`, async () => {
  const { resolveMeta } = await import('../src/modules/substack-contract.mjs');
  assert.deepEqual(resolveMeta({metaJson,freeHtml}),expected);
});
await test('AC-71 removed metadata source cannot supply title', async () => {
  const { resolveMeta } = await import('../src/modules/substack-contract.mjs');
  assert.deepEqual(resolveMeta({metaJson:null,freeHtml:'', [['content','BlogJson'].join('')]:{title:'Old',title_en:'Old'}}),{error:'missing_title'});
});
await test('AC-73 bilingual full documentation and skill', async () => {
  const en = read('README.md'), ja = read('README.ja.md');
  assert.ok(en.includes('README.ja.md')); assert.ok(ja.includes('README.md'));
  const count = s => (s.match(/^## /gm) ?? []).length;
  assert.ok(count(en)>=12); assert.equal(count(en),count(ja));
  assert.ok(!japanese.test(en.split('\n').filter(l => !l.includes('README.ja.md')).join('\n'))); assert.ok(japanese.test(ja));
  for (const text of [en,ja]) { for (const name of [...flags,...variables]) assert.ok(text.includes(name),name); for (const code of [0,1,2,3,4,5,6,7,64]) assert.match(text,new RegExp(`\\b${code}\\b`)); }
  for (const p of ['docs/runbook.md','docs/runbook.ja.md','docs/agent-contract.md','docs/agent-contract.ja.md','docs/ui-observations.md','docs/HISTORY.md','docs/roadmap/rate-limit.md']) assert.ok(fs.statSync(at(p)).isFile());
  assert.ok(!japanese.test(read('docs/ui-observations.md')));
  const skill = read('.claude/skills/substack-draft-post/SKILL.md'); assert.ok(Buffer.byteLength(skill)<=8000); assert.ok(!japanese.test(skill));
});
await test('AC-73 synthetic example plans without browser', async () => {
  const { main } = await import('../src/cli.mjs');
  for (const p of ['sample-free-preview.html','sample-paid-body.html','sample.meta.json']) assert.ok(fs.statSync(at(`examples/input/${p}`)).isFile());
  await fixture(async dir => { const f = dependencies(dir); assert.equal(await main(['--dry-run',`--in-dir=${at('examples/input')}`,'--slug=sample','--publication=https://example.substack.com','--json'],f.deps),0); const result = JSON.parse(f.output.join('')); assert.equal(result.schema,'substack-post-result/1'); assert.equal(result.results[0].outcome,'planned'); assert.equal(f.launches,0); });
});
await test('AC-73 schema example contains structure only', async () => {
  const text = read('examples/tiptap-schema.example.json'), schema = JSON.parse(text); assert.ok(Buffer.byteLength(text)<2048); assert.equal(typeof schema.paywallNode.type,'string'); assert.equal(typeof schema.editorPath,'string');
  function check(v) { if (v && typeof v === 'object') { assert.ok(!Object.hasOwn(v,'text')); Object.values(v).forEach(check); } } check(schema);
});
await test('AC-74 private data ignored', async () => { const ignore = read('.gitignore'); for (const entry of ['.substack-poster/','node_modules/','substack-input/']) assert.ok(ignore.includes(entry)); });
if (!fs.existsSync(at('.git'))) console.log('PASS (skipped: no .git) AC-74 history');
else await test('AC-74 isolated history and public author', async () => {
  const git = args => execFileSync('git',args,{cwd:root,encoding:'utf8'});
  assert.ok(!git(['ls-files']).split('\n').some(p => /^(?:\.substack-poster|node_modules)\//.test(p)));
  for (const line of git(['remote','-v']).trim().split('\n').filter(Boolean)) assert.match(line, new RegExp(`^origin\\thttps://github\\.com/${owner}/substack-draft-poster(?:\\.git)? \\((?:fetch|push)\\)$`), 'the only allowed remote is this repository on GitHub');
  const commits = git(['log','--format=%an%x09%ae']).trim().split('\n'); assert.ok(commits.length && commits[0]); for (const line of commits) assert.equal(line,`${owner}\t${email}`);
});
await test('AC-78 CLI text is English: no Japanese in source, help, usage errors or the human-readable summary', async () => {
  const japaneseText = /[\u3040-\u30ff\u4e00-\u9fff\uff00-\uffef]/;
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  for (const file of [...walk(at('src')), ...walk(at('scripts')).filter(f => /\.mjs$/.test(f))]) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.includes('const hasJa =')) continue; // the diagnostic's language detector must match Japanese characters
      assert.ok(!japaneseText.test(line), `${path.relative(root, file)}: Japanese text: ${line.trim().slice(0, 60)}`);
    }
  }
  const { main } = await import('../src/cli.mjs');
  const { parseArgs } = await import('../src/modules/substack-contract.mjs');
  await fixture(async dir => {
    const help = dependencies(dir);
    assert.equal(await main(['--help'], help.deps), 0);
    assert.ok(!japaneseText.test(help.output.join('')));
    for (const bad of [['--nope'], ['--limit=0'], ['--slug=a b'], ['--open', '--json'], ['--status', '--login'], ['--login', '--force'], ['--json=1']]) {
      assert.throws(() => parseArgs(bad), e => e.exitCode === 64 && !japaneseText.test(e.message), bad.join(' '));
    }
    const plain = dependencies(dir);
    assert.equal(await main(['--status', `--in-dir=${at('examples/input')}`], plain.deps), 0);
    assert.ok(!japaneseText.test(plain.output.join('')));
    const dry = dependencies(dir);
    await main(['--dry-run', `--in-dir=${at('examples/input')}`, '--slug=sample', '--publication=https://example.substack.com'], dry.deps);
    assert.match(dry.output.join(''), /^Substack dry-run: exit 0 \/ /);
  });
});
console.log(`Results: ${passes} PASS, ${failures} FAIL`);
process.exitCode = failures ? 1 : 0;
