import {trace} from './aws-rules.mjs';
import {cidr, lookup, effective, subnetMode} from './model.mjs';
import {aclDecision, customer, ingress, instanceGroup, testCustomerAccess} from './simulation.mjs';

const note = (rule, label, detail, node, pass = true) => trace(rule, label, detail, node, pass ? 'pass' : 'fail');
const result = (status, outcome, steps, nodes = []) => ({status, outcome, steps, nodes});
const missing = label => result('unknown', `${label} is missing or has no modeled configuration.`, []);
const address = (subnet, offset) => cidr(subnet.cidr).start + offset;
const allowed = (graph, subnet, direction, port, ip) =>
  aclDecision(effective(graph, subnet, 'acl'), direction, port, ip)?.action === 'allow';

function externalPath(graph, subnet, loadBalancer, port) {
  return subnetMode(graph,subnet) === 'Public' &&
    allowed(graph, subnet, 'inbound', port) && allowed(graph, subnet, 'outbound', customer.port) &&
    ingress(instanceGroup(graph, loadBalancer, subnet.parent), port);
}
function privatePath(graph, from, to, fromResource, toResource, port) {
  const source = address(from,10);
  const destination = address(to,11);
  const sourceGroup = instanceGroup(graph,fromResource,from.parent);
  const group = instanceGroup(graph,toResource,to.parent);
  const groupAllows = ingress(group,port,source,sourceGroup.id);
  // This model uses default outbound SG allow. Network ACLs see connections crossing the subnet boundary.
  const aclsAllow = from.id === to.id || (allowed(graph,from,'outbound',port,destination) &&
    allowed(graph,to,'inbound',port,source) &&
    allowed(graph,to,'outbound',customer.port,source) &&
    allowed(graph,from,'inbound',customer.port,destination));
  return {group,groupAllows,aclsAllow};
}

export function simulateWeb(graph, {endpoint, requestPort, unavailableZone} = {}) {
  const selected = lookup(graph, endpoint);
  if (!selected) return missing('The customer endpoint');
  if (selected.type === 'ec2') {
    if (!selected.runtime) return missing('The EC2 listener');
    const runtime = selected.runtime;
    const direct = testCustomerAccess({...graph,customerApp:{
      instance:selected.id, requestPort, listenPort:runtime.port,
      response:runtime.state === 'stopped' ? 'stopped' : runtime.response,
    }}, {unavailableZone});
    return {...direct, nodes:direct.status === 'healthy' ? [selected.id] : []};
  }
  if (selected.type !== 'alb' || !selected.listener) return missing('The HTTP load balancer listener');

  const listener = selected.listener;
  const steps = [note('alb.probes','ALB model','Using settled probe state, cross-zone routing, and the ALB group’s default outbound allow.',selected)];
  const lbSubnets = selected.subnets.map(id=>lookup(graph,id)).filter(n=>n.az !== unavailableZone);
  const isListening = listener.port === requestPort;
  steps.push(note('alb.listener','Customer listener', `Customer TCP ${requestPort}; ALB HTTP ${listener.port}.`, selected, isListening));
  if (!isListening) return result('blocked','No matching listener',steps);
  if (selected.scheme !== 'internet-facing') {
    steps.push(note('vpc.internet-gateway','Internet entry','This ALB is internal.',selected,false));
    return result('blocked','No public entry point',steps);
  }
  const paths = lbSubnets.filter(n=>externalPath(graph,n,selected,requestPort));
  for (const subnet of lbSubnets) {
    const route = effective(graph,subnet,'route');
    const routed = subnetMode(graph,subnet) === 'Public';
    const network = allowed(graph,subnet,'inbound',requestPort) && allowed(graph,subnet,'outbound',customer.port);
    const group = instanceGroup(graph,selected,subnet.parent);
    const groupAllows = ingress(group,requestPort);
    steps.push(note('vpc.default-route',`Internet route · ${subnet.az}`,routed ? 'The subnet has a route to the internet gateway.' : 'The subnet has no default IPv4 route to an internet gateway.',route,routed));
    steps.push(note('vpc.acl',`ALB subnet ACL · ${subnet.az}`,network ? 'Request and reply are allowed.' : 'The ACL blocks the request or reply.',effective(graph,subnet,'acl'),network));
    steps.push(note('vpc.sg',`ALB ingress · ${subnet.az}`,groupAllows ? 'The ALB security group allows the client.' : 'The ALB security group blocks the client.',group,groupAllows));
  }
  if (!paths.length || paths.length !== lbSubnets.length) return result('blocked',paths.length ? 'At least one surviving entry path is blocked' : 'No reachable ALB entry path',steps);

  const enabled = new Set(lbSubnets.map(n=>n.az));
  const registered = listener.targets.map(id=>lookup(graph,id)).filter(n=>n && enabled.has(lookup(graph,n.parent).az));
  if (!registered.length) {
    steps.push(note('alb.no-targets','Target group','No registered instance remains in an enabled, available zone.',selected,false));
    return result('blocked','Modeled ALB HTTP 503 · no available targets',steps);
  }
  if (registered.some(n=>!n.runtime)) return {...missing('A registered EC2 target runtime'), steps};

  const evaluated = registered.map(instance=>{
    const subnet = lookup(graph,instance.parent);

    const usable = port => paths.every(from => {
      const path = privatePath(graph,from,subnet,selected,instance,port);
      return path.groupAllows && path.aclsAllow;
    });
    const runtime = instance.runtime;
    const probe = runtime.state === 'running' && runtime.port === listener.healthPort && (runtime.health ?? runtime.response) === '200' && usable(listener.healthPort);
    const responds = runtime.state === 'running' && runtime.port === listener.targetPort && runtime.response === '200' && usable(listener.targetPort);
    steps.push(note('alb.targets',`Health check · ${instance.name}`,`HTTP probe on port ${listener.healthPort} in ${subnet.az} ${probe ? 'passes' : 'fails'}.`,instance,probe));
    const group = instanceGroup(graph,instance,subnet.parent);
    const groupAllows = paths.every(from=>privatePath(graph,from,subnet,selected,instance,listener.targetPort).groupAllows);
    const aclsAllow = paths.every(from=>privatePath(graph,from,subnet,selected,instance,listener.targetPort).aclsAllow);
    steps.push(note('vpc.sg-reference',`Target ingress · ${instance.name}`,groupAllows ? 'The target security group allows the ALB on the application port.' : 'The target security group blocks the ALB or application port.',group,groupAllows));
    steps.push(note('vpc.acl',`Target subnet path · ${instance.name}`,aclsAllow ? 'The modeled ALB-to-target path and reply pass the applicable ACLs.' : 'A subnet ACL blocks the modeled target connection or reply.',subnet,aclsAllow));
    return {instance,probe,responds};
  });
  const healthy = evaluated.filter(target=>target.probe);
  const eligible = healthy.length ? healthy : evaluated;
  if (!healthy.length) steps.push(note('alb.fail-open','Fail open','All eligible health checks failed. The ALB can still try the registered targets.',selected));
  for (const target of eligible) steps.push(note('app.listener',`Application reply · ${target.instance.name}`,target.responds ? 'HTTP 200 reaches the customer.' : 'This forwarded request does not return HTTP 200.',target.instance,target.responds));
  const responders = eligible.filter(target=>target.responds).map(target=>target.instance.id);
  return result(responders.length === eligible.length ? 'healthy' : responders.length ? 'degraded' : 'blocked',
    responders.length === eligible.length ? 'HTTP 200 from every eligible target' : 'Some or all forwarded requests fail',steps,responders);
}

