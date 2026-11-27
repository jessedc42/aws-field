import {add, defaults, lookup, starter, validate} from './model.mjs';
import {rules, trace} from './aws-rules.mjs';
import {simulateWeb, simulateObjectRead, simulateStorage, simulateDatabase, scaleTimeline, alarmAt} from './service-simulation.mjs';

const exams = 'https://docs.aws.amazon.com/aws-certification/latest/';
const saa = (domain, title) => ({title:`SAA-C03 · ${title}`, url:exams+`solutions-architect-associate-03/solutions-architect-associate-03-domain${domain}.html`});
const soa = (domain, title) => ({title:`SOA-C03 · ${title}`, url:exams+`sysops-administrator-associate-03/sysops-administrator-associate-03-domain${domain}.html`});
const rel = 'https://docs.aws.amazon.com/wellarchitected/latest/framework/rel10-bp01.html';
const framework = 'https://docs.aws.amazon.com/wellarchitected/latest/framework/';
export const zones = ['us-east-2a','us-east-2b'];
export const load = [80,120,240,240,240,120];
export const metrics = [0,6,2,8,0,0,0];
export const storageDemand = {size:100,iops:4000,throughput:200};
export const budget = 20;
export const requestPort = 8080;
export const unitCapacity = 100;

export const lessons = {
  fleet:{
    title:'Fleet Portal · Survive an AZ outage', domain:'Resilience', services:'VPC, EC2, Elastic Load Balancing',
    goal:'Return HTTP 200 normally and after losing either us-east-2a or us-east-2b. Test fresh requests after the simulated traffic shift.',
    debrief:'A healthy direct request proves reachability. Surviving both outage tests requires that entry points and healthy backends still work when either zone is gone.',
    exams:[saa(2,'Design resilient architectures'), soa(2,'Reliability and business continuity')],
    design:[['Well-Architected · Deploy to multiple locations',rel],['AWS reference architecture · Web application on AWS','https://d1.awsstatic.com/architecture-diagrams/ArchitectureDiagrams/web-application-architecture-on-aws-ra.pdf'],['AWS Architecture Center','https://aws.amazon.com/architecture/']],
  },
  access:{
    title:'Fleet Portal · Protect objects', domain:'Security', services:'IAM, S3',
    goal:'Permit the same-account application role to read the object. Deny an anonymous read of that same object.',
    debrief:'Read the identity decision and the anonymous request separately. A public-access control changes what the bucket policy can grant, and an explicit Deny still wins for the role.',
    exams:[saa(1,'Design secure architectures'), soa(4,'Security and compliance')],
    design:[['Well-Architected · Grant least privilege',framework+'sec_permissions_least_privileges.html']],
  },
  scale:{
    title:'Fleet Portal · Handle a traffic spike', domain:'Performance', services:'EC2 Auto Scaling, EC2, Elastic Load Balancing',
    goal:'Serve every request in the stated traffic profile, including while new instances are warming.',
    debrief:'The target and bounds change when scale-out is requested. Initial capacity determines how much traffic you can serve while launched instances are warming.',
    exams:[saa(3,'Design high-performing architectures'), soa(1,'Monitoring and performance optimization')],
    design:[['Well-Architected · Performance efficiency',framework+'performance-efficiency.html']],
  },
  storage:{
    title:'Fleet Portal · Right-size block storage', domain:'Cost', services:'EBS, EC2',
    goal:'Keep the volume attached, meet 100 GiB, 4,000 IOPS, and 200 MiB/s, and spend no more than USD $20 per modeled month on the volume.',
    debrief:'gp3 separates storage from provisioned performance. Compare proposed configurations. On AWS, an existing volume cannot shrink in place. Compare the itemized charges and keep the workload envelope in view.',
    exams:[saa(4,'Design cost-optimized architectures'), saa(3,'Design high-performing architectures')],
    design:[['Well-Architected · Cost optimization',framework+'cost-optimization.html']],
  },
  database:{
    title:'Fleet Portal · Recover the database', domain:'Resilience', services:'RDS',
    goal:'Keep the DB endpoint usable at baseline, then make it usable again by the final reconnect event after its primary zone fails.',
    debrief:'The standby enables RDS to promote a replacement. This exercise grades recovery at a named event. It does not measure real-world recovery time or assert uninterrupted connections.',
    exams:[saa(2,'Design resilient architectures'), soa(2,'Reliability and business continuity')],
    design:[['Well-Architected · Deploy to multiple locations',rel]],
  },
  alarm:{
    title:'Fleet Portal · Detect an incident', domain:'CloudOps', services:'CloudWatch',
    goal:'Keep the alarm OK at baseline, detect the incident by event 4, and return to OK by the final event.',
    debrief:'Compare the threshold with the rolling window and the number of required breaches. The trace shows which periods affected the state.',
    exams:[soa(1,'Monitoring, logging, analysis, and remediation')],
    design:[['Well-Architected · Operational excellence',framework+'operational-excellence.html']],
  },
};
for (const lesson of Object.values(lessons)) Object.freeze(lesson);
Object.freeze(lessons);

