import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const emailAllowed = (email, config) => (config.allowedEmails ?? []).includes(email)
  || (config.allowedEmailPatterns ?? []).some(pattern => new RegExp(pattern, 'i').test(email));
const redact = value => value.length > 5 ? `${value.slice(0, 4)}…` : '…';
export function scanFiles(files, config) {
  const findings = [];
  for (const file of files) {
    const add = (kind, value, line) => findings.push({ kind, path: file.path, line, excerpt: redact(value) });
    const parts = file.path.replaceAll('\\', '/').split('/');
    if (parts.some(p => p === '.env' || p.startsWith('.env.') && !p.endsWith('.example'))
      || parts.some(p => ['.substack-poster', 'substack-profile'].includes(p))) add('secret', file.path, 1);
    for (const [index, line] of file.content.split('\n').entries()) {
      const number = index + 1;
      const patterns = [
        /\bsk-[A-Za-z0-9_-]{16,}/g,
        /\bghp_[A-Za-z0-9]{20,}/g,
        /\bAKIA[A-Z0-9]{16}/g,
        /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g,
        /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}=*/gi,
        /\bsubstack\.sid\s*=\s*[^\s;"']+/gi,
        /\b(?:API_KEY|ACCESS_TOKEN|CLIENT_SECRET|PASSWORD)\s*=\s*["']?[A-Za-z0-9_+\/-]{12,}/gi,
      ];
      for (const pattern of patterns) for (const match of line.matchAll(pattern)) add('secret', match[0], number);
      for (const match of line.matchAll(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi)) if (!emailAllowed(match[0], config)) add('email', match[0], number);
      for (const match of line.matchAll(/\/(?:Users|home)\/[^\s"'`<>]+/g)) add('abs_path', match[0], number);
      for (const word of config.forbiddenWords ?? []) {
        if ((config.allowIn?.[word] ?? []).includes(file.path)) continue;
        if (line.toLowerCase().includes(word.toLowerCase())) add('forbidden_word', word, number);
      }
      for (const match of line.matchAll(/https?:\/\/([a-z0-9.-]+\.substack\.com)([^\s"'`<>]*)/gi)) {
        if (!(config.allowedHosts ?? []).includes(match[1].toLowerCase())) add('foreign_host', match[0], number);
        const id = match[2].match(/^\/publish\/(?:post|posts\/detail)\/(\d+)/)?.[1];
        if (id && !['1', '2', '3', '101', '123'].includes(id)) add('substack_id_url', match[0], number);
      }
    }
  }
  return findings;
}
export function scanCommits(commits, config) {
  return commits.flatMap(commit => {
    const name = `commit:${commit.hash}`;
    const emails = [commit.authorEmail, commit.committerEmail].filter(email => !emailAllowed(email, config))
      .map(email => ({ kind: 'author_email', path: name, line: 1, excerpt: redact(email ?? '') }));
    // Split the diff per file and apply allowIn (terms allowed only in specific files) to that file.
    // A diff without a diff --git header is scanned as one chunk under the name commit:<hash>.
    const sections = []; let current = { file: null, lines: [] };
    for (const line of (commit.diff ?? '').split('\n')) {
      const header = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (header) { sections.push(current); current = { file: header[2], lines: [] }; }
      current.lines.push(line);
    }
    sections.push(current);
    const diffFindings = sections.filter(section => section.lines.length).flatMap(section => scanFiles([{ path: section.file ?? name, content: section.lines.join('\n') }], config)
      .map(finding => section.file ? { ...finding, path: `${name}:${section.file}` } : finding));
    return [...emails, ...scanFiles([{ path: name, content: commit.message ?? '' }], config), ...diffFindings];
  });
}
export async function runCheck({ root, readConfig, listFiles, readFile, gitLog }) {
  const config = await readConfig(root);
  const files = await listFiles(root);
  const contents = await Promise.all(files.map(async file => ({ path: file, content: await readFile(file, root) })));
  const findings = [...scanFiles(contents, config), ...(gitLog ? scanCommits(await gitLog(root), config) : [])];
  return { findings, exitCode: findings.length ? 1 : 0 };
}
function listFiles(root, dir = root) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['.git', 'node_modules', '.substack-poster'].includes(entry.name)) return [];
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(root, file) : [path.relative(root, file).split(path.sep).join('/')];
  });
}
function gitHistory(root) {
  // One read-only invocation includes metadata, messages and full root diffs.
  const log = execFileSync('git', ['log', '--root', '--no-ext-diff', '--no-renames', '--format=%x1e%H%x1f%an%x1f%ae%x1f%ce%x1f%B%x1f', '-p'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return log.split('\x1e').filter(Boolean).map(record => {
    const [hash, authorName, authorEmail, committerEmail, message, ...diff] = record.split('\x1f');
    return { hash, authorName, authorEmail, committerEmail, message, diff: diff.join('\x1f') };
  });
}
// The published config (check-public.config.json) must not contain terms that identify a person. Personal blocklist terms
// (real names, private project names and so on) go in the untracked scripts/check-public.local.json. When present, arrays are
// concatenated and allowIn is merged key by key.
export function loadConfig(root) {
  const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const config = read('scripts/check-public.config.json');
  const localPath = path.join(root, 'scripts/check-public.local.json');
  if (!fs.existsSync(localPath)) return config;
  const local = read('scripts/check-public.local.json');
  const merged = { ...config };
  for (const key of ['forbiddenWords', 'allowedEmails', 'allowedEmailPatterns', 'allowedHosts']) merged[key] = [...(config[key] ?? []), ...(local[key] ?? [])];
  merged.allowIn = { ...(config.allowIn ?? {}) };
  for (const [word, paths] of Object.entries(local.allowIn ?? {})) merged.allowIn[word] = [...(merged.allowIn[word] ?? []), ...paths];
  return merged;
}
async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = await runCheck({ root, readConfig: () => loadConfig(root),
    listFiles, readFile: file => fs.readFileSync(path.join(root, file), 'utf8'),
    ...(fs.existsSync(path.join(root, '.git')) ? { gitLog: gitHistory } : {}) });
  for (const finding of result.findings) console.log(`${finding.kind} ${finding.path}:${finding.line} ${finding.excerpt}`);
  return result.exitCode;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(`Public check failed: ${error.code ?? error.name}`); process.exitCode = 1; });
}
