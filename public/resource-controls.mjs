import {lookup} from './model.mjs';

export const editableTypes = new Set(['ec2','alb','asg','s3','role','rds','alarm','ebs']);

export function renderResourceControls(form, node, graph, ui) {
  const {el, labelControl, selectControl, inputControl} = ui;
  const section = el('section',undefined,'rule-editor');
  section.append(el('h3','Simulation settings'));
  const field = (label, control) => section.append(labelControl(label,control));
  const choices = (label, options, value, update) => field(label,selectControl(options,String(value),update));
  const num = (label, settings, key, min, max) =>
    field(label,inputControl('number',settings[key],value=>{settings[key]=value;},{min,max}));
  const bool = (label, key, yes, no) => {
    node[key] ??= false;
    choices(label,[['true',yes],['false',no]],node[key],v=>{node[key]=v === 'true';});
  };
  if (node.type === 'ec2') {
    node.runtime ??= {state:'running',port:8080,response:'200',health:'200'};
    const state = node.runtime;
    choices('Instance state',[['running','Running'],['stopped','Stopped']],state.state,v=>{state.state=v;});
    num('Application listener port',state,'port',1,65535);
    const responses = [['200','HTTP 200'],['503','HTTP 503']];
    choices('Application response',responses,state.response,v=>{state.response=v;});
    choices('Health check response',responses,state.health ?? state.response,v=>{state.health=v;});
  }
  if (node.type === 'alb') {
    node.listener ??= {protocol:'http',port:8080,targetPort:8080,healthPort:8080,targets:[]};
    const listener = node.listener;
    num('HTTP listener port',listener,'port',1,65535);
    num('Target application port',listener,'targetPort',1,65535);
    num('Health check port',listener,'healthPort',1,65535);
    section.append(el('p','Register EC2 targets. Health checks determine which targets receive traffic.'));
    const targets = graph.nodes.filter(n=>n.type === 'ec2' && lookup(graph,n.parent)?.parent === node.parent);
    appendChecklist(section,targets,listener.targets,ui,ids=>{listener.targets=ids;});
  }
  if (node.type === 'asg') {
    node.capacity ??= {min:1,desired:1,max:3,target:90,warmup:2};
    for (const [label,key,min,max] of [
      ['Minimum capacity','min',0,50],['Initial desired capacity','desired',0,50],['Maximum capacity','max',0,50],
      ['Target requests/s per instance','target',1,10000],['Warmup in events','warmup',1,4],
    ]) num(label,node.capacity,key,min,max);
    const albs = graph.nodes.filter(n=>n.type === 'alb' && n.parent === node.parent);
    choices('ALB target group',[['','Unassigned'],...albs.map(n=>[n.id,n.name])],node.loadBalancer ?? '',v=>{node.loadBalancer=v || undefined;});
    const subnets = graph.nodes.filter(n=>n.type === 'subnet' && n.parent === node.parent);
    section.append(el('p','Launch subnets'));
    appendChecklist(section,subnets,node.subnets ?? [],ui,ids=>{node.subnets=ids.length ? ids : undefined;});
  }
  if (node.type === 'ebs') {
    node.gp3 ??= {size:100,iops:3000,throughput:125};
    section.append(el('p','Choose a proposed volume configuration. On AWS, a smaller existing volume requires replacement and data migration.'));
    num('Proposed gp3 size (GiB)',node.gp3,'size',1,65536);
    num('Provisioned IOPS',node.gp3,'iops',3000,80000);
    num('Provisioned throughput (MiB/s)',node.gp3,'throughput',125,2000);
  }
  if (node.type === 'role') {
    node.objectPolicy ??= 'none';
    choices('Modeled identity policy',[['allow-read','Allow GetObject'],['allow-and-deny-read','Allow + explicit Deny'],['none','No applicable statement']],node.objectPolicy,v=>{node.objectPolicy=v;});
  }
  if (node.type === 's3') {
    bool('Bucket policy','publicPolicy','Public GetObject grant','No public GetObject grant');
    bool('RestrictPublicBuckets','restrictPublicBuckets','Enabled','Disabled');
  }
  if (node.type === 'rds') {
    const zones = [...new Set((lookup(graph,node.parent)?.subnets ?? []).map(id=>lookup(graph,id)?.az).filter(Boolean))];
    if (!zones.length) return;
    node.deployment ??= {primary:zones[0],standby:null};
    const list = zones.map(zone=>[zone,zone]);
    choices('Primary Availability Zone',list,node.deployment.primary,v=>{node.deployment.primary=v;});
    choices('Standby Availability Zone',[['','None · Single-AZ'],...list],node.deployment.standby ?? '',v=>{node.deployment.standby=v || null;});
  }
  if (node.type === 'alarm') {
    node.alarm ??= {threshold:5,periods:3,breaches:2};
    num('Error threshold per period',node.alarm,'threshold',1,10000);
    num('Evaluation periods (N)',node.alarm,'periods',1,5);
    num('Datapoints to alarm (M)',node.alarm,'breaches',1,5);
  }
  form.append(section);
}

function appendChecklist(section, nodes, ids, {el}, update) {
  let checked = new Set(ids);
  const list = el('div',undefined,'checklist');
  for (const node of nodes) {
    const label = el('label');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = checked.has(node.id);
    input.onchange = () => {
      if (input.checked) checked.add(node.id);
      else checked.delete(node.id);
      update([...checked]);
    };
    label.append(input,el('span',node.name)); list.append(label);
  }
  if (nodes.length) section.append(list);
}