function put(graph,type,parent,values) {
  const node = {...defaults(graph,type,parent?.id),...values};
  add(graph,node);
  return node;
}
const vpc = graph => graph.nodes.find(n=>n.type === 'vpc');
const webRuntime = () => ({state:'running',port:requestPort,response:'200',health:'200'});
const fromAll = port => ({protocol:'tcp',cidr:'0.0.0.0/0',from:port,to:port});
const fromLb = (id,port) => ({protocol:'tcp',sourceGroup:id,from:port,to:port});

function network(graph) {
  const location = put(graph,'region',null,{name:'Ohio',region:'us-east-2'});
  const network = put(graph,'vpc',location,{name:'Fleet VPC',cidr:'10.42.0.0/16'});
  const gateway = put(graph,'igw',network,{name:'Internet gateway'});
  const route = put(graph,'route',network,{name:'Edge routes',gateway:gateway.id});
  const edge = zones.map((az,i)=>put(graph,'subnet',network,{name:`Public edge ${az.at(-1).toUpperCase()}`,az,cidr:`10.42.${i+1}.0/24`,route:route.id}));
  const app = zones.map((az,i)=>put(graph,'subnet',network,{name:`Private app ${az.at(-1).toUpperCase()}`,az,cidr:`10.42.${i+3}.0/24`}));
  return {location,network,edge,app};
}
export function addLabLoadBalancer(graph) {
  const network = vpc(graph);
  if (!network) throw new Error('Add a VPC before adding the lab ALB.');
  const subnets = zones.map(az=>graph.nodes.find(n=>n.type === 'subnet' && n.parent === network.id && n.az === az &&
    lookup(graph,n.route)?.gateway && lookup(graph,lookup(graph,n.route).gateway)?.type === 'igw'));
  if (subnets.some(n=>!n)) throw new Error('The lab ALB needs a public subnet in each exercise zone.');
  const group = put(graph,'sg',network,{name:'Portal ALB security group',ingress:[fromAll(requestPort)]});
  const node = put(graph,'alb',network,{name:'Portal ALB',scheme:'internet-facing',sg:group.id,subnets:subnets.map(n=>n.id),
    listener:{protocol:'http',port:requestPort,targetPort:requestPort,healthPort:requestPort,targets:[]}});
  graph.practice.refs.endpoint = node.id;
  return node;
}
export function addLabWebServer(graph, subnet, loadBalancer) {
  if (subnet?.type !== 'subnet') throw new Error('Choose a subnet for the web instance.');
  const network = lookup(graph,subnet.parent);
  const lbGroup = lookup(graph,loadBalancer?.sg);
  const group = put(graph,'sg',network,{name:`Web ${subnet.az.at(-1).toUpperCase()} security group`,
    ingress:lbGroup ? [fromLb(lbGroup.id,requestPort)] : [fromAll(requestPort)]});
  const node = put(graph,'ec2',subnet,{name:`Web ${subnet.az.at(-1).toUpperCase()} server`,
    sg:group.id, publicIpv4:!lbGroup, runtime:webRuntime()});
  if (loadBalancer?.listener) loadBalancer.listener.targets.push(node.id);
  return node;
}

export function useDiagramForLab(graph,id) {
  if (!Object.hasOwn(lessons,id)) throw new Error('Choose a supported practice scenario.');
  const refs = {};
  const first = type => graph.nodes.find(n=>n.type === type)?.id;
  const resourceTypes = {
    fleet:{endpoint:'ec2'}, access:{bucket:'s3',role:'role',instance:'ec2'}, scale:{endpoint:'alb',group:'asg'},
    storage:{volume:'ebs',instance:'ec2'}, database:{database:'rds',instance:'ec2'}, alarm:{alarm:'alarm'},
  };
  for (const [key,type] of Object.entries(resourceTypes[id])) {
    const found = first(type);
    if (found) refs[key]=found;
  }
  graph.practice = {lesson:id,refs};
  return graph;
}

