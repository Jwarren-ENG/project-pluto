import {app,BrowserWindow,Menu,dialog,ipcMain,safeStorage,session,shell} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createWorkspace} from './workspace.mjs';
import {createConfig} from './config.mjs';
import {createProviders} from './providers.mjs';
import {createMail} from './mail.mjs';
import {createResume} from './resume.mjs';
import {scheduler} from './schedule.mjs';
import {fillContacts,webUrl} from './web.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const entry=pathToFileURL(path.join(here,'../dist/index.html')).href;
let win,workspace,config,timer;
app.setName('PROJECT PLUTO');
if(!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',()=>{if(win?.isMinimized())win.restore();win?.focus();});
  app.whenReady().then(start).catch(error=>{dialog.showErrorBox('PROJECT PLUTO could not start',error.message);app.quit();});
}
app.on('window-all-closed',()=>app.quit());
app.on('will-quit',()=>{clearInterval(timer);workspace?.close();config?.close();});

function denyDevices(s){
  s.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  s.setPermissionCheckHandler(()=>false);
}
function jobById(id){
  const job=workspace.snapshot().jobs.find(record=>record.id===id);
  if(!job)throw new Error('This application could not be found.');
  return job;
}
function openApplication(id){
  const job=jobById(id), url=webUrl(job.url);
  const remote=new BrowserWindow({width:1080,height:820,title:job.title+' · '+job.company,webPreferences:{partition:'persist:pluto-employers',sandbox:true,nodeIntegration:false,contextIsolation:true,webSecurity:true}});
  const renderer=remote.webContents;
  denyDevices(renderer.session);
  const guarded=(event,target)=>{try{webUrl(target);}catch{event.preventDefault();}};
  renderer.on('will-navigate',guarded);renderer.on('will-redirect',guarded);
  renderer.setWindowOpenHandler(({url:target})=>{try{const dest=webUrl(target);setImmediate(()=>{if(!remote.isDestroyed())remote.loadURL(dest).catch(()=>{});});}catch{}return {action:'deny'};});
  const fill=async()=>{
    const profile=workspace.snapshot().profile || {};
    const current=webUrl(renderer.getURL());
    const {response}=await dialog.showMessageBox(remote,{type:'question',buttons:['Cancel','Fill contact fields'],defaultId:0,cancelId:0,message:'Fill empty contact fields on '+new URL(current).hostname+'?',detail:'Only confirmed full name, email and phone are used. Review the answers on the form before submitting.'});
    if(response!==1||remote.isDestroyed()||renderer.getURL()!==current)return;
    const selected=Object.fromEntries(['name','email','phone'].map(k=>[k,typeof profile[k]==='string'?profile[k]:'']));
    const n=await renderer.executeJavaScript('('+fillContacts.toString()+')('+JSON.stringify(selected)+')');
    await dialog.showMessageBox(remote,{message:n+' contact field'+(n===1?'':'s')+' filled.'});
  };
  renderer.on('context-menu',()=>Menu.buildFromTemplate([{label:'Fill confirmed contact fields',click:()=>fill().catch(()=>{})},{role:'copy'},{role:'paste'},{role:'selectAll'}]).popup({window:remote}));
  renderer.on('before-input-event',(event,input)=>{if(input.type==='keyDown' && (input.meta||input.control) && input.shift && input.key.toLowerCase()==='f'){event.preventDefault();fill().catch(()=>{});}});
  return remote.loadURL(url).then(()=>true);
}
async function exportPdf(job){
  const text=job.resumeText?.trim();
  if(!text)throw new Error('Save your reviewed résumé text for this role first.');
  const result=await dialog.showSaveDialog(win,{title:'Save reviewed résumé',defaultPath:'Resume.pdf',filters:[{name:'PDF document',extensions:['pdf']}]});
  if(result.canceled)return false;
  const paper=new BrowserWindow({show:false,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,javascript:false}});
  const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  try{
    await paper.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<meta charset=utf-8><style>body{white-space:pre-wrap;overflow-wrap:anywhere;font:11pt/1.45 Arial,sans-serif;color:#171717}</style><body>'+escape(text)));
    const bytes=await paper.webContents.printToPDF({pageSize:'Letter',margins:{top:0.65,bottom:0.65,left:0.7,right:0.7}});
    fs.writeFileSync(result.filePath,bytes,{mode:0o600});return true;
  }finally{paper.destroy();}
}
async function start(){
  const dir=app.getPath('userData');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  workspace=createWorkspace(dir);config=createConfig(dir,safeStorage);
  const openExternal=url=>shell.openExternal(webUrl(url));
  const providers=createProviders({...config,openExternal}), mail=createMail({...config,openExternal});
  const resume=createResume({dialog,window:()=>win});
  denyDevices(session.defaultSession);
  const methods={
    'workspace.snapshot':()=>workspace.snapshot(),
    'workspace.saveJob':p=>workspace.saveJob(p),'workspace.saveNote':p=>workspace.saveNote(p),
    'workspace.saveProfile':p=>workspace.saveProfile(p),
    'workspace.saveSchedule':p=>workspace.saveSchedule({...p,lastRunDate:workspace.snapshot().schedule?.lastRunDate||''}),
    'discovery.status':()=>({latest:config.prefs.get('discoveryResults'),run:config.prefs.get('discoveryRun')}),
    'application.open':p=>openApplication(p.id),'application.pdf':p=>exportPdf(jobById(p.id)),
    'app.openExternal':p=>openExternal(p.url),'resume.pick':()=>resume.pick()
  };
  for(const action of ['settings','configure','test','disconnect','draft','search'])methods['providers.'+action]=p=>providers[action](p);
  for(const action of ['settings','connect','disconnect','scan'])methods['mail.'+action]=p=>mail[action](p);
  for(const action of ['importVault','exportVault'])methods['workspace.'+action]=async()=>{
    const result=await dialog.showOpenDialog(win,{title:action==='exportVault'?'Choose a folder for your Obsidian export':'Choose the folder containing your Pluto vault',properties:['openDirectory','createDirectory']});
    return result.canceled?null:workspace[action](result.filePaths[0]);
  };
  ipcMain.handle('pluto:action',async(event,key,payload)=>{
    if(!win || event.sender!==win.webContents || event.senderFrame!==win.webContents.mainFrame || event.senderFrame.url.split('#')[0]!==entry || !Object.hasOwn(methods,key))throw new Error('This action is unavailable here.');
    if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('Invalid action details.');
    return await methods[key](payload);
  });
  win=new BrowserWindow({width:1260,height:850,minWidth:740,minHeight:570,show:false,backgroundColor:'#f8f9fb',title:'PROJECT PLUTO',
    ...(process.platform==='darwin'?{titleBarStyle:'hiddenInset',trafficLightPosition:{x:20,y:17}}:{}),
    webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,preload:path.join(here,'preload.cjs')}});
  win.webContents.on('will-navigate',e=>e.preventDefault());win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.once('ready-to-show',()=>win.show());win.on('closed',()=>{win=null;});
  await win.loadURL(entry);
  const tick=scheduler({workspace,prefs:config.prefs,search:p=>providers.search(p)});
  timer=setInterval(()=>tick().catch(()=>{}),45000);await tick();
}
