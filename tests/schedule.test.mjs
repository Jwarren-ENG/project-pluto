import test from 'node:test';
import assert from 'node:assert/strict';
import {scheduler} from '../desktop/schedule.mjs';
import {webUrl} from '../desktop/web.mjs';
function example(search){
  let schedule={enabled:true,hour:9,minute:30,query:'example hiring'},date=new Date(2026,1,1,9,29);
  const log=new Map();
  const workspace={snapshot:()=>({schedule}),saveSchedule:s=>{schedule=s;}};
  return {tick:scheduler({workspace,search,prefs:log,clock:()=>date}),log,at:d=>{date=d;}};
}
test('daily search waits for local time, reserves before search and recovers next day',async()=>{
  let calls=0;const app=example(async()=>{if(++calls===1)throw Error('Offline');return [{title:'Example'}];});
  await app.tick();assert.equal(calls,0);
  app.at(new Date(2026,1,1,9,30));await Promise.all([app.tick(),app.tick()]);await app.tick();
  assert.equal(calls,1);assert.match(app.log.get('discoveryRun').status,/Failed/);
  app.at(new Date(2026,1,2,14));await app.tick();assert.equal(calls,2);assert.equal(app.log.get('discoveryResults').results.length,1);
});
test('only HTTPS destinations without embedded credentials open externally',()=>{
  assert.equal(webUrl('https://example.org/job'),'https://example.org/job');
  for(const target of ['file:///tmp/example','https://name:password@example.org','javascript:alert(1)','http://example.org'])assert.throws(()=>webUrl(target));
});

test('scheduled discovery records partial source results and their errors together', async () => {
  const sources = [{label:'Job list',count:1,status:'ok'}, {label:'Careers',count:0,status:'error',error:'Site unavailable'}];
  const results = [{title:'Product Analyst',url:'https://example.org/jobs/42',source:'Job list'}];
  const runner = example(async()=>({results,sources}));
  runner.at(new Date(2026,1,2,12));
  await runner.tick();
  assert.deepEqual(runner.log.get('discoveryResults').sources,sources);
  assert.deepEqual(runner.log.get('discoveryResults').results,results);
  assert.match(runner.log.get('discoveryRun').status,/source errors/);
})
