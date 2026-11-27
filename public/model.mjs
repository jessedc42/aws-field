import {requireRule, supportedGp3, whole} from './aws-rules.mjs';

export const types = {
  region: ['Region', 'Scope', null, '#a398ff', 'RG'],
  vpc: ['VPC', 'Network', 'region', '#a398ff', 'VP'],
  subnet: ['Subnet', 'Network', 'vpc', '#51e3bd', 'SN'],
  igw: ['Internet gateway', 'Network', 'vpc', '#ffcf72', 'IG'],
  nat: ['Public NAT gateway', 'Network', 'subnet', '#ffcf72', 'NG'],
  route: ['Route table', 'Network', 'vpc', '#72b9ff', 'RT'],
  acl: ['Network ACL', 'Security', 'vpc', '#f795bc', 'NA'],
  sg: ['Security group', 'Security', 'vpc', '#f795bc', 'SG'],
  ec2: ['EC2 instance', 'Compute', 'subnet', '#ffa973', 'EC'],
  eni: ['Network interface', 'Compute', 'subnet', '#ffa973', 'NI'],
  ebs: ['EBS volume', 'Storage', 'region', '#d9a6ff', 'EB'],
  alb: ['Application Load Balancer', 'Network', 'vpc', '#ffcf72', 'LB'],
  asg: ['EC2 Auto Scaling group', 'Compute', 'vpc', '#fdb66e', 'AS'],
  alarm: ['CloudWatch alarm', 'Observability', 'region', '#fb86b9', 'AL'],
  dbgroup: ['DB subnet group', 'Database', 'vpc', '#9ab2ff', 'DG'],
  rds: ['RDS DB instance', 'Database', 'dbgroup', '#9ab2ff', 'DB'],
  s3: ['S3 bucket', 'Storage', 'region', '#50d8ad', 'S3'],
  lambda: ['Lambda function', 'Compute', 'region', '#ffa973', 'λ'],
  log: ['CloudWatch log group', 'Observability', 'region', '#f795bc', 'CW'],
  sns: ['SNS topic', 'Messaging', 'region', '#f795bc', 'NS'],
  sqs: ['SQS queue', 'Messaging', 'region', '#f795bc', 'QS'],
  role: ['IAM EC2 role', 'Security', null, '#f795bc', 'IR'],
};

const fields = {
  region: ['region'], vpc: ['cidr'], subnet: ['cidr', 'az', 'route', 'acl'],
  route: ['system', 'gateway'], acl: ['system', 'rules'], sg: ['system', 'ingress'], nat: ['elasticIp'],
  ec2: ['sg', 'role', 'publicIpv4', 'runtime'], eni: ['sg'], ebs: ['az', 'instance', 'gp3'], alb: ['subnets', 'scheme', 'sg', 'listener'],
  dbgroup: ['subnets'], rds: ['sg', 'deployment'], asg: ['capacity', 'loadBalancer', 'subnets'], alarm: ['alarm'], role: ['objectPolicy'], s3: ['publicPolicy', 'restrictPublicBuckets'],
};
const coreFields = new Set(['id', 'type', 'name', 'parent']);

export const regionZones = {
  'us-east-2': ['a', 'b', 'c'], 'us-east-1': ['a', 'b', 'c', 'd', 'e', 'f'],
  'us-west-2': ['a', 'b', 'c', 'd'], 'eu-west-1': ['a', 'b', 'c'],
  'eu-central-1': ['a', 'b', 'c'], 'ap-southeast-2': ['a', 'b', 'c'],
};

export function lookup(graph, id) {
  return graph.nodes.find(node => node.id === id);
}

export function ancestor(graph, node, type) {
  while (node && node.type !== type) node = lookup(graph, node.parent);
  return node;
}

export function cidr(value) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(value);
  if (!match) return;
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (prefix > 32 || octets.some(octet => octet > 255)) return;
  const start = octets.reduce((result, octet) => result * 256 + octet, 0);
  const count = 2 ** (32 - prefix);
  if (start % count !== 0) return;
  return {start, end: start + count - 1, prefix};
}

