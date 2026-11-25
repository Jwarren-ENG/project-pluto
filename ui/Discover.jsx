import React,{useState,useEffect} from 'react';
import {Button} from './components/ui/button';
import {Input} from './components/ui/input';
import {Search,ArrowRight} from 'lucide-react';
import DiscoverySources from './DiscoverySources.jsx';
import {webUrl} from '../desktop/web.mjs';
const call=(action,data)=>window.pluto.call(action,data);
const displayTime=s=>[s.hour,s.minute].map(v=>String(v).padStart(2,'0')).join(':');

function PostingSource({source,url,notify}){
  let href;
  try{href=webUrl(url);}catch{/* Older results can contain an incomplete address. */}
  function open(event){
    event.preventDefault();
    call('app.openExternal',{url:href}).catch(error=>notify(error.message || 'Couldn’t open this posting in your browser.'));
  }
  return <span className="source-url">{source && source+' · '}{href
    ? <a href={href} title="Open posting in your browser" onClick={open} onAuxClick={event=>{if(event.button===1)open(event);}}>{url}</a>
    : url}</span>;
}
export default function Discover({state,refresh,notify,edit,go}){
  const [sourceCount,setSourceCount]=useState({active:0,total:0});
  const [schedule,setSchedule]=useState(state.schedule);
  const [query,setQuery]=useState(state.schedule.query||[state.profile?.targetRoles,state.profile?.location].filter(Boolean).join(' '));
  const [items,setItems]=useState(null),[run,setRun]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{let live=true;call('discovery.status').then(r=>{if(live){setRun(r.run);if(r.latest)setItems(r.latest);}}).catch(e=>{if(live)setError(e.message);});return ()=>{live=false;};},[]);
  async function search(e){e.preventDefault();setError('');setBusy(true);
    try{const found=await call('discovery.search',{query:query.trim()});setItems(found);}catch(e){setError(e.message);}finally{setBusy(false);}
  }
  async function save(e){e.preventDefault();setBusy(true);setError('');
    try{await call('workspace.saveSchedule',schedule);await refresh();notify('Daily search settings saved.');}catch(e){setError(e.message);}finally{setBusy(false);}
  }
  return <div className="stack"><section className="panel"><h2>Search job postings</h2>
    <form onSubmit={search}><label>Role and location<Input required maxLength={1000} value={query} onChange={e=>setQuery(e.target.value)} placeholder="Product operations in your city"/></label>
    <div className="actions"><Button className="primary" disabled={busy||!query.trim()||(sourceCount.total>0 && sourceCount.active===0)}><Search size={16}/> {busy?'Working…':sourceCount.total ? 'Search saved sources' : 'Search with Firecrawl'}</Button><Button type="button" onClick={()=>go('Connections')}>Manage connection</Button></div></form>
    {sourceCount.total>0 && sourceCount.active===0 && <p role="status">Select a source below to search it.</p>}{error&&<p role="alert">{error}</p>}</section>
    <DiscoverySources onCount={setSourceCount}/>
    {items&&<section className="panel"><div className="section-heading"><h2>Search results</h2><span>{items.results.length} results</span></div><p className="muted">{items.query}</p>
    {items.sources?.map((s,i)=><p className="muted" key={i}>{s.label} · {s.error || (s.count + (s.count === 1 ? ' match' : ' matches'))}</p>)}
    {items.results.length?items.results.map((r,i)=><article className="result" key={r.url+i}><h3>{r.title}</h3><PostingSource source={r.source} url={r.url} notify={notify}/><p>{r.description}</p><Button onClick={()=>edit({url:r.url,title:r.title,description:r.description,company:r.company,location:r.location})}>Review role <ArrowRight size={14}/></Button></article>):<p>{items.sources?.some(s=>s.error) ? 'Review the source status above before trying again.' : 'No matching roles. Try a broader title or location.'}</p>}</section>}
    <section className="panel"><h2>Daily discovery</h2><p>Search once a day while the app is open. Results stay here for review. Enabled sources are checked at the scheduled time. GitHub job lists are free to read. Other websites use Firecrawl.</p>
    <form onSubmit={save}><label className="check"><input type="checkbox" checked={schedule.enabled} onChange={e=>setSchedule({...schedule,enabled:e.target.checked})}/> Enable daily search</label>
    <div className="field-grid"><label>Scheduled query<Input required={schedule.enabled} value={schedule.query} onChange={e=>setSchedule({...schedule,query:e.target.value})}/></label>
    <label>Local time<Input type="time" required value={displayTime(schedule)} onChange={e=>{const [hour,minute]=e.target.value.split(':').map(Number);if(Number.isInteger(minute))setSchedule({...schedule,hour,minute});}}/></label></div>
    <Button disabled={busy}>Save schedule</Button></form>{run&&<p className="muted">Last run · {new Date(run.at).toLocaleString()} · {run.status}</p>}</section></div>;
}
