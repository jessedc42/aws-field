import {types, regionZones, starter, validate, lookup, ancestor, effective, subnetMode, candidates, defaults, add, aclRules, customerLab} from './model.mjs';
import {createScene} from './scene.mjs';
import {customer, testCustomerAccess} from './simulation.mjs';
import {rules} from './aws-rules.mjs';
import {evaluateLab} from './learning.mjs';
import {renderPractice} from './practice-ui.mjs';
import {editableTypes, renderResourceControls} from './resource-controls.mjs';

const $ = id => document.getElementById(id);
const root = $('panel-body');
const dialog = $('dialog');
const tabs = [...document.querySelectorAll('[data-tab]')];
const categories = ['All', ...new Set(Object.values(types).map(t => t[1]))];
let state, activeId, selected, pending, draft, detailForm;
let simulationRun, showTrace = false, simulationAvailable = false;
let practiceAvailable = false, browsePractice = false, practiceEdit = false, focusedCheckpoint;
let tab = 'add', category = 'All', query = '', resourceQuery = '', busy = false, noticeTimer;
const graph = () => state?.documents.find(doc => doc.id === activeId)?.graph;
const scene = createScene($('scene'), $('labels'), selectResource, label => { $('engine').textContent = label; });

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, action, kind) {
  const node = el('button', text, kind);
  node.type = 'button';
  node.onclick = action;
  return node;
}
function glyph(type) {
  const node = el('span', types[type][4], 'glyph');
  node.style.setProperty('--tone', types[type][3]);
  node.setAttribute('aria-hidden', 'true');
  return node;
}
function row(type, title, subtitle, action) {
  const node = button(undefined, action, 'row');
  const text = el('span', title);
  if (subtitle) text.append(el('small', subtitle));
  node.append(glyph(type), text);
  return node;
}
function message(text, error = false) {
  clearTimeout(noticeTimer);
  const node = $('notice');
  node.textContent = text; node.hidden = false;
  node.className = `notice${error ? ' error' : ''}`;
  noticeTimer = setTimeout(() => { node.hidden = true; }, 5300);
}
function saveStatus(text, status = 'ok') {
  const node = $('save-state');
  node.dataset.state = status;
  node.lastElementChild.textContent = text;
}
function labelControl(title, control) {
  const label = el('label', title, 'field');
  label.append(control);
  return label;
}
function selectControl(options, value, onChange) {
  const select = el('select');
  for (const [key, label] of options) {
    const option = el('option', label);
    option.value = key;
    select.append(option);
  }
  select.value = value;
  select.onchange = () => onChange(select.value);
  return select;
}
function inputControl(type, value, onInput, attributes = {}) {
  const input = Object.assign(el('input'), {type, value, required: true}, attributes);
  input.oninput = () => onInput(type === 'number' ? input.valueAsNumber : input.value);
  return input;
}
function formError() {
  const error = el('p', undefined, 'form-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  return error;
}
function heading(title, description) {
  root.append(el('h2', title));
  if (description) root.append(el('p', description));
}
function describe(node) {
  if (node.type === 'subnet') return `${subnetMode(graph(), node)} · ${node.cidr} · ${node.az}`;
  if (node.type === 'region') return node.region;
  return [types[node.type][0], node.cidr ?? node.az ?? lookup(graph(), node.parent)?.name].filter(Boolean).join(' · ');
}
function rememberActive() {
  try { localStorage.setItem('aws-field-active', activeId); } catch {}
}
function selectDocument(id, nextTab = 'add') {
  activeId = id;
  rememberActive();
  selected = pending = draft = detailForm = undefined;
  simulationRun = undefined; showTrace = false;
  browsePractice = practiceEdit = false; focusedCheckpoint = undefined;
  tab = nextTab;
  render(true);
}

async function persist(change) {
  if (busy) throw new Error('A save is in progress. Try again in a moment.');
  const next = structuredClone(state);
  change(next.documents);
  busy = true;
  saveStatus('Saving', 'pending');
  try {
    const response = await fetch('/api/workspace', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(next)});
    const result = await response.json();
    if (response.status === 409) {
      state = result.state;
      simulationRun = undefined; showTrace = false;
      if (!graph()) activeId = state.documents[0].id;
      selected = pending = draft = detailForm = undefined;
      if (dialog.open) dialog.close();
      render(true);
      throw new Error(result.error);
    }
    if (!response.ok) throw new Error(result.error || 'Could not save.');
    state = result;
    simulationRun = undefined; showTrace = false; focusedCheckpoint = undefined;
    saveStatus('Saved');
  } catch (error) {
    saveStatus('Save interrupted', 'error');
    message(error.message, true);
    throw error;
  } finally { busy = false; }
}
function saveGraph(next, preserveEvent = false) {
  if (next.practice && !preserveEvent) delete next.practice.event;
  validate(next);
  const id = activeId;
  return persist(docs => { docs.find(doc => doc.id === id).graph = next; });
}
function drawScene(refit) {
  const possible = pending && !draft ? candidates(graph(), pending).map(n => n.id) : [];
  const active = graph().practice?.event;
  const overlay = active === undefined ? undefined : focusedCheckpoint ?? evaluateLab(graph())?.frames[active];
  scene.show(graph(), selected, possible, refit, overlay);
  const bar = $('placement-bar');
  bar.className = 'placement';
  bar.textContent = possible.length ? `Tap a highlighted ${types[types[pending][2]][0].toLowerCase()}` : '';
  bar.hidden = !possible.length;
}
function render(refit = false) {
  if (!graph()) return;
  $('diagram-title').textContent = graph().title;
  $('scene-title').textContent = graph().title;
  const count = graph().nodes.length;
  const vpcs = graph().nodes.filter(n => n.type === 'vpc').length;
  $('summary').textContent = `${count} ${count === 1 ? 'resource' : 'resources'} · ${vpcs} ${vpcs === 1 ? 'VPC' : 'VPCs'}`;
  drawScene(refit);
  renderPanel();
}
function renderPanel() {
  tabs.forEach(node => node.setAttribute('aria-selected', String(node.dataset.tab === tab)));
  root.replaceChildren();
  root.scrollTop = 0;
  if (tab === 'add') {
    if (draft) return renderForm(draft, false);
    if (pending) return renderPlacement();
    return renderLibrary();
  }
  if (tab === 'resources') return renderResources();
  if (tab === 'simulate') return renderSimulation();
  if (tab === 'practice') return renderPractice({
    root, graph:graph(), available:practiceAvailable, browsing:browsePractice,
    browse:value=>{browsePractice=value;renderPanel();},
    startLab:next=>createDocument(next,'practice'), update:updatePractice,
    focus:(id,checkpoint)=>{selected=id;focusedCheckpoint=checkpoint;drawScene(true);},
    edit:id=>{
      if (busy) return;
      const node=lookup(graph(),id);
      if (!node) return;
      selected=id; detailForm=structuredClone(node); practiceEdit=true; tab='details'; render();
    },
    ui:{el,button,labelControl,selectControl,heading},
  });
  if (detailForm) return renderForm(detailForm, true);
  renderDetails();
}
async function updatePractice(change, preserveEvent = false) {
  if (busy) return;
  const next=structuredClone(graph());
  try {
    change(next);
    await saveGraph(next,preserveEvent);
    render(true);
    if (preserveEvent) {
      const nextEvent = root.querySelector('.practice-event');
      if (nextEvent) { nextEvent.tabIndex = -1; nextEvent.focus({preventScroll:true}); }
    }
  } catch (error) { message(error.message,true); }
}
function selectResource(id) {
  if (busy) return;
  const node = lookup(graph(), id);
  if (!node) return;
  if (pending && !draft) {
    if (candidates(graph(), pending).some(n => n.id === id)) setParent(id);
    else message(`Choose a highlighted ${types[types[pending][2]][0].toLowerCase()}.`);
    return;
  }
  if (draft) return;
  selected = id; detailForm = undefined; practiceEdit = false; tab = 'details';
  render();
}
function begin(type) {
  pending = type; draft = detailForm = undefined; tab = 'add';
  if (!types[type][2]) return setParent(null);
  render();
}
function setParent(id) {
  draft = defaults(graph(), pending, id);
  if (id) selected = id;
  render();
}
function cancelForm() {
  pending = draft = detailForm = undefined;
  if (practiceEdit) { practiceEdit=false; tab='practice'; }
  render();
}
function searchBox(value, placeholder, onInput) {
  const input = el('input');
  input.type = 'search'; input.placeholder = placeholder; input.value = value;
  input.setAttribute('aria-label', placeholder);
  input.oninput = () => onInput(input.value);
  return input;
}
function renderLibrary() {
  heading('Add a resource', 'Choose a resource, then tap where it belongs.');
  const chips = el('div', undefined, 'chips');
  const grid = el('div', undefined, 'cards');
  const draw = () => {
    for (const chip of chips.children) chip.setAttribute('aria-pressed', String(chip.textContent === category));
    grid.replaceChildren();
    for (const [type, [label, group]] of Object.entries(types)) {
      if ((category !== 'All' && category !== group) || !(label+' '+group).toLowerCase().includes(query.toLowerCase().trim())) continue;
      const card = button(undefined, () => begin(type), 'card');
      card.append(glyph(type), el('span', label)); grid.append(card);
    }
    if (!grid.childElementCount) grid.append(el('p', 'No matching resources.'));
  };
  for (const name of categories) chips.append(button(name, () => { category = name; draw(); }));
  root.append(searchBox(query, 'Search AWS resources', value => { query = value; draw(); }), chips, grid);
  draw();
}
function renderPlacement() {
  const parentType = types[pending][2];
  heading(`Add ${types[pending][0]}`, `Choose a ${types[parentType][0]} below or tap it in the diagram.`);
  const possible = candidates(graph(), pending);
  const list = el('div', undefined, 'stack');
  for (const node of possible) list.append(row(node.type, node.name, describe(node), () => setParent(node.id)));
  if (!possible.length) {
    const text = pending === 'igw' && graph().nodes.some(n => n.type === 'vpc') ? 'Every VPC already has an internet gateway.' : `Add a ${types[parentType][0]} first.`;
    root.append(el('p', text));
    if (pending !== 'igw' || !graph().nodes.some(n => n.type === 'vpc')) list.append(button(`Add ${types[parentType][0]}`, () => begin(parentType), 'primary'));
  }
  const actions = el('div', undefined, 'actions');
  actions.append(button('Cancel', cancelForm)); root.append(list, actions);
}