const formatCidr = (n, p) => `${[24, 16, 8, 0].map(s => (n >>> s) & 255).join('.')}/${p}`;
const intersects = (a, b) => a.start <= b.end && b.start <= a.end;
const reserved = ['0.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '224.0.0.0/4'].map(cidr);
const byType = (graph, type, parent) => graph.nodes.filter(n => n.type === type && n.parent === parent);

export function nextSubnet(graph, vpc) {
  const range = cidr(vpc.cidr);
  const taken = byType(graph, 'subnet', vpc.id).map(n => cidr(n.cidr));
  for (let prefix = Math.max(24, range.prefix); prefix <= 28; prefix++) {
    const size = 2 ** (32 - prefix);
    let start = range.start;
    while (start + size - 1 <= range.end) {
      const occupied = taken.find(block => intersects(block, {start, end: start + size - 1}));
      if (!occupied) return formatCidr(start, prefix);
      start = Math.ceil((occupied.end + 1) / size) * size;
    }
  }
  return '';
}

export function effective(graph, subnet, type) {
  return lookup(graph, subnet[type]) ?? byType(graph, type, subnet.parent).find(n => n.system);
}

export function subnetMode(graph, subnet) {
  const target = lookup(graph, effective(graph, subnet, 'route')?.gateway);
  return target?.type === 'igw' ? 'Public' : target?.type === 'nat' ? 'Private · NAT' : 'Isolated';
}

export function candidates(graph, type) {
  return graph.nodes.filter(node => node.type === types[type][2] &&
    (type !== 'igw' || !byType(graph, 'igw', node.id).length));
}

export function defaults(graph, type, parentId) {
  const parent = lookup(graph, parentId);
  const count = graph.nodes.filter(n => n.type === type && !n.system).length;
  const node = {id: crypto.randomUUID(), type, name: `${types[type][0]} ${count + 1}`, parent: parentId ?? null};
  if (type === 'region') node.region = Object.keys(regionZones).find(r => !graph.nodes.some(n => n.region === r)) ?? 'us-east-2';
  if (type === 'vpc') node.cidr = `10.${count % 256}.0.0/16`;
  if (type === 'subnet') {
    node.cidr = nextSubnet(graph, parent);
    node.az = ancestor(graph, parent, 'region').region + 'a';
  }
  if (type === 'dbgroup' || type === 'alb') node.subnets = [];
  if (type === 'alb') node.scheme = 'internal';
  if (type === 'ebs') node.az = parent.region + 'a';
  if (type === 'nat') node.elasticIp = true;
  return node;
}

export function add(graph, node) {
  graph.nodes.push(node);
  if (node.type !== 'vpc') return;
  for (const [type, name] of [['route', 'Main route table'], ['acl', 'Default network ACL'], ['sg', 'Default security group']]) {
    graph.nodes.push({id: crypto.randomUUID(), type, name, parent: node.id, system: true});
  }
}

export const isPort = value => Number.isInteger(value) && value >= 1 && value <= 65535;

export function aclRules(node) {
  if (node.rules) return node.rules;
  if (!node.system) return [];
  return ['inbound', 'outbound'].map(direction => ({
    number: 100, direction, action: 'allow', protocol: 'all', cidr: '0.0.0.0/0',
  }));
}

function validateRules(node, acl, fail, sameVpc) {
  const rules = acl ? node.rules : node.ingress;
  if (rules === undefined) return;
  if (!Array.isArray(rules) || rules.length > 100) fail(`${node.name} can have up to 100 modeled rules.`);
  const keys = new Set();
  const isRulePort = value => value === 0 || isPort(value);
  const allowed = new Set(acl ? ['number', 'direction', 'action', 'protocol', 'cidr', 'from', 'to'] : ['protocol', 'cidr', 'sourceGroup', 'from', 'to']);
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object' || Object.keys(rule).some(key => !allowed.has(key)) ||
        !(typeof rule.cidr === 'string' && cidr(rule.cidr) && rule.sourceGroup === undefined || !acl && rule.cidr === undefined && sameVpc(rule.sourceGroup, 'sg')) || !['all','tcp'].includes(rule.protocol)) {
      fail(`${node.name} needs a valid traffic source and TCP or All traffic for each rule.`);
    }
    if (rule.protocol === 'tcp' && (!isRulePort(rule.from) || !isRulePort(rule.to) || rule.from > rule.to)) fail(`${node.name} needs a TCP port range from 0 to 65535.`);
    if (rule.protocol === 'all' && (rule.from !== undefined || rule.to !== undefined)) fail('All traffic rules apply to every port.');
    if (acl) {
      if (!['inbound','outbound'].includes(rule.direction) || !['allow','deny'].includes(rule.action) ||
          !Number.isInteger(rule.number) || rule.number < 1 || rule.number > 32766) fail(`${node.name} needs a direction, an action and a rule number from 1 to 32766.`);
      const key = rule.direction + rule.number;
      if (keys.has(key)) fail(`${node.name} already has rule ${rule.number} in that direction.`);
      keys.add(key);
    } else {
      const range = typeof rule.cidr === 'string' ? cidr(rule.cidr) : null;
      const key = [range ? `${range.start}/${range.prefix}` : rule.sourceGroup, rule.protocol, rule.from, rule.to].join('/');
      if (keys.has(key)) fail(`${node.name} already has that inbound rule.`);
      keys.add(key);
    }
  }
}

