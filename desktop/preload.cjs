const {contextBridge,ipcRenderer}=require('electron');
const actions=new Set(['workspace.snapshot','workspace.saveProfile','workspace.saveReviewedProfile','workspace.saveJob','workspace.saveNote','workspace.saveSchedule','workspace.importVault','workspace.exportVault','providers.settings','providers.subscriptionStatus','providers.models','providers.fallbackStatus','providers.enableFallback','providers.disableFallback','providers.setFallbackModel','providers.configure','providers.disconnect','providers.test','providers.draft','providers.search','mail.settings','mail.appleAccounts','mail.connect','mail.disconnect','mail.scan','drive.settings','drive.importRegistration','drive.connect','drive.disconnect','drive.cancel','application.drivePdf','resume.pick','application.open','application.pdf','app.openExternal','discovery.search','discovery.status','sources.list','sources.add','sources.setEnabled','sources.remove']);
contextBridge.exposeInMainWorld('pluto',Object.freeze({platform:process.platform,call(action,data={}){
  if(!actions.has(action))return Promise.reject(new Error('Unsupported workspace action.'));
  return ipcRenderer.invoke('pluto:action',action,data);
}}));
