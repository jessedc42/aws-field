import {estimateWebDesign} from './service-simulation.mjs';
import {rules} from './aws-rules.mjs';
import {lookup, subnetMode} from './model.mjs';
import {addLabLoadBalancer, addLabWebServer, createLab, evaluateLab, gradeLab, lessons, ruleEvidence, useDiagramForLab, zones, load, metrics, unitCapacity} from './learning.mjs';

export function renderPractice({root, graph, available, browsing, browse, startLab, update, focus, edit, ui}) {
  const {el, button, labelControl, selectControl, heading} = ui;
  if (!available) {
    heading('Restart AWS Field','The host is running an older server. Restart it before opening the practice labs.');
    return;
  }
  const lesson = graph.practice && Object.hasOwn(lessons,graph.practice.lesson) ? lessons[graph.practice.lesson] : undefined;
  if (!lesson || browsing) {
    heading('AWS practice labs','Open a working environment, then change the design and test it.');
    if (lesson) root.append(button('Return to current lab',()=>browse(false)));
    const list = el('div',undefined,'stack practice-list');
    for (const [id, item] of Object.entries(lessons)) {
      const card = button(undefined,()=>startLab(createLab(id)),'row practice-choice');
      const name = el('span',item.title);
      name.append(el('small',`${item.domain} · ${item.services}`));
      card.append(name);
      list.append(card);
    }
    root.append(list);
    if (!lesson) {
      const attach = el('details',undefined,'practice-details');
      attach.append(el('summary','Use this diagram'));
      attach.append(labelControl('Apply a scenario to your diagram',selectControl(
        [['','Choose a scenario'],...Object.entries(lessons).map(([id,item])=>[id,item.title])],
        '',id=>{if (id) update(next=>useDiagramForLab(next,id));},
      )));
      root.append(attach);
    }
    return;
  }

  const {lesson:id,refs,event} = graph.practice;
  const run = evaluateLab(graph);
  const current = event === undefined ? undefined : Math.min(event,run.frames.length-1);
  const grade = gradeLab(run,current ?? -1);
  const eventFrame = run.frames[current];
  heading(lesson.title,lesson.goal);

  const status = el('section',undefined,'practice-status stack');
  status.append(el('p','Configuration · Valid in AWS Field'));
  const progress = el('p',`Lab ${grade.complete ? 'passed' : 'incomplete'} · ${grade.passed}/${grade.checks.length} checks passed`);
  progress.setAttribute('role','status');
  status.append(progress);
  root.append(status);
  if (id === 'fleet') {
    const estimate = estimateWebDesign(graph);
    const pricing = el('details',undefined,'practice-details');
    pricing.append(el('summary',`Modeled compute + ALB · USD $${estimate.usd.toFixed(2)}/month`),
      el('p',estimate.detail),el('p',rules['web.price'].detail),
      link(el,'AWS EC2 T3 rates','https://aws.amazon.com/ec2/instance-types/t3/'),
      link(el,'AWS ALB base rate',rules['web.price'].url));
    root.append(pricing);
  }

  const actions = el('div',undefined,'actions');
  if (current === undefined) actions.append(button('Run baseline',()=>update(g=>{g.practice.event=0;},true),'primary'));
  else {
    if (current+1 < run.frames.length) actions.append(button('Next event',()=>update(g=>{g.practice.event=current+1;},true),'primary'));
    actions.append(button('Replay',()=>update(g=>{g.practice.event=0;},true)));
  }
  actions.append(button('Browse labs',()=>browse(true)));
  root.append(actions);

  if (eventFrame) {
    const statusCard = el('section',undefined,'sim-card practice-event');
    statusCard.setAttribute('aria-live','polite');
    statusCard.append(el('span',`Event ${current+1} of ${run.frames.length}`,'tag'),
      el('h3',eventFrame.title),el('p',eventFrame.summary));
    root.append(statusCard);
  }

  const gradePanel = el('details',undefined,'practice-details');
  gradePanel.append(el('summary','Required checks'));
  const list = el('ul',undefined,'practice-checks');
  const labels = {pass:'Pass', fail:'Fail', unknown:'Not evaluated'};
  for (const item of grade.checks) {
    const row = el('li',undefined,'practice-check');
    row.dataset.result=item.status;
    row.append(el('strong',labels[item.status]),el('span',item.title));
    if (item.status === 'unknown') row.append(el('small',item.event > (current ?? -1) ?
      `Run through event ${item.event+1}.` : run.frames[item.event].summary));
    list.append(row);
  }
  gradePanel.append(list); root.append(gradePanel);

  const settings = el('details',undefined,'practice-details');
  settings.append(el('summary','Change architecture'));
  if (id === 'fleet' || id === 'scale') {
    const endpoints = graph.nodes.filter(n=>n.type === 'ec2' || n.type === 'alb');
    const options = [['','Choose endpoint'], ...endpoints.map(n=>[n.id,`${n.name} · ${n.type === 'ec2' ? 'EC2' : 'ALB'}`])];
    settings.append(labelControl('Customer endpoint',selectControl(options,refs.endpoint ?? '',value=>update(g=>{
      if (value) g.practice.refs.endpoint=value;
      else delete g.practice.refs.endpoint;
    }))));
    const endpoint = lookup(graph,refs.endpoint);
    if (id === 'fleet') {
      const quick = el('div',undefined,'actions');
      if (!graph.nodes.some(n=>n.type === 'alb')) quick.append(button('Add public ALB',()=>update(g=>{addLabLoadBalancer(g);})));
      if (endpoint?.type === 'alb') {
        const subnets = graph.nodes.filter(n=>n.type === 'subnet' && n.parent === endpoint.parent);
        for (const zone of zones) {
          const subnet = subnets.find(n=>n.az === zone && subnetMode(graph,n) !== 'Public');
          if (!subnet) continue;
          if (endpoint.listener?.targets.some(id=>lookup(graph,id)?.parent===subnet.id)) continue;
          quick.append(button(`Add and register EC2 in ${zone}`,()=>update(g=>{
            addLabWebServer(g,lookup(g,subnet.id),lookup(g,endpoint.id));
          })));
        }
      }
      settings.append(quick);
    }
    if (endpoint) settings.append(button(`Edit ${endpoint.name}`,()=>edit(endpoint.id)));
  }
  const handles = id === 'scale' ? ['group'] : id === 'access' ? ['bucket','role','instance'] :
    id === 'storage' ? ['volume','instance'] : id === 'database' ? ['database','instance'] : id === 'alarm' ? ['alarm'] : [];
  const shortcuts = el('div',undefined,'actions');
  for (const key of handles) {
    const node = lookup(graph,refs[key]);
    if (node) shortcuts.append(button(`Edit ${node.name}`,()=>edit(node.id)));
    else {
      const type = {group:'asg',bucket:'s3',role:'role',instance:'ec2',volume:'ebs',database:'rds',alarm:'alarm'}[key];
      const options = [['','Choose a resource'],...graph.nodes.filter(n=>n.type===type).map(n=>[n.id,n.name])];
      settings.append(labelControl(`Replace missing ${key}`,selectControl(options,'',value=>{
        if (value) update(g=>{g.practice.refs[key]=value;});
      })));
    }
  }
  settings.append(shortcuts);
  settings.append(el('p','Use Add, Resources, and Details to make other changes in this lab.'));
  root.append(settings);

  if (id === 'scale' || id === 'alarm') {
    const narrative = id === 'scale' ? `Requests/s by event: ${load.join(', ')}. Each healthy instance handles ${unitCapacity} requests/s in this exercise.` :
      `Errors by period: ${metrics.join(', ')}. The alarm starts with five quiet periods of history.`;
    root.append(el('p',narrative,'practice-note'));
  }

  if (eventFrame) {
    const evidence = el('details',undefined,'practice-details');
    evidence.append(el('summary','Trace this event'));
    const timeline = el('ol',undefined,'sim-trace');
    for (const step of eventFrame.steps) {
      const rule = ruleEvidence(step);
      const row = el('li',undefined,'sim-card');
      row.dataset.result=step.status === 'fail' ? 'blocked' : 'healthy';
      row.append(el('span',rule.fidelity,'tag'),el('h3',step.label),el('p',step.detail));
      if (rule.detail) row.append(el('p',rule.detail));
      const tools = el('div',undefined,'actions');
      if (step.nodeId) tools.append(button('Locate in 3D',()=>focus(step.nodeId)),button('Inspect',()=>edit(step.nodeId)));
      if (rule.url) tools.append(link(el,'AWS documentation',rule.url));
      row.append(tools,el('small',step.ruleId,'rule-id'));
      timeline.append(row);
    }
    evidence.append(timeline);
    if (!eventFrame.steps.length) evidence.append(el('p',eventFrame.summary));
    root.append(evidence);
  }

  const debrief = el('details',undefined,'practice-details');
  debrief.append(el('summary','Debrief and exam objectives'),el('p',lesson.debrief));
  const outcomes = el('ul',undefined,'practice-checks');
  for (const item of grade.checks.filter(it=>it.event <= (current ?? -1))) {
    const checkpoint = run.frames[item.event];
    const firstFailure = checkpoint.steps.find(step=>step.status === 'fail' && step.ruleId !== 'az.fault' && step.nodeId);
    const nodeId = item.status === 'fail' ? firstFailure?.nodeId : checkpoint.nodeIds[0] ?? checkpoint.steps.at(-1)?.nodeId;
    const line = el('li');
    line.append(el('span',`${labels[item.status]} · ${item.title}. ${checkpoint.summary}.`));
    if (nodeId) line.append(button('Locate in 3D',()=>focus(nodeId,checkpoint)));
    outcomes.append(line);
  }
  debrief.append(outcomes);
  const links = el('ul',undefined,'practice-checks');
  for (const item of lesson.exams) {
    const li=el('li'); li.append(link(el,item.title,item.url)); links.append(li);
  }
  for (const [title,url] of lesson.design) {
    const li=el('li'); li.append(link(el,title,url)); links.append(li);
  }
  debrief.append(links); root.append(debrief);
}

function link(el,title,url) {
  const a = el('a',title,'trace-reference');
  a.href=url;
  a.target='_blank';
  a.rel='noopener noreferrer';
  return a;
}
