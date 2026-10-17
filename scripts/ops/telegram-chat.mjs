// Identify the one private chat that started the dedicated Ante Up bot.
// Never print the bot token, Telegram URL, or raw provider response.
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

export async function discoverPrivateChat(tokenFile,fetcher=fetch) {
  const token=(await readFile(tokenFile,'utf8')).trim();
  if(!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token))throw Error('TELEGRAM_CONFIG_INVALID');
  try {
    const response=await fetcher(`https://api.telegram.org/bot${token}/getUpdates`,{
      signal:AbortSignal.timeout(10000),redirect:'error'
    });
    const body=await response.json();
    if(!response.ok||body.ok!==true||!Array.isArray(body.result))throw Error('TELEGRAM_UPDATES_FAILED');
    const chats=new Set(body.result
      .filter(update=>update.message?.chat?.type==='private'&&/^\/start(?:\s|$)/.test(update.message?.text??''))
      .map(update=>String(update.message.chat.id)));
    if(chats.size!==1)throw Error(chats.size?'TELEGRAM_CHAT_AMBIGUOUS':'TELEGRAM_START_MISSING');
    return [...chats][0];
  } catch(error) {
    if(['TELEGRAM_CHAT_AMBIGUOUS','TELEGRAM_START_MISSING'].includes(error.message))throw error;
    throw Error('TELEGRAM_UPDATES_FAILED');
  }
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  try {
    if(process.argv.length!==3)throw Error('TELEGRAM_TOKEN_FILE_REQUIRED');
    console.log(await discoverPrivateChat(process.argv[2]));
  } catch(error) {
    console.error(error.message);
    process.exitCode=1;
  }
}
