import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const key = process.env.API_KEY;
if (!key || key.length < 24) throw new Error('API_KEY must have at least 24 characters');
let client, pending, busy = false;
async function connect() {
  if (client) return client;
  if (!pending) pending = (async () => {
    const c = new Client({name:'ozon-research-http',version:'1.0.0'});
    const t = new StdioClientTransport({command:process.execPath,args:['src/index.js'],env:{...process.env,OZON_EXIT_IDLE_MS:'2147483647'},stderr:'inherit'});
    t.onclose = () => { if(client===c) client=undefined; };
    try { await c.connect(t); client=c; c.onclose=()=>{if(client===c)client=undefined;}; return c; }
    catch(e){await c.close().catch(()=>{});throw e;}
  })().finally(()=>{pending=undefined;});
  return pending;
}
function authorized(req){
  const a=Buffer.from(req.headers.authorization || '');
  const b=Buffer.from('Bearer '+key);
  return a.length===b.length && timingSafeEqual(a,b);
}
function send(res,status,data){
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(data));
}
http.createServer(async(req,res)=>{
  if(req.method==='GET' && req.url==='/health') return send(res,200,{ok:true});
  if(!authorized(req)) return send(res,401,{error:'Unauthorized'});
  if(busy) return send(res,429,{error:'Another request is running'});
  busy=true;
  try{
    if(req.method==='GET' && req.url==='/tools'){
      return send(res,200,await (await connect()).listTools());
    }
    if(req.method!=='POST'||req.url!=='/call') return send(res,404,{error:'Not found'});
    let body='';
    for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>65536)return send(res,413,{error:'Request too large'});}
    const {name,arguments:args={}}=JSON.parse(body);
    if(typeof name!=='string'||!/^ozon_[a-z_]+$/.test(name)||!args||typeof args!=='object'||Array.isArray(args))return send(res,400,{error:'Invalid tool request'});
    const result=await (await connect()).callTool({name,arguments:args},undefined,{timeout:100000});
    return send(res,result.isError?502:200,result);
  }catch(e){return send(res,502,{error:String(e.message||e)});}
  finally{busy=false;}
}).listen(Number(process.env.PORT||10000),'0.0.0.0',()=>console.log('HTTP server ready'));
