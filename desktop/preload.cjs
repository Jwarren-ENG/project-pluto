const {contextBridge,ipcRenderer}=require('electron');
const actions=new Set(['workspace.snapshot','workspace.saveProfile','workspace.saveJob','workspace.saveNote','workspace.saveSchedule','workspace.importVault','workspace.exportVault','providers.settings','providers.configure','providers.disconnect','providers.test','providers.draft','providers.search','mail.settings','mail.connect','mail.disconnect','mail.scan','resume.pick','application.open','application.pdf','app.openExternal','discovery.status']);
contextBridge.exposeInMainWorld('pluto',Object.freeze({platform:process.platform,call(action,data={}){
  if(!actions.has(action))return Promise.reject(new Error('Unsupported workspace action.'));
  return ipcRenderer.invoke('pluto:action',action,data);
}}));
