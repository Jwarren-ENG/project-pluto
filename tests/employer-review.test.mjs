import assert from 'node:assert/strict'
import test from 'node:test'
import {createEmployerReview} from '../desktop/employer-review.mjs'

test('mail review accepts only a recent server match for the same account and role', async () => {
  let clock=0,connected=true,account='user@example.test'
  const job={id:'j',company:'Fictional Books',title:'Buyer',url:'https://example.org/1'}
  const message={account,key:'abc',subject:'Application received for Buyer'}
  const match={jobId:job.id,title:job.title,company:job.company,jobUrl:job.url,purpose:'receipt',message}
  const calls=[]
  const service=createEmployerReview({
    jobMail:{scan:async()=>({matches:[match]})},mail:{settings:async()=>[{provider:'gmail',email:connected?account:''}]},
    getJob:()=>job,recordUpdate:p=>calls.push(p),now:()=>clock,
  })
  const selection={provider:'gmail',jobId:'j',messageKey:'abc'}
  await assert.rejects(service.review(selection))
  await service.scan({provider:'gmail'})
  await assert.rejects(service.review({...selection,jobId:'other'}))
  await service.review({...selection,purpose:'interview-scheduled',message:{key:'forged'}})
  assert.deepEqual(calls[0].message,message)
  assert.equal(calls[0].purpose,'receipt')
  account='another@example.test'
  await assert.rejects(service.review(selection), /mailbox connection changed/)
  assert.equal(calls.length,1)
  account=message.account
  job.title='Editor'
  await assert.rejects(service.review(selection))
  job.title='Buyer'
  connected=false
  await assert.rejects(service.review(selection))
  connected=true
  clock+=16*60000
  await assert.rejects(service.review(selection))
  await service.scan({provider:'gmail'})
  service.forget('gmail')
  await assert.rejects(service.review(selection))
})
