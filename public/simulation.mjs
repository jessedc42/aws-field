import {trace} from './aws-rules.mjs';
import {aclRules, cidr, effective, lookup} from './model.mjs';

export const customer = {ip: '203.0.113.42', port: 55000};
const ruleIds = {
  'Customer': 'ec2.endpoint', 'EC2 target': 'ec2.endpoint', 'EC2 lifecycle':'ec2.running',
  'Public IPv4': 'vpc.public-address', 'Internet gateway':'vpc.internet-gateway',
  'Subnet route table':'vpc.default-route', 'Network ACL · request':'vpc.acl',
  'Network ACL · reply':'vpc.acl', 'Security group':'vpc.sg',
  'App listener':'app.listener', 'HTTP response':'app.listener',
};
const customerIp = cidr(customer.ip + '/32').start;

export function matches(rule, port, ip = customerIp, sourceGroup) {
  const range = rule.cidr ? cidr(rule.cidr) : null;
  const sourceMatches = range ? ip >= range.start && ip <= range.end : !!sourceGroup && rule.sourceGroup === sourceGroup;
  return sourceMatches && (rule.protocol === 'all' || (port >= rule.from && port <= rule.to));
}
export function aclDecision(acl, direction, port, ip = customerIp) {
  return [...aclRules(acl)].sort((a,b) => a.number - b.number)
    .find(rule => rule.direction === direction && matches(rule, port, ip));
}
export function instanceGroup(graph, node, vpcId) {
  return lookup(graph, node.sg) ?? graph.nodes.find(n => n.type === 'sg' && n.parent === vpcId && n.system);
}
export function ingress(group, port, ip, sourceGroup) {
  return (group.ingress ?? []).some(rule => matches(rule, port, ip, sourceGroup)) ||
    (group.system === true && sourceGroup === group.id && group.ingress === undefined);
}

export function testCustomerAccess(graph, {unavailableZone} = {}) {
  const app = graph.customerApp;
  if (!app) return null;
  const steps = [];
  function step(label, detail, node, status = 'pass') {
    steps.push(trace(ruleIds[label], label, detail, node, status));
  }
  function blocked(outcome) {
    return {status: 'blocked', outcome, steps};
  }
  const instance = lookup(graph, app.instance);
  step('Customer', `${customer.ip}:${customer.port} opens TCP port ${app.requestPort}.`);
  if (!instance) {
    step('EC2 target', 'The selected EC2 instance has been removed. Edit the app to select a target.', null, 'fail');
    return blocked('The endpoint is missing');
  }
  const subnet = lookup(graph, instance.parent);
  if (subnet.az === unavailableZone) {
    steps.push(trace('az.fault', 'Availability Zone', `${subnet.az} is unavailable; ${instance.name} cannot serve the request.`, subnet, 'fail'));
    return blocked('The endpoint is unreachable');
  }
  if (instance.runtime?.state === 'stopped') {
    step('EC2 lifecycle', `${instance.name} is stopped.`, instance, 'fail');
    return blocked('The endpoint is unreachable');
  }
  if (!instance.publicIpv4) {
    step('Public IPv4', `${instance.name} has no public IPv4 address for a direct internet connection.`, instance, 'fail');
    return blocked('The endpoint is unreachable');
  }
  step('Public IPv4', `${instance.name} has a simulated public IPv4 address.`, instance);

  const vpc = lookup(graph, subnet.parent);
  const igw = graph.nodes.find(n => n.type === 'igw' && n.parent === vpc.id);
  if (!igw) {
    step('Internet gateway', `${vpc.name} has no attached internet gateway.`, vpc, 'fail');
    return blocked('The connection timed out');
  }
  step('Internet gateway', `${igw.name} is attached to ${vpc.name}.`, igw);
  const route = effective(graph, subnet, 'route');
  if (route.gateway !== igw.id) {
    const target = lookup(graph, route.gateway);
    const detail = target?.type === 'nat'
      ? `The default IPv4 route in ${route.name} points to ${target.name}. A NAT gateway supports connections initiated from inside the VPC.`
      : `${route.name} has no default IPv4 route to ${igw.name}.`;
    step('Subnet route table', detail, route, 'fail');
    return blocked('The connection timed out');
  }
  step('Subnet route table', `The default IPv4 route in ${route.name} points to ${igw.name}.`, route);

  const acl = effective(graph, subnet, 'acl');
  function checkAcl(direction, port) {
    const rule = aclDecision(acl, direction, port);
    const label = direction === 'inbound' ? 'Network ACL · request' : 'Network ACL · reply';
    const passed = rule?.action === 'allow';
    const action = passed ? 'allows' : 'denies';
    const reason = rule ? `rule ${rule.number}` : 'the implicit deny';
    step(label, `${acl.name}: ${reason} ${action} ${direction} TCP traffic on destination port ${port}.`, acl, passed ? 'pass' : 'fail');
    return passed;
  }
  if (!checkAcl('inbound', app.requestPort)) return blocked('The connection timed out');

  const group = instanceGroup(graph, instance, vpc.id);
  const allowed = ingress(group, app.requestPort);
  const detail = allowed
    ? `${group.name} allows ${customer.ip} on TCP ${app.requestPort}. Replies are allowed by connection tracking.`
    : `${group.name} has no matching inbound allow rule for ${customer.ip} on TCP ${app.requestPort}.`;
  step('Security group', detail, group, allowed ? 'pass' : 'fail');
  if (!allowed) return blocked('The connection timed out');
  if (!checkAcl('outbound', customer.port)) return blocked('The connection timed out');

  if (app.response === 'stopped' || app.listenPort !== app.requestPort) {
    const detail = app.response === 'stopped' ? 'The simulated app is stopped.' : `The app listens on TCP ${app.listenPort}. The request arrived on TCP ${app.requestPort}.`;
    step('App listener', detail, instance, 'fail');
    return blocked('The connection was refused');
  }
  step('App listener', `The app accepts TCP ${app.listenPort} on ${instance.name}.`, instance);
  if (app.response === '503') {
    step('HTTP response', 'The app returned HTTP 503 Service Unavailable.', instance, 'fail');
    return {status: 'degraded', outcome: 'HTTP 503 Service Unavailable', steps};
  }
  step('HTTP response', 'The app returned HTTP 200 OK.', instance);
  return {status: 'healthy', outcome: 'HTTP 200 OK', steps};
}
