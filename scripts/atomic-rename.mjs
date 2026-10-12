import {rename} from 'node:fs/promises';
import {setTimeout} from 'node:timers/promises';

// Windows indexers can briefly hold the destination. Never unlink the old journal.
export async function replaceJournal(source,target,{move=rename,wait=setTimeout,platform=process.platform}={}) {
  for(let attempt=0;;attempt++) {
    try {await move(source,target);return;}
    catch(error) {
      if(platform!=='win32' || !['EPERM','EACCES','EBUSY'].includes(error.code) || attempt>=5) throw error;
      await wait(25*2**attempt);
    }
  }
}
