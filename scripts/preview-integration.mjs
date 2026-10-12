// Local fixture-only preview, no wallet, network provider, upload or asset action.
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {createApp} from '../services/api/src/app.ts';
import {createServer as createVite} from '../apps/web/node_modules/vite/dist/node/index.js';
process.env.VITE_API_BASE_URL='/api';
process.env.VITE_ALLOW_FIXTURE_API='true';
const app=createApp();
const api=createServer(async(req,res)=>{
  try{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const request=new Request(`http://127.0.0.1:8789${req.url}`,{method:req.method,headers:req.headers,
      body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)});
    const response=await app.handle(request);res.writeHead(response.status,Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  }catch(e){res.writeHead(500);res.end(String(e))}
});
await new Promise((resolve,reject)=>{api.once('error',reject);api.listen(8789,'127.0.0.1',resolve)});
const vite=await createVite({root:fileURLToPath(new URL('../apps/web',import.meta.url)),
  server:{host:'127.0.0.1',port:5194,strictPort:true,proxy:{'/api':{target:'http://127.0.0.1:8789',rewrite:p=>p.replace(/^\/api/,'')}}}});
await vite.listen();
console.log(`FIXTURE PREVIEW http://127.0.0.1:5194 pid=${process.pid}`);
const close=async()=>{await vite.close();api.closeAllConnections();api.close(()=>process.exit(0))};
process.on('SIGTERM',close);process.on('SIGINT',close);
