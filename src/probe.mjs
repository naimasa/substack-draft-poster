import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, prompt, editorAction, schemaFile } from './cli.mjs';

import { resolvePublication } from './modules/substack-contract.mjs';

async function main() {
  if (process.env.CI !== undefined) { console.error('This tool runs only on a local Mac. The probe cannot run in CI.'); return 1; }
  if (process.argv.includes('--help')) {
    console.log('node src/probe.mjs\nCompares getJSON before and after a hand-made draft gets a Paywall, and saves the observed node and the access path.');
    return 0;
  }
  const origin = resolvePublication({});
  const outputFile = schemaFile();
  const context = await launchBrowser();
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/publish/posts/drafts`);
    await prompt('In the signed-in browser, open a hand-made probe draft and add each kind of formatting. Do not insert the Paywall yet; press Enter: ');
    await page.locator('.ProseMirror').waitFor({ timeout: 15000 });
    const before = await page.evaluate(editorAction, { action: 'snapshot' });
    if (!before.reachable) throw new Error('Cannot reach Tiptap. Check element.editor / element.__tiptapEditor / window.editor / window.tiptapEditor. The fixture is not saved.');
    await prompt('Without changing the body, insert exactly one Paywall with More > Paywall. Press Enter when done: ');
    const after = await page.evaluate(editorAction, { action: 'snapshot', editorPath: before.editorPath });
    if (!after.reachable) throw new Error('Lost the editor reference');
    const old = before.json.content || [];
    const current = after.json.content || [];
    // Require exactly one inserted top-level node, without guessing its name.
    const candidates = current.map((node, index) => ({ node, index })).filter(({ index }) =>
      JSON.stringify(current.filter((_, i) => i !== index)) === JSON.stringify(old));
    if (current.length !== old.length + 1 || candidates.length !== 1) throw new Error('The difference is not a single node. Insert only the Paywall and run again.');
    const paywallNode = candidates[0].node;
    if (!paywallNode.type || ['paragraph', 'text', 'heading'].includes(paywallNode.type)) throw new Error('The difference is plain text. Check that the Paywall was inserted.');
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, JSON.stringify({ capturedAt: new Date().toISOString(), editorPath: after.editorPath,
      paywallNode, before: before.json, after: after.json }, null, 2) + '\n');
    console.log(`Saved: ${outputFile}\nAccess path: ${after.editorPath}\nObserved node type: ${paywallNode.type}\nThe fixture contains the probe body. Check it for personal or confidential data before committing.`);
    return 0;
  } finally { await context.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(`[Substack probe] ${error.message}`); process.exitCode = 1; });
