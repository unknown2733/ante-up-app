import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {createFromRoot} from 'codama';
import {rootNodeFromAnchor} from '@codama/nodes-from-anchor';
import {renderVisitor} from '@codama/renderers-js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const idlPath = resolve(packageRoot, 'idl/ante_up.json');
const idl = JSON.parse(readFileSync(idlPath, 'utf8'));
const source = readFileSync(resolve(packageRoot, '../../programs/ante_up/src/lib.rs'), 'utf8');
const declared = source.match(/declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/)?.[1];
if (!declared || idl.address !== declared) {
  throw new Error('Compiled IDL program address does not match declare_id');
}
const codama = createFromRoot(rootNodeFromAnchor(idl));
await codama.accept(renderVisitor(packageRoot, {syncPackageJson: false, importExtension: 'js'}));
console.log('Generated Kit client from compiled Anchor IDL');
