# AWS Field

AWS Field is a phone-first 3D AWS diagram editor. Start with the Ohio web lab or open **Diagrams → New blank**. Workspace changes are saved on the host and are available to other devices that connect to that host. Refresh a device to pick up changes made elsewhere. If you save against an older version, the editor loads the latest workspace and asks you to repeat your edit.

## Run on Ubuntu or macOS

Extract the archive and open the `aws-field` directory. Use Node.js 22 or newer.

```bash
npm install --no-audit --no-fund
./start.sh
```

On macOS you can also double-click `Start AWS Field.command`. Open `http://127.0.0.1:4187/` on the host. The npm step installs the pinned Three.js renderer. The built-in 3D canvas works if npm or WebGL is unavailable. Either renderer runs locally in your browser. The app loads assets from its own server.

## Open on your phone through Tailscale

With Tailscale connected on the host and phone, leave AWS Field running. In a second terminal on the host, check existing Serve routes and use a free HTTPS port. The example uses 8443 so a site already on 443 can continue running.

```bash
tailscale serve status
tailscale serve --bg --https=8443 http://127.0.0.1:4187
```

Open the exact HTTPS URL printed by Tailscale on your phone. Tailscale may ask you to enable HTTPS certificates. The host must stay awake and the app process must stay running. On a host where Tailscale requires operator permissions, run the Serve command with `sudo`. Access follows the tailnet's policy. Anyone allowed to reach this service can edit the shared workspace. These commands use private Tailscale Serve. [Tailscale Serve CLI documentation](https://tailscale.com/docs/reference/tailscale-cli/serve)

To keep the Ubuntu app running through reboots under your own user account, create `~/.config/systemd/user/aws-field.service` with the following contents. Replace `/absolute/path/aws-field` with your extracted directory and `/usr/bin/node` with the output of `command -v node` if it differs.

```ini
[Unit]
Description=AWS Field diagram editor

[Service]
WorkingDirectory=/absolute/path/aws-field
ExecStart=/usr/bin/node /absolute/path/aws-field/server.mjs
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now aws-field.service
loginctl enable-linger "$USER"
```

## Build a diagram

- **Add → EC2 instance**. Tap a highlighted subnet or its list button. Accept the suggested label or edit it, choose a security group and optional IAM role, then tap **Add resource**.
- To build a public subnet, add an internet gateway to its VPC, give a route table a default IPv4 route to that gateway, and choose that route table when adding or editing the subnet. The diagram shows the subnet's resulting routing classification. An EC2 public IP and traffic policy are separate from this classification.
- Use **Resources** to select by name, including route tables and security resources. **Details** shows the selected placement, links and edit controls. Use a drag to orbit, pinch to zoom or pan, and the fit button to bring the diagram back into view.
- Use **Diagrams → Export JSON** to back up a diagram or move it to another AWS Field host. The server saves edits in `data/workspace.json`. Set `AWS_FIELD_DATA` to use a different data directory. Set `PORT` to change the local listener and update your Serve target accordingly.

## Guided practice

Open **Labs** and select an exercise. Each open creates an editable copy. Choose **Run baseline**, then **Next event** to advance through the scenario. **Replay** starts the same event sequence again. **Required checks** keeps credit for checks that passed and marks checks that still need evidence. A configuration change starts a fresh attempt against the new design. The current event is saved with the diagram.

In **Survive an AZ outage**, confirm the single EC2 endpoint works at baseline and loses service with its zone. Open **Change architecture** and build a design that serves both outage cases. The guided controls can create an ALB and register private EC2 instances, or use the normal resource editor and choose your own customer endpoint. **Trace this event** identifies the affected resources in 3D. **Debrief and exam objectives** links the outcomes to the AWS exam guides and design references.

| Exercise | Coverage |
| --- | --- |
| Survive an AZ outage | VPC IPv4 routing, subnet ACLs, security groups, EC2, and ALB target routing |
| Protect objects | IAM explicit deny and S3 public-access restrictions |
| Handle a traffic spike | EC2 Auto Scaling capacity limits and an explicit request and warmup model |
| Right-size block storage | EBS attachment, gp3 provisioning, and a fixed illustrative price calculation |
| Recover the database | RDS Single-AZ versus a Multi-AZ DB instance, with promotion and reconnect checkpoints |
| Detect an incident | CloudWatch M-out-of-N alarms over complete synthetic periods |

Use **Diagrams → New blank** for an empty canvas. **Labs → Use this diagram** applies a scenario to a diagram you built. Select its relevant resources in **Change architecture**. A missing or unsupported dependency leaves its check **Not evaluated**.