function renderResources() {
  heading('Resources', 'Tap a resource to inspect its placement and connections.');
  const group = el('div', undefined, 'stack');
  const draw = () => {
    group.replaceChildren();
    const q = resourceQuery.toLowerCase().trim();
    for (const n of graph().nodes) {
      if (!(n.name+' '+describe(n)).toLowerCase().includes(q)) continue;
      const item = row(n.type,n.name,describe(n),()=>selectResource(n.id));
      item.setAttribute('aria-pressed', String(selected === n.id));
      group.append(item);
    }
    if (!group.childElementCount) group.append(el('p', 'No matching resources.'));
  };
  root.append(searchBox(resourceQuery,'Find resources in this diagram', value => { resourceQuery = value; draw(); }), el('div', undefined, 'actions'), group);
  draw();
}
function renderDetails() {
  const n = lookup(graph(), selected);
  if (!n) { heading('Resource details', 'Tap a shape in the diagram or choose a resource from the list.'); return; }
  root.append(el('span',types[n.type][0], 'tag'));
  heading(n.name, describe(n));
  const parent = lookup(graph(), n.parent);
  const list = el('div', undefined, 'stack');
  function related(id, relationship) {
    const target = lookup(graph(), id);
    if (target) list.append(row(target.type, target.name, relationship, () => selectResource(id)));
  }
  if (parent) related(parent.id, 'Placement');
  if (n.type === 'subnet') {
    related(effective(graph(),n,'route')?.id, 'Effective route table');
    related(effective(graph(),n,'acl')?.id, 'Effective network ACL');
  }
  if (n.type === 'route') {
    const vpc = lookup(graph(), n.parent);
    list.append(el('p', `${vpc.cidr} → local`));
    related(n.gateway, '0.0.0.0/0 default route');
    for (const subnet of graph().nodes.filter(child => child.type === 'subnet' && effective(graph(),child,'route')?.id === n.id)) related(subnet.id, 'Associated subnet');
  }
  if (n.type === 'nat') {
    const reachable = subnetMode(graph(), parent) === 'Public';
    list.append(el('p', reachable ? 'Elastic IP assigned in this model.' : 'Internet egress unavailable. Its subnet needs a route to the internet gateway.'));
  }
  if (n.type === 'ec2') list.append(el('p', n.publicIpv4 ? 'Simulated public IPv4 assigned' : 'No simulated public IPv4'));
  if (n.type === 'sg' || n.type === 'acl') renderRuleSummary(list, n);
  if (n.type === 'alb') {
    list.append(el('p', `Scheme · ${n.scheme}`));
    for (const id of n.listener?.targets ?? []) related(id,'Registered target');
  }
  if (n.type === 'asg') related(n.loadBalancer,'Load balancer target group');
  if (n.runtime) list.append(el('p',`Modeled state · ${n.runtime.state} · TCP ${n.runtime.port}`));
  if (n.deployment) list.append(el('p',`Primary ${n.deployment.primary} · Standby ${n.deployment.standby ?? 'none'}`));
  if (['ec2','eni','alb','rds'].includes(n.type)) {
    const vpc = ancestor(graph(),n,'vpc');
    related(n.sg ?? graph().nodes.find(other => other.type === 'sg' && other.parent === vpc.id && other.system)?.id, 'Security group');
  }
  related(n.role,'IAM role'); related(n.instance,'Attached instance');
  for (const id of n.subnets ?? []) related(id,'Selected subnet');
  for (const child of graph().nodes.filter(other => other.parent === n.id && !other.system)) related(child.id, types[child.type][0]);
  root.append(list);
  const actions = el('div', undefined, 'actions');
  actions.append(button('Edit', () => { detailForm = structuredClone(n); renderPanel(); }, 'primary'));
  if (!n.system) actions.append(button('Delete', () => confirmDelete(n), 'danger'));
  if (n.type === 'subnet') actions.append(button('Add EC2 here', () => { pending = 'ec2'; tab = 'add'; setParent(n.id); }));
  root.append(actions);
}

