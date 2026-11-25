import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LayoutDashboard, Search, BriefcaseBusiness, NotebookPen, Mail as MailIcon, UserRound, Cable, SlidersHorizontal, ArrowRight, Plus, Orbit, CalendarDays } from 'lucide-react';
import Applications from './Applications.jsx';
import Notebook from './Notebook.jsx';
import Connections from './Connections.jsx';
import Profile from './Profile.jsx';
import Mail from './Mail.jsx';
import Budget from './Budget.jsx';
import Discover from './Discover.jsx';
import './style.css';

const views = [
  ['Overview', LayoutDashboard], ['Discover', Search], ['Applications', BriefcaseBusiness],
  ['Notebook', NotebookPen], ['Mail', MailIcon], ['Daily budget', SlidersHorizontal],
  ['Profile', UserRound], ['Connections', Cable]
];
const subtitles = {
  Discover: 'Find openings and schedule your next search.',
  Applications: 'Track each role from first look to employer response.',
  Notebook: 'Keep research and interview notes with the roles they belong to.',
  Mail: 'Review employer replies from a connected account.',
  'Daily budget': 'Plan how many applications you can work on each day.',
  Profile: 'Choose the experience and preferences to use in your applications.',
  Connections: 'Choose your AI provider and job search services.'
};
function Logo(){ return <div className="brand"><Orbit size={31} strokeWidth={1.5}/><strong>PROJECT PLUTO</strong></div>; }
function Overview({state,go,edit}){
  const name=state.profile?.name || '';
  const jobs=state.jobs;
  const interviews=jobs.filter(j=>j.stage==='Interview').sort((a,b)=>(a.interviewAt || 'z').localeCompare(b.interviewAt || 'z'));
  const next=interviews.find(j=>j.interviewAt && Date.parse(j.interviewAt)>=Date.now());
  const first=!state.profile?.resumeText;
  const target=state.profile?.budget?.jobsPerDay;
  const today=new Date().toDateString();
  const todayCount=jobs.filter(j=>j.submittedSnapshot?.submittedAt && new Date(j.submittedSnapshot.submittedAt).toDateString()===today).length;
  const counts=[['Saved roles',jobs.length],['In preparation',jobs.filter(j=>j.stage==='Preparing').length],['Submitted',jobs.filter(j=>!!j.submittedSnapshot).length],['Interviews',interviews.length]];
  return <>
    <div className="hero"><img src="./pluto.jpg" alt="" /><div className="hero-copy"><p className="hero-date">{new Date().toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'})}</p><h1>{name ? 'Welcome back, '+name.split(' ')[0]+'.' : 'Your application desk.'}</h1><p>{first ? 'Start with your résumé. Keep applications and interviews together as your search grows.' : next ? 'Your next interview is with '+next.company+'.' : 'Pick up a saved role or find your next opportunity.'}</p><button className="hero-button" onClick={()=>first?go('Profile'):next?edit(next):go('Discover')}>{first?'Start with your résumé':next?'Open interview':'Discover roles'} <ArrowRight size={16}/></button></div></div>
    <div className="metrics">{counts.map(([label,n])=><button key={label} onClick={()=>go('Applications')}><strong>{n}</strong><span>{label}</span></button>)}</div>
    {Number.isInteger(target)&&<section className="panel daily-progress"><div className="section-heading"><h2>Today's applications</h2><button className="text-button" onClick={()=>go('Daily budget')}>Adjust target</button></div><p>{todayCount} verified {todayCount===1?'submission':'submissions'}{target?' of '+target+' planned today.':'. Daily target is paused.'}</p>{target>0&&<progress aria-label="Daily application progress" value={Math.min(todayCount,target)} max={target}/>}</section>}
    <section className="panel"><div className="section-heading"><h2>Interviews</h2><CalendarDays size={19}/></div>{interviews.length? interviews.map(j=><button key={j.id} className="record-row" onClick={()=>edit(j)}><span><strong>{j.company}</strong><small>{j.title}</small></span><span>{j.interviewAt?new Date(j.interviewAt).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'Date pending'}</span></button>):<p className="empty">Scheduled interviews appear here when you record an invitation.</p>}</section>
    <section className="panel"><div className="section-heading"><h2>Recent applications</h2><button className="text-button" onClick={()=>edit({})}><Plus size={16}/> Add role</button></div>{jobs.length?jobs.slice(0,5).map(j=><button className="record-row" key={j.id} onClick={()=>edit(j)}><span><strong>{j.title}</strong><small>{j.company}</small></span><span className="stage">{j.stage}</span></button>):<p className="empty">Save an employer posting to start your first application.</p>}</section>
  </>;
}
function App(){
  const [state,setState]=useState(null),[view,go]=useState('Overview'),[seed,setSeed]=useState(null),[notice,setNotice]=useState(''),[loadError,setLoadError]=useState('');
  const refresh=useCallback(async()=>{const s=await window.pluto.call('workspace.snapshot');setState(s);setLoadError('');return s;},[]);
  useEffect(()=>{refresh().catch(e=>setLoadError(e.message));},[refresh]);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),9000);return ()=>clearTimeout(timer);},[notice]);
  const edit=value=>{setSeed(value.id?{id:value.id}:value);go('Applications');};
  const props={state,refresh,notify:setNotice,go,edit,seed,setSeed};
  const panels={Overview,Discover,Applications,Notebook,Mail,Profile,Connections,'Daily budget':Budget};
  const Panel=panels[view];
  return <div className="shell"><aside><div className="drag-area"></div><Logo/><nav aria-label="Workspace">{views.map(([label,Icon],i)=><button key={label} className={(view===label?'active ':'')+(i===5?'divider':'')} aria-current={view===label?'page':undefined} onClick={()=>{if(label==='Applications')setSeed(null);go(label);}}><Icon size={19} strokeWidth={1.7}/><span>{label}</span></button>)}</nav><div className="local-mark"><i/> Local workspace</div></aside>
    <main><div className="titlebar">Workspace <span>/</span> {view}</div>
    <div className="content" key={view}>{state ? <>{view!=='Overview'&&<header className="page-heading"><h1>{view}</h1><p>{subtitles[view]}</p></header>}<Panel {...props}/></> : loadError?<section className="panel"><h2>Workspace unavailable</h2><p role="alert">{loadError}</p><button onClick={()=>refresh().catch(e=>setLoadError(e.message))}>Try again</button></section>:<p role="status">Opening your workspace…</p>}</div></main>
    {notice&&<div className="toast" role="status"><span>{notice}</span><button aria-label="Dismiss notification" onClick={()=>setNotice('')}>×</button></div>}</div>;
}
class ErrorBoundary extends React.Component{
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<section className="panel"><h1>Reopen your workspace</h1><button onClick={()=>window.location.reload()}>Reload PROJECT PLUTO</button></section>:this.props.children;}
}
createRoot(document.getElementById('root')).render(<ErrorBoundary><App/></ErrorBoundary>);