export function validate(graph) {
  const fail = message => { throw new Error(message); };
  if (!graph || graph.version !== 1 || typeof graph.title !== 'string' || !graph.title.trim() || graph.title.length > 100 || !Array.isArray(graph.nodes)) {
    fail('This file is not a supported AWS Field diagram.');
  }
  if (graph.nodes.length > 1000) fail('This workspace supports up to 1,000 resources per diagram.');
  const ids = new Set();
  for (const n of graph.nodes) {
    if (!n || !Object.hasOwn(types, n.type) || typeof n.id !== 'string' || !n.id || n.id.length > 100 || ids.has(n.id)) fail('A resource has an invalid type or ID.');
    if (typeof n.name !== 'string' || !n.name.trim() || n.name.length > 70) fail('Resource names must be between 1 and 70 characters.');
    if (Object.keys(n).some(key => !coreFields.has(key) && !fields[n.type]?.includes(key))) fail(`${n.name} has a field this resource type does not support.`);
    if (n.system !== undefined && n.system !== true) fail(`${n.name} has an invalid default resource flag.`);
    ids.add(n.id);
  }
  for (const n of graph.nodes) {
    const required = types[n.type][2];
    if (required ? lookup(graph, n.parent)?.type !== required : n.parent !== null) fail(`${n.name} needs a valid ${types[required]?.[0] ?? 'top-level placement'}.`);
  }
  const regions = new Set();
  const vpcOf = node => ancestor(graph, node, 'vpc')?.id;
  for (const n of graph.nodes) {
    const region = ancestor(graph, n, 'region');
    const sameVpc = (id, type) => {
      const target = lookup(graph, id);
      return target?.type === type && vpcOf(target) === vpcOf(n);
    };
    if (n.type === 'region') {
      if (!Object.hasOwn(regionZones, n.region) || regions.has(n.region)) fail('Choose a supported Region that is not already in the diagram.');
      regions.add(n.region);
    }
    if (n.type === 'vpc' || n.type === 'subnet') {
      const block = cidr(n.cidr);
      if (!block || block.prefix < 16 || block.prefix > 28) fail(`${n.name} needs an aligned IPv4 CIDR between /16 and /28.`);
      if (n.type === 'vpc') {
        if (reserved.some(range => intersects(range, block))) fail(`${n.name} uses a CIDR reserved by AWS.`);
        for (const type of ['route', 'acl', 'sg']) {
          if (byType(graph, type, n.id).filter(child => child.system === true).length !== 1) fail(`${n.name} needs one default ${types[type][0].toLowerCase()}.`);
        }
      } else {
        const range = cidr(lookup(graph, n.parent).cidr);
        if (!range || range.start > block.start || range.end < block.end) fail(`${n.name} must fit inside its VPC CIDR.`);
        if (byType(graph, 'subnet', n.parent).some(other => {
          const otherBlock = cidr(other.cidr);
          return other.id !== n.id && otherBlock && intersects(otherBlock, block);
        })) fail(`${n.name} overlaps another subnet in its VPC.`);
        for (const type of ['route', 'acl']) {
          if (n[type] != null && !sameVpc(n[type], type)) fail(`${n.name} needs a ${types[type][0].toLowerCase()} in its VPC.`);
        }
      }
    }
    if (['subnet', 'ebs'].includes(n.type) && !regionZones[region.region]?.some(zone => n.az === region.region + zone)) fail(`${n.name} needs an Availability Zone in its Region.`);
    if (n.type === 'igw' && byType(graph, 'igw', n.parent).length > 1) fail('A VPC can have only one attached internet gateway.');
    if (n.type === 'route' && n.gateway != null && !['igw', 'nat'].some(type => sameVpc(n.gateway, type))) fail(`${n.name} needs a gateway in its VPC.`);
    if (n.type === 'nat' && n.elasticIp !== true) fail(`${n.name} needs an Elastic IP.`);
    if (n.type === 'ec2' && n.publicIpv4 !== undefined && typeof n.publicIpv4 !== 'boolean') fail(`${n.name} has an invalid public IPv4 setting.`);
    if (n.type === 'sg' || n.type === 'acl') validateRules(n, n.type === 'acl', fail, sameVpc);
    if (['ec2', 'eni', 'alb', 'rds'].includes(n.type) && n.sg != null && !sameVpc(n.sg, 'sg')) fail(`${n.name} needs a security group in its VPC.`);
    if (n.runtime !== undefined) {
      const value = n.runtime;
      if (!value || !['running','stopped'].includes(value.state) || !isPort(value.port) ||
          !['200','503'].includes(value.response) || (value.health !== undefined && !['200','503'].includes(value.health))) fail('A web instance needs a valid running state, listener port and HTTP response.');
    }
    if (n.gp3 !== undefined) requireRule(n.gp3 && supportedGp3(n.gp3), 'ebs.gp3', `${n.name} gp3 settings exceed the supported storage, IOPS, or throughput limits.`);
    if (n.type === 'asg') {
      if (n.subnets !== undefined && (!Array.isArray(n.subnets) || !n.subnets.length ||
          new Set(n.subnets).size !== n.subnets.length || n.subnets.some(id=>!sameVpc(id,'subnet')))) fail('Choose distinct Auto Scaling subnets in the same VPC.');
      if (n.loadBalancer !== undefined && !sameVpc(n.loadBalancer,'alb')) fail('Choose an ALB in the Auto Scaling group’s VPC.');
    }
    if (n.capacity !== undefined) {
      const value = n.capacity;
      requireRule(value && whole(value.min,0,50) && whole(value.max,0,50) && whole(value.desired,value.min,value.max),
        'asg.bounds', 'Auto Scaling capacity must satisfy minimum ≤ desired ≤ maximum within the lab range of 0–50.');
      if (!whole(value.target,1,10000) || !whole(value.warmup,1,4)) fail('Choose a positive request target and a warmup of 1–4 events.');
    }
    if (n.alarm !== undefined) {
      const value = n.alarm;
      if (!value || !whole(value.threshold,1,10000) || !whole(value.periods,1,5) || !whole(value.breaches,1,value.periods)) fail('An alarm needs a threshold and M breaching datapoints in N periods, with 1 ≤ M ≤ N ≤ 5.');
    }
    if (n.objectPolicy !== undefined && !['allow-read','allow-and-deny-read','none'].includes(n.objectPolicy)) fail('Choose a supported IAM object policy.');
    if (['publicPolicy','restrictPublicBuckets'].some(key => n[key] !== undefined && typeof n[key] !== 'boolean')) fail('S3 toggle settings must be true or false.');
    if (n.deployment !== undefined) {
      const value = n.deployment;
      const zones = lookup(graph, n.parent).subnets?.map(id => lookup(graph,id)?.az) ?? [];
      if (!value || !zones.includes(value.primary) || (value.standby !== null && (!zones.includes(value.standby) || value.standby === value.primary))) fail('Choose a primary zone and, for Multi-AZ, a different standby zone in the DB subnet group.');
    }
    if (n.listener !== undefined) {
      const value = n.listener;
      if (!value || !['http'].includes(value.protocol) || ![value.port,value.targetPort,value.healthPort].every(isPort) ||
          !Array.isArray(value.targets) || new Set(value.targets).size !== value.targets.length ||
          value.targets.some(id => typeof id !== 'string' || !id || (lookup(graph,id) && !sameVpc(id,'ec2')))) fail('The listener needs HTTP ports and distinct EC2 target references in its VPC.');
    }
    if (n.type === 'ec2' && n.role != null && lookup(graph, n.role)?.type !== 'role') fail(`${n.name} needs a valid EC2 IAM role.`);
    if (n.type === 'ebs' && n.instance != null) {
      const target = lookup(graph, n.instance);
      if (target?.type !== 'ec2' || lookup(graph, target.parent).az !== n.az) requireRule(false, 'ebs.attach', `${n.name} and its EC2 instance must be in the same Availability Zone.`);
    }
    if (['alb', 'dbgroup'].includes(n.type)) {
      const ids = n.subnets;
      if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.length < 2 || ids.some(id => !sameVpc(id, 'subnet'))) fail(`${n.name} needs at least two subnets in its VPC.`);
      const subnets = ids.map(id => lookup(graph, id));
      const zones = new Set(subnets.map(s => s.az));
      if (zones.size < 2) fail(`${n.name} spans at least two Availability Zones in this model.`);
      if (n.type === 'alb') {
        requireRule(zones.size === ids.length, 'alb.two-zones', 'An Application Load Balancer selects one subnet per Availability Zone.');
        if (!['internal', 'internet-facing'].includes(n.scheme)) fail('Choose an Application Load Balancer scheme.');
        if (subnets.some(s => cidr(s.cidr)?.prefix > 27)) fail('Choose ALB subnets sized /27 or larger.');
        
      }
    }
  }
  if (graph.practice !== undefined) {
    const value = graph.practice;
    if (!value || typeof value.lesson !== 'string' || value.lesson.length > 40 || !value.refs ||
        Array.isArray(value.refs) || typeof value.refs !== 'object' || Object.keys(value.refs).length > 20 ||
        (value.event !== undefined && !whole(value.event,0,20)) || Object.values(value.refs).some(id => typeof id !== 'string' || !id || id.length > 100)) fail('The lab metadata is invalid.');
  }
  if (graph.customerApp !== undefined) {
    const app = graph.customerApp;
    if (!app || typeof app.name !== 'string' || !app.name.trim() || app.name.length > 70 ||
        typeof app.instance !== 'string' || !app.instance || !isPort(app.requestPort) || !isPort(app.listenPort) ||
        !['200','503','stopped'].includes(app.response)) fail('The simulated app needs a name, an EC2 target, valid ports and a response.');
    const target = lookup(graph, app.instance);
    if (target && target.type !== 'ec2') fail('The simulated app target must be an EC2 instance.');
  }
  return graph;
}