function ruleText(rule) {
  const ports = rule.from === rule.to ? rule.from : `${rule.from}–${rule.to}`;
  const source = rule.cidr ?? lookup(graph(),rule.sourceGroup)?.name ?? 'Missing security group';
  return `${rule.protocol === 'all' ? 'All traffic' : 'TCP ' + ports} · ${source}`;
}
function renderRuleSummary(list, node) {
  const acl = node.type === 'acl';
  const rules = acl ? aclRules(node) : node.ingress ?? [];
  if (!acl && node.system) list.append(el('p', 'The AWS default self-reference is internal. The rules below govern internet customers in this lab.'));
  if (!rules.length) list.append(el('p', acl ? 'No numbered rules. Unmatched traffic is denied.' : 'No IPv4 CIDR rules allow inbound connections.'));
  for (const rule of acl ? [...rules].sort((a, b) => a.number - b.number) : rules) {
    const prefix = acl ? `${rule.number} · ${rule.direction} ${rule.action} · ` : 'Inbound allow · ';
    list.append(el('p', prefix + ruleText(rule)));
  }
}
function renderRuleEditor(form, node) {
  const acl = node.type === 'acl';
  const panel = el('section', undefined, 'rule-editor');
  panel.append(el('h3', acl ? 'Network ACL rules' : 'Inbound IPv4 rules'));
  panel.append(el('p', acl ? 'The lowest matching rule number wins in each direction. Unmatched traffic is denied.' : 'Inbound traffic needs a matching allow rule. Connection tracking allows replies.'));
  const items = el('div', undefined, 'stack');
  const original = acl ? aclRules(node) : node.ingress ?? [];
  let rules = structuredClone(original);
  const update = () => { node[acl ? 'rules' : 'ingress'] = rules; };
  function draw(openIndex) {
    items.replaceChildren();
    rules.forEach((rule, index) => {
      const details = el('details', undefined, 'sim-card');
      details.open = index === openIndex;
      function summaryText() {
        const prefix = acl ? `${rule.number} · ${rule.direction} ${rule.action} · ` : 'Allow · ';
        return prefix + ruleText(rule);
      }
      const summary = el('summary', summaryText());
      details.append(summary);
      function set(key, value) { rule[key] = value; summary.textContent = summaryText(); update(); }
      const field = (label, control) => details.append(labelControl(label, control));
      if (acl) {
        field('Rule number', inputControl('number', rule.number, v => set('number', v), {min: 1, max: 32766}));
        field('Direction', selectControl([['inbound','Inbound'],['outbound','Outbound']], rule.direction, v => set('direction', v)));
        field('Action', selectControl([['allow','Allow'],['deny','Deny']], rule.action, v => set('action', v)));
      }
      field('Protocol', selectControl([['tcp','TCP'],['all','All traffic']], rule.protocol, value => {
        if (value === 'all') { delete rule.from; delete rule.to; }
        else { rule.from = 8080; rule.to = 8080; }
        set('protocol', value); draw(index);
      }));
      if (!acl && practiceAvailable) {
        const groupOptions = graph().nodes.filter(n=>n.type === 'sg' && n.parent === node.parent).map(n=>[n.id,n.name]);
        if (!graph().nodes.some(n=>n.id===node.id)) groupOptions.push([node.id,'This security group']);
        field('Source type',selectControl([['cidr','IPv4 CIDR'],['sg','Security group']],rule.sourceGroup ? 'sg' : 'cidr',value=>{
          if (value === 'sg') { delete rule.cidr; set('sourceGroup',groupOptions[0]?.[0] ?? node.id); }
          else { delete rule.sourceGroup; set('cidr','0.0.0.0/0'); }
          draw(index);
        }));
        if (rule.sourceGroup) field('Source security group',selectControl(groupOptions,rule.sourceGroup,v=>set('sourceGroup',v)));
      }
      if (!rule.sourceGroup) field(acl ? 'Remote IPv4 CIDR' : 'Source IPv4 CIDR', inputControl('text', rule.cidr, v => set('cidr',v), {maxLength: 18}));
      if (rule.protocol === 'tcp') {
        const ports = el('div', undefined, 'sim-fields');
        ports.append(labelControl('First port', inputControl('number', rule.from, v => set('from',v), {min: 0, max: 65535})),
          labelControl('Last port', inputControl('number', rule.to, v => set('to',v), {min: 0, max: 65535})));
        details.append(ports);
      }
      details.append(button('Remove rule', () => { rules = rules.filter((_, i) => i !== index); update(); draw(); }, 'danger'));
      items.append(details);
    });
  }
  const actions = el('div', undefined, 'actions');
  actions.append(button('Add TCP rule', () => {
    const rule = {protocol:'tcp', cidr:'0.0.0.0/0', from:8080, to:8080};
    if (acl) {
      let number = 10;
      while (rules.some(r => r.direction === 'inbound' && r.number === number)) number += 10;
      Object.assign(rule, {number, direction:'inbound', action:'allow'});
    }
    rules.push(rule); update(); draw(rules.length - 1);
  }));
  panel.append(items, actions);
  form.append(panel); draw();
}

