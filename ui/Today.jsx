import React, { useRef, useState } from 'react';
import { ArrowRight, CalendarDays, Plus, SlidersHorizontal } from 'lucide-react';
import { Button } from './components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table';

const filters = [
  { key: 'open', label: 'In progress', include: job => ['Saved','Preparing'].includes(job.stage) },
  { key: 'sent', label: 'Submitted', include: job => Boolean(job.submittedSnapshot) },
  { key: 'all', label: 'All roles', include: () => true }
];
function receiptDate(job) {
  const recorded = job.submittedSnapshot?.submittedAt;
  return recorded ? new Date(recorded).toDateString() : null;
}
const fullDate = date => date.toLocaleDateString(undefined, {weekday:'long', month:'long', day:'numeric'});

function RoleList({jobs,edit,allCount,go,byReceipt=false}){
  if (!jobs.length) return <div className="queue-empty">
    <p>{byReceipt ? 'No application receipts on this day.' : allCount ? 'No roles in this view.' : 'Your application queue is empty.'}</p>
    {!byReceipt && !allCount && <Button variant="link" onClick={()=>go('Discover')}>Find openings <ArrowRight size={14}/></Button>}
  </div>;
  const visible = byReceipt ? jobs : jobs.slice(0,8);
  return <Table className="job-ledger"><TableHeader><TableRow><TableHead>Role / company</TableHead><TableHead>Status</TableHead><TableHead>{byReceipt ? 'Receipt recorded' : 'Updated'}</TableHead></TableRow></TableHeader><TableBody>
    {visible.map(job=><TableRow key={job.id}><TableCell><Button className="ledger-link" variant="link" onClick={()=>edit(job)}>{job.title}</Button><small>{job.company}</small></TableCell><TableCell>{job.stage}</TableCell><TableCell>{byReceipt
      ? <time dateTime={job.submittedSnapshot.submittedAt}>{new Date(job.submittedSnapshot.submittedAt).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}</time>
      : new Date(job.updatedAt).toLocaleDateString(undefined,{month:'short',day:'numeric'})}</TableCell></TableRow>)}
  </TableBody></Table>;
}
function Week({jobs,target,go,selectedDay,onSelect}){
  const now=new Date(),monday=new Date(now.getFullYear(),now.getMonth(),now.getDate()-(now.getDay()+6)%7);
  const days=Array.from({length:7},(_,offset)=>{
    const date=new Date(monday);date.setDate(date.getDate()+offset);
    const key=date.toDateString();
    return {date,key,count:jobs.filter(job=>receiptDate(job)===key).length};
  });
  const today=days.find(d=>d.key===now.toDateString()),peak=Math.max(1,...days.map(d=>d.count));
  return <section className="rail-section"><div className="rail-heading"><h2>Daily target</h2><Button className="quiet-icon" variant="ghost" size="icon" aria-label="Adjust daily target" onClick={()=>go('Daily budget')}><SlidersHorizontal size={16}/></Button></div>
    <div className="daily-total"><strong>{today.count}</strong>{target>0 && <span> / {target}</span>}</div>
    <p className="rail-meta">{target===0 ? 'Target paused' : 'Confirmed submissions today'}</p>
    <div className="week" role="group" aria-label="Filter applications by receipt date">{days.map(({date,key,count})=><button type="button" key={key}
      className={key===today.key?'week-day current':'week-day'} aria-pressed={selectedDay===key} aria-controls="today-application-queue"
      aria-current={key===today.key?'date':undefined} aria-label={fullDate(date)+', '+count+(count===1?' receipt':' receipts')}
      title={fullDate(date)+' · '+count+(count===1?' receipt':' receipts')} onClick={event=>onSelect(date,event.currentTarget)}>
      <svg aria-hidden="true" viewBox="0 0 24 44" preserveAspectRatio="none"><rect x="2" width="20" y={42-count/peak*36} height={Math.max(1,count/peak*36)} /></svg>
      <span aria-hidden="true">{date.toLocaleDateString(undefined,{weekday:'narrow'})}</span>
    </button>)}</div>{!Number.isInteger(target)&&<Button variant="link" onClick={()=>go('Daily budget')}>Set a target <ArrowRight size={14}/></Button>}
  </section>;
}
function NextInterview({job,edit}){
  const date=new Date(job.interviewAt);
  return <section className="next-interview" aria-label="Next interview">
    <time dateTime={job.interviewAt} className="appointment-date">
      <span>{date.toLocaleDateString(undefined,{month:'short'})}</span>
      <strong>{date.getDate()}</strong>
    </time>
    <div className="appointment-copy">
      <p className="dateline">Next interview · {date.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}</p>
      <h2>{job.company}</h2><p>{job.title}</p>
      <Button variant="link" onClick={()=>edit(job)}>Open application <ArrowRight size={14}/></Button>
    </div>
  </section>;
}

