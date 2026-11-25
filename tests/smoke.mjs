// Exercise the actual desktop renderer and restricted main-process bridge with disposable local data.
import { _electron as electron } from 'playwright';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
const dir=await mkdtemp(path.join(os.tmpdir(),'pluto-desktop-test-'));
const executablePath=process.env.PLUTO_EXECUTABLE || process.env.PLUTO_SMOKE_EXECUTABLE;
const args=['--user-data-dir='+dir,...(executablePath?[]:['.'])];

// Exercise the shipped editor and capture exactly what reaches a local test model.
// Leave the editor open during revocation to catch stale renderer permissions.
async function checkDraftPrivacy(page) {
  const received = [];
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/show') return res.end(JSON.stringify({ model_info: {} }));
    if (req.url !== '/api/chat') { res.writeHead(404); return res.end(); }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { messages } = JSON.parse(Buffer.concat(chunks).toString());
    received.push(JSON.parse(messages.find(message => message.role === 'user').content));
    res.end(JSON.stringify({ message: { content: 'Example introduction ' + received.length } }));
  });
  try {
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    await page.evaluate(async port => {
      const call = window.pluto.call;
      await call('providers.configure', { provider: 'ollama', model: 'example', endpoint: 'http://127.0.0.1:' + port });
      await call('workspace.saveProfile', {
        confirmedFacts: ['Counted sample stock.'], resumeText: 'Unreviewed résumé line',
        experienceStories: [
          { id: 'shared', title: 'Count review', action: 'Reconciled a sample count.', useInDrafts: true },
          { id: 'private', title: 'Private story', action: 'Private action', useInDrafts: false },
        ],
        applicationAnswers: { address: 'Private example address', salaryMin: 91000 },
      });
    }, server.address().port);
    await page.reload();
    await page.getByRole('navigation').getByRole('button', { name: 'Applications', exact: true }).click();
    await page.getByRole('button', { name: 'Open Product Analyst at Example Company' }).click();
    const draft = page.getByLabel('Application draft', { exact: true });
    await draft.fill('');
    const generate = page.getByRole('button', { name: 'Draft with AI' });
    await generate.click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Application draft"]').value === 'Example introduction 1');
    const expected = { name: 'Sample Candidate', confirmedFacts: ['Counted sample stock.'] };
    assert.deepEqual(received[0].profile, { ...expected, experienceStories: [
      { title: 'Count review', action: 'Reconciled a sample count.' },
    ] });
    await page.evaluate(async () => {
      const { profile } = await window.pluto.call('workspace.snapshot');
      const experienceStories = profile.experienceStories.map(story => ({ ...story, useInDrafts: false }));
      await window.pluto.call('workspace.saveReviewedProfile', { changes: { experienceStories }, expected: { experienceStories: profile.experienceStories } });
    });
    await draft.fill('');
    await generate.click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Application draft"]').value === 'Example introduction 2');
    assert.deepEqual(received[1].profile, expected);
    assert.equal(received.length, 2);
    await page.reload();
    await page.getByRole('heading', { name: 'Today', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Add role', exact: true }).waitFor();
  } finally {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  }
}

async function checkConnections(app, page) {
  // This is the final check in the disposable process. Exercise the shipped renderer,
  // preload and provider service with an in-memory sign-in and a captured guide link.
  const fixture = await app.evaluateHandle(({ app, ipcMain }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
    const { createProviders } = require('./desktop/providers.mjs');
    const fixture = { state: 'missing', calls: [], holdLogin: true };
    fixture.drive = { connected: false, email: '', busy: '', registrationAvailable: false };
    const prefs = new Map();
    const keys = new Map();
    fixture.keys = keys;
    const service = createProviders({
      prefs,
      secrets: { get: key => keys.get(key), set: (key, value) => keys.set(key, value), remove: key => keys.delete(key) },
      fetchImpl: async () => {
        if (fixture.offline) throw new Error('Synthetic offline state');
        return Response.json({ data: [
          { id: 'gpt-example-old', created: 1600000000 },
          { id: 'gpt-example-undated' },
          { id: 'gpt-example-new', created: 1750000000 },
        ] });
      },
      codex: {
        models: async () => [{ id: 'example-plan', label: 'Example subscription model' }],
        async status() {
          if (fixture.failNextCheck) {
            fixture.failNextCheck = false;
            throw new Error('Synthetic check failure');
          }
          return { state: fixture.state };
        },
        async login(signal) {
          if (fixture.holdLogin) {
            await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
          }
          fixture.state = 'chatgpt';
        },
      },
    });
    ipcMain.removeHandler('pluto:action');
    ipcMain.handle('pluto:action', (_, action, payload) => {
      fixture.calls.push([action, payload.apiKey ? { ...payload, apiKey: '(entered)' } : payload]);
      if (action === 'app.openExternal') return;
      if (action === 'providers.settings' && fixture.aiUnavailable) throw new Error('Synthetic AI settings failure');
      if (action === 'mail.settings') {
        const rows = ['gmail','outlook'].map(provider => ({ provider, email: '', busy: '', ...fixture.mail?.[provider] }));
        return fixture.macMail ? [...rows, {provider:'apple', available:true, email:''}] : rows;
      }
      if (action === 'mail.appleAccounts') return [{id:'sample-mailbox', label:'Sample account', email:'candidate@example.test'}];
      if (action === 'mail.connect' || action === 'mail.disconnect') {
        const linked = action === 'mail.connect' && !payload.cancel;
        fixture.mail[payload.provider] = { ...fixture.mail[payload.provider],
          email: linked ? 'candidate@example.test' : '', via: payload.appleAccountId ? 'apple' : undefined };
        return fixture.mail[payload.provider];
      }
      if (action === 'drive.settings') return fixture.drive;
      if (action === 'drive.connect' || action === 'drive.disconnect') {
        fixture.drive.connected = action === 'drive.connect';
        fixture.drive.email = fixture.drive.connected ? 'sample@example.test' : '';
        return fixture.drive;
      }
      const gateName = action === 'providers.models' ? 'nextModels' : action === 'providers.subscriptionStatus' ? 'nextStatus' : null;
      if (gateName && fixture[gateName]) {
        const gate = fixture[gateName];
        fixture[gateName] = null;
        gate.started.resolve();
        return gate.reply.promise;
      }
      const method = action.slice('providers.'.length);
      if (!action.startsWith('providers.') || !['settings', 'models', 'fallbackStatus', 'subscriptionStatus', 'configure', 'test', 'disconnect'].includes(method)) {
        throw new Error('Unexpected smoke test action: ' + action);
      }
      return service[method](payload);
    });
    return fixture;
  });
  const button = name => page.getByRole('button', { name, exact: true });
  const visible = text => page.getByText(text, { exact: false }).waitFor();
  async function refreshAs(state) {
    await fixture.evaluate((f, next) => { f.state = next; }, state);
    await button('Refresh status').click();
  }
  await page.getByRole('navigation').getByRole('button', { name: 'Connections', exact: true }).click();
  const accounts = page.getByRole('group', { name: 'AI accounts' });
  await accounts.waitFor();
  assert.deepEqual(await accounts.getByRole('button').allTextContents(), ['ChatGPT','Grok','Claude','Gemini']);
  for (const name of ['Grok','Claude','Gemini']) {
    await accounts.getByRole('button', { name, exact: true }).click();
    await button('Open ' + name + ' in browser').click();
    const api = page.getByRole('group', { name: (name === 'Claude' ? 'Anthropic' : name) + ' API' });
    await api.getByLabel('API key', { exact: true }).waitFor();
    await api.getByLabel('Model', { exact: true }).waitFor();
    if (name !== 'Claude') {
      await api.getByLabel('API key', { exact: true }).fill('sample-catalog-key');
      await api.getByRole('button', { name: 'Load models' }).click();
      await api.getByLabel('Model', { exact: true }).selectOption({ label: 'gpt-example-new' });
      const request = await fixture.evaluate(f => f.calls.filter(([action]) => action === 'providers.models').at(-1));
      assert.deepEqual(request, ['providers.models', { provider: name === 'Grok' ? 'xai' : 'gemini', apiKey: '(entered)' }]);
      await page.getByText('Other ways to sign in to ' + name, { exact: true }).click();
      await page.getByLabel('Sign-in method', { exact: true }).selectOption('cli');
      await page.getByText(name === 'Grok' ? 'grok login' : 'agy', { exact: true }).waitFor();
    }
  }
  await accounts.getByRole('button', { name: 'ChatGPT' }).click();
  assert.equal(await page.getByLabel('API key', { exact: true }).count(), 0);
  await button('Open Codex installation guide').click();
  await refreshAs('unsupported');
  await visible('Update the Codex CLI');
  await refreshAs('other');
  await visible('sign out in Codex');
  assert.equal(await button('Sign in with ChatGPT').count(), 0);
  await fixture.evaluate(f => { f.failNextCheck = true; });
  await button('Refresh status').click();
  await visible('Pluto couldn’t check the Codex sign-in.');
  await refreshAs('signedOut');
  await button('Sign in with ChatGPT').click();
  await visible('Finish signing in');
  await button('Cancel sign-in').click();
  await button('Sign in with ChatGPT').waitFor();
  assert.equal(await button('Unlink from Pluto').count(), 0);

  await fixture.evaluate(f => { f.holdLogin = false; });
  await button('Sign in with ChatGPT').click();
  await visible('Current provider: ChatGPT subscription · Codex');
  await button('Check sign-in').click();
  await visible('ChatGPT sign-in verified.');
  await button('Unlink from Pluto').click();
  await button('Use subscription for drafts').click(); // Same Codex account is still signed in.
  await visible('Current provider: ChatGPT subscription · Codex');
  const subscriptionModel = page.getByRole('combobox', { name: 'Subscription model' });
  await subscriptionModel.selectOption({ label: 'Example subscription model' });
  await button('Save subscription model').click();
  await subscriptionModel.selectOption({ label: 'Account default' });
  await button('Save subscription model').click();
  await button('API or local model').click();
  await page.getByLabel('API key', { exact: true }).waitFor();

  // Finish an old check after a different provider was selected and Codex reopened.
  await fixture.evaluate(f => {
    f.gate = { started: Promise.withResolvers(), reply: Promise.withResolvers() };
    f.nextStatus = f.gate;
  });
  await button('ChatGPT').click();
  await fixture.evaluate(f => f.gate.started.promise);
  await button('API or local model').click();
  await page.getByLabel('API key', { exact: true }).waitFor();
  await button('ChatGPT').click();
  await button('Check sign-in').waitFor();
  await fixture.evaluate(f => f.gate.reply.resolve({ state: 'missing' }));
  // Round-trip through the same bridge, then let the renderer paint its settled state.
  await page.evaluate(async () => {
    await window.pluto.call('providers.settings');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  assert.ok(await button('Check sign-in').isVisible());
  assert.equal(await button('Open Codex installation guide').count(), 0);
  const actions = await fixture.evaluate(f => f.calls.filter(([action]) => ['app.openExternal','providers.configure','providers.test','providers.disconnect'].includes(action)));
  assert.deepEqual(actions, [
    ['app.openExternal', { url: 'https://grok.com/' }],
    ['app.openExternal', { url: 'https://claude.ai/' }],
    ['app.openExternal', { url: 'https://gemini.google.com/app' }],
    ['app.openExternal', { url: 'https://developers.openai.com/codex/cli/' }],
    ['providers.configure', { provider: 'codex', auth: 'login', model: '' }],
    ['providers.configure', { provider: 'codex', auth: 'cancel' }],
    ['providers.configure', { provider: 'codex', auth: 'login', model: '' }],
    ['providers.test', { provider: 'codex' }],
    ['providers.disconnect', { provider: 'codex' }],
    ['providers.configure', { provider: 'codex', model: '' }],
    ['providers.configure', { provider: 'codex', model: 'example-plan' }],
    ['providers.configure', { provider: 'codex', model: '' }],
  ]);
  await checkModelPicker(page, fixture);
  await page.getByRole('navigation').getByRole('button', { name: 'Today', exact: true }).click();
  await fixture.evaluate(f => { f.aiUnavailable = true; });
  await page.getByRole('navigation').getByRole('button', { name: 'Connections', exact: true }).click();
  await button('Retry connections').waitFor();
  for (const name of ['Gmail', 'Outlook']) {
    await button('Connect ' + name).click();
    const setup = page.getByRole('dialog', { name: 'Connect ' + name });
    await setup.getByLabel('Desktop client ID', { exact: true }).waitFor();
    await setup.getByRole('button', { name: 'Cancel', exact: true }).click();
    await setup.waitFor({ state: 'hidden' });
  }
  // Simulate a Mac with a configured mailbox and a publisher-registered provider.
  await fixture.evaluate(f => { f.macMail = true; f.mail = { outlook: { direct:true } }; });
  await page.getByRole('navigation').getByRole('button', { name:'Job mail', exact:true }).click();
  await button('Connect an inbox').click();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'email-connections-heading');
  await button('Connect Gmail').click();
  const picker = page.getByRole('dialog', {name:'Connect Gmail'});
  await picker.getByRole('button', {name:'candidate@example.test'}).click();
  await picker.waitFor({state:'hidden'});
  await visible('candidate@example.test · via Apple Mail');
  await button('Connect Outlook').click();
  await button('Disconnect Outlook').waitFor();
  await button('Open job mail').click();
  await page.getByLabel('Mail source').waitFor();
  assert.equal(await page.getByLabel('Mail source').locator('option').count(), 2);
  assert.deepEqual(await fixture.evaluate(f => f.calls.filter(([name]) => name === 'mail.connect')), [
    ['mail.connect', {provider:'gmail', appleAccountId:'sample-mailbox'}],
    ['mail.connect', {provider:'outlook'}],
  ]);
  await page.getByRole('navigation').getByRole('button', {name:'Connections', exact:true}).click();
  await button('Connect Google Drive').click();
  const drive = page.getByRole('dialog', { name: 'Google Drive desktop client setup' });
  await drive.getByLabel('Google desktop client ID').fill('smoke-test.apps.googleusercontent.com');
  await drive.getByRole('button', { name: 'Continue with Google', exact: true }).click();
  await drive.waitFor({ state: 'hidden' });
  await button('Unlink Google Drive').waitFor();
  await fixture.evaluate(f => { f.drive.registrationAvailable = true; });
  await button('Unlink Google Drive').click();
  await button('Connect Google Drive').click();
  await button('Unlink Google Drive').waitFor();
  assert.equal(await drive.count(), 0);
  assert.deepEqual(await fixture.evaluate(f => f.calls.filter(([action]) => action === 'drive.connect')), [
    ['drive.connect', { clientId: 'smoke-test.apps.googleusercontent.com', clientSecret: '' }],
    ['drive.connect', {}],
  ]);
  await fixture.dispose();
}

async function checkModelPicker(page, fixture) {
  const api = page.getByRole('group', { name: 'API or local model', exact: true });
  const provider = api.getByLabel('Provider', { exact: true });
  const model = api.getByLabel('Model', { exact: true });
  const key = api.getByLabel('API key', { exact: true });
  const endpoint = api.getByLabel('HTTPS API base URL');
  const lastRequests = () => fixture.evaluate(f => f.calls.filter(([action]) => action === 'providers.models').map(([,p]) => p));
  const optionLabels = () => model.locator('option').allTextContents();
  const load = name => api.getByRole('button', { name, exact: true }).click();
  await page.getByRole('button', { name: 'API or local model', exact: true }).click();
  await provider.selectOption('openrouter');
  await api.getByText('Provider model list.', { exact: false }).waitFor();
  assert.deepEqual((await optionLabels()).filter(label => label.startsWith('gpt-example')), ['gpt-example-new', 'gpt-example-old', 'gpt-example-undated']);
  assert.deepEqual((await lastRequests()).at(-1), { provider: 'openrouter' });
  await key.fill('synthetic-unused-public-list-key');
  await load('Load models');
  await api.getByText('Provider model list.', { exact: false }).waitFor();
  assert.deepEqual((await lastRequests()).at(-1), { provider: 'openrouter' });
  await provider.selectOption('custom');
  const before = (await lastRequests()).length;
  await endpoint.fill('https://one.example.test/v1');
  await key.fill('synthetic-first-key');
  await model.selectOption({ label: 'Enter a model ID manually' });
  const manual = api.getByLabel('Model ID', { exact: true });
  assert.ok(await manual.evaluate(field => field === document.activeElement));
  await manual.fill('legacy/manual-model');
  assert.equal((await lastRequests()).length, before);

  // A result for a previous account, endpoint or provider must never populate the new picker.
  for (const change of ['key', 'endpoint', 'provider']) {
    await fixture.evaluate(f => {
      f.modelGate = { started: Promise.withResolvers(), reply: Promise.withResolvers() };
      f.nextModels = f.modelGate;
    });
    await load('Load models');
    await fixture.evaluate(f => f.modelGate.started.promise);
    if (change === 'key') await key.fill('synthetic-second-key');
    if (change === 'endpoint') await endpoint.fill('https://two.example.test/v1');
    if (change === 'provider') await provider.selectOption('anthropic');
    await fixture.evaluate(f => f.modelGate.reply.resolve({ models: [{ id: 'stale', label: 'Wrong account' }], source: 'provider', order: 'provider' }));
    await page.evaluate(async () => {
      await window.pluto.call('providers.settings');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    assert.ok(!(await optionLabels()).includes('Wrong account'));
    if (change === 'endpoint') {
      assert.equal(await key.inputValue(), '');
      assert.equal(await api.getByLabel('Model ID', { exact: true }).inputValue(), 'legacy/manual-model');
      await key.fill('synthetic-bound-key');
    }
  }
  assert.equal((await lastRequests()).length, before + 3);
  await provider.selectOption('custom');
  await endpoint.fill('https://two.example.test/v1');
  await key.fill('synthetic-bound-key');
  await load('Load models');
  await model.selectOption({ label: 'gpt-example-new' });
  assert.deepEqual((await lastRequests()).at(-1), { provider: 'custom', endpoint: 'https://two.example.test/v1', apiKey: '(entered)' });
  assert.equal(await fixture.evaluate(f => f.keys.size), 0);
  await load('Use for drafts');
  await api.getByText('Provider model list.', { exact: false }).waitFor();
  await api.getByRole('button', { name: 'Save connection' }).waitFor();
  assert.equal(await key.inputValue(), '');
  assert.deepEqual((await lastRequests()).at(-1), { provider: 'custom', endpoint: 'https://two.example.test/v1' });
  await fixture.evaluate(f => { f.offline = true; });
  await load('Refresh models');
  await api.getByText('Last known model list', { exact: false }).waitFor();
  assert.equal(await model.locator('option:checked').textContent(), 'gpt-example-new');
}

async function checkUnsavedEditors(page){
  const nav=page.getByRole('navigation');
  const button=name=>page.getByRole('button',{name,exact:true});
  for(const item of [
    {view:'Applications',kind:'application',open:'Open Product Analyst at Example Company',field:'Application draft',save:'Save application',other:'Notebook'},
    {view:'Notebook',kind:'note',open:'Edit Interview notes',field:'Markdown',save:'Save note',other:'Today'},
  ]){
    const navigate=where=>nav.getByRole('button',{name:where,exact:true}).click();
    const dialog=page.getByRole('alertdialog',{name:'Discard your '+item.kind+' edits?'});
    const field=page.getByLabel(item.field,{exact:true});
    await navigate(item.view);
    await button(item.open).click();
    const original=await field.inputValue();
    const draft='Unsaved '+item.kind+' draft';
    await field.fill(draft);
    await navigate(item.other);
    await dialog.waitFor();
    const keep=dialog.getByRole('button',{name:'Keep editing'});
    assert.ok(await keep.evaluate(el=>el===document.activeElement));
    await keep.click();
    assert.equal(await field.inputValue(),draft);
    // Notebook stays on the same editor; Applications explicitly returns to its list.
    await navigate(item.view);
    if(item.view==='Applications'){
      await dialog.waitFor();
      await page.keyboard.press('Escape');
    }
    assert.equal(await field.inputValue(),draft);
    await button('Close').click();
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await field.inputValue(),draft);
    await button('Close').click();
    await dialog.getByRole('button',{name:'Discard changes'}).click();
    await button(item.open).click();
    assert.equal(await field.inputValue(),original);
    await field.fill(draft);
    await navigate(item.other);
    await dialog.getByRole('button',{name:'Discard changes'}).click();
    await page.getByRole('heading',{name:item.other,exact:true,level:1}).waitFor();
    await navigate(item.view);
    await button(item.open).click();
    assert.equal(await field.inputValue(),original);
    await field.fill(draft);
    await field.fill(original);
    await button('Close').click();
    await button(item.open).click(); // Reverting the edit should leave cleanly.
    await field.fill('Saved '+item.kind);
    await button(item.save).click();
    await button('Close').click();
    await button(item.open).click(); // Successful saves should leave cleanly too.
    assert.equal(await field.inputValue(),'Saved '+item.kind);
    await navigate(item.other);
    await page.getByRole('heading',{name:item.other,exact:true,level:1}).waitFor();
  }
}

let app;
try{
  app=await electron.launch({args, ...(executablePath?{executablePath}:{}),timeout:45000});
  let page=await app.firstWindow();
  const faults=[];
  page.on('pageerror',e=>faults.push(e.message));
  await page.getByRole('heading',{name:'Today', exact:true}).waitFor();
  assert.equal(await page.locator('.brand img').evaluate(img=>img.complete&&img.naturalWidth>0),true);
  if(process.env.PLUTO_SCREENSHOT)await page.screenshot({path:process.env.PLUTO_SCREENSHOT});
  const nav=page.getByRole('navigation');
  await page.getByRole('button',{name:'Add résumé'}).click();
  await page.getByRole('button',{name:'Choose résumé file'}).waitFor();
  for(const title of ['Discover','Applications','Notebook','Connections','Job mail','Daily budget']){
    await nav.getByRole('button',{name:title,exact:true}).click();
    await page.getByRole('heading',{name:title,exact:true,level:1}).waitFor();
    if(title==='Connections'){
      for(const name of ['Connect Gmail','Connect Outlook','Connect Google Drive']){
        await page.getByRole('button',{name,exact:true}).waitFor();
      }
    }
  }
  const slider=page.getByRole('slider',{name:'Adjust jobs per day'});
  await slider.focus();await slider.press('Home');for(let i=0;i<25;i++)await slider.press('ArrowRight');
  assert.equal(await slider.getAttribute('aria-valuenow'),'25');
  await page.getByRole('button',{name:/save budget|save daily|save target/i}).click();
  await page.waitForFunction(async()=>(await window.pluto.call('workspace.snapshot')).profile?.budget?.jobsPerDay===25);
  const proof=await page.evaluate(async()=>{
    const call=window.pluto.call;
    await call('workspace.saveProfile',{name:'Sample Candidate'});
    const job=await call('workspace.saveJob',{title:'Product Analyst',company:'Example Company',url:'https://example.org/position',stage:'Preparing',resumeText:'Reviewed example résumé'});
    let rejected=false;try{await call('workspace.saveJob',{id:job.id,stage:'Applied'});}catch{rejected=true;}
    const sent=await call('workspace.saveJob',{id:job.id,stage:'Applied',evidence:'Example portal receipt'});
    await call('workspace.saveNote',{title:'Interview notes',body:'## Topics',jobId:job.id});
    let unknown=false;try{await call('filesystem.readEverything');}catch{unknown=true;}
    return {rejected,unknown,resume:sent.submittedSnapshot.resumeText,node:typeof require};
  });
  assert.deepEqual(proof,{rejected:true,unknown:true,resume:'Reviewed example résumé',node:'undefined'});
  await page.reload();
  await checkUnsavedEditors(page);
  assert.deepEqual(faults,[]);
  await app.close();app=null;
  app=await electron.launch({args,...(executablePath?{executablePath}:{}),timeout:45000});
  page=await app.firstWindow();
  await page.getByRole('heading',{name:'Today',exact:true}).waitFor();
  await page.getByRole('tab',{name:/Submitted/}).click();
  await page.getByRole('button',{name:/Product Analyst/}).waitFor();
  const saved=await page.evaluate(()=>window.pluto.call('workspace.snapshot'));
  assert.equal(saved.profile.budget.jobsPerDay,25);
  assert.equal(saved.notes.length,1);assert.equal(saved.jobs[0].submittedSnapshot.evidence,'Example portal receipt');
  page.on('pageerror',e=>faults.push(e.message));
  await checkDraftPrivacy(page);
  await checkConnections(app,page);
  assert.deepEqual(faults,[]);
  console.log('Desktop verified: navigation, application target, receipt, private notes, restart persistence, AI accounts, model selection and connection setup.');
}finally{if(app)await app.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:250});}