function renderSimulation() {
  if (!simulationAvailable) {
    heading('Restart AWS Field', 'The host is still running an older server. Restart AWS Field on the host, then refresh this page.');
    return;
  }
  const app = graph().customerApp;
  heading('Customer access', 'Simulated internet request directly to an EC2 instance.');
  if (!app) {
    const actions = el('div', undefined, 'actions');
    if (graph().nodes.some(n => n.type === 'ec2')) actions.append(button('Set up an app', () => renderAppForm(), 'primary'));
    else root.append(el('p', 'Add an EC2 instance to simulate an app in this diagram.'));
    actions.append(button('Open Fleet Portal lab', () => createDocument(customerLab(), 'simulate')));
    root.append(actions);
    return;
  }
  const endpoint = lookup(graph(), app.instance);
  const status = el('section', undefined, 'sim-card');
  status.setAttribute('role','status');
  const result = simulationRun;
  status.dataset.result = result?.status ?? 'ready';
  const text = {
    healthy: `Customers can reach ${app.name}`,
    blocked: `Customers can’t reach ${app.name}`,
    degraded: `${app.name} is returning errors`,
  };
  status.append(el('span', 'Simulated app', 'tag'), el('h3', result ? text[result.status] : app.name),
    el('p', result ? result.outcome : `${endpoint?.name ?? 'Missing EC2 target'} · TCP ${app.requestPort}`));
  const actions = el('div', undefined, 'actions');
  actions.append(button('Test customer access', () => {
    simulationRun = testCustomerAccess(graph()); showTrace = false; renderPanel();
    root.querySelector('.sim-card').focus({preventScroll:true});
  }, 'primary'), button('Edit app', () => renderAppForm()));
  status.tabIndex = -1;
  root.append(status, actions);
  if (!result) return;
  const traceButton = button(showTrace ? 'Hide trace' : 'Trace request', () => {
    showTrace = !showTrace; renderPanel();
    root.querySelector('#trace-toggle').focus({preventScroll:true});
  });
  traceButton.id = 'trace-toggle';
  traceButton.setAttribute('aria-expanded', String(showTrace));
  actions.append(traceButton);
  if (!showTrace) return;
  traceButton.setAttribute('aria-controls','request-trace');
  const trace = el('ol', undefined, 'sim-trace');
  trace.id = 'request-trace';
  for (const step of result.steps) {
    const item = el('li', undefined, 'sim-card');
    item.dataset.result = step.status === 'fail' ? 'blocked' : 'healthy';
    item.append(el('h3', `${step.label} · ${step.status === 'fail' ? 'Failed' : 'Passed'}`), el('p', step.detail));
    if (step.nodeId || step.reference) {
      const controls = el('div', undefined, 'actions');
      if (step.nodeId) controls.append(button('Highlight', () => {
        selected = step.nodeId; drawScene(true);
      }), button('Inspect', () => selectResource(step.nodeId)));
      const evidence = rules[step.ruleId];
      if (evidence) {
        item.append(el('p',`${evidence.fidelity} · ${step.ruleId}`));
        if (evidence.detail) item.append(el('p',evidence.detail));
      }
      if (step.reference) {
        const source = el('a','AWS docs','trace-reference');
        source.href = step.reference; source.target = '_blank'; source.rel = 'noopener noreferrer';
        controls.append(source);
      }
      item.append(controls);
    }
    trace.append(item);
  }
  root.append(trace);
}

