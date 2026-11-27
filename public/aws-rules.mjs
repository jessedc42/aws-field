const docs = 'https://docs.aws.amazon.com/';
const vpc = docs + 'vpc/latest/userguide/';
const ec2 = docs + 'AWSEC2/latest/UserGuide/';
const alb = docs + 'elasticloadbalancing/latest/application/';
const asg = docs + 'autoscaling/ec2/userguide/';
const rds = docs + 'AmazonRDS/latest/UserGuide/';
const ebs = docs + 'ebs/latest/userguide/';
const cw = docs + 'AmazonCloudWatch/latest/monitoring/';
const framework = docs + 'wellarchitected/latest/framework/';

const documented = (title, url) => ({title, url, fidelity:'AWS-documented rule'});
const assumption = (title, detail, url) => ({title, detail, url, fidelity:'Simulation assumption'});
export const rules = {
  'vpc.public-address': documented('Direct internet access requires a public IPv4 address', vpc + 'VPC_Internet_Gateway.html'),
  'vpc.internet-gateway': documented('Attach an internet gateway', vpc + 'working-with-igw.html'),
  'vpc.default-route': documented('Route IPv4 internet traffic to the internet gateway', vpc + 'route-table-options.html'),
  'vpc.acl': documented('Network ACLs use the first matching rule in each direction', vpc + 'nacl-rules.html'),
  'vpc.sg': documented('A security group must allow the initial connection', vpc + 'security-group-rules.html'),
  'vpc.sg-return': documented('Tracked replies are allowed by security groups', ec2 + 'security-group-connection-tracking.html'),
  'vpc.sg-reference': documented('An ALB security group can be the source for target ingress', alb + 'load-balancer-update-security-groups.html'),
  'vpc.local': documented('The local route supports traffic within the VPC', vpc + 'subnet-route-tables.html'),
  'vpc.subnet-range': documented('Subnet CIDRs are contained in the VPC and have no overlaps', vpc + 'subnet-sizing.html'),
  'ec2.running': documented('The instance must be running to serve the request', ec2 + 'ec2-instance-lifecycle.html'),
  'ec2.endpoint': assumption('Configured EC2 endpoint', 'The scenario uses one fixed client IP, source port, and selected endpoint.'),
  'app.listener': assumption('Simulated application listener', 'A running listener gives the configured HTTP response. The simulator does not run application code or a TCP stack.'),
  'az.fault': assumption('Availability Zone outage', 'The selected zone becomes unavailable at one event. Reachability is evaluated after the modeled traffic shift. Detection and DNS cache timing are excluded.', framework + 'rel10-bp01.html'),
  'lab.recovery': assumption('Restore the scenario', 'Recovery in the lab clears the injected fault immediately.'),
  'alb.listener': documented('A listener checks for connections on its configured protocol and port', alb + 'load-balancer-listeners.html'),
  'alb.two-zones': documented('The model uses a regional ALB with subnets in two or more zones', alb + 'application-load-balancers.html#subnets-load-balancer'),
  'alb.targets': documented('Health checks and enabled zones determine target routing', alb + 'target-group-health-checks.html'),
  'alb.fail-open': documented('An ALB can fail open when every eligible registered target is unhealthy', alb + 'target-group-health-checks.html'),
  'alb.no-targets': documented('An ALB can return 503 when there are no registered targets', alb + 'load-balancer-troubleshooting.html'),
  'alb.probes': assumption('Settled ALB probe state', 'The lab models one HTTP listener, one instance target group, cross-zone routing and scenario probe results. It assumes default outbound security-group allow, representative subnet IPs and a fixed client source port. Threshold convergence and target deregistration delays are excluded.', alb + 'target-group-health-checks.html'),
  'asg.bounds': documented('Desired capacity stays between minimum and maximum', asg + 'asg-capacity-limits.html'),
  'asg.scaling': assumption('Modeled target tracking response', 'The exercise samples requests per second and uses ceil(load ÷ target). The two configured, healthy target instances provide a launch template for the capacity model. New instances become available after the configured number of events. Scale-in is excluded. AWS does not publish this as its exact controller algorithm.', asg + 'as-scaling-target-tracking.html'),
  'app.capacity': assumption('Application capacity model', 'Each healthy instance contributes the configured requests per second. No queue, autoscaling API timing, CPU model, or AWS throughput guarantee is implied.'),
  'iam.evaluate': documented('Within the modeled same-account identity policy, explicit deny overrides allow', docs + 'IAM/latest/UserGuide/reference_policies_evaluation-logic.html'),
  's3.public': documented('RestrictPublicBuckets blocks anonymous reads granted by a public bucket policy', docs + 'AmazonS3/latest/userguide/access-control-block-public-access.html'),
  's3.scope': assumption('S3 request scope', 'Same account, one existing unencrypted object, one authenticated role and one anonymous request. ACLs, organization controls, endpoint policies and access points are excluded.'),
  'ebs.attach': documented('The instance and attached EBS volume must be in the same Availability Zone', ebs + 'ebs-attaching-volume.html'),
  'ebs.gp3': documented('gp3 size, IOPS and throughput can be independently configured within documented limits', ebs + 'general-purpose.html'),
  'ebs.load': assumption('Storage workload envelope', 'The given IOPS, throughput and storage are independent requirements. Assume instance EBS bandwidth is sufficient. This is a provisioning check, not a benchmark.', ebs + 'general-purpose.html'),
  'web.price': assumption('Fixed compute and load balancer illustration', 'Pinned us-east-1 Linux On-Demand example rates, November 23, 2026. The topology stays in Ohio. This subtotal covers 730 instance-hours per running EC2 and 730 ALB base hours per load balancer. It excludes storage, LCU usage, addresses, traffic and credits.', 'https://docs.aws.amazon.com/solutions/latest/prebid-server-deployment-on-aws/cost1.html'),
  'ebs.price': assumption('Fixed gp3 teaching rates', 'USD rates from the published AWS gp3 pricing example, pinned November 23, 2026. The example does not specify a Region. The lab diagram is in Ohio and the rates are illustrative, not a quote for Ohio. Full 30-day month, storage and provisioned performance only.', 'https://aws.amazon.com/ebs/pricing/'),
  'rds.client': documented('Authorize the application to reach the DB listener in its VPC', rds + 'Overview.RDSSecurityGroups.html'),
  'rds.standby': documented('A Multi-AZ DB instance has a standby for failover that does not serve reads', rds + 'Concepts.MultiAZSingleStandby.html'),
  'rds.recover': documented('RDS can promote a standby in another Availability Zone', rds + 'Concepts.MultiAZ.Failover.html'),
  'rds.timing': assumption('Simulated RDS failover timeline', 'Promotion and application reconnect advance on separate events. The lab uses one TCP 5432 endpoint, representative subnet IPs, the first DB subnet per zone, and default outbound security-group allow. AWS failover duration varies. Recovery timing and data loss are outside this exercise.', rds + 'Concepts.MultiAZ.Failover.html'),
  'cw.alarm': documented('A CloudWatch alarm transitions according to M breaching datapoints out of N', cw + 'alarm-evaluation.html'),
  'cw.input': assumption('Simulated CloudWatch metric stream', 'Each event provides one complete, synthetic period. Missing-data policies, high-resolution periods and alarm actions are excluded.', cw + 'alarm-evaluation.html'),
};
for (const entry of Object.values(rules)) Object.freeze(entry);
Object.freeze(rules);

export function trace(ruleId, label, detail, node, status = 'pass') {
  const rule = rules[ruleId];
  if (!rule) throw new Error(`Unknown simulation rule ${ruleId}`);
  return {ruleId, label, detail, nodeId:node?.id, status, reference:rule.url};
}
export const whole = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
export const supportedGp3 = ({size,iops,throughput}) => whole(size,1,65536) && whole(iops,3000,80000) &&
  iops <= Math.max(3000, size * 500) && whole(throughput,125,2000) && throughput <= iops / 4;

export function requireRule(condition, id, message) {
  if (condition) return;
  throw Object.assign(new Error(message), {ruleId:id});
}
