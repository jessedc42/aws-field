import test from 'node:test';
import assert from 'node:assert/strict';
import {effective, lookup, starter, validate} from '../public/model.mjs';
import {lessons,createLab,useDiagramForLab,evaluateLab,gradeLab,addLabLoadBalancer,addLabWebServer,requestPort,zones} from '../public/learning.mjs';
import {simulateWeb,simulateObjectRead,simulateStorage,alarmAt} from '../public/service-simulation.mjs';
import {rules} from '../public/aws-rules.mjs';

const refs = (g,key) => lookup(g,g.practice.refs[key]);
const solved = g => {
  const result = evaluateLab(validate(g));
  return gradeLab(result,result.frames.length-1).complete;
};

test('all practice diagrams round-trip and every emitted simulation decision has a source or an explicit assumption', ()=>{
  for (const id of Object.keys(lessons)) {
    const graph = validate(JSON.parse(JSON.stringify(createLab(id))));
    const run = evaluateLab(graph);
    assert.ok(run.frames.length >= 2);
    for (const step of run.frames.flatMap(it=>it.steps)) {
      const rule = rules[step.ruleId];
      assert.ok(rule,step.ruleId);
      if (rule.fidelity === 'AWS-documented rule') assert.match(rule.url,/^https:\/\/docs\.aws\.amazon\.com/);
      else assert.ok(rule.detail);
    }
    assert.equal(gradeLab(run,-1).passed,0);
  }
  const blank = useDiagramForLab(starter(true),'storage');
  assert.deepEqual(evaluateLab(validate(blank)).checks.map(it=>it.status),['unknown','unknown']);
});

test('Fleet Portal passes on two healthy paths, even when independent AZ faults are tested', ()=>{
  const graph = createLab('fleet');
  const start = evaluateLab(graph);
  assert.deepEqual(start.checks.map(it=>it.status),['pass','fail','pass']);
  assert.equal(gradeLab(start,1).passed,1);
  const alb = addLabLoadBalancer(graph);
  const subnets = graph.nodes.filter(n=>n.type === 'subnet' && n.name.startsWith('Private'));
  addLabWebServer(graph,subnets[0],alb);
  assert.equal(solved(graph),false);
  addLabWebServer(graph,subnets[1],alb);
  assert.equal(solved(graph),true);
  assert.deepEqual(evaluateLab(graph).frames[1].nodeIds,[alb.listener.targets[1]]);
  assert.deepEqual(evaluateLab(graph).frames[3].nodeIds,[alb.listener.targets[0]]);
  const route = effective(graph,lookup(graph,alb.subnets[0]),'route');
  delete route.gateway;
  assert.equal(solved(graph),false);
});

test('ALB distinguishes no registered targets, unhealthy health probes and unhealthy application replies', ()=>{
  const graph = createLab('scale');
  const alb=refs(graph,'endpoint');
  const run = () => simulateWeb(validate(graph),{endpoint:alb.id,requestPort});
  const [first,second]=alb.listener.targets.map(id=>lookup(graph,id));
  first.runtime.response='503';
  assert.equal(run().status,'degraded');
  first.runtime.health='503';
  assert.equal(run().status,'healthy');
  second.runtime.health='503';
  assert.equal(run().status,'degraded');
  assert.ok(run().steps.some(step=>step.ruleId === 'alb.fail-open'));
  alb.listener.targets=[];
  assert.equal(run().steps.at(-1).ruleId,'alb.no-targets');
});

test('security group references must resolve in the same VPC and allow ALB target ingress', ()=>{
  const graph=createLab('scale');
  const alb=refs(graph,'endpoint');
  const target=lookup(graph,alb.listener.targets[0]);
  const group=lookup(graph,target.sg);
  assert.equal(group.ingress[0].sourceGroup,alb.sg);
  group.ingress[0].sourceGroup=group.id;
  const result=simulateWeb(validate(graph),{endpoint:alb.id,requestPort,unavailableZone:zones[1]});
  assert.equal(result.status,'blocked');
  group.ingress[0].sourceGroup='missing';
  assert.throws(()=>validate(graph),/valid traffic source/);
});

test('IAM explicit deny and S3 restriction are independently observable', ()=>{
  const graph=createLab('access');
  const bucket=refs(graph,'bucket');
  const role=refs(graph,'role');
  assert.equal(solved(graph),false);
  bucket.restrictPublicBuckets=true;
  assert.equal(solved(graph),true);
  role.objectPolicy='allow-and-deny-read';
  assert.equal(solved(graph),false);
  assert.equal(simulateObjectRead(bucket,role).roleAllowed,false);
  role.objectPolicy='none';
  assert.equal(simulateObjectRead(bucket,role).roleAllowed,true);
  bucket.publicPolicy=false;
  assert.equal(simulateObjectRead(bucket,role).roleAllowed,false);
});

test('gp3 lab grades storage and cost independently, enforcing provisioned limits', ()=>{
  const graph=createLab('storage');
  const volume=refs(graph,'volume');
  assert.equal(solved(graph),false);
  volume.gp3={size:100,iops:4000,throughput:200};
  assert.equal(solved(graph),true);
  assert.equal(simulateStorage(volume,refs(graph,'instance'),{size:100,iops:4000,throughput:200}).cost,17.5);
  volume.gp3.throughput=2000;
  assert.throws(()=>validate(graph),{ruleId:'ebs.gp3'});
});

test('performance checks cover early traffic, warmup and capped capacity', ()=>{
  const graph=createLab('scale');
  const scale=refs(graph,'group');
  assert.equal(solved(graph),false);
  scale.capacity={min:1,desired:2,max:3,target:50,warmup:1};
  assert.equal(solved(graph),true);
  scale.capacity.warmup=2;
  assert.equal(solved(graph),false);
  scale.capacity.desired=5;
  assert.throws(()=>validate(graph),{ruleId:'asg.bounds'});
});

test('RDS distinguishes recovery from initial availability and CloudWatch grades M of N', ()=>{
  const db=createLab('database');
  assert.equal(solved(db),false);
  refs(db,'database').deployment.standby=zones[1];
  const timeline=evaluateLab(db);
  assert.match(timeline.frames[1].summary,/unavailable/);
  assert.match(timeline.frames[2].summary,/unavailable/);
  assert.equal(solved(db),true);
  lookup(db,refs(db,'database').sg).ingress = [];
  assert.equal(solved(db),false);
  assert.equal(evaluateLab(db).frames.at(-1).steps.find(step=>step.ruleId === 'rds.client').status,'fail');
  const monitoring=createLab('alarm');
  assert.equal(solved(monitoring),false);
  refs(monitoring,'alarm').alarm.threshold=5;
  assert.equal(solved(monitoring),true);
  assert.equal(alarmAt(refs(monitoring,'alarm'),[6,2,8]).state,'ALARM');
});