function renderAppForm() {
  root.replaceChildren();
  root.scrollTop = 0;
  const previous = graph().customerApp;
  const instances = graph().nodes.filter(n => n.type === 'ec2');
  const values = previous ? {...previous} : {name:'My app', instance:instances[0].id, requestPort:8080, listenPort:8080, response:'200'};
  heading(previous ? 'Edit simulated app' : 'Set up a simulated app',
    `The test customer uses ${customer.ip} and TCP source port ${customer.port}.`);
  const form = el('form');
  const name = inputControl('text', values.name, v=>{values.name=v;}, {maxLength:70});
  const targets = instances.map(n => [n.id, `${n.name} · ${lookup(graph(),n.parent).name}`]);
  if (!instances.some(n => n.id === values.instance)) targets.unshift([values.instance, 'Missing EC2 target']);
  const target = selectControl(targets, values.instance, v=>{values.instance=v;});
  const ports = el('div', undefined, 'sim-fields');
  ports.append(labelControl('Requested port',inputControl('number',values.requestPort,v=>{values.requestPort=v;},{min:1,max:65535})),
    labelControl('App listen port',inputControl('number',values.listenPort,v=>{values.listenPort=v;},{min:1,max:65535})));
  const response = selectControl([['200','Running · HTTP 200'],['503','Running · HTTP 503'],['stopped','Stopped']], values.response, v=>{values.response=v;});
  const error = formError();
  const actions = el('div', undefined, 'actions');
  const save = el('button','Save app','primary'); save.type = 'submit';
  actions.append(save, button('Cancel',renderPanel));
  if (previous) {
    const remove = button('Remove app', async () => {
      const next = structuredClone(graph()); delete next.customerApp;
      try { await saveGraph(next); renderPanel(); } catch (err) { error.textContent=err.message; error.hidden=false; }
    }, 'danger');
    actions.append(remove);
  }
  form.append(labelControl('App name',name),labelControl('EC2 target',target),ports,labelControl('App response',response),error,actions);
  form.onsubmit = async event => {
    event.preventDefault(); save.disabled = true; error.hidden = true;
    try {
      const next = structuredClone(graph());
      next.customerApp = {...values, name:values.name.trim()};
      await saveGraph(next);
      renderPanel();
    } catch (err) { error.textContent = err.message; error.hidden = false; }
    finally { save.disabled = false; }
  };
  root.append(form);
}

