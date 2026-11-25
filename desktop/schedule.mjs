export function localDay(date) {
  return [date.getFullYear(), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')].join('-');
}
export function scheduler({workspace,prefs,search,clock=()=>new Date()}) {
  let running=false;
  return async function tick(){
    const s=workspace.snapshot().schedule;
    const now=clock(), day=localDay(now);
    if(running || !s?.enabled || !s.query?.trim() || s.lastRunDate===day || now.getHours()*60+now.getMinutes()<s.hour*60+s.minute)return;
    running=true;
    try{
      // Reserve before the network request. Restarting the app cannot bill a second search today.
      workspace.saveSchedule({...s,lastRunDate:day});
      prefs.set('discoveryRun',{at:now.toISOString(),query:s.query,status:'Started'});
      const found=await search({query:s.query});
      const {results,sources=[]}=Array.isArray(found)?{results:found}:found;
      prefs.set('discoveryResults',{at:now.toISOString(),query:s.query,results,sources});
      prefs.set('discoveryRun',{at:now.toISOString(),query:s.query,status:sources.some(source=>source.error)?'Finished with source errors':'Finished',count:results.length});
    }catch{
      prefs.set('discoveryRun',{at:now.toISOString(),query:s.query,status:'Failed. Check your sources or run a search manually.'});
    }finally{running=false;}
  };
}
