import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
async function defaultFiles(base) {
  const files = ['apps/web/index.html'];
  async function walk(relative) {
    for (const entry of await readdir(path.resolve(base, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (/\.(?:tsx?|html)$/.test(entry.name)) files.push(child);
    }
  }
  await walk('apps/web/src');
  return files;
}

export async function auditEnglish(files, base = root) {
  const findings = [];
  for (const relative of files ?? await defaultFiles(base)) {
    const body = await readFile(path.resolve(base, relative), 'utf8');
    const lines = body.split(/\r?\n/);
    lines.forEach((line, i) => {
      const visibleCandidate = line.replace(/\/\[가-힣\]\/[gimsuy]*/gu, '');
      if (/[\uac00-\ud7a3\u3131-\u318e]/u.test(visibleCandidate)) findings.push({ file: relative, line: i + 1, rule: 'hangul', excerpt: line.trim().slice(0, 100) });
    });
    if (relative.endsWith('index.html')) {
      if (!/<html\s+lang=["']en["']/i.test(body)) findings.push({ file: relative, line: 1, rule: 'html-lang-en' });
      if (!/<meta\s+name=["']description["'][^>]+content=["'][^"']+["']/i.test(body)) findings.push({ file: relative, line: 1, rule: 'description' });
      if (!/<link\s+rel=["'](?:icon|shortcut icon)["'][^>]+href=/i.test(body)) findings.push({ file: relative, line: 1, rule: 'favicon-link' });
    }
  }
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  const findings = await auditEnglish(files.length ? files : undefined);
  for (const item of findings) console.log(`${item.file}:${item.line} ${item.rule}${item.excerpt ? ` ${item.excerpt}` : ''}`);
  console.log(`${findings.length} English audit finding(s)`);
  if (findings.length) process.exitCode = 1;
}
