import * as financial from '../../src/liveFinancial.ts';
import * as free from '../../src/liveFree.ts';
import * as clock from '../../src/apiClock.ts';
import * as boundary from '../../src/transactionBoundary.ts';
import * as verifier from '../../src/freeInstructionVerifier.ts';
const isolatedFree={...free,createLiveFreeFlow(options){
  const memory=new Map();
  return free.createLiveFreeFlow({...options,storage:options.storage??{
    getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key),
  }});
}};
const modules={'/src/liveFinancial.ts':financial,'/src/liveFree.ts':isolatedFree,'/src/apiClock.ts':clock,
  '/src/transactionBoundary.ts':boundary,'/src/freeInstructionVerifier.ts':verifier};
export async function createServer(){return {close(){},async ssrLoadModule(path){
  if(!modules[path])throw Error('Unsupported browser fixture module: '+path);return modules[path];
}};}