export function simulateObjectRead(bucket, role) {
  if (bucket?.type !== 's3' || role?.type !== 'role' || role.objectPolicy === undefined ||
      bucket.publicPolicy === undefined || bucket.restrictPublicBuckets === undefined) return null;
  const auth = role.objectPolicy === 'allow-read';
  const explicitDeny = role.objectPolicy === 'allow-and-deny-read';
  const anonymous = bucket.publicPolicy && !bucket.restrictPublicBuckets;
  // The public policy grants GetObject to Principal "*", including an authenticated requester, absent explicit deny.
  const roleAllowed = !explicitDeny && (auth || bucket.publicPolicy);
  const detail = explicitDeny ? 'The explicit identity Deny overrides Allows.' : roleAllowed ?
    'An applicable Allow grants the same-account role GetObject.' : 'Neither policy grants the role GetObject.';
  return {roleAllowed, anonymous, steps:[
    note('s3.scope','Request scope','One same-account object is requested twice.',bucket),
    note('iam.evaluate','Role GetObject',detail,role,roleAllowed),
    note('s3.public','Anonymous GetObject',anonymous ? 'The public bucket policy grants anonymous reads.' :
      bucket.publicPolicy ? 'RestrictPublicBuckets prevents the public policy from granting anonymous reads.' :
      'The bucket policy grants no anonymous read.',bucket,!anonymous),
  ]};
}

export function estimateWebDesign(graph) {
  const ec2 = graph.nodes.filter(n=>n.type === 'ec2' && n.runtime?.state === 'running').length;
  const alb = graph.nodes.filter(n=>n.type === 'alb').length;
  const compute = ec2 * 730 * .0104;
  const balancing = alb * 730 * .0225;
  return {usd:compute+balancing, detail:`${ec2} running EC2 × USD $0.0104/hr + ${alb} ALB × USD $0.0225/hr, for 730 hours.`};
}

