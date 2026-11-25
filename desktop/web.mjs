export function webUrl(value) {
  let url;try{url=new URL(value);}catch{throw new Error('Enter a complete https website address.');}
  if(url.protocol!=='https:' || url.username || url.password)throw new Error('Choose a secure https website without embedded credentials.');
  return url.href;
}

// This runs only after a user chooses Fill contacts and confirms the exact employer origin.
export function fillContacts(contacts) {
  const normal=s=>s.trim().toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const names=new Map(Object.entries({'full name':'name','name':'name','email':'email','email address':'email','phone':'phone','phone number':'phone'}));
  let count=0;
  for(const input of document.querySelectorAll('input')){
    if(input.value || input.disabled || input.readOnly || !['email','tel','text'].includes(input.type) || !input.getClientRects().length)continue;
    const label=Array.from(input.labels || []).map(x=>x.textContent).join(' ') || input.getAttribute('aria-label') || '';
    const key=names.get(normal(label));
    if(!key || !contacts[key])continue;
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(input,contacts[key]);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));count++;
  }
  return count;
}
