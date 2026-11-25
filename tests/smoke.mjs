// Exercise the actual desktop renderer and restricted main-process bridge with disposable local data.
import { _electron as electron } from 'playwright';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const dir=await mkdtemp(path.join(os.tmpdir(),'pluto-desktop-test-'));
const executablePath=process.env.PLUTO_EXECUTABLE || process.env.PLUTO_SMOKE_EXECUTABLE;
const args=['--user-data-dir='+dir,...(executablePath?[]:['.'])];
let app;
try{
  app=await electron.launch({args, ...(executablePath?{executablePath}:{}),timeout:45000});
  let page=await app.firstWindow();
  const faults=[];
  page.on('pageerror',e=>faults.push(e.message));
  await page.getByRole('heading',{name:'Your application desk.'}).waitFor();
  assert.equal(await page.locator('.hero img').evaluate(img=>img.complete&&img.naturalWidth>0),true);
  if(process.env.PLUTO_SCREENSHOT)await page.screenshot({path:process.env.PLUTO_SCREENSHOT});
  const nav=page.getByRole('navigation');
  await page.getByRole('button',{name:'Start with your résumé'}).click();
  await page.getByRole('button',{name:'Choose résumé file'}).waitFor();
  for(const title of ['Discover','Applications','Notebook','Connections','Mail','Daily budget']){
    await nav.getByRole('button',{name:title,exact:true}).click();
    await page.getByRole('heading',{name:title,exact:true,level:1}).waitFor();
  }
  const slider=page.getByRole('slider',{name:'Adjust jobs per day'});
  await slider.focus();await slider.press('Home');for(let i=0;i<25;i++)await slider.press('ArrowRight');
  assert.equal(await slider.inputValue(),'25');
  await page.getByRole('button',{name:/save budget|save daily|save target/i}).click();
  await page.waitForFunction(async()=>(await window.pluto.call('workspace.snapshot')).profile?.budget?.jobsPerDay===25);
  const proof=await page.evaluate(async()=>{
    const call=window.pluto.call;
    await call('workspace.saveProfile',{name:'Sample Candidate'});
    const job=await call('workspace.saveJob',{title:'Product Analyst',company:'Example Company',url:'https://example.org/position',stage:'Preparing',resumeText:'Reviewed example résumé'});
    let rejected=false;try{await call('workspace.saveJob',{id:job.id,stage:'Applied'});}catch{rejected=true;}
    const sent=await call('workspace.saveJob',{id:job.id,stage:'Applied',evidence:'Example portal receipt'});
    await call('workspace.saveNote',{title:'Interview notes',body:'## Topics',jobId:job.id});
    let unknown=false;try{await call('filesystem.readEverything');}catch{unknown=true;}
    return {rejected,unknown,resume:sent.submittedSnapshot.resumeText,node:typeof require};
  });
  assert.deepEqual(proof,{rejected:true,unknown:true,resume:'Reviewed example résumé',node:'undefined'});
  assert.deepEqual(faults,[]);
  await app.close();app=null;
  app=await electron.launch({args,...(executablePath?{executablePath}:{}),timeout:45000});
  page=await app.firstWindow();
  await page.getByRole('heading',{name:'Welcome back, Sample.'}).waitFor();
  await page.getByRole('button',{name:/Product Analyst/}).waitFor();
  const saved=await page.evaluate(()=>window.pluto.call('workspace.snapshot'));
  assert.equal(saved.profile.budget.jobsPerDay,25);
  assert.equal(saved.notes.length,1);assert.equal(saved.jobs[0].submittedSnapshot.evidence,'Example portal receipt');
  console.log('Desktop verified: navigation, application target, receipt, private notes and restart persistence.');
}finally{if(app)await app.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:250});}
