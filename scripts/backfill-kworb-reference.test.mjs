import test from 'node:test';
import assert from 'node:assert/strict';
import {parseKworbReport} from './backfill-kworb-reference.mjs';
const id='5MhMXTuVODDF234VDvSxQx';
const html=(date,value)=>`Last updated: ${date}<table><tr><td><a href="https://open.spotify.com/track/${id}">Awake</a></td><td>${value}</td></tr></table>`;
test('dated source reports retain exact dates and integer counts',()=>{
  assert.deepEqual(parseKworbReport(html('2024/02/29','114,014,946'),id),{reportedDate:'2024-02-29',value:'114014946'});
  assert.equal(parseKworbReport(html('2026/10/27','114014946'),id).value,'114014946');
});
test('calendar overflow cannot silently move a provider report into another date',()=>{
  for(const date of ['2026/02/29','2026/02/31','2026/04/31','2026/13/01'])
    assert.throws(()=>parseKworbReport(html(date,'114,014,946'),id),/KWORB_REPORT_DATE_INVALID/);
});
test('malformed source thousands separators cannot become a plausible count',()=>{
  for(const value of ['114,,014,946','114,01,946','1,234,','01,234'])
    assert.throws(()=>parseKworbReport(html('2026/10/27',value),id),/KWORB_STREAM_COUNT_INVALID/);
});