export function createLab(id) {
  if (!Object.hasOwn(lessons,id)) throw new Error('Unknown lab.');
  const graph = starter(true);
  graph.title = lessons[id].title;
  const refs = {};
  graph.practice = {lesson:id,refs};
  if (id === 'alarm') {
    const location = put(graph,'region',null,{name:'Ohio',region:'us-east-2'});
    refs.alarm = put(graph,'alarm',location,{name:'Portal errors',alarm:{threshold:10,periods:3,breaches:2}}).id;
    return validate(graph);
  }
  const {location,network:home,edge,app} = network(graph);
  const head = addLabWebServer(graph,edge[0]);
  if (id === 'fleet') refs.endpoint = head.id;
  if (id === 'scale') {
    const alb = addLabLoadBalancer(graph);
    for (const subnet of app) addLabWebServer(graph,subnet,alb);
    refs.group = put(graph,'asg',home,{name:'Portal Auto Scaling group',
      capacity:{min:1,desired:1,max:2,target:90,warmup:2}, loadBalancer:alb.id, subnets:app.map(n=>n.id)}).id;
  }
  if (id === 'access') {
    refs.role = put(graph,'role',null,{name:'Portal instance role',objectPolicy:'allow-read'}).id;
    head.role = refs.role;
    refs.instance = head.id;
    refs.bucket = put(graph,'s3',location,{name:'Portal asset bucket',publicPolicy:true,restrictPublicBuckets:false}).id;
  }
  if (id === 'storage') {
    refs.instance = head.id;
    refs.volume = put(graph,'ebs',location,{name:'Portal data volume',az:edge[0].az,instance:head.id,gp3:{size:200,iops:6000,throughput:300}}).id;
  }
  if (id === 'database') {
    const client = addLabWebServer(graph,app[1]);
    client.name = 'Database client';
    client.publicIpv4 = false;
    refs.instance = client.id;
    const ingress = put(graph,'sg',home,{name:'Database security group',ingress:[fromLb(client.sg,5432)]});
    const group = put(graph,'dbgroup',home,{name:'DB subnet group',subnets:app.map(n=>n.id)});
    refs.database = put(graph,'rds',group,{name:'Portal database',sg:ingress.id,deployment:{primary:zones[0],standby:null}}).id;
  }
  return validate(graph);
}

const check = (title, event, passed) => ({title,event,status:passed == null ? 'unknown' : passed ? 'pass' : 'fail'});
const frame = (title, steps, summary, nodeIds = [], zone) => ({title,steps,summary,nodeIds,zone});
const answer = (frames, checks) => ({frames,checks});
function faultStep(zone, graph) {
  return trace('az.fault','Zone unavailable',`${zone} is unavailable in this event.`,graph.nodes.find(n=>n.type === 'subnet' && n.az === zone),'fail');
}

function availability(graph, refs) {
  const phases = [
    {title:'Baseline request'}, {title:`Lose ${zones[0]}`,zone:zones[0]},
    {title:`Restore ${zones[0]}`,restored:zones[0]}, {title:`Lose ${zones[1]}`,zone:zones[1]},
    {title:`Restore ${zones[1]}`,restored:zones[1]},
  ];
  const output = phases.map(({title,zone,restored})=>{
    const run = simulateWeb(graph,{endpoint:refs.endpoint,requestPort,unavailableZone:zone});
    const leading = zone ? [faultStep(zone,graph)] : restored ?
      [trace('lab.recovery','Zone restored',`${restored} is available again.`)] : [];
    return {up:run.status === 'unknown' ? null : run.status === 'healthy',
      frame:frame(title,[...leading,...run.steps],run.outcome,run.nodes,zone)};
  });
  return answer(output.map(it=>it.frame),[0,1,3].map(i=>check(phases[i].title,i,output[i].up)));
}

function access(graph, refs) {
  const instance = lookup(graph,refs.instance);
  const role = lookup(graph,instance?.role);
  const run = simulateObjectRead(lookup(graph,refs.bucket),role);
  return answer([
    frame('Application object read',run?.steps.slice(0,2) ?? [],run ? run.roleAllowed ? 'GetObject allowed' : 'GetObject denied' : 'Object access is not modeled for these resources.'),
    frame('Anonymous object read',run?.steps.slice(2) ?? [],run ? run.anonymous ? 'Anonymous read exposed' : 'Anonymous read blocked' : 'Object access is not modeled for these resources.'),
  ],[check('Application can read',0,run?.roleAllowed),check('Anonymous access is blocked',1,run && !run.anonymous)]);
}

