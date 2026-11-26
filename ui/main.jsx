import React,{useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import { createRoot } from 'react-dom/client';
import { CalendarCheck, Search, BriefcaseBusiness, NotebookPen, Mail as MailIcon, UserRound, Cable, SlidersHorizontal, ListStart, X } from 'lucide-react';
import { Button } from './components/ui/button';
import { Separator } from './components/ui/separator';
import Today from './Today.jsx';
import Applications from './Applications.jsx';
import Notebook from './Notebook.jsx';
import Connections from './Connections.jsx';
import Profile from './Profile.jsx';
import Mail from './Mail.jsx';
import Budget from './Budget.jsx';
import Discover from './Discover.jsx';
import FirstRun, { initialSetup, replaySetup } from './FirstRun.jsx';
import './style.css';

const groups=[
  [['Today',CalendarCheck],['Applications',BriefcaseBusiness],['Discover',Search],['Notebook',NotebookPen],['Mail',MailIcon]],
  [['Daily budget',SlidersHorizontal],['Profile',UserRound],['Connections',Cable]]
];
const panels={Today,Discover,Applications,Notebook,Mail,Profile,Connections,'Daily budget':Budget};
const viewLabel=view=>view==='Mail'?'Job mail':view;

function DiscardDialog({kind,keep,discard}){
  const dialog=useRef(null);
  useLayoutEffect(()=>{
    const element=dialog.current;
    element.showModal();
    return ()=>element.close();
  },[]);
  return <dialog ref={dialog} role="alertdialog" aria-labelledby="discard-title" aria-describedby="discard-description"
    className="fixed inset-0 m-auto w-[min(26rem,90vw)] border bg-background p-5 text-foreground backdrop:bg-black/35"
    onCancel={event=>{event.preventDefault();keep();}}>
    <h2 id="discard-title">Discard your {kind} edits?</h2>
    <p id="discard-description">Your unsaved changes will be lost.</p>
    <div className="toolbar">
      <Button type="button" autoFocus onClick={keep}>Keep editing</Button>
      <Button type="button" variant="outline" onClick={discard}>Discard changes</Button>
    </div>
  </dialog>;
}

function App(){
  const [state,setState]=useState(null),[view,setView]=useState('Today'),[seed,setSeed]=useState(null),[notice,setNotice]=useState(''),[loadError,setLoadError]=useState('');
  const version=useRef(null);
  const opened=useRef(false),focusDashboard=useRef(false),dashboard=useRef(null);
  const [setup,setSetup]=useState(null);
  const refresh=useCallback(async()=>{
    const snapshot=await window.pluto.call('workspace.snapshot');
    if(!opened.current){
      setSetup(initialSetup(snapshot));
      opened.current=true;
    }
    version.current=snapshot.dataVersion;
    setState(snapshot);
    setLoadError('');
    return snapshot;
  },[]);
  useEffect(()=>{
    let checking=false;
    let disposed=false;
    async function checkLocalChanges(){
      if(checking || document.hidden || version.current==null)return;
      checking=true;
      try{
        const latest=await window.pluto.call('workspace.dataVersion');
        if(!disposed && latest!==version.current)await refresh();
      }catch{/* Retain the open workspace and retry on the next check. */}
      finally{checking=false;}
    }
    const timer=window.setInterval(checkLocalChanges,60_000);
    window.addEventListener('focus',checkLocalChanges);
    document.addEventListener('visibilitychange',checkLocalChanges);
    return ()=>{
      disposed=true;
      window.clearInterval(timer);
      window.removeEventListener('focus',checkLocalChanges);
      document.removeEventListener('visibilitychange',checkLocalChanges);
    };
  },[refresh]);
  useEffect(()=>{refresh().catch(e=>setLoadError(e.message));},[refresh]);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),9000);return ()=>clearTimeout(timer);},[notice]);
  const [entrySection,setEntrySection]=useState(null);
  const editorStatus=useRef(null);
  const [leave,setLeave]=useState(null);
  const reportEditor=useCallback(status=>{editorStatus.current=status;},[]);
  function requestLeave(proceed){
    const editor=editorStatus.current;
    if(editor?.working){setNotice(editor.working);return;}
    if(editor?.dirty){setLeave({kind:editor.kind,proceed});return;}
    proceed();
  }
  const go=(destination,section=null)=>{
    if(destination===view && !(view==='Applications' && seed))return;
    requestLeave(()=>{
      if(destination==='Applications')setSeed(null);
      setEntrySection(section);
      setView(destination);
    });
  };
  const edit=value=>requestLeave(()=>{setSeed(value.id?{id:value.id}:value);setView('Applications');});
  const props={state,refresh,entrySection,notify:setNotice,go,edit,seed,setSeed,reportEditor,requestLeave};
  const Panel=panels[view];
  const platform=window.pluto?.platform;
  useLayoutEffect(()=>{
    if(!setup && focusDashboard.current){
      dashboard.current?.focus();
      focusDashboard.current=false;
    }
  },[setup]);
  function openSetup(){
    requestLeave(()=>{
      try{setSetup(replaySetup());}
      catch{setNotice('Could not open setup. Check the available disk space and try again.');}
    });
  }
  function closeSetup(){
    focusDashboard.current=true;
    setView('Today');
    setSeed(null);
    setSetup(null);
  }
  if(!state)return <main className="content">{loadError?
    <section className="panel"><h1>Workspace unavailable</h1><p role="alert">{loadError}</p>
      <Button onClick={()=>refresh().catch(e=>setLoadError(e.message))}>Try again</Button>
    </section>:<p role="status">Opening your workspace…</p>}</main>;
  const toast=notice&&<div className="toast" role="status"><span>{notice}</span>
    <Button size="icon" variant="ghost" aria-label="Dismiss notification" onClick={()=>setNotice('')}><X size={15}/></Button>
  </div>;
  if(setup)return <><FirstRun initial={setup} state={state} refresh={refresh} notify={setNotice} onExit={closeSetup}/>{toast}</>;
  return <div className={'shell platform-'+platform}>
    <aside className="sidebar"><div className="drag-area"/>
      <div className="brand"><img src="./pluto.jpg" alt=""/><strong>Project Pluto</strong></div>
      <nav aria-label="Workspace">{groups.map((group,i)=><React.Fragment key={i}>{i>0&&<Separator/>}{group.map(([label,Icon])=>
        <Button variant="ghost" key={label} className="nav-item" aria-label={viewLabel(label)} aria-current={view===label?'page':undefined} onClick={()=>go(label)}><Icon size={17} strokeWidth={1.6}/><span>{viewLabel(label)}</span></Button>
      )}</React.Fragment>)}<Button variant="ghost" className="nav-item" aria-label="Open setup" title="Open setup" onClick={openSetup}><ListStart size={17} strokeWidth={1.6}/><span>Open setup</span></Button></nav>
      <div className="local-mark"><span className="local-dot"/> Local workspace</div>
    </aside>
    <main tabIndex={-1} ref={dashboard} aria-label={viewLabel(view)}><div className="window-line"><span>Workspace</span><span aria-hidden="true">/</span><strong>{viewLabel(view)}</strong></div>
      <div className="content" key={view}>{view!=='Today'&&<header className="page-heading"><h1>{viewLabel(view)}</h1></header>}<Panel {...props}/></div>
    </main>
    {leave&&<DiscardDialog kind={leave.kind} keep={()=>setLeave(null)} discard={()=>{setLeave(null);leave.proceed();}}/>}
    {toast}
  </div>;
}
class ErrorBoundary extends React.Component{
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<section className="panel"><h1>Reopen your workspace</h1><Button onClick={()=>window.location.reload()}>Reload Project Pluto</Button></section>:this.props.children;}
}
createRoot(document.getElementById('root')).render(<ErrorBoundary><App/></ErrorBoundary>);
