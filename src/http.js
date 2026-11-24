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
const testPage = "<!doctype html><html lang=\"ru\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Ozon Research — тест</title><style>body{font:16px system-ui;max-width:680px;margin:24px auto;padding:16px}input,button,textarea,select{box-sizing:border-box;width:100%;padding:12px;margin:6px 0;font:inherit}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eee;padding:12px}label{display:block;margin-top:12px}</style><h1>Ozon Research</h1><label>Секретный ключ<input id=\"key\" type=\"password\" autocomplete=\"off\"></label><label>Название товара или артикул<input id=\"query\" value=\"молоко Neo безлактозное\"></label><button id=\"tools\">Проверить инструменты</button><button id=\"search\">Поиск товаров</button><button id=\"details\">Карточка товара</button><pre id=\"out\">Введите ключ.</pre><script>\nconst el=id=>document.getElementById(id);\nasync function run(name){\n const key=el('key').value.trim(),q=el('query').value.trim();\n if(!key){el('out').textContent='Введите ключ';return;}\n const buttons=document.querySelectorAll('button');buttons.forEach(b=>b.disabled=true);\n el('out').textContent='Выполняется запрос. Подождите до двух минут.';\n try{\n const opts={headers:{Authorization:'Bearer '+key}};\n if(name){opts.method='POST';opts.headers['Content-Type']='application/json';opts.body=JSON.stringify({name,arguments:name==='ozon_search'?{query:q,limit:5}:{product:q}});}\n const r=await fetch(name?'/call':'/tools',opts);const data=await r.json();\n if(!name&&r.ok&&Array.isArray(data.tools)){el('out').textContent='HTTP '+r.status+' — инструментов: '+data.tools.length+'\\n'+data.tools.map(t=>t.name).join('\\n');}\n else{el('out').textContent='HTTP '+r.status+'\\n'+JSON.stringify(data,null,2);}\n }catch(e){el('out').textContent=String(e);}finally{buttons.forEach(b=>b.disabled=false);}\n}\nel('tools').onclick=()=>run();el('search').onclick=()=>run('ozon_search');el('details').onclick=()=>run('ozon_product_details');\n</script></html>";
http.createServer(async(req,res)=>{
  if(req.method==='GET' && req.url==='/test'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"});return res.end(testPage);}
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
