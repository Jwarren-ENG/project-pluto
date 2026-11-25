// Exercise the actual desktop renderer and restricted main-process bridge with disposable local data.
import { _electron as electron } from 'playwright';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const dir=await mkdtemp(path.join(os.tmpdir(),'pluto-desktop-test-'));
const executablePath=process.env.PLUTO_EXECUTABLE || process.env.PLUTO_SMOKE_EXECUTABLE;
const args=['--user-data-dir='+dir,...(executablePath?[]:['.'])];
async function checkUnsavedEditors(page){
  const nav=page.getByRole('navigation');
  const button=name=>page.getByRole('button',{name,exact:true});
  for(const item of [
    {view:'Applications',kind:'application',open:'Open Product Analyst at Example Company',field:'Application draft',save:'Save application',other:'Notebook'},
    {view:'Notebook',kind:'note',open:'Edit Interview notes',field:'Markdown',save:'Save note',other:'Today'},
  ]){
    const navigate=where=>nav.getByRole('button',{name:where,exact:true}).click();
    const dialog=page.getByRole('alertdialog',{name:'Discard your '+item.kind+' edits?'});
    const field=page.getByLabel(item.field,{exact:true});
    await navigate(item.view);
    await button(item.open).click();
    const original=await field.inputValue();
    const draft='Unsaved '+item.kind+' draft';
    await field.fill(draft);
    await navigate(item.other);
    await dialog.waitFor();
    const keep=dialog.getByRole('button',{name:'Keep editing'});
    assert.ok(await keep.evaluate(el=>el===document.activeElement));
    await keep.click();
    assert.equal(await field.inputValue(),draft);
    // Notebook stays on the same editor; Applications explicitly returns to its list.
    await navigate(item.view);
    if(item.view==='Applications'){
      await dialog.waitFor();
      await page.keyboard.press('Escape');
    }
    assert.equal(await field.inputValue(),draft);
    await button('Close').click();
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await field.inputValue(),draft);
    await button('Close').click();
    await dialog.getByRole('button',{name:'Discard changes'}).click();
    await button(item.open).click();
    assert.equal(await field.inputValue(),original);
    await field.fill(draft);
    await navigate(item.other);
    await dialog.getByRole('button',{name:'Discard changes'}).click();
    await page.getByRole('heading',{name:item.other,exact:true,level:1}).waitFor();
    await navigate(item.view);
    await button(item.open).click();
    assert.equal(await field.inputValue(),original);
    await field.fill(draft);
    await field.fill(original);
    await button('Close').click();
    await button(item.open).click(); // Reverting the edit should leave cleanly.
    await field.fill('Saved '+item.kind);
    await button(item.save).click();
    await button('Close').click();
    await button(item.open).click(); // Successful saves should leave cleanly too.
    assert.equal(await field.inputValue(),'Saved '+item.kind);
    await navigate(item.other);
    await page.getByRole('heading',{name:item.other,exact:true,level:1}).waitFor();
  }
}

let app;
try{
  app=await electron.launch({args, ...(executablePath?{executablePath}:{}),timeout:45000});
  let page=await app.firstWindow();
  const faults=[];
  page.on('pageerror',e=>faults.push(e.message));
  await page.getByRole('heading',{name:'Today', exact:true}).waitFor();
  assert.equal(await page.locator('.brand img').evaluate(img=>img.complete&&img.naturalWidth>0),true);
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
  assert.equal(await slider.getAttribute('aria-valuenow'),'25');
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
  await page.reload();
  await checkUnsavedEditors(page);
  assert.deepEqual(faults,[]);
  await app.close();app=null;
  app=await electron.launch({args,...(executablePath?{executablePath}:{}),timeout:45000});
  page=await app.firstWindow();
  await page.getByRole('heading',{name:'Today',exact:true}).waitFor();
  await page.getByRole('tab',{name:/Submitted/}).click();
  await page.getByRole('button',{name:/Product Analyst/}).waitFor();
  const saved=await page.evaluate(()=>window.pluto.call('workspace.snapshot'));
  assert.equal(saved.profile.budget.jobsPerDay,25);
  assert.equal(saved.notes.length,1);assert.equal(saved.jobs[0].submittedSnapshot.evidence,'Example portal receipt');
  console.log('Desktop verified: navigation, application target, receipt, private notes and restart persistence.');
}finally{if(app)await app.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:250});}
