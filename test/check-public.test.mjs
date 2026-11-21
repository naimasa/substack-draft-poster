import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
let passes = 0, failures = 0;
async function test(name, fn) {
  try { await fn(); passes++; console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}: ${e.message}`); }
}
const word = ['proto','col-j'].join('');
const personal = ['some','one','@','gmail','.com'].join('');
const allowed = ['a','@','example','.com'].join('');
const noreply = ['123+u','@users.','noreply.github.com'].join('');
const config = {
  forbiddenWords: [word], allowedEmails: [allowed],
  allowedEmailPatterns: ['^[^@]+@users\\.noreply\\.github\\.com$','^[^@]+@example\\.[a-z.]+$'],
  allowedHosts: ['example.substack.com'], allowIn: {},
};
const secrets = [
  ['api', ['sk','-', 'A1b2C3d4'.repeat(6)].join('')],
  ['github', ['ghp','_', 'Ab12'.repeat(10)].join('')],
  ['aws', ['AK','IA','A1B2C3D4E5F6G7H8'].join('')],
  ['private key', ['-----BEGIN ','PRIVATE KEY','-----'].join('')],
  ['bearer', ['Bear','er ', 'SyntheticToken1234567890abcdefgh'].join('')],
  ['cookie', ['substack','.sid','=', 'SyntheticCookie1234567890'].join('')],
];
const samples = [
  ...secrets.map(([name,value]) => [name,'secret',value]),
  ['email','email',personal],
  ['absolute path','abs_path',['','Users','someone','private.txt'].join('/')],
  ['home path','abs_path',['','home','someone','private.txt'].join('/')],
  ['forbidden word','forbidden_word',word],
  ['post ID','substack_id_url',['https://','x','.substack.com/publish/post/','123','456','789'].join('')],
  ['foreign host','foreign_host',['https://','foreign-synthetic','.substack.com'].join('')],
];
for (const [name,kind,value] of samples) await test(`AC-77 detects and redacts ${name}`, async () => {
  const { scanFiles } = await import('../scripts/check-public.mjs');
  const findings = scanFiles([{path:'fixture.txt',content:`Safe heading\n${value}\n`}],config);
  const found = findings.find(f => f.kind === kind); assert.ok(found,kind);
  assert.equal(found.path,'fixture.txt'); assert.equal(found.line,2);
  assert.equal(typeof found.excerpt,'string'); assert.ok(found.excerpt.length>0); assert.ok(found.excerpt.length<value.length); assert.ok(!found.excerpt.includes(value));
  assert.ok(!JSON.stringify(findings).includes(value));
});
for (const [name,value] of [['example email',allowed],['noreply email',noreply],['synthetic post',['https://example.substack.com','/publish/post/','123'].join('')],['synthetic ID',['1','2','3'].join('')]]) await test(`AC-77 permits ${name}`, async () => {
  const { scanFiles } = await import('../scripts/check-public.mjs');
  assert.deepEqual(scanFiles([{path:'fixture.txt',content:value}],config),[]);
});
await test('AC-77 forbidden words are configuration driven', async () => {
  const { scanFiles } = await import('../scripts/check-public.mjs');
  const files = [{path:'fixture.txt',content:word}];
  assert.ok(scanFiles(files,config).some(f => f.kind === 'forbidden_word'));
  assert.deepEqual(scanFiles(files,{...config,forbiddenWords:[]}),[]);
  const other = ['synthetic','restricted'].join('-');
  assert.ok(scanFiles([{path:'fixture.txt',content:other}],{...config,forbiddenWords:[other]}).some(f => f.kind === 'forbidden_word'));
});
await test('AC-77 allowIn applies only to its word and exact path', async () => {
  const { scanFiles } = await import('../scripts/check-public.mjs');
  const c = {...config,allowIn:{[word]:['docs/origin.md']}};
  assert.deepEqual(scanFiles([{path:'docs/origin.md',content:word}],c),[]);
  assert.ok(scanFiles([{path:'docs/other.md',content:word}],c).some(f => f.kind === 'forbidden_word'));
  assert.ok(scanFiles([{path:'docs/origin.md',content:personal}],c).some(f => f.kind === 'email'));
});
const commit = {hash:'abc123',authorName:'Synthetic Author',authorEmail:allowed,committerEmail:noreply,message:'Safe change',diff:'+ Safe text'};
for (const field of ['authorEmail','committerEmail']) await test(`AC-77 commit rejects ${field}`, async () => {
  const { scanCommits } = await import('../scripts/check-public.mjs');
  const findings = scanCommits([{...commit,[field]:personal}],config);
  assert.ok(findings.some(f => f.kind === 'author_email' && f.path === `commit:${commit.hash}`));
  assert.ok(!JSON.stringify(findings).includes(personal));
});
for (const field of ['message','diff']) for (const [name,kind,value] of samples) await test(`AC-77 commit ${field} detects ${name}`, async () => {
  const { scanCommits } = await import('../scripts/check-public.mjs');
  const findings = scanCommits([{...commit,[field]:`Safe\n${value}`}],config);
  assert.ok(findings.some(f => f.kind === kind && f.path === `commit:${commit.hash}` && f.line === 2));
  assert.ok(!JSON.stringify(findings).includes(value));
});
await test('AC-77 allowed commit is clean', async () => {
  const { scanCommits } = await import('../scripts/check-public.mjs');
  assert.deepEqual(scanCommits([commit],config),[]);
});
for (const scenario of ['clean','file finding','history finding','no history']) await test(`AC-77 runCheck ${scenario}`, async () => {
  const { runCheck } = await import('../scripts/check-public.mjs');
  const calls = {config:0,list:0,read:0,history:0};
  const deps = {
    root,
    readConfig: () => { calls.config++; return config; },
    listFiles: () => { calls.list++; return ['fixture.txt']; },
    readFile: () => { calls.read++; return scenario === 'file finding' ? word : 'Safe'; },
    ...(scenario === 'no history' ? {} : {gitLog: () => { calls.history++; return [{...commit,message:scenario === 'history finding' ? word : 'Safe'}]; }}),
  };
  const result = await runCheck(deps), dirty = scenario.includes('finding');
  assert.equal(result.exitCode,dirty ? 1 : 0); assert.ok(Array.isArray(result.findings));
  if (dirty) assert.ok(result.findings.some(f => f.kind === 'forbidden_word')); else assert.deepEqual(result.findings,[]);
  assert.ok(calls.config>0 && calls.list>0 && calls.read>0); assert.equal(calls.history,scenario === 'no history' ? 0 : 1);
});
await test('AC-77 checker source is read only and offline', async () => {
  const source = fs.readFileSync(path.join(root,'scripts/check-public.mjs'),'utf8');
  assert.ok(source.length>0);
  for (const pattern of [/\bfetch\s*\(/,/https?\s*\.\s*(?:request|get)\s*\(/,/\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|unlink(?:Sync)?|rmSync|renameSync)\b/]) assert.ok(!pattern.test(source),`Disallowed operation: ${pattern}`);
  // Only a literal git log read is permitted through a subprocess API.
  const stripped = source.replace(/execFileSync\(\s*(['"])git\1\s*,\s*\[\s*(['"])log\2[^\]]*\]\s*(?:,\s*\{[^}]*\}\s*)?\)/g,'READ_ONLY_LOG');
  assert.ok(!/\b(?:execSync|exec|spawnSync|spawn|execFile)\s*\(/.test(stripped));
  assert.ok(!/\bexecFileSync\s*\(/.test(stripped));
});
await test('AC-77 actual repository and optional history are clean', async () => {
  const { runCheck } = await import('../scripts/check-public.mjs');
  const git = args => execFileSync('git',args,{cwd:root,encoding:'utf8'});
  const hasGit = fs.existsSync(path.join(root,'.git'));
  function walk(dir = root) { return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e => ['.git','node_modules','.substack-poster'].includes(e.name) ? [] : e.isDirectory() ? walk(path.join(dir,e.name)) : [path.relative(root,path.join(dir,e.name))]); }
  function history() {
    return git(['log','--format=%H']).trim().split('\n').filter(Boolean).map(hash => {
      const [authorName,authorEmail,committerEmail,...message] = git(['show','-s','--format=%an%n%ae%n%ce%n%B',hash]).split('\n');
      return {hash,authorName,authorEmail,committerEmail,message:message.join('\n'),diff:git(['show','--format=','--root','--no-ext-diff',hash])};
    });
  }
  const result = await runCheck({root,readConfig:() => JSON.parse(fs.readFileSync(path.join(root,'scripts/check-public.config.json'),'utf8')),listFiles:() => hasGit ? git(['ls-files','-z']).split('\0').filter(Boolean) : walk(),readFile:p => fs.readFileSync(path.isAbsolute(p) ? p : path.join(root,p),'utf8'),...(hasGit ? {gitLog:history} : {})});
  assert.equal(result.exitCode,0); assert.deepEqual(result.findings,[]);
});
console.log(`Results: ${passes} PASS, ${failures} FAIL`);
// Regression for the pre-release check: 個人を特定する禁止語は、追跡されないローカル設定に置く
await test('QA-1 tracked config holds no personal terms and local config is merged', async () => {
  const { loadConfig } = await import('../scripts/check-public.mjs');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const tracked = fs.readFileSync(path.join(root, 'scripts/check-public.config.json'), 'utf8');
  for (const word of [['Mas','aki'].join(''), ['Na','ito'].join(''), ['proto','col-j'].join(''), ['proto','colj'].join('')]) assert.ok(!tracked.includes(word), 'tracked config must not list personal terms');
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /check-public\.local\.json/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-public-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.writeFileSync(path.join(dir, 'scripts/check-public.config.json'), JSON.stringify({ forbiddenWords: ['a'], allowIn: { a: ['x'] } }));
    assert.deepEqual(loadConfig(dir).forbiddenWords, ['a']);
    fs.writeFileSync(path.join(dir, 'scripts/check-public.local.json'), JSON.stringify({ forbiddenWords: ['b'], allowIn: { a: ['y'], b: ['z'] } }));
    const merged = loadConfig(dir);
    assert.deepEqual(merged.forbiddenWords, ['a', 'b']);
    assert.deepEqual(merged.allowIn, { a: ['x', 'y'], b: ['z'] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
// QA 回帰: 履歴の差分でも、特定のファイルでだけ許可する語(allowIn)がファイルごとに適用される
await test('QA-2 history diffs apply allowIn per file', async () => {
  const { scanCommits } = await import('../scripts/check-public.mjs');
  const word = ['own', 'er-id'].join('');
  const config = { forbiddenWords: [word], allowIn: { [word]: ['LICENSE'] }, allowedEmails: [], allowedEmailPatterns: ['^[^@]+@example\\.com$'], allowedHosts: [] };
  const commit = diff => ({ hash: 'abc', authorName: 'a', authorEmail: 'a@example.com', committerEmail: 'a@example.com', message: 'm', diff });
  const ok = scanCommits([commit(`diff --git a/LICENSE b/LICENSE\n+Copyright ${word}\n`)], config);
  assert.deepEqual(ok, []);
  const bad = scanCommits([commit(`diff --git a/LICENSE b/LICENSE\n+Copyright ${word}\ndiff --git a/notes.md b/notes.md\n+see ${word}\n`)], config);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].kind, 'forbidden_word');
  assert.match(bad[0].path, /notes\.md$/);
});
process.exitCode = failures ? 1 : 0;
