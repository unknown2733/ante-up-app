/** Bound public browser-QA reads. Never forwards credentials or write methods. */
export function createPublicQaFetcher({fetcher=fetch,intervalMs=500,wait=ms=>new Promise(r=>setTimeout(r,ms)),onRead=()=>{}}={}){
  let queue=Promise.resolve();
  const cache=new Map();
  return (input,init={})=>{
    const url=new URL(String(input));
    const method=init.method??'GET';
    if(!['GET','HEAD'].includes(method)||!(url.origin==='https://ante-up.fun'||
      url.protocol==='http:'&&url.hostname==='127.0.0.1')||url.username||url.password)
      return Promise.reject(Error('QA_PUBLIC_READ_ONLY'));
    const key=method+url.href;
    if(cache.has(key))return cache.get(key).then(r=>r.clone());
    const operation=queue.then(async()=>{
      let response;
      for(let attempt=0;attempt<3;attempt++){
        await wait(intervalMs);
        response=await fetcher(url,{method,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20_000)});
        onRead({path:url.pathname+url.search,status:response.status,attempt});
        if(response.status!==429)break;
        if(attempt<2){
          const raw=response.headers.get('retry-after');
          const seconds=raw===null?2:Number(raw);
          if(!Number.isFinite(seconds)||seconds<0||seconds>15)break;
          await response.arrayBuffer();await wait(Math.max(1000,seconds*1000));
        }
      }
      return response;
    });
    queue=operation.catch(()=>{});
    cache.set(key,operation);
    operation.then(r=>{if(!r.ok)cache.delete(key);},()=>cache.delete(key));
    return operation.then(r=>r.clone());
  };
}
