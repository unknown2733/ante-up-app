import { readFile } from 'node:fs/promises';
import { auditConsumerSnapshot } from './audit.mjs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node apps/web/qa/consumer/audit-cli.mjs SNAPSHOT.json');
  process.exitCode = 2;
} else {
  try {
    const snapshot = JSON.parse(await readFile(file, 'utf8'));
    const issues = auditConsumerSnapshot(snapshot);
    for (const issue of issues) console.log(`${issue.path}: ${issue.message}`);
    console.log(`${issues.length} consumer contract finding(s)`);
    if (issues.length) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