function renderForm(node, editing) {
  const type = node.type;
  const parent = lookup(graph(),node.parent);
  const vpc = ancestor(graph(),parent,'vpc');
  const region = ancestor(graph(),parent,'region');
  heading(`${editing ? 'Edit' : 'Add'} ${types[type][0]}`, parent ? `Placement · ${parent.name}` : '');
  const form = el('form');
  function text(title, prop, maxlength) {
    const input = el('input'); input.value = node[prop] ?? ''; input.required = true; input.maxLength = maxlength;
    input.oninput = () => { node[prop] = input.value; };
    form.append(labelControl(title,input));
  }
  function choose(title, prop, options) {
    const select = el('select');
    for (const [value, label] of options) { const option = el('option',label); option.value=value; select.append(option); }
    select.value = node[prop] ?? '';
    select.onchange = () => { node[prop] = select.value || undefined; };
    form.append(labelControl(title,select));
  }
  const refs = (kind, filter) => graph().nodes.filter(n=>n.type===kind && filter(n)).map(n=>[n.id,n.name]);
  const inVpc = n => ancestor(graph(),n,'vpc')?.id === vpc?.id;
  text('Diagram label', 'name', 70);
  if (type === 'region') choose('AWS Region', 'region', Object.keys(regionZones).filter(r=>r===node.region || !graph().nodes.some(n=>n.region===r)).map(r=>[r,r]));
  if (type === 'vpc' || type === 'subnet') text('IPv4 CIDR', 'cidr', 18);
  if (type === 'subnet' || type === 'ebs') choose('Availability Zone','az',regionZones[region.region].map(suffix=>[region.region+suffix,region.region+suffix]));
  if (type === 'subnet') {
    choose('Route table','route',[['','VPC main route table'], ...refs('route', n=>inVpc(n) && !n.system)]);
    choose('Network ACL','acl',[['','VPC default network ACL'], ...refs('acl', n=>inVpc(n) && !n.system)]);
    form.append(el('p','The route table determines whether the subnet is public, uses NAT, or is isolated.'));
  }
  if (type === 'route') choose('Default IPv4 route · 0.0.0.0/0','gateway',[['','Local routes only'], ...refs('igw',inVpc), ...refs('nat',inVpc)]);
  if (type === 'nat') form.append(el('p','This public NAT gateway is modeled with an Elastic IP.'));
  if (['ec2','eni','alb','rds'].includes(type)) choose('Security group','sg',[['','VPC default security group'], ...refs('sg',n=>inVpc(n) && !n.system)]);
  if (type === 'ec2') {
    choose('IAM EC2 role','role',[['','No IAM role'], ...refs('role',()=>true)]);
    const address = selectControl([['no','None'],['yes','Assigned']], node.publicIpv4 ? 'yes' : 'no', value => { node.publicIpv4 = value === 'yes'; });
    if (simulationAvailable) form.append(labelControl('Simulated public IPv4', address));
  }
  if (simulationAvailable && (type === 'sg' || type === 'acl')) renderRuleEditor(form, node);
  if (type === 'ebs') {
    const original = form.querySelector('select');
    const redraw = () => {
      form.querySelector('[data-attachment]')?.remove();
      choose('Attach to EC2 in this AZ','instance',[['','Unattached'], ...refs('ec2',n=>lookup(graph(),n.parent).az===node.az)]);
      const latest = form.lastElementChild; latest.dataset.attachment='';
      if (original.parentElement.nextElementSibling !== latest) original.parentElement.after(latest);
    };
    original.addEventListener('change', () => { node.instance=undefined; redraw(); }); redraw();
  }
  if (type === 'alb') choose('Scheme','scheme',[['internal','Internal'],['internet-facing','Internet-facing']]);
  if (type === 'alb' || type === 'dbgroup') {
    const eligible = graph().nodes.filter(n=>n.type === 'subnet' && inVpc(n));
    form.append(el('p','Select subnets across at least two Availability Zones.'));
    const checks = el('div', undefined, 'checklist');
    for (const subnet of eligible) {
      const label = el('label'); const check = el('input'); check.type='checkbox'; check.checked=node.subnets.includes(subnet.id);
      check.onchange=()=>{ node.subnets = check.checked ? [...node.subnets,subnet.id] : node.subnets.filter(id=>id!==subnet.id); };
      label.append(check, el('span', `${subnet.name} · ${subnet.az}`)); checks.append(label);
    }
    if (!eligible.length) checks.append(el('p','Add subnets to this VPC first.'));
    form.append(checks);
  }
  if (practiceAvailable && editableTypes.has(type)) {
    renderResourceControls(form, node, graph(), {el,labelControl,selectControl,inputControl});
  }
  const error = formError();
  const actions = el('div', undefined, 'actions');
  const submit = el('button', editing ? 'Save changes' : 'Add resource','primary'); submit.type='submit';
  actions.append(submit, button('Cancel',cancelForm)); form.append(error,actions);
  form.onsubmit = async event => {
    event.preventDefault(); submit.disabled=true; error.hidden=true;
    try {
      const next = structuredClone(graph());
      const copy = structuredClone(node); copy.name = copy.name.trim();
      if (editing) next.nodes[next.nodes.findIndex(n=>n.id===node.id)] = copy;
      else add(next, copy);
      await saveGraph(next);
      pending = draft = detailForm = undefined;
      selected = copy.id; tab = practiceEdit ? 'practice' : 'details'; practiceEdit=false;
      render(!editing);
      message(`${copy.name} ${editing ? 'updated' : 'added'}.`);
    } catch (err) {
      error.textContent=err.message;
      const source = rules[err.ruleId];
      if (source?.url) {
        const link = el('a','AWS documentation','trace-reference');
        link.href=source.url; link.target='_blank'; link.rel='noopener noreferrer';
        error.append(link);
      }
      error.hidden=false; error.scrollIntoView({block:'nearest'});
    }
    finally { submit.disabled=false; }
  };
  root.append(form);
}

