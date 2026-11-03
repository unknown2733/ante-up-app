// Small browser assertion adapter for the existing pure wallet-flow fixtures.
// Unsupported assertion methods fail the bundle/run rather than becoming no-ops.
const cases=[];
export default function test(name,run){cases.push({name,run});}
export const after=()=>{};
const fail=message=>{throw Error(message??'Assertion failed');};
const canonical=value=>JSON.stringify(value,(_key,item)=>{
  if(typeof item==='bigint')return `${item}n`;
  if(item&&typeof item==='object'&&!Array.isArray(item))return Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]]));
  return item;
});
function matches(error,expected){
  if(expected===undefined)return true;
  if(expected instanceof RegExp)return expected.test(String(error?.message??error));
  if(typeof expected==='function')return error instanceof expected;
  return Object.entries(expected).every(([key,value])=>error?.[key]===value);
}
export const assert={
  equal:(a,b,m)=>Object.is(a,b)||fail(m??`Expected ${String(a)} to equal ${String(b)}`),
  notEqual:(a,b,m)=>!Object.is(a,b)||fail(m),
  ok:(a,m)=>!!a||fail(m),
  match:(a,b,m)=>b.test(a)||fail(m??`${a} does not match ${b}`),
  deepEqual:(a,b,m)=>canonical(a)===canonical(b)||fail(m??`Different objects: ${canonical(a)} / ${canonical(b)}`),
  throws:(fn,expected)=>{try{fn();}catch(error){if(matches(error,expected))return;throw error;}fail('Expected throw');},
  rejects:async(fn,expected)=>{try{await(typeof fn==='function'?fn():fn);}catch(error){if(matches(error,expected))return;throw error;}fail('Expected rejection');},
};
export async function run(){
  const results=[];
  for(const item of cases){
    window.__walletQA={done:false,current:item.name,results};
    try{await item.run();results.push({name:item.name,passed:true});}
    catch(error){results.push({name:item.name,passed:false,error:error.message});}
    document.querySelector('pre').textContent=JSON.stringify(results,null,2);
  }
  window.__walletQA={done:true,results,passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length};
}
