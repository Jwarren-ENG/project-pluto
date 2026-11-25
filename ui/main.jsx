import React,{useCallback,useEffect,useState} from 'react';
import { createRoot } from 'react-dom/client';
import { CalendarCheck, Search, BriefcaseBusiness, NotebookPen, Mail as MailIcon, UserRound, Cable, SlidersHorizontal, X } from 'lucide-react';
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
import './style.css';

const groups=[
  [['Today',CalendarCheck],['Applications',BriefcaseBusiness],['Discover',Search],['Notebook',NotebookPen],['Mail',MailIcon]],
  [['Daily budget',SlidersHorizontal],['Profile',UserRound],['Connections',Cable]]
];
const panels={Today,Discover,Applications,Notebook,Mail,Profile,Connections,'Daily budget':Budget};

function App(){
  const [state,setState]=useState(null),[view,go]=useState('Today'),[seed,setSeed]=useState(null),[notice,setNotice]=useState(''),[loadError,setLoadError]=useState('');
  const refresh=useCallback(async()=>{const s=await window.pluto.call('workspace.snapshot');setState(s);setLoadError('');return s;},[]);
  useEffect(()=>{refresh().catch(e=>setLoadError(e.message));},[refresh]);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),9000);return ()=>clearTimeout(timer);},[notice]);
  const edit=value=>{setSeed(value.id?{id:value.id}:value);go('Applications');};
  const props={state,refresh,notify:setNotice,go,edit,seed,setSeed};
  const Panel=panels[view];
  const platform=window.pluto?.platform;
  return <div className={'shell platform-'+platform}>
    <aside className="sidebar"><div className="drag-area"/>
      <div className="brand"><img src="./pluto.jpg" alt=""/><strong>Project Pluto</strong></div>
      <nav aria-label="Workspace">{groups.map((group,i)=><React.Fragment key={i}>{i>0&&<Separator/>}{group.map(([label,Icon])=>
        <Button variant="ghost" key={label} className="nav-item" aria-label={label} aria-current={view===label?'page':undefined} onClick={()=>{if(label==='Applications')setSeed(null);go(label);}}><Icon size={17} strokeWidth={1.6}/><span>{label}</span></Button>
      )}</React.Fragment>)}</nav>
      <div className="local-mark"><span className="local-dot"/> Local workspace</div>
    </aside>
    <main><div className="window-line"><span>Workspace</span><span aria-hidden="true">/</span><strong>{view}</strong></div>
      <div className="content" key={view}>{state?<>{view!=='Today'&&<header className="page-heading"><h1>{view}</h1></header>}<Panel {...props}/></>:
      loadError?<section className="panel"><h1>Workspace unavailable</h1><p role="alert">{loadError}</p><Button onClick={()=>refresh().catch(e=>setLoadError(e.message))}>Try again</Button></section>:<p role="status">Opening your workspace…</p>}</div>
    </main>
    {notice&&<div className="toast" role="status"><span>{notice}</span><Button size="icon" variant="ghost" aria-label="Dismiss notification" onClick={()=>setNotice('')}><X size={15}/></Button></div>}
  </div>;
}
class ErrorBoundary extends React.Component{
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<section className="panel"><h1>Reopen your workspace</h1><Button onClick={()=>window.location.reload()}>Reload Project Pluto</Button></section>:this.props.children;}
}
createRoot(document.getElementById('root')).render(<ErrorBoundary><App/></ErrorBoundary>);