export function starter(blank = false) {
  const graph = {version: 1, title: blank ? 'Untitled diagram' : 'Ohio web lab', nodes: []};
  if (blank) return graph;
  const make = (type, parent, props) => {
    const node = {...defaults(graph, type, parent?.id), ...props};
    add(graph, node);
    return node;
  };
  const region = make('region', null, {name: 'Ohio', region: 'us-east-2'});
  const vpc = make('vpc', region, {name: 'Learning VPC', cidr: '10.42.0.0/16'});
  const igw = make('igw', vpc, {name: 'Internet gateway'});
  const edgeRoute = make('route', vpc, {name: 'Edge routes', gateway: igw.id});
  const edge = make('subnet', vpc, {name: 'Public edge', cidr: '10.42.1.0/24', route: edgeRoute.id});
  const nat = make('nat', edge, {name: 'Outbound NAT'});
  const appRoute = make('route', vpc, {name: 'App routes', gateway: nat.id});
  const app = make('subnet', vpc, {name: 'Private app', cidr: '10.42.2.0/24', az: 'us-east-2b', route: appRoute.id});
  const sg = make('sg', vpc, {name: 'App security group'});
  make('ec2', edge, {name: 'Bastion'});
  make('ec2', app, {name: 'App server', sg: sg.id});
  make('s3', region, {name: 'Asset bucket'});
  return validate(graph);
}

export function customerLab() {
  const graph = starter();
  graph.title = 'Fleet Portal lab';
  const subnet = graph.nodes.find(n => n.name === 'Public edge');
  const group = defaults(graph, 'sg', subnet.parent);
  add(graph, {...group, name: 'Portal security group', ingress: [
    {protocol: 'tcp', cidr: '0.0.0.0/0', from: 8080, to: 8080},
  ]});
  const instance = defaults(graph, 'ec2', subnet.id);
  add(graph, {...instance, name: 'Portal server', publicIpv4: true, sg: group.id});
  graph.customerApp = {name: 'Fleet Portal', instance: instance.id, requestPort: 8080, listenPort: 8080, response: '200'};
  return validate(graph);
}