The trace labels documented AWS decisions and simulation assumptions, with a stable rule ID for each. AZ outage and recovery events, ALB health convergence, application capacity, scaling, and prices use the assumptions shown in the exercise. The graded EBS exercise uses AWS's published illustrative rates for an unspecified Region. Fleet Portal's informational compute and ALB subtotal uses published Northern Virginia example rates while the diagram itself is in Ohio. This app uses local data and does not connect to or deploy AWS services.

## Simulate customer access

Open **Simulate → Open Fleet Portal lab → Test customer access**. The sample starts healthy. To practice an outage, inspect **Edge routes**, set its default IPv4 route to **Local routes only**, and save. Run the test again, then open **Trace request**. **Highlight** locates a resource on the diagram. **Inspect** opens its details so you can repair it. Restore **Internet gateway** as the target and rerun the test.

On an existing diagram, choose **Simulate → Set up an app**. Pick an EC2 target and the port customers request, then set the app's listener and response. Edit EC2 to assign a simulated public IPv4 address. Edit a security group to add an IPv4 CIDR ingress rule, or edit a network ACL to set numbered allow and deny rules. A retest re-evaluates the current diagram.

The first simulator models one fresh internet IPv4 TCP connection directly to EC2. Its synthetic customer is `203.0.113.42:55000`. It uses a public IPv4 assignment flag, an attached internet gateway, the subnet's effective default IPv4 route, numbered network ACL rules in both directions, and the selected security group's IPv4 ingress rules. App listeners and HTTP 200/503 are scenario inputs. DNS, load balancers, TLS, host firewalls, arbitrary routes, established sessions, and other real network behavior are outside this simulation.

| Simulated decision | Official AWS reference |
| --- | --- |
| Public IPv4, VPC gateway, and direct routes | [Internet gateways](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Internet_Gateway.html), [route table examples](https://docs.aws.amazon.com/vpc/latest/userguide/route-table-options.html) |
| NAT requires working routes for internet egress | [Troubleshoot NAT gateways](https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateway-troubleshooting.html) |
| The first matching numbered ACL rule wins in each direction | [Network ACL rules](https://docs.aws.amazon.com/vpc/latest/userguide/nacl-rules.html), [default ACL](https://docs.aws.amazon.com/vpc/latest/userguide/default-network-acl.html) |
| Security groups track replies, and network ACLs check them separately | [EC2 connection tracking](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/security-group-connection-tracking.html), [VPC flow log examples](https://docs.aws.amazon.com/vpc/latest/userguide/flow-logs-records-examples.html) |

For an upgrade, stop your current server and start the updated copy using the same data directory. The archive excludes `data/` and `node_modules/`. If you extract to a new directory, copy your current workspace data or point `AWS_FIELD_DATA` at the existing directory before starting. Your current Tailscale Serve URL can be reused when the host and port stay the same.

## What the model checks

The catalog has 22 resource types. This release models a single account, six sample commercial Regions, one IPv4 CIDR per VPC, subnet and Availability Zone placement, one modeled security group per applicable resource, a route table's local and default IPv4 routes, public zonal NAT gateways, and standard regional Application Load Balancers and RDS DB instances. Services such as S3 and CloudWatch can appear as regional resources.

The app checks subnet CIDR containment and overlaps, same-VPC associations, internet gateway uniqueness, public NAT Elastic IP requirements, same-AZ EBS attachments, and the subnet requirements for ALBs and DB subnet groups. A missing internet route for an internet-facing ALB is a simulated reachability issue. The labs model HTTP listeners, EC2 targets, selected same-account IAM behavior, and named capacity settings. Live IP availability, service quotas, full IAM evaluation, and precise service timing are outside the model. It creates diagram data and does not connect to AWS.

| Model | AWS reference |
| --- | --- |
| Subnets and route tables | [Subnet IPv4 sizing](https://docs.aws.amazon.com/vpc/latest/userguide/subnet-sizing.html), [Subnet route tables](https://docs.aws.amazon.com/vpc/latest/userguide/subnet-route-tables.html) |
| Internet and public NAT gateways | [Internet gateways](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Internet_Gateway.html), [NAT gateways](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html) |
| EBS, ALB, and RDS placement | [EBS attachments](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-attaching-volume.html), [ALB subnets](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html#subnets-load-balancer), [RDS in a VPC](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_VPC.WorkingWithRDSInstanceinaVPC.html) |

Run `npm test` to check topology, simulation, grading, and workspace save handling.