export const gp3Rates = Object.freeze({size:.08, iops:.005, throughput:.06});
export function simulateStorage(volume, instance, workload) {
  if (volume?.type !== 'ebs' || !volume.gp3) return null;
  const {size,iops,throughput} = volume.gp3;
  const attached = instance?.type === 'ec2' && volume.instance === instance.id;
  const handles = attached && size >= workload.size && iops >= workload.iops && throughput >= workload.throughput;
  const components = [size*gp3Rates.size,(iops-3000)*gp3Rates.iops,(throughput-125)*gp3Rates.throughput];
  const cost = Math.round(components.reduce((a,b)=>a+b,0)*100)/100;
  return {handles, cost, steps:[
    note('ebs.attach','EBS attachment',attached ? `Attached to ${instance.name} in ${volume.az}.` : 'The selected EC2 workload has no attachment to this volume.',volume,attached),
    note('ebs.gp3','gp3 provisioning',`${size} GiB · ${iops} IOPS · ${throughput} MiB/s`,volume),
    note('ebs.load','Storage objective',`Needs at least ${workload.size} GiB, ${workload.iops} IOPS and ${workload.throughput} MiB/s.`,volume,handles),
    note('ebs.price','Monthly EBS estimate',`USD $${cost.toFixed(2)} = $${components[0].toFixed(2)} storage + $${components[1].toFixed(2)} extra IOPS + $${components[2].toFixed(2)} extra throughput.`,volume),
  ]};
}

export function simulateDatabase(graph, database, client, unavailableZone, event) {
  if (database?.type !== 'rds' || !database.deployment || client?.type !== 'ec2' || !client.runtime) return null;
  const {primary,standby} = database.deployment;
  const clientSubnet = lookup(graph,client.parent);
  const group = lookup(graph,database.parent);
  if (clientSubnet.parent !== group.parent) return null;
  const failed = primary === unavailableZone;
  const canPromote = !!standby && standby !== unavailableZone;
  const promoted = failed && canPromote && event >= 2;
  const databaseReady = !failed || (promoted && event >= 3);
  const readyClient = clientSubnet.az !== unavailableZone && client.runtime.state === 'running';
  const steps = [
    note('rds.standby','Standby deployment',standby ? `Primary ${primary}; standby ${standby} (no read traffic).` : `Primary ${primary}; no standby configured.`,database),
    ...(failed ? [note('rds.recover','Database failover', !canPromote ? 'There is no available standby.' :
      !promoted ? 'Primary unreachable; failover in progress.' : `Standby in ${standby} promoted.`,database,promoted),
    note('rds.timing','Reconnect checkpoint', databaseReady ? 'The lab permits a fresh connection after promotion.' :
      'The database is unavailable to fresh connections at this event.',database,databaseReady)] : []),
    note('ec2.running','Database client',readyClient ? 'The application client is available.' :
      'The application client is stopped or in the unavailable zone.',client,readyClient),
  ];
  if (!databaseReady || !readyClient) return {up:false,steps,nodes:[]};
  const to = group.subnets.map(id=>lookup(graph,id)).find(n=>n.az === (promoted ? standby : primary));
  if (!to) return {up:null,steps,nodes:[]};
  const path = privatePath(graph,clientSubnet,to,client,database,5432);
  steps.push(note('rds.client','Database security group',path.groupAllows ? 'The DB group allows the modeled client on TCP 5432.' :
    'The DB group blocks the modeled client on TCP 5432.',path.group,path.groupAllows));
  steps.push(note('vpc.acl','Database subnet path',path.aclsAllow ? 'The applicable ACLs allow the connection and reply.' :
    'A subnet ACL blocks the connection or reply.',to,path.aclsAllow));
  const up = path.groupAllows && path.aclsAllow;
  return {up,steps,nodes:up ? [client.id,to.id,database.id] : []};
}

export function scaleTimeline(group, load, capacityPerInstance, deploymentReady) {
  if (group?.type !== 'asg' || !group.capacity) return null;
  const {min,desired,max,target,warmup} = group.capacity;
  let running = desired;
  let update;
  return load.map((demand,index)=>{
    if (update?.at === index) { running = update.count; update = undefined; }
    const goal = Math.max(min, Math.min(max, Math.ceil(demand/target)));
    if (!update && goal > running) update = {at:index+warmup,count:goal};
    const capacity = deploymentReady ? running*capacityPerInstance : 0;
    const served = Math.min(capacity,demand);
    return {running, demand, served, capacity, launch:update?.count, steps:[
      note('asg.bounds','Auto Scaling limits',`Min ${min} · Initial desired ${desired} · Max ${max}`,group),
      note('asg.scaling','Modeled scaling response',`${running} instances ready; calculated scale-out goal ${goal}. ${update ? `${update.count-running} warming for event ${update.at+1}.` : 'No pending launch.'}`,group),
      note('app.capacity','Request capacity',`${served}/${demand} requests/s served at ${capacityPerInstance} requests/s per reachable instance.`,group,served === demand),
    ]};
  });
}

export function alarmAt(node, samples) {
  if (node?.type !== 'alarm' || !node.alarm) return null;
  const {threshold,periods,breaches} = node.alarm;
  const window = samples.slice(-periods);
  const count = window.filter(value=>value>=threshold).length;
  // Practice scenarios supply complete periods. An empty history has insufficient input.
  const state = window.length < periods ? 'INSUFFICIENT_DATA' : count >= breaches ? 'ALARM' : 'OK';
  return {state, steps:[
    note('cw.input','Metric input',`Synthetic error samples per event: ${window.join(', ') || 'none'}.`,node),
    note('cw.alarm','CloudWatch alarm', `${state} · ${count} of ${window.length} samples ≥ ${threshold}; needs ${breaches} of ${periods}.`,node),
  ]};
}
