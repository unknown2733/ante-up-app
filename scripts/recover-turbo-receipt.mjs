import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {createReceiptVerifier} from '../services/evidence/receipt.mjs';
const require=createRequire(new URL('../services/evidence/package.json',import.meta.url));
const {DataItem}=require('@dha-team/arbundles'),{TurboFactory}=require('@ardrive/turbo-sdk');
const directory=process.env.ANTE_UP_RECOVERY_DIRECTORY;
if(!directory)throw Error('RECOVERY_DIRECTORY_REQUIRED');
const bytes=await readFile(`${directory}/recovered-item.bin`),item=new DataItem(bytes);
if(item.id!=='kn0PKZR1QdhpdWBjyHeyP2vNmrkZ2jhuB47NGT3yMaY'||!(await item.isValid()))throw Error('RECOVERED_ITEM_INVALID');
if(createHash('sha256').update(Buffer.from(item.owner,'base64url')).digest('base64url')!=='EQn0YOvg1UAJMRCYwvejTD0_VZRqu4BZGoltRPTGMbA')throw Error('OWNER_MISMATCH');
console.log(JSON.stringify({state:'EXISTING_SIGNED_ITEM_VERIFIED',id:item.id,bytes:bytes.length}));
if(process.argv.includes('--execute')){
 const turbo=TurboFactory.unauthenticated();
 const receipt=JSON.parse(JSON.stringify(await turbo.uploadSignedDataItem({dataItemStreamFactory:()=>Readable.from(bytes),dataItemSizeFactory:()=>bytes.length})));
 await mkdir(`${directory}/receipts`,{recursive:true});
 await writeFile(`${directory}/recovered-receipt.json`,JSON.stringify(receipt),{mode:0o600});
 if(receipt.id!==item.id||!await createReceiptVerifier({allowedAddresses:['JNC6vBhjHY1EPwV3pEeNmrsgFMxH5d38_LHsZ7jful8']})(receipt))throw Error('RECOVERED_RECEIPT_INVALID');
 const hash=item.tags.find(t=>t.name==='Ante-Up-Content-Hash')?.value;
 if(!/^[a-f0-9]{64}$/.test(hash))throw Error('CONTENT_HASH_REQUIRED');
 await writeFile(`${directory}/receipts/${hash}.json`,JSON.stringify(receipt),{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({state:'RECEIPT_RECOVERED',id:receipt.id,winc:receipt.winc}));
}