function modal(title) {
  const body = el('div', undefined, 'dialog-body');
  const head = el('div', undefined, 'dialog-head');
  const close = button('×',()=>dialog.close()); close.setAttribute('aria-label','Close');
  head.append(el('h2',title),close); body.append(head); dialog.replaceChildren(body);
  dialog.setAttribute('aria-label',title);
  if (!dialog.open) dialog.showModal();
  return body;
}
function confirmDelete(node) {
  const body = modal('Delete resource');
  body.append(el('p',`Remove ${node.name} from this diagram?`));
  const actions=el('div',undefined,'actions');
  actions.append(button('Cancel',()=>dialog.close()),button('Delete resource',async()=>{
    try {
      const next=structuredClone(graph());
      const children=next.nodes.filter(n=>n.parent===node.id);
      if (children.some(n=>!n.system)) throw new Error('Remove the resources inside this resource first.');
      const removed=new Set([node.id,...children.map(n=>n.id)]);
      next.nodes=next.nodes.filter(n=>!removed.has(n.id));
      await saveGraph(next);
      selected=undefined; dialog.close(); render(true); message(`${node.name} deleted.`);
    } catch(error) { const p=el('p',error.message,'form-error'); body.querySelector('.form-error')?.remove(); body.insertBefore(p,actions); }
  },'danger')); body.append(actions);
}
function changeTitle() {
  const body=modal('Rename diagram');
  const form=el('form'); const input=el('input'); input.value=graph().title; input.maxLength=100; input.required=true;
  const submit=el('button','Save name','primary'); submit.type='submit';
  const actions=el('div',undefined,'actions'); actions.append(submit);
  form.append(labelControl('Diagram name',input),actions); body.append(form); input.select();
  form.onsubmit=async e=>{
    e.preventDefault();
    try { const next=structuredClone(graph()); next.title=input.value.trim(); await saveGraph(next); dialog.close(); render(); }
    catch(error) { message(error.message,true); }
  };
}
async function createDocument(next, nextTab) {
  try {
    validate(next);
    const id=crypto.randomUUID();
    await persist(docs=>docs.push({id,graph:next}));
    dialog.close(); selectDocument(id, nextTab); message(`${next.title} opened.`);
  } catch(error) { message(error.message,true); }
}
function exportDocument() {
  const url=URL.createObjectURL(new Blob([JSON.stringify(graph(),null,2)],{type:'application/json'}));
  const link=el('a'); link.href=url; link.download=`${graph().title.replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'')||'diagram'}.aws-field.json`;
  link.click(); setTimeout(()=>URL.revokeObjectURL(url),1500);
}
function openWorkspace() {
  if (busy) return;
  const body=modal('Diagrams'); const list=el('div',undefined,'stack');
  for (const doc of state.documents) {
    const item=row('region',doc.graph.title,`${doc.graph.nodes.length} resources`,()=>{dialog.close(); selectDocument(doc.id, doc.graph.practice ? 'practice' : 'add');});
    item.setAttribute('aria-pressed',String(activeId===doc.id)); list.append(item);
  }
  const actions=el('div',undefined,'actions');
  actions.append(button('New blank',()=>createDocument(starter(true)),'primary'),button('Open example',()=>createDocument(starter())),button('Rename',changeTitle),button('Export JSON',exportDocument),button('Import JSON',()=>$('import-file').click()));
  body.append(list,actions);
}
$('import-file').onchange=async e=>{
  const [file]=e.target.files; e.target.value='';
  if (!file) return;
  try { if(file.size>2_000_000) throw new Error('Choose an AWS Field diagram under 2 MB.'); await createDocument(JSON.parse(await file.text())); }
  catch(error) { message(error.message,true); }
};
$('workspace').onclick=()=>{if(state) openWorkspace();};
$('fit').onclick=()=>scene.fit(); $('rotate').onclick=()=>scene.rotate();
$('zoom-in').onclick=()=>scene.zoom(1.25); $('zoom-out').onclick=()=>scene.zoom(.8);
for (const item of tabs) item.onclick=()=>{ if (!busy) { practiceEdit=false; tab=item.dataset.tab; cancelForm(); } };

try {
  const response=await fetch('/api/workspace');
  if (!response.ok) throw new Error('The workspace could not be opened.');
  simulationAvailable = response.headers.get('X-AWS-Field-Simulation') === '1';
  practiceAvailable = response.headers.get('X-AWS-Field-Practice') === '1';
  state=await response.json();
  let last;
  try { last=localStorage.getItem('aws-field-active'); } catch {}
  const doc=state.documents.find(doc=>doc.id===last) ?? state.documents[0];
  selectDocument(doc.id, doc.graph.practice ? 'practice' : 'add');
  saveStatus(state.revision ? 'Saved' : 'Ready');
} catch(error) { saveStatus('Unavailable','error'); heading('Could not open the workspace',error.message); }