export default function Today({state,go,edit}){
  const [filter,setFilter]=useState('open');
  const [day,setDay]=useState(null);
  const dayButton=useRef(null);
  const {jobs,profile}=state;
  const dayKey=day?.toDateString();
  const dayJobs=day ? jobs.filter(job=>receiptDate(job)===dayKey) : [];
  function selectDay(date,button){
    dayButton.current=button;
    setDay(date.toDateString()===dayKey ? null : date);
  }
  function clearDay(){
    setDay(null);
    dayButton.current?.focus();
  }
  const first=!profile?.resumeText && !profile?.confirmedFacts?.length;
  const interviews=jobs.filter(j=>j.stage==='Interview' && (!j.interviewAt || Date.parse(j.interviewAt)>=Date.now())).sort((a,b)=>(a.interviewAt||'z').localeCompare(b.interviewAt||'z'));
  const next=interviews.find(j=>j.interviewAt);
  const remaining=interviews.filter(j=>j.id!==next?.id);
  return <>
    <header className="desk-header"><div><p className="dateline">{new Date().toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'})}</p><h1>Today</h1></div>
      <div className="desk-actions">
        {first && <Button variant="link" onClick={()=>go('Profile')}>Add résumé</Button>}
        <Button className="add-role" onClick={()=>edit({})}><Plus size={16}/> Add role</Button>
      </div>
    </header>
    <div className="desk-columns"><div className="desk-primary">
      {next && <NextInterview job={next} edit={edit}/>}
      <section className="queue" id="today-application-queue"><div className="rail-heading"><h2>Application queue</h2><Button variant="link" onClick={()=>go('Applications')}>View all <ArrowRight size={14}/></Button></div>
        <Tabs value={day?'sent':filter} onValueChange={value=>{setDay(null);setFilter(value);}}><TabsList aria-label="Application queue filters">{filters.map(f=><TabsTrigger key={f.key} value={f.key}>{f.label}<span className="tab-count">{day && f.key==='sent' ? dayJobs.length : jobs.filter(f.include).length}</span></TabsTrigger>)}</TabsList>
        <div className="receipt-filter"><span role="status">{day && fullDate(day)+' · '+dayJobs.length+(dayJobs.length===1?' receipt':' receipts')}</span>
          {day && <Button type="button" variant="link" onClick={clearDay}>Clear day filter</Button>}</div>
        {filters.map(f=><TabsContent key={f.key} value={f.key}><RoleList jobs={day && f.key==='sent' ? dayJobs : jobs.filter(f.include)} byReceipt={Boolean(day) && f.key==='sent'} allCount={jobs.length} edit={edit} go={go}/></TabsContent>)}</Tabs>
      </section>
    </div><aside className="agenda"><Week jobs={jobs} target={profile?.budget?.jobsPerDay} go={go} selectedDay={dayKey} onSelect={selectDay}/>
      <section className="rail-section"><div className="rail-heading"><h2>{next ? 'Later interviews' : 'Upcoming interviews'}</h2><CalendarDays size={16}/></div>
        {remaining.length?remaining.map(j=><Button variant="ghost" key={j.id} className="interview-row" onClick={()=>edit(j)}><strong>{j.company}</strong><small>{j.title}</small><time>{j.interviewAt?new Date(j.interviewAt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'Date pending'}</time></Button>):<p className="rail-meta">{next?'No other interviews scheduled.':'No interviews scheduled.'}</p>}
      </section></aside></div></>;
}