function scaling(graph, refs) {
  const web = simulateWeb(graph,{endpoint:refs.endpoint,requestPort});
  const group = lookup(graph,refs.group);
  const endpoint = lookup(graph,refs.endpoint);
  const registeredZones = (endpoint?.listener?.targets ?? []).map(id=>lookup(graph,id)?.parent);
  const hasTemplates = group?.loadBalancer === refs.endpoint && group.subnets?.length &&
    group.subnets.every(id=>registeredZones.includes(id));
  const timeline = hasTemplates ? scaleTimeline(group,load,unitCapacity,web.status === 'healthy') : null;
  return answer(load.map((demand,i)=>{
    const item = timeline?.[i];
    const unknown = !item || web.status === 'unknown';
    return frame(`Event ${i+1} · ${demand} req/s`,unknown ? web.steps : [...item.steps,...(i === 0 ? web.steps : [])],
      unknown ? 'The ALB path or scaling group cannot be evaluated.' : `${item.served} of ${demand} requests/s served`,
      unknown || item.capacity === 0 ? [] : web.nodes);
  }),load.map((_,i)=>check(`Serve every request at event ${i+1}`,i,timeline && web.status !== 'unknown' ? timeline[i].served === timeline[i].demand : null)));
}

function storage(graph, refs) {
  const run = simulateStorage(lookup(graph,refs.volume),lookup(graph,refs.instance),storageDemand);
  return answer([
    frame('Provisioned storage check',run?.steps.slice(0,3) ?? [],run ? run.handles ? 'Storage meets the workload envelope' : 'Storage misses the workload envelope' : 'The volume cannot be evaluated.'),
    frame('Monthly price check',run?.steps.slice(3) ?? [],run ? `USD $${run.cost.toFixed(2)} per modeled month` : 'The volume price cannot be evaluated.'),
  ],[check('Meets the storage workload',0,run?.handles),check(`At or below USD $${budget}`,1,run && run.cost <= budget)]);
}

function database(graph, refs) {
  const db = lookup(graph,refs.database);
  const down = db?.deployment?.primary;
  const titles = ['Baseline connection','Lose the primary zone','RDS promotion checkpoint','Application reconnect'];
  const output = titles.map((title,index)=>{
    const zone = index > 0 ? down : undefined;
    const run = simulateDatabase(graph,db,lookup(graph,refs.instance),zone,index);
    const prefix = index === 1 && zone ? [faultStep(zone,graph)] : [];
    return {up:run?.up,frame:frame(title,[...prefix,...(run?.steps ?? [])],
      run?.up == null ? 'The DB path cannot be evaluated for these resources.' : run.up ? 'Database endpoint available' : 'Database endpoint unavailable.',
      run?.nodes ?? [],zone)};
  });
  return answer(output.map(it=>it.frame),[check('Baseline connection works',0,output[0].up),check('Reconnect by the final event',3,output[3].up)]);
}

function monitoring(graph, refs) {
  const output = metrics.map((value,i)=>{
    const run = alarmAt(lookup(graph,refs.alarm),[0,0,0,0,0,...metrics.slice(0,i+1)]);
    return {state:run?.state,frame:frame(`Period ${i+1} · ${value} errors`,run?.steps ?? [],run?.state ?? 'The alarm cannot be evaluated.')};
  });
  return answer(output.map(it=>it.frame),[
    check('Alarm is OK at baseline',0,output[0].state && output[0].state === 'OK'),
    check('Detect incident by event 4',3,output[3].state && output.slice(0,4).some(it=>it.state === 'ALARM')),
    check('Alarm returns to OK',6,output[6].state && output[6].state === 'OK'),
  ]);
}
const exercises = {fleet:availability,access,scale:scaling,storage,database,alarm:monitoring};

export function evaluateLab(graph) {
  if (!graph.practice || !Object.hasOwn(exercises,graph.practice.lesson)) return null;
  return exercises[graph.practice.lesson](graph,graph.practice.refs);
}

export function gradeLab(run, through) {
  const checks = run.checks.map(it=>it.event > through ? {...it,status:'unknown'} : it);
  const passed = checks.filter(it=>it.status === 'pass').length;
  return {checks,passed,complete:passed === checks.length};
}

export function ruleEvidence(step) {
  return rules[step.ruleId];
}
