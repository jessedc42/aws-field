import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {add, candidates, defaults, starter, subnetMode, validate} from '../public/model.mjs';
import {createLab, evaluateLab, gradeLab} from '../public/learning.mjs';

const nodes = (g, type) => g.nodes.filter(n => n.type === type);
const one = (g, type) => nodes(g, type)[0];
const insert = (g,type,parent,props) => {
  const n = {...defaults(g,type,parent?.id), ...props};
  add(g,n);
  return n;
};

test('subnet placement and automatic VPC defaults', () => {
  const g = starter();
  const vpc = one(g, 'vpc');
  const node = insert(g,'subnet',vpc,{});
  assert.equal(subnetMode(g,node),'Isolated');
  assert.equal(nodes(g,'subnet').map(n=>subnetMode(g,n)).join('/'),'Public/Private · NAT/Isolated');
  assert.equal(node.cidr, '10.42.0.0/24');
  validate(g);
  node.cidr = '10.42.1.128/25';
  assert.throws(()=>validate(g),/overlaps/);
  node.cidr = '10.43.1.0/24';
  assert.throws(()=>validate(g),/inside its VPC/);
});

test('instance placement, gateway dependencies and same-VPC links', () => {
  const g = starter();
  const e = one(g, 'ec2');
  const vpc = one(g,'vpc');
  const [edge,app] = nodes(g, 'subnet');
  e.parent = vpc.id;
  assert.throws(()=>validate(g),/valid Subnet/);
  e.parent = edge.id;
  assert.deepEqual(candidates(g,'nat').map(n=>n.id),[edge.id,app.id]);
  const other = insert(g,'vpc',one(g,'region'),{cidr:'10.11.0.0/16'});
  const foreign = nodes(g,'sg').find(n=>n.parent===other.id);
  e.sg=foreign.id;
  assert.throws(()=>validate(g),/security group in its VPC/);
  delete e.sg;
  one(g,'nat').parent = app.id;
  validate(g);
  one(g,'nat').elasticIp = false;
  assert.throws(()=>validate(g),/needs an Elastic IP/);
  one(g,'nat').elasticIp = true;
  one(g,'nat').parent = edge.id;
  insert(g,'igw',vpc,{});
  assert.throws(()=>validate(g),/only one/);
});

test('EBS attachment and multi-AZ resources', () => {
  const g = starter();
  const vpc = one(g,'vpc');
  const region = one(g,'region');
  const [edge,app] = nodes(g,'subnet');
  const [bastion, server] = nodes(g,'ec2');
  const volume = insert(g,'ebs',region,{instance:server.id});
  assert.throws(()=>validate(g),/same Availability Zone/);
  volume.instance = bastion.id;
  const db = insert(g,'dbgroup',vpc,{subnets:[edge.id]});
  assert.throws(()=>validate(g),/at least two subnets/);
  db.subnets.push(app.id);
  insert(g,'rds',db,{});
  validate(g);
  app.az=edge.az;
  assert.throws(()=>validate(g),/at least two Availability Zones/);
  app.az='us-east-2b';
  const alb = insert(g,'alb',vpc,{scheme:'internet-facing',subnets:[edge.id,app.id]});
  validate(g);
  const wrong = insert(g,'subnet',vpc,{az:edge.az});
  alb.subnets = [edge.id,wrong.id];
  assert.throws(()=>validate(g),/at least two Availability Zones/);
});

test('rejects malformed resources, reserved networks and mismatched scopes', () => {
  const g = starter();
  const e = one(g,'ec2');
  e.subnets = 40;
  assert.throws(()=>validate(g),/field this resource type/);
  delete e.subnets;
  const region = one(g,'region');
  insert(g,'vpc',region,{cidr:'169.254.0.0/16'});
  assert.throws(()=>validate(g),/reserved by AWS/);
});

test('HTTP handler serves the editor, validates saves and preserves newer edits', async () => {
  const dir = await mkdtemp(join(tmpdir(),'aws-field-test-'));
  process.env.AWS_FIELD_DATA=dir;
  try {
    const {handleRequest}=await import('../server.mjs');
    const request=(method,url,body,headers={}) => new Promise((resolve,reject)=>{
      const req=Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
      Object.assign(req,{method,url,headers:{'content-type':'application/json',...headers}});
      const res={writeHead(status,headers){this.responseHeaders=headers;this.status=status;this.headersSent=true;},end(bytes){resolve([this.status,bytes.toString(),this.responseHeaders]);}};
      handleRequest(req,res).catch(reject);
    });
    const [ok,html] = await request('GET','/');
    assert.equal(ok,200);
    assert.match(html, /script type="module" src="\/app.mjs"/);
    assert.equal((await request('GET','/data/workspace.json'))[0],404);
    const [,workspace,headers]=await request('GET','/api/workspace');
    assert.equal(headers['X-AWS-Field-Simulation'],'1');
    assert.equal(headers['X-AWS-Field-Practice'],'1');
    const initial=JSON.parse(workspace);
    const broken=structuredClone(initial);
    one(broken.documents[0].graph,'ec2').parent='missing';
    assert.equal((await request('PUT','/api/workspace',broken))[0],400);
    assert.equal((await request('PUT','/api/workspace',initial,{'sec-fetch-site':'cross-site'}))[0],403);
    initial.documents[0].graph.title='Phone edit';
    const next=structuredClone(initial);
    next.documents[0].graph.title='Desktop edit';
    const responses=await Promise.all([request('PUT','/api/workspace',initial),request('PUT','/api/workspace',next)]);
    assert.deepEqual(responses.map(([status])=>status).sort(),[200,409]);
    const committed=JSON.parse(responses.find(([status])=>status===200)[1]);
    const conflict=JSON.parse(responses.find(([status])=>status===409)[1]);
    assert.deepEqual(conflict.state,committed);
    assert.deepEqual(JSON.parse(await readFile(join(dir,'workspace.json'),'utf8')),committed);
    const graph=createLab('fleet');
    graph.practice.event=1;
    committed.documents.push({id:'practice-example',graph});
    const [saved,body]=await request('PUT','/api/workspace',committed);
    assert.equal(saved,200);
    const savedGraph=JSON.parse(body).documents.at(-1).graph;
    assert.equal(gradeLab(evaluateLab(savedGraph),savedGraph.practice.event).passed,1);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
