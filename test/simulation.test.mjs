import test from 'node:test';
import assert from 'node:assert/strict';
import {aclRules, customerLab, defaults, add, effective, lookup, starter, validate} from '../public/model.mjs';
import {customer, testCustomerAccess} from '../public/simulation.mjs';

const instanceOf = graph => lookup(graph, graph.customerApp.instance);
const subnetOf = graph => lookup(graph, instanceOf(graph).parent);
const run = graph => testCustomerAccess(validate(graph));
const failure = result => result.steps.at(-1);

test('existing diagrams remain valid and Fleet Portal serves a modeled customer', () => {
  assert.equal(run(starter()), null);
  const result = run(customerLab());
  assert.equal(result.status, 'healthy');
  assert.equal(result.outcome, 'HTTP 200 OK');
  assert.ok(result.steps.every(step => step.status === 'pass'));
});

test('a valid diagram can be missing a public address, internet gateway or usable route', () => {
  const graph = customerLab();
  const instance = instanceOf(graph);
  const route = effective(graph, subnetOf(graph), 'route');
  instance.publicIpv4 = false;
  assert.equal(failure(run(graph)).label, 'Public IPv4');
  instance.publicIpv4 = true;
  const igw = route.gateway;
  delete route.gateway;
  assert.equal(failure(run(graph)).nodeId, route.id);
  route.gateway = graph.nodes.find(n => n.type === 'nat').id;
  assert.match(failure(run(graph)).detail, /NAT gateway supports connections initiated from inside/);
  delete route.gateway;
  graph.nodes = graph.nodes.filter(n => n.id !== igw);
  assert.equal(failure(run(graph)).label, 'Internet gateway');
  graph.nodes = graph.nodes.filter(n => n.id !== instance.id);
  assert.equal(failure(run(graph)).label, 'EC2 target');
});

test('security groups match source and destination port and NACLs evaluate both directions', () => {
  const graph = customerLab();
  const app = graph.customerApp;
  const instance = instanceOf(graph);
  const sg = lookup(graph, instance.sg);
  const subnet = subnetOf(graph);
  const acl = defaults(graph, 'acl', subnet.parent);
  add(graph, acl);
  subnet.acl = acl.id;
  const tcp = port => ({protocol:'tcp', from:port, to:port, cidr:customer.ip + '/32'});
  assert.equal(failure(run(graph)).label, 'Network ACL · request');
  acl.rules = [{...tcp(app.requestPort), number:100, action:'allow', direction:'inbound'}];
  sg.ingress[0].cidr = '198.51.100.0/24';
  assert.equal(failure(run(graph)).label, 'Security group');
  sg.ingress = [tcp(app.requestPort)];
  assert.equal(failure(run(graph)).label, 'Network ACL · reply');
  assert.match(failure(run(graph)).detail, /55000/);
  acl.rules.push({...tcp(customer.port), number:100, action:'allow', direction:'outbound'});
  assert.equal(run(graph).status, 'healthy');
  acl.rules.push({...tcp(customer.port), number:90, action:'deny', direction:'outbound'});
  assert.match(failure(run(graph)).detail, /rule 90 denies/);
});

test('defaults and rule compatibility checks are independent of outcomes', () => {
  const graph = customerLab();
  const subnet = subnetOf(graph);
  const acl = effective(graph, subnet, 'acl');
  assert.equal(aclRules(acl).length, 2);
  const instance = instanceOf(graph);
  const sg = lookup(graph, instance.sg);
  sg.ingress.push({...sg.ingress[0]});
  assert.throws(() => validate(graph), /already has that inbound rule/);
  sg.ingress.pop();
  acl.rules = [...aclRules(acl), {...aclRules(acl)[0]}];
  assert.throws(() => validate(graph), /already has rule 100/);
  acl.rules = [];
  assert.equal(failure(run(graph)).label,'Network ACL · request');
  delete acl.rules;
  delete instance.sg;
  assert.equal(failure(run(graph)).label,'Security group');
  graph.customerApp.instance = subnet.id;
  assert.throws(() => validate(graph), /target must be an EC2 instance/);
});

test('listener and HTTP failures appear only after network checks pass', () => {
  const graph = customerLab();
  const app = graph.customerApp;
  app.listenPort = 8081;
  assert.equal(failure(run(graph)).label, 'App listener');
  app.listenPort = app.requestPort;
  app.response = 'stopped';
  assert.equal(run(graph).outcome, 'The connection was refused');
  app.response = '503';
  assert.equal(run(graph).status, 'degraded');
  assert.equal(run(graph).outcome, 'HTTP 503 Service Unavailable');
  instanceOf(graph).publicIpv4 = false;
  assert.equal(run(graph).status, 'blocked');
});
