const express = require('express');
const { Pool } = require('pg');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '128kb' }));
const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.BOT_TOKEN || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const SETUP_SECRET = process.env.SETUP_SECRET || '';
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const ADMINS = new Set((process.env.ADMIN_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
const PHOTO = fs.existsSync(path.join(__dirname, 'bot-photo.b64')) ? Buffer.from(fs.readFileSync(path.join(__dirname, 'bot-photo.b64'), 'utf8').trim(), 'base64') : null;
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 8 });
let schemaPromise;
async function schema() {
  if (!schemaPromise) schemaPromise = (async () => {
    await db.query([
      'CREATE TABLE IF NOT EXISTS players(id BIGSERIAL PRIMARY KEY,telegram_id BIGINT UNIQUE NOT NULL,username TEXT,first_name TEXT NOT NULL DEFAULT \'Игрок\',coins INTEGER NOT NULL DEFAULT 0 CHECK(coins>=0),last_daily_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT NOW())',
      'CREATE TABLE IF NOT EXISTS gifts(id TEXT PRIMARY KEY,name TEXT NOT NULL,emoji TEXT NOT NULL,rarity TEXT NOT NULL,sell_price INTEGER NOT NULL,weight INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS inventory(player_id BIGINT REFERENCES players(id) ON DELETE CASCADE,gift_id TEXT REFERENCES gifts(id),quantity INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(player_id,gift_id))',
      'CREATE TABLE IF NOT EXISTS shop(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,emoji TEXT NOT NULL,price INTEGER NOT NULL,active BOOLEAN NOT NULL DEFAULT TRUE)',
      'CREATE TABLE IF NOT EXISTS owned_items(player_id BIGINT REFERENCES players(id) ON DELETE CASCADE,item_id TEXT REFERENCES shop(id),purchased_at TIMESTAMPTZ DEFAULT NOW(),PRIMARY KEY(player_id,item_id))',
      'CREATE TABLE IF NOT EXISTS promos(id BIGSERIAL PRIMARY KEY,code TEXT UNIQUE NOT NULL,reward INTEGER NOT NULL,max_uses INTEGER,used INTEGER NOT NULL DEFAULT 0,expires_at TIMESTAMPTZ,active BOOLEAN DEFAULT TRUE)',
      'CREATE TABLE IF NOT EXISTS promo_claims(promo_id BIGINT REFERENCES promos(id),player_id BIGINT REFERENCES players(id) ON DELETE CASCADE,claimed_at TIMESTAMPTZ DEFAULT NOW(),UNIQUE(promo_id,player_id))'
    ].join(';'));
    await db.query("INSERT INTO gifts(id,name,emoji,rarity,sell_price,weight) VALUES ('feather','Голубое перо','🪶','Обычный',12,50),('egg','Счастливое яйцо','🥚','Обычный',18,35),('carrot','Золотая морковка','🥕','Редкий',45,12),('crystal','Лунный кристалл','💎','Эпический',100,3) ON CONFLICT(id) DO NOTHING");
    await db.query("INSERT INTO shop(id,name,description,emoji,price) VALUES ('title','Титул «Меткий лучник»','Особая подпись профиля.','🏹',120),('sky-frame','Рамка «Небесная»','Голубая рамка профиля.','🩵',180),('moon-frame','Рамка «Лунная»','Сияющая рамка профиля.','🌙',260),('gold-badge','Значок «Золотое перо»','Значок коллекции.','🏅',350) ON CONFLICT(id) DO NOTHING");
  })().catch(e => { schemaPromise = null; throw e; });
  return schemaPromise;
}
async function player(from) {
  await schema();
  const r = await db.query('INSERT INTO players(telegram_id,username,first_name) VALUES($1,$2,$3) ON CONFLICT(telegram_id) DO UPDATE SET username=EXCLUDED.username,first_name=EXCLUDED.first_name RETURNING *', [String(from.id), from.username || null, String(from.first_name || 'Игрок').slice(0,64)]);
  return r.rows[0];
}
function pickGift(rows) {
  const total = rows.reduce((s,x) => s + Number(x.weight), 0);
  let n = crypto.randomInt(1,total+1);
  for (const row of rows) { n -= Number(row.weight); if (n <= 0) return row; }
  return rows[0];
}
async function daily(pid) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const p = (await c.query('SELECT * FROM players WHERE id=$1 FOR UPDATE',[pid])).rows[0];
    if (p.last_daily_at && new Date(p.last_daily_at).getTime()+86400000 > Date.now()) {
      await c.query('ROLLBACK');
      return {ok:false,nextAt:new Date(new Date(p.last_daily_at).getTime()+86400000)};
    }
    const gift = pickGift((await c.query('SELECT * FROM gifts')).rows);
    await c.query('INSERT INTO inventory(player_id,gift_id,quantity) VALUES($1,$2,1) ON CONFLICT(player_id,gift_id) DO UPDATE SET quantity=inventory.quantity+1',[pid,gift.id]);
    await c.query('UPDATE players SET last_daily_at=NOW() WHERE id=$1',[pid]);
    await c.query('COMMIT');
    return {ok:true,gift};
  } catch(e) { await c.query('ROLLBACK').catch(()=>{}); throw e; } finally { c.release(); }
}
async function inventory(pid) {
  return (await db.query('SELECT g.id,g.name,g.emoji,g.rarity,g.sell_price,i.quantity FROM inventory i JOIN gifts g ON g.id=i.gift_id WHERE i.player_id=$1 AND i.quantity>0 ORDER BY g.sell_price DESC',[pid])).rows;
}
async function shopList(pid) {
  return (await db.query('SELECT s.*, (o.item_id IS NOT NULL) AS owned FROM shop s LEFT JOIN owned_items o ON o.item_id=s.id AND o.player_id=$1 WHERE s.active=TRUE ORDER BY s.price',[pid])).rows;
}
async function sell(pid,id) {
  const c=await db.connect();
  try {
    await c.query('BEGIN');
    const row=(await c.query('SELECT i.quantity,g.name,g.emoji,g.sell_price FROM inventory i JOIN gifts g ON g.id=i.gift_id WHERE i.player_id=$1 AND i.gift_id=$2 FOR UPDATE',[pid,id])).rows[0];
    if(!row || Number(row.quantity)<1){await c.query('ROLLBACK');return {ok:false,message:'Такого подарка нет в инвентаре.'};}
    await c.query('UPDATE inventory SET quantity=quantity-1 WHERE player_id=$1 AND gift_id=$2',[pid,id]);
    await c.query('UPDATE players SET coins=coins+$2 WHERE id=$1',[pid,row.sell_price]);
    const coins=Number((await c.query('SELECT coins FROM players WHERE id=$1',[pid])).rows[0].coins);
    await c.query('COMMIT');
    return {ok:true,gift:row,earned:Number(row.sell_price),coins};
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
async function buy(pid,id) {
  const c=await db.connect();
  try {
    await c.query('BEGIN');
    const p=(await c.query('SELECT coins FROM players WHERE id=$1 FOR UPDATE',[pid])).rows[0];
    const item=(await c.query('SELECT * FROM shop WHERE id=$1 AND active=TRUE',[id])).rows[0];
    if(!item){await c.query('ROLLBACK');return {ok:false,message:'Товар не найден.'};}
    if((await c.query('SELECT 1 FROM owned_items WHERE player_id=$1 AND item_id=$2',[pid,id])).rowCount){await c.query('ROLLBACK');return {ok:false,message:'Этот товар уже куплен.'};}
    if(Number(p.coins)<Number(item.price)){await c.query('ROLLBACK');return {ok:false,message:'Не хватает монет. Продай подарки или забери ежедневный.'};}
    await c.query('UPDATE players SET coins=coins-$2 WHERE id=$1',[pid,item.price]);
    await c.query('INSERT INTO owned_items(player_id,item_id) VALUES($1,$2)',[pid,id]);
    const coins=Number((await c.query('SELECT coins FROM players WHERE id=$1',[pid])).rows[0].coins);
    await c.query('COMMIT');
    return {ok:true,item,coins};
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
async function promo(pid,raw) {
  const code=String(raw||'').trim().toUpperCase();
  if(!/^[A-Z0-9_-]{3,32}$/.test(code))return {ok:false,message:'Проверь формат промокода.'};
  const c=await db.connect();
  try{
    await c.query('BEGIN');
    const p=(await c.query('SELECT * FROM promos WHERE code=$1 FOR UPDATE',[code])).rows[0];
    if(!p||!p.active){await c.query('ROLLBACK');return {ok:false,message:'Активный промокод не найден.'};}
    if(p.expires_at&&new Date(p.expires_at).getTime()<=Date.now()){await c.query('ROLLBACK');return {ok:false,message:'Срок действия промокода закончился.'};}
    if(p.max_uses!==null&&Number(p.used)>=Number(p.max_uses)){await c.query('ROLLBACK');return {ok:false,message:'Лимит активаций закончился.'};}
    if((await c.query('SELECT 1 FROM promo_claims WHERE promo_id=$1 AND player_id=$2',[p.id,pid])).rowCount){await c.query('ROLLBACK');return {ok:false,message:'Ты уже использовал этот промокод.'};}
    await c.query('INSERT INTO promo_claims(promo_id,player_id) VALUES($1,$2)',[p.id,pid]);
    await c.query('UPDATE promos SET used=used+1 WHERE id=$1',[p.id]);
    await c.query('UPDATE players SET coins=coins+$2 WHERE id=$1',[pid,p.reward]);
    const coins=Number((await c.query('SELECT coins FROM players WHERE id=$1',[pid])).rows[0].coins);
    await c.query('COMMIT');
    return {ok:true,reward:Number(p.reward),coins};
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
async function createPromo(code,reward,limit,hours) {
  code=String(code||'').trim().toUpperCase(); reward=Number(reward);limit=Number(limit);
  if(!/^[A-Z0-9_-]{3,32}$/.test(code))throw new Error('Код: 3–32 символа A–Z, 0–9, _ или -.');
  if(!Number.isInteger(reward)||reward<1||reward>100000)throw new Error('Награда: от 1 до 100000 монет.');
  if(!Number.isInteger(limit)||limit<1||limit>1000000)throw new Error('Лимит: от 1 до 1000000.');
  const expiry=hours===undefined?null:Number(hours);
  if(expiry!==null&&(!Number.isFinite(expiry)||expiry<1||expiry>8760))throw new Error('Срок — от 1 до 8760 часов.');
  return (await db.query("INSERT INTO promos(code,reward,max_uses,expires_at) VALUES($1,$2,$3,CASE WHEN $4::numeric IS NULL THEN NULL ELSE NOW()+($4::text || ' hours')::interval END) RETURNING *",[code,reward,limit,expiry])).rows[0];
}
async function state(pid) {
  const p=(await db.query('SELECT * FROM players WHERE id=$1',[pid])).rows[0];
  const [inv,items,owned]=await Promise.all([inventory(pid),shopList(pid),db.query('SELECT s.id,s.name,s.emoji FROM owned_items o JOIN shop s ON s.id=o.item_id WHERE o.player_id=$1',[pid])]);
  const next=p.last_daily_at?new Date(new Date(p.last_daily_at).getTime()+86400000):null;
  return {player:{name:p.first_name,coins:Number(p.coins),nextDailyAt:next?next.toISOString():null,canClaimDaily:!next||next.getTime()<=Date.now()},inventory:inv,shop:items,ownedItems:owned.rows};
}
function verifyInitData(raw) {
  if(!TOKEN||!raw)throw new Error('Открой Mini App через кнопку в Telegram.');
  const params=new URLSearchParams(raw),hash=params.get('hash');if(!hash)throw new Error('Нет подписи Telegram.');
  params.delete('hash');
  const authDate=Number(params.get('auth_date')||0);if(!authDate||Math.abs(Date.now()/1000-authDate)>86400)throw new Error('Сессия устарела. Перезапусти Mini App.');
  const check=[...params.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(x=>x[0]+'='+x[1]).join('\n');
  const key=crypto.createHmac('sha256','WebAppData').update(TOKEN).digest();
  const expected=crypto.createHmac('sha256',key).update(check).digest('hex');
  const a=Buffer.from(expected,'hex'),b=Buffer.from(hash,'hex');
  if(a.length!==b.length||!crypto.timingSafeEqual(a,b))throw new Error('Подпись Telegram не прошла проверку.');
  const data=params.get('user');if(!data)throw new Error('Telegram не передал пользователя.');
  return JSON.parse(data);
}
function auth(req,res,next){try{req.tgUser=verifyInitData(req.get('x-telegram-init-data')||'');next();}catch(e){res.status(401).json({error:e.message});}}
const replyKeyboard={keyboard:[[{text:'🎁 Ежедневный подарок'},{text:'🪙 Баланс'}],[{text:'🎒 Инвентарь'},{text:'🛍 Магазин'}],[{text:'🏷 Промокод'},{text:'🌐 Mini App'}]],resize_keyboard:true,is_persistent:true};
function inline() {
  const rows=[];if(APP_URL)rows.push([{text:'🌐 Открыть Mini App',web_app:{url:APP_URL+'/app'}}]);
  rows.push([{text:'🎁 Подарок',callback_data:'daily'},{text:'🪙 Баланс',callback_data:'balance'}],[{text:'🛍 Магазин',callback_data:'shop'},{text:'🎒 Инвентарь',callback_data:'inventory'}]);
  return {inline_keyboard:rows};
}
async function tg(method,data){
  if(!TOKEN)throw new Error('Добавь BOT_TOKEN в Railway Variables.');
  const r=await fetch('https://api.telegram.org/bot'+TOKEN+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data||{})});
  const j=await r.json();if(!j.ok)throw new Error(j.description||'Telegram API error');return j.result;
}
async function send(chat,text,extra){
  return tg('sendMessage',Object.assign({chat_id:chat,text,parse_mode:'HTML',reply_markup:replyKeyboard},extra||{}));
}
async function sendPhoto(chat,text){
  if(!PHOTO)return send(chat,text,{reply_markup:inline()});
  const form=new FormData();form.append('chat_id',String(chat));form.append('photo',new Blob([PHOTO],{type:'image/jpeg'}),'chicken-archer.jpg');form.append('caption',text);form.append('parse_mode','HTML');form.append('reply_markup',JSON.stringify(inline()));
  const r=await fetch('https://api.telegram.org/bot'+TOKEN+'/sendPhoto',{method:'POST',body:form});const j=await r.json();if(!j.ok)throw new Error(j.description||'sendPhoto failed');return j.result;
}
function cooldown(d){const n=Math.max(0,Math.ceil((new Date(d).getTime()-Date.now())/1000));return Math.floor(n/3600)+' ч. '+Math.floor(n%3600/60)+' мин.';}
async function showInventory(chat,p){
  const rows=await inventory(p.id);if(!rows.length)return send(chat,'🎒 Инвентарь пуст. Забери подарок командой /daily.');
  const text='🎒 <b>Инвентарь</b>\n'+rows.map(x=>x.emoji+' '+x.name+' ×'+x.quantity+' — '+x.sell_price+' 🪙').join('\n');
  return send(chat,text,{reply_markup:{inline_keyboard:rows.map(x=>[{text:'Продать '+x.emoji+' ×1 · '+x.sell_price+' 🪙',callback_data:'sell:'+x.id}])}});
}
async function showShop(chat,p){
  const rows=await shopList(p.id);const text='🛍 <b>Магазин</b>\nБаланс: '+p.coins+' 🪙\n\n'+rows.map(x=>x.emoji+' <b>'+x.name+'</b> — '+x.price+' 🪙\n'+x.description+(x.owned?'\n✅ Уже куплено':'')).join('\n\n');
  return send(chat,text,{reply_markup:{inline_keyboard:rows.filter(x=>!x.owned).map(x=>[{text:'Купить '+x.emoji+' · '+x.price+' 🪙',callback_data:'buy:'+x.id}])}});
}
async function onMessage(m){
  if(!m.from||m.from.is_bot)return;
  const p=await player(m.from),chat=m.chat.id,t=String(m.text||'').trim(),l=t.toLowerCase();
  if(l.startsWith('/start'))return sendPhoto(chat,'🏹 <b>Gift Hub — Chicken Archer</b>\n\n🎁 Ежедневный подарок раз в 24 часа.\n🪙 Продавай подарки и собирай монеты.\n🛍 Покупай оформление в магазине.\n🏷 Активируй промокоды.\n\nОткрой Mini App для красивого интерфейса или пользуйся кнопками ниже.');
  if(l==='/daily'||l==='/gift'||l==='🎁 ежедневный подарок'){
    const r=await daily(p.id);return send(chat,r.ok?'🎁 Получен подарок: '+r.gift.emoji+' <b>'+r.gift.name+'</b> ('+r.gift.rarity+'). Продажа: '+r.gift.sell_price+' монет.':'⏳ Следующий подарок будет через <b>'+cooldown(r.nextAt)+'</b>.');
  }
  if(l==='/balance'||l==='🪙 баланс')return send(chat,'🪙 Баланс: <b>'+p.coins+' монет</b>.');
  if(l==='/inventory'||l==='/sell'||l==='🎒 инвентарь')return showInventory(chat,p);
  if(l==='/shop'||l==='🛍 магазин')return showShop(chat,p);
  if(l==='/promo'||l==='🏷 промокод')return send(chat,'Отправь команду: /promo КОД');
  if(l.startsWith('/promo ')){const r=await promo(p.id,t.split(/\s+/)[1]);return send(chat,r.ok?'✅ Начислено '+r.reward+' монет. Баланс: '+r.coins+' 🪙.':'❌ '+r.message);}
  if(l.startsWith('/promo_create ')){
    if(!ADMINS.has(String(m.from.id)))return send(chat,'Команда доступна только администратору.');
    const z=t.split(/\s+/);try{const r=await createPromo(z[1],z[2],z[3],z[4]);return send(chat,'✅ Создан <code>'+r.code+'</code>: '+r.reward+' монет, лимит '+r.max_uses+(r.expires_at?', срок до '+new Date(r.expires_at).toLocaleString('ru-RU'):''));}catch(e){return send(chat,'❌ '+e.message+'\nФормат: /promo_create CODE 100 50 [72]');}
  }
  if(l==='/help'||l==='помощь')return send(chat,'<b>Команды</b>\n/start — меню\n/daily — подарок\n/balance — монеты\n/inventory — инвентарь\n/shop — магазин\n/promo CODE — промокод\n/help — помощь\n\nАдмин: /promo_create CODE 100 50 [72]');
  if(l==='🌐 mini app')return send(chat,'🌐 Открой Mini App по кнопке в меню.',{reply_markup:inline()});
  return send(chat,'Нажми кнопку меню или напиши /help.');
}
async function onCallback(q){
  if(!q.from||!q.message)return;
  const p=await player(q.from),chat=q.message.chat.id,d=String(q.data||'');
  await tg('answerCallbackQuery',{callback_query_id:q.id}).catch(()=>{});
  if(d==='daily'){const r=await daily(p.id);return send(chat,r.ok?'🎁 Получен '+r.gift.emoji+' '+r.gift.name+'. Продажа: '+r.gift.sell_price+' 🪙.':'⏳ Новый подарок через '+cooldown(r.nextAt)+'.');}
  if(d==='balance')return send(chat,'🪙 Баланс: <b>'+p.coins+' монет</b>.');
  if(d==='inventory')return showInventory(chat,p);
  if(d==='shop')return showShop(chat,p);
  if(d.startsWith('sell:')){const r=await sell(p.id,d.slice(5));return send(chat,r.ok?'💰 Продано: '+r.gift.emoji+' '+r.gift.name+'. +'+r.earned+' 🪙. Баланс: '+r.coins:'❌ '+r.message);}
  if(d.startsWith('buy:')){const r=await buy(p.id,d.slice(4));return send(chat,r.ok?'✅ Куплено: '+r.item.name+'. Осталось '+r.coins+' 🪙.':'❌ '+r.message);}
}
app.get('/health',(_q,s)=>s.json({ok:true,service:'chicken-archer-gift-hub'}));
app.get('/',(_q,s)=>s.redirect('/app'));
app.get('/bot-photo.jpg',(_q,s)=>PHOTO?s.type('image/jpeg').send(PHOTO):s.sendStatus(404));
app.get('/app',(_q,s)=>s.type('html').send(PAGE));
app.post('/telegram/webhook',async(q,s)=>{
  if(WEBHOOK_SECRET&&q.get('x-telegram-bot-api-secret-token')!==WEBHOOK_SECRET)return s.sendStatus(401);
  try{if(q.body.message)await onMessage(q.body.message);else if(q.body.callback_query)await onCallback(q.body.callback_query);}catch(e){console.error('Telegram update error',e);}return s.sendStatus(200);
});
app.get('/admin/setup',async(q,s)=>{
  if(!SETUP_SECRET||q.query.key!==SETUP_SECRET)return s.sendStatus(403);
  if(!TOKEN||!APP_URL)return s.status(400).send('Нужны BOT_TOKEN и APP_URL в Railway Variables.');
  try{
    await schema();
    await tg('setWebhook',{url:APP_URL+'/telegram/webhook',secret_token:WEBHOOK_SECRET,allowed_updates:['message','callback_query']});
    await tg('setChatMenuButton',{menu_button:{type:'web_app',text:'Gift Hub',web_app:{url:APP_URL+'/app'}}}).catch(()=>{});
    await tg('setMyCommands',{commands:[{command:'start',description:'Главное меню'},{command:'daily',description:'Ежедневный подарок'},{command:'balance',description:'Баланс монет'},{command:'inventory',description:'Инвентарь'},{command:'shop',description:'Магазин'},{command:'promo',description:'Промокод'},{command:'help',description:'Помощь'}]}).catch(()=>{});
    return s.send('Готово: webhook и Mini App подключены.');
  }catch(e){console.error(e);return s.status(500).send('Не удалось настроить: '+e.message);}
});
app.get('/api/state',auth,async(q,s)=>{try{const p=await player(q.tgUser);s.json(await state(p.id));}catch(e){s.status(500).json({error:e.message});}});
app.post('/api/daily',auth,async(q,s)=>{try{const p=await player(q.tgUser),r=await daily(p.id);s.json(r.ok?{ok:true,gift:r.gift,message:'Подарок получен!'}:{ok:false,nextAt:r.nextAt,message:'Подарок уже забран.'});}catch(e){s.status(400).json({error:e.message});}});
app.post('/api/sell',auth,async(q,s)=>{try{const p=await player(q.tgUser),r=await sell(p.id,q.body.giftId);if(!r.ok)return s.status(400).json({error:r.message});s.json({message:'Продано! +'+r.earned+' монет.',state:await state(p.id)});}catch(e){s.status(400).json({error:e.message});}});
app.post('/api/buy',auth,async(q,s)=>{try{const p=await player(q.tgUser),r=await buy(p.id,q.body.itemId);if(!r.ok)return s.status(400).json({error:r.message});s.json({message:'Покупка оформлена!',state:await state(p.id)});}catch(e){s.status(400).json({error:e.message});}});
app.post('/api/promo',auth,async(q,s)=>{try{const p=await player(q.tgUser),r=await promo(p.id,q.body.code);if(!r.ok)return s.status(400).json({error:r.message});s.json({message:'Промокод активирован: +'+r.reward+' монет.',state:await state(p.id)});}catch(e){s.status(400).json({error:e.message});}});

const PAGE = String.raw`<!doctype html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><meta name="theme-color" content="#111a31"><title>Gift Hub</title><script src="https://telegram.org/js/telegram-web-app.js"></script><style>
*{box-sizing:border-box}body{margin:0;padding:16px 13px 30px;background:radial-gradient(circle at 15% 0,#254a75,transparent 40%),#0d1427;color:#f2f7ff;font:15px system-ui}.wrap{max-width:720px;margin:auto}.top{display:flex;align-items:center;gap:12px;margin:8px 0 18px}.logo{width:68px;height:68px;object-fit:cover;border:2px solid #67caff;border-radius:19px}.title{font-size:24px;font-weight:950}.sub,.muted{color:#9cb1d1;font-size:12px}.balance{margin-left:auto;background:#ffda70;color:#2b2940;border-radius:13px;padding:9px 11px;font-weight:950;white-space:nowrap}.hero,.card{border:1px solid #ffffff20;background:linear-gradient(145deg,#1b3152,#121e36);border-radius:19px;padding:15px;margin-bottom:11px}.hero{background:linear-gradient(120deg,#274c80,#56518a)}h1{font-size:21px;margin:0 0 6px}h2{font-size:18px;margin:18px 0 9px}.btn{border:0;border-radius:13px;padding:11px 14px;background:linear-gradient(#ffe58f,#ffc54b);color:#25314a;font-weight:900;font-size:14px}.btn:disabled{opacity:.45}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:9px}.stat{background:#14233d;border:1px solid #ffffff18;border-radius:15px;padding:12px}.stat strong{display:block;font-size:21px}.items{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.item{background:#172742;border:1px solid #ffffff18;border-radius:15px;padding:11px;display:flex;flex-direction:column;gap:6px;min-width:0}.emoji{font-size:27px}.item p{font-size:12px;color:#9cb1d1;flex:1;margin:0}.price{color:#ffda70;font-weight:900}.item .btn{font-size:12px;padding:9px}.promo{display:flex;gap:7px}.promo input{flex:1;min-width:0;border:1px solid #ffffff2b;background:#111d34;color:white;border-radius:12px;padding:11px;font-size:14px;text-transform:uppercase}.note{font-size:11px;color:#97abc9;margin:12px 0;text-align:center}.toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:#f4f8ff;color:#15233c;padding:10px 15px;border-radius:12px;font-weight:900;max-width:90vw}.hide{display:none}@media(min-width:600px){.items{grid-template-columns:repeat(3,1fr)}}
</style></head><body><main class="wrap"><div class="top"><img class="logo" src="/bot-photo.jpg" alt="Chicken Archer"><div><div class="title">Gift Hub</div><div class="sub">Подарки и монеты Chicken Archer</div></div><div class="balance" id="bal">🪙 —</div></div>
<section class="hero"><h1>Забирай ежедневный подарок!</h1><p>Раз в 24 часа получай предмет, продавай дубликаты и копи монеты на оформление.</p><button class="btn" id="daily" onclick="claim()">🎁 Забрать подарок</button><div class="muted" id="timer" style="margin-top:8px">Загрузка…</div></section>
<div class="grid"><div class="stat"><span class="muted">Баланс</span><strong id="coins">— 🪙</strong></div><div class="stat"><span class="muted">Предметов</span><strong id="count">— 🎁</strong></div></div>
<h2>🎒 Инвентарь</h2><div class="items" id="inventory"></div><h2>🛍 Магазин</h2><div class="items" id="shop"></div>
<h2>🏷 Промокод</h2><div class="promo"><input id="code" placeholder="ВВЕДИ КОД" maxlength="32"><button class="btn" onclick="redeem()">Активировать</button></div>
<div class="note">Монеты — внутренняя валюта бота, не деньги и не выводятся.</div></main><div id="toast" class="toast hide"></div>
<script>
const tg=window.Telegram&&Telegram.WebApp?Telegram.WebApp:null;if(tg){tg.ready();tg.expand();}const init=tg?tg.initData:'';const headers={'Content-Type':'application/json','X-Telegram-Init-Data':init};let data=null;
function notify(t){const e=document.getElementById('toast');e.textContent=t;e.classList.remove('hide');clearTimeout(window.nt);window.nt=setTimeout(()=>e.classList.add('hide'),2600);}
async function api(url,body){const r=await fetch(url,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});const j=await r.json();if(!r.ok)throw Error(j.error||'Ошибка');return j;}
function draw(){if(!data)return;document.getElementById('bal').textContent='🪙 '+data.player.coins;document.getElementById('coins').textContent=data.player.coins+' 🪙';document.getElementById('count').textContent=data.inventory.reduce((a,x)=>a+x.quantity,0)+' 🎁';const b=document.getElementById('daily');b.disabled=!data.player.canClaimDaily;b.textContent=data.player.canClaimDaily?'🎁 Забрать подарок':'⏳ Уже забрано';document.getElementById('timer').textContent=data.player.canClaimDaily?'Новый подарок готов!':('Следующий: '+new Date(data.player.nextDailyAt).toLocaleString('ru-RU'));
const inv=document.getElementById('inventory');inv.innerHTML='';if(!data.inventory.length)inv.innerHTML='<div class="card muted">Инвентарь пуст — забери подарок.</div>';data.inventory.forEach(x=>{const e=document.createElement('div');e.className='item';e.innerHTML='<div class="emoji">'+x.emoji+'</div><b></b><span class="muted"></span><div class="price"></div><button class="btn">Продать ×1</button>';e.querySelector('b').textContent=x.name+' ×'+x.quantity;e.querySelector('.muted').textContent=x.rarity;e.querySelector('.price').textContent=x.sell_price+' 🪙';e.querySelector('button').onclick=()=>sell(x.id);inv.appendChild(e);});
const sh=document.getElementById('shop');sh.innerHTML='';data.shop.forEach(x=>{const e=document.createElement('div');e.className='item';e.innerHTML='<div class="emoji">'+x.emoji+'</div><b></b><p></p><div class="price"></div><button class="btn">Купить</button>';e.querySelector('b').textContent=x.name;e.querySelector('p').textContent=x.description;e.querySelector('.price').textContent=x.price+' 🪙';const b=e.querySelector('button');b.disabled=x.owned;b.textContent=x.owned?'Куплено':'Купить';b.onclick=()=>buyItem(x.id);sh.appendChild(e);});}
async function refresh(){try{data=await api('/api/state');draw();}catch(e){notify(e.message);document.getElementById('timer').textContent=e.message;}}
async function claim(){try{const r=await api('/api/daily',{});notify(r.ok?('Получено: '+r.gift.emoji+' '+r.gift.name):r.message);await refresh();}catch(e){notify(e.message);}}
async function sell(id){try{const r=await api('/api/sell',{giftId:id});notify(r.message);data=r.state;draw();}catch(e){notify(e.message);}}
async function buyItem(id){try{const r=await api('/api/buy',{itemId:id});notify(r.message);data=r.state;draw();}catch(e){notify(e.message);}}
async function redeem(){try{const r=await api('/api/promo',{code:document.getElementById('code').value});notify(r.message);document.getElementById('code').value='';data=r.state;draw();}catch(e){notify(e.message);}}
refresh();
</script></body></html>`;

app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:'Внутренняя ошибка сервера.'});});
app.listen(PORT,'0.0.0.0',async()=>{try{await schema();console.log('Gift Hub listening on '+PORT);}catch(e){console.error('Database init failed',e);}});
process.on('SIGTERM',async()=>{await db.end().catch(()=>{});process.exit(0);});
