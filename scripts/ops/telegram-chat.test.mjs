import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {discoverPrivateChat} from './telegram-chat.mjs';

test('finds only the private /start chat without returning the bot token',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'ante-up-telegram-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'token'),token='12345:'+('a'.repeat(24));await writeFile(path,token);
  const fetcher=async(url)=>{
    assert.ok(url.includes(token));
    return {ok:true,json:async()=>({ok:true,result:[
      {message:{chat:{id:-100123,type:'group'},text:'/start'}},
      {message:{chat:{id:567890,type:'private'},text:'/start'}},
      {message:{chat:{id:567890,type:'private'},text:'/start more'}}
    ]})};
  };
  assert.equal(await discoverPrivateChat(path,fetcher),'567890');
});

test('fails closed on missing, ambiguous or rejected Telegram updates',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'ante-up-telegram-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'token');await writeFile(path,'12345:'+('a'.repeat(24)));
  await assert.rejects(discoverPrivateChat(path,async()=>({ok:true,json:async()=>({ok:true,result:[]})})),/TELEGRAM_START_MISSING/);
  await assert.rejects(discoverPrivateChat(path,async()=>({ok:true,json:async()=>({ok:true,result:[
    {message:{chat:{id:1,type:'private'},text:'/start'}},
    {message:{chat:{id:2,type:'private'},text:'/start'}}
  ]})})),/TELEGRAM_CHAT_AMBIGUOUS/);
  await assert.rejects(discoverPrivateChat(path,async()=>{throw Error('bot-secret-url')}),error=>error.message==='TELEGRAM_UPDATES_FAILED');
});
