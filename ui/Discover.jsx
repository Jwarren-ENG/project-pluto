import React,{useState,useEffect} from 'react';
import {Button} from './components/ui/button';
import {Input} from './components/ui/input';
import {Search,ArrowRight} from 'lucide-react';
const call=(action,data)=>window.pluto.call(action,data);
const displayTime=s=>[s.hour,s.minute].map(v=>String(v).padStart(2,'0')).join(':');
export default function Discover({state,refresh,notify,edit,go}){
  const [schedule,setSchedule]=useState(state.schedule);
  const [query,setQuery]=useState(state.schedule.query||[state.profile?.targetRoles,state.profile?.location].filter(Boolean).join(' '));
  const [items,setItems]=useState(null),[run,setRun]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{let live=true;call('discovery.status').then(r=>{if(live){setRun(r.run);if(r.latest)setItems(r.latest);}}).catch(e=>{if(live)setError(e.message);});return ()=>{live=false;};},[]);
  async function search(e){e.preventDefault();setError('');setBusy(true);
    try{const results=await call('providers.search',{query:query.trim()});setItems({query:query.trim(),results});}catch(e){setError(e.message);}finally{setBusy(false);}
  }
  async function save(e){e.preventDefault();setBusy(true);setError('');
    try{await call('workspace.saveSchedule',schedule);await refresh();notify('Daily search settings saved.');}catch(e){setError(e.message);}finally{setBusy(false);}
  }
  return <div className="stack"><section className="panel"><h2>Search job postings</h2>
    <form onSubmit={search}><label>Role and location<Input required maxLength={1000} value={query} onChange={e=>setQuery(e.target.value)} placeholder="Product operations in your city"/></label>
    <div className="actions"><Button className="primary" disabled={busy||!query.trim()}><Search size={16}/> {busy?'Working…':'Search with Firecrawl'}</Button><Button type="button" onClick={()=>go('Connections')}>Manage connection</Button></div></form>
    {error&&<p role="alert">{error}</p>}</section>
    {items&&<section className="panel"><div className="section-heading"><h2>Search results</h2><span>{items.results.length} results</span></div><p className="muted">{items.query}</p>
    {items.results.length?items.results.map((r,i)=><article className="result" key={r.url+i}><h3>{r.title}</h3><span className="source-url">{r.url}</span><p>{r.description}</p><Button onClick={()=>edit({url:r.url,title:r.title,description:r.description})}>Review role <ArrowRight size={14}/></Button></article>):<p>No results for this query. Try a broader role title or location.</p>}</section>}
    <section className="panel"><h2>Daily discovery</h2><p>Search once a day while the app is open. Results stay here for review. Each search uses your Firecrawl account.</p>
    <form onSubmit={save}><label className="check"><input type="checkbox" checked={schedule.enabled} onChange={e=>setSchedule({...schedule,enabled:e.target.checked})}/> Enable daily search</label>
    <div className="field-grid"><label>Scheduled query<Input required={schedule.enabled} value={schedule.query} onChange={e=>setSchedule({...schedule,query:e.target.value})}/></label>
    <label>Local time<Input type="time" required value={displayTime(schedule)} onChange={e=>{const [hour,minute]=e.target.value.split(':').map(Number);if(Number.isInteger(minute))setSchedule({...schedule,hour,minute});}}/></label></div>
    <Button disabled={busy}>Save schedule</Button></form>{run&&<p className="muted">Last run · {new Date(run.at).toLocaleString()} · {run.status}</p>}</section></div>;
}
