import {ancestor, lookup, types, effective, subnetMode} from './model.mjs';

const faces = [[0,1,2,3],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]];
const section = new Set(['region', 'vpc', 'subnet']);
const technical = new Set(['route', 'acl', 'sg']);
const tint = (hex, alpha) => `${hex}${alpha}`;

function arrange(graph, expanded) {
  const boxes = [];
  const add = (node, x, y, z, w, h, d) => boxes.push({node, x, y, z, w, h, d});
  let regionStart = 0;
  for (const region of graph.nodes.filter(n => n.type === 'region')) {
    const vpcs = graph.nodes.filter(n => n.parent === region.id && n.type === 'vpc');
    let cursor = regionStart + 2;
    let depth = 16;
    for (const vpc of vpcs) {
      const children = graph.nodes.filter(n => n.parent === vpc.id);
      const subnets = children.filter(n => n.type === 'subnet');
      const vpcNodes = children.filter(n => n.type !== 'subnet' && (!technical.has(n.type) || expanded(n)));
      const cols = Math.max(1, Math.min(3, subnets.length));
      const width = Math.max(cols * 8 + 2, 10);
      const rows = [];
      for (let i = 0; i < subnets.length; i += cols) {
        const group = subnets.slice(i, i + cols).map(subnet => ({subnet, items: graph.nodes.filter(n => n.parent === subnet.id)}));
        rows.push({group, depth: Math.max(7, ...group.map(({items}) => Math.ceil(items.length / 2) * 3.1 + 2.4))});
      }
      const vpcGlyphs = vpcNodes.flatMap(n => [n, ...graph.nodes.filter(child => child.parent === n.id)]);
      const vpcNodeRows = Math.max(1, Math.ceil(vpcGlyphs.length / (cols * 2)));
      const vpcDepth = 3 + vpcNodeRows * 3.4 + rows.reduce((total, row) => total + row.depth + 0.8, 0);
      add(vpc, cursor + width / 2, .55, 2.2 + vpcDepth / 2, width, .36, vpcDepth);
      let z = 3;
      for (const {group, depth: rowDepth} of rows) {
        for (const [{subnet, items}, index] of group.map((item, index) => [item, index])) {
          const x = cursor + 5 + index * 8;
          add(subnet, x, 1, z + rowDepth / 2, 7.3, .42, rowDepth);
          items.forEach((node, i) => add(node, x + ((i % 2) - .5) * 3.1, 1.37, z + 2 + Math.floor(i / 2) * 3.1, 1.65, 1.62, 1.65));
        }
        z += rowDepth + .8;
      }
      vpcGlyphs.forEach((n, i) => add(n, cursor + 2.6 + (i % (cols * 2)) * 3.5, 1, z + 1.25 + Math.floor(i / (cols * 2)) * 3.1, 1.65, 1.62, 1.65));
      cursor += width + 2.3;
      depth = Math.max(depth, 4 + vpcDepth);
    }
    const regional = graph.nodes.filter(n => n.parent === region.id && n.type !== 'vpc');
    const width = Math.max(12, cursor - regionStart + (regional.length ? 5.5 : 0));
    depth = Math.max(depth, regional.length * 3.1 + 4);
    add(region, regionStart + width / 2, 0, depth / 2, width, .36, depth);
    regional.forEach((n, i) => add(n, regionStart + width - 3, .65, 3.1 * i + 3.5, 1.7, 1.6, 1.7));
    regionStart += width + 5;
  }
  graph.nodes.filter(n => n.type === 'role').forEach((n, i) => add(n, 2 + i * 3.1, .4, -3, 1.7, 1.6, 1.7));
  return boxes;
}

function connections(graph, boxes, selected) {
  const byId = new Map(boxes.map(box => [box.node.id, box]));
  const lines = [];
  function link(from, id, color) {
    const target = byId.get(id);
    if (target) lines.push([from, target, color]);
  }
  for (const box of boxes) {
    const n = box.node;
    if (n.type === 'subnet') {
      const route = effective(graph, n, 'route');
      if (selected === route?.id || selected === n.id) link(box, route?.id, '#8fbdff');
      else link(box, route?.gateway, '#e5b75e');
      const acl = effective(graph, n, 'acl');
      if (selected === acl?.id || selected === n.id) link(box, acl?.id, '#f795bc');
    }
    if (n.type === 'route' && selected === n.id) link(box, n.gateway, '#ffcf72');
    if (['dbgroup','alb','asg'].includes(n.type)) for (const id of n.subnets ?? []) link(box, id, '#9ab2ff');
    if (n.type === 'alb') for (const id of n.listener?.targets ?? []) link(box,id,'#e5b75e');
    if (n.type === 'asg') link(box,n.loadBalancer,'#ffcf72');
    if (n.type === 'rds' && n.deployment) {
      const dbSubnets = lookup(graph,n.parent)?.subnets?.map(id=>lookup(graph,id)) ?? [];
      link(box,dbSubnets.find(subnet=>subnet.az===n.deployment.primary)?.id,'#9ab2ff');
      link(box,dbSubnets.find(subnet=>subnet.az===n.deployment.standby)?.id,'#d9a6ff');
    }
    const vpc = ancestor(graph, n, 'vpc');
    const sg = n.sg ?? graph.nodes.find(child => child.parent === vpc?.id && child.type === 'sg' && child.system)?.id;
    if (['ec2','eni','rds','alb'].includes(n.type) && (selected === n.id || selected === sg)) link(box, sg, '#f795bc');
    link(box, n.instance, '#d9a6ff');
    if (n.type === 'ec2') link(box, n.role, '#f795bc');
  }
  return lines;
}

export function createScene(canvas, labels, onPick, onEngine) {
  let surface = canvas;
  let ctx = null;
  let renderer, camera, scene, three;
  let graph = {nodes: []}, boxes = [], links = [], hits = [];
  let selected, targets = new Set(), impact = new Map(), yaw = -.58, pitch = .91, scale = 17, offsetX = 0, offsetY = 0;
  let center = [0, 0, 0], width = 1, height = 1, frame;
  let fitOnResize = true;
  const pointers = new Map();
  let gestureMoved = false;
  let labelMap = new Map();

  const world = (x, y, z) => {
    x -= center[0]; y -= center[1]; z -= center[2];
    const along = x * Math.sin(yaw) + z * Math.cos(yaw);
    return [x * Math.cos(yaw) - z * Math.sin(yaw), y * Math.cos(pitch) - along * Math.sin(pitch), y * Math.sin(pitch) + along * Math.cos(pitch)];
  };
  const screen = ([x, y, z]) => [width / 2 + offsetX + x * scale, height * .54 + offsetY - y * scale, z];
  const project = (x, y, z) => screen(world(x, y, z));
  const vertices = ({x,y,z,w,h,d}) => [0,1,2,3,4,5,6,7].map(i => [x + ([1,2,5,6].includes(i) ? w : -w) / 2, y + (i >= 4 ? h : 0), z + ([2,3,6,7].includes(i) ? d : -d) / 2]);
  function fit() {
    fitOnResize = true;
    offsetX = 0; offsetY = 0;
    if (!boxes.length) return requestRender();
    const all = boxes.flatMap(vertices);
    center = [0,1,2].map(i => (Math.min(...all.map(p => p[i])) + Math.max(...all.map(p => p[i]))) / 2);
    const points = all.map(p => world(...p));
    const reach = [0, 1].map(i => Math.max(1, ...points.map(p => Math.abs(p[i]))));
    scale = Math.max(.6, Math.min((width - Math.min(135, width * .24)) / (2 * reach[0]), (height - Math.min(142, height * .31)) / (2 * reach[1]), 31));
    requestRender();
  }
  function resize() {
    const rect = surface.getBoundingClientRect();
    width = rect.width || 1;
    height = rect.height || 1;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    if (renderer) { renderer.setPixelRatio(ratio); renderer.setSize(width, height, false); }
    else { surface.width = Math.round(width * ratio); surface.height = Math.round(height * ratio); ctx = surface.getContext('2d'); ctx.setTransform(ratio,0,0,ratio,0,0); }
    if (fitOnResize) fit(); else requestRender();
  }
  function requestRender() {
    if (frame == null) frame = requestAnimationFrame(() => { frame = null; paint(); });
  }
  function polygon(pts, fill, stroke, lineWidth = 1) {
    ctx.beginPath();
    pts.forEach(([x,y], index) => index ? ctx.lineTo(x,y) : ctx.moveTo(x,y));
    ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke();
  }
  function rail(a, b) {
    const start = [a.x, a.y + a.h + .07, a.z];
    const end = [b.x, b.y + b.h + .07, b.z];
    const level = Math.max(start[1], end[1]) + .42;
    return [start, [a.x, level, a.z], [a.x, level, b.z], [b.x, level, b.z], end];
  }
  function eventAccent(id) {
    return impact.get(id) === 'affected' ? '#ff8aab' : impact.get(id) === 'serving' ? '#5ce7be' : undefined;
  }

  function drawCanvas() {
    ctx.clearRect(0,0,width,height);
    const glow = ctx.createRadialGradient(width*.48,height*.52,5,width*.48,height*.52,Math.max(width,height)*.66);
    glow.addColorStop(0,'#232944'); glow.addColorStop(1,'#10121e');
    ctx.fillStyle = glow; ctx.fillRect(0,0,width,height);
    ctx.strokeStyle = '#35405b75'; ctx.lineWidth = .65;
    ctx.beginPath();
    for (let k = -24; k <= 24; k++) {
      for (const [a,b] of [[[k*2, -1,-48],[k*2,-1,48]],[[-48,-1,k*2],[48,-1,k*2]]]) {
        const p = project(a[0]+center[0], a[1], a[2]+center[2]);
        const q = project(b[0]+center[0], b[1], b[2]+center[2]);
        ctx.moveTo(p[0],p[1]); ctx.lineTo(q[0],q[1]);
      }
    }
    ctx.stroke();
    const layer = box => ({region:0,vpc:1,subnet:2}[box.node.type] ?? 3);
    function drawBox(box) {
      const pts = vertices(box).map(p => project(...p));
      const color = eventAccent(box.node.id) ?? types[box.node.type][3];
      const active = selected === box.node.id || targets.has(box.node.id);
      const shell = section.has(box.node.type);
      const colored = shell ? (impact.get(box.node.id) === 'affected' ? '#522739' : {region:'#292741',vpc:'#333354',subnet:'#224948'}[box.node.type]) : color;
      const ordered = faces.map((face, i) => ({i, pts:face.map(j=>pts[j])})).sort((a,b)=>a.pts.reduce((s,p)=>s+p[2],0)-b.pts.reduce((s,p)=>s+p[2],0));
      for (const face of ordered) {
        const fill = shell ? colored : face.i === 1 ? tint(colored,'be') : tint(colored,face.i % 2 ? '7a' : '50');
        polygon(face.pts, fill, active ? '#f1e9ff' : tint(color,shell ? '93' : 'd3'), active ? 1.5 : .85);
      }
    }
    const sorted = [...boxes].sort((a,b)=>layer(a)-layer(b) || project(a.x,a.y,a.z)[2]-project(b.x,b.y,b.z)[2]);
    sorted.filter(b => layer(b) < 3).forEach(drawBox);
    for (const [a,b,color] of links) {
      ctx.beginPath(); ctx.strokeStyle = tint(color,'a9'); ctx.lineWidth = 1.45; ctx.setLineDash([5,4]);
      rail(a,b).map(p => project(...p)).forEach(([x,y],i)=>i ? ctx.lineTo(x,y) : ctx.moveTo(x,y));
      ctx.stroke(); ctx.setLineDash([]);
    }
    sorted.filter(b => layer(b) === 3).forEach(drawBox);
  }
  function buildThree() {
    if (!three) return;
    for (const child of [...scene.children]) {
      scene.remove(child);
      child.traverse(obj => {
        obj.geometry?.dispose();
        for (const material of [obj.material].flat()) material?.dispose();
      });
    }
    const grid = new three.GridHelper(96,48,0x46516b,0x30394f);
    grid.position.set(center[0],-1,center[2]); scene.add(grid);
    for (const box of boxes) {
      const n = box.node;
      const color = eventAccent(n.id) ?? types[n.type][3];
      const shell = impact.get(n.id) === 'affected' && n.type === 'subnet' ? '#522739' :
        {region:'#292741',vpc:'#38385b',subnet:'#245251'}[n.type];
      const active = selected === n.id || targets.has(n.id);
      const geometry = new three.BoxGeometry(box.w, box.h, box.d);
      const colors = ['#97a2c0','#626a87','#d8e1ff','#57627d','#8490b1','#6d7897'];
      const materials = colors.map(shade => new three.MeshBasicMaterial({color: new three.Color(shell ?? color).multiply(new three.Color(shade))}));
      const mesh = new three.Mesh(geometry, materials);
      mesh.position.set(box.x,box.y + box.h / 2,box.z);
      mesh.add(new three.LineSegments(new three.EdgesGeometry(geometry),new three.LineBasicMaterial({color: active ? '#f1e9ff' : color, transparent: true, opacity: shell ? .64 : .9})));
      scene.add(mesh);
    }
    for (const [a,b,color] of links) {
      const pts = rail(a,b).map(p => new three.Vector3(...p));
      const line = new three.Line(new three.BufferGeometry().setFromPoints(pts),new three.LineDashedMaterial({color, dashSize:.43,gapSize:.26}));
      line.computeLineDistances(); scene.add(line);
    }
  }
  function paint() {
    if (renderer) {
      camera.left = (-width/2 - offsetX) / scale;
      camera.right = (width/2 - offsetX) / scale;
      camera.top = (height*.54 + offsetY) / scale;
      camera.bottom = (-height*.46 + offsetY) / scale;
      const radius = 2500;
      camera.position.set(center[0]+radius*Math.sin(yaw)*Math.cos(pitch),center[1]+radius*Math.sin(pitch),center[2]+radius*Math.cos(yaw)*Math.cos(pitch));
      camera.lookAt(...center); camera.updateProjectionMatrix(); renderer.render(scene,camera);
    } else drawCanvas();
    hits = [];
    const occupied = [];
    const priority = [...boxes].sort((a,b) => Number(targets.has(b.node.id) || impact.has(b.node.id) || selected===b.node.id)-Number(targets.has(a.node.id) || impact.has(a.node.id) || selected===a.node.id) || Number(section.has(a.node.type))-Number(section.has(b.node.type)));
    for (const {node:n,...box} of priority) {
      const shell = section.has(n.type);
      const labelPoint = shell ? [box.x,box.y+box.h,box.z+box.d/2-.15] : [box.x,box.y+box.h+.46,box.z];
      const [x,y,depth] = project(...labelPoint);
      const active = selected === n.id || targets.has(n.id) || impact.has(n.id);
      hits.push({n, pts: vertices(box).map(p=>project(...p)), depth});
      const label = labelMap.get(n.id);
      const hidden = x < 24 || x > width - 28 || y < 15 || y > height - 18 || (!active && (technical.has(n.type) || occupied.some(p=>Math.abs(p[0]-x)<52 && Math.abs(p[1]-y)<20)));
      label.hidden = hidden;
      if (!hidden) { label.style.left = `${x}px`; label.style.top = `${y}px`; occupied.push([x,y]); }
    }
  }
  function pick(x,y) {
    function contains(pts) {
      let within = false;
      for (let i=0,j=pts.length-1;i<pts.length;j=i++) {
        const [ax,ay]=pts[i], [bx,by]=pts[j];
        if ((ay>y)!==(by>y) && x<(bx-ax)*(y-ay)/(by-ay)+ax) within=!within;
      }
      return within;
    }
    const possible = hits.filter(h => faces.some(face=>contains(face.map(i=>h.pts[i]))));
    const rank = h => targets.has(h.n.id) ? 5 : ({region:1,vpc:2,subnet:3}[h.n.type] ?? 4);
    possible.sort((a,b)=>rank(b)-rank(a) || b.depth-a.depth);
    if (possible[0]) onPick(possible[0].n.id);
  }
  function bind(el) {
    el.addEventListener('pointerdown', e => {
      if (!pointers.size) gestureMoved = false;
      else gestureMoved = true;
      pointers.set(e.pointerId,[e.clientX,e.clientY,e.clientX,e.clientY]); el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', e => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const dx = e.clientX-prev[0], dy = e.clientY-prev[1];
      pointers.set(e.pointerId,[e.clientX,e.clientY,prev[2],prev[3]]);
      if (Math.hypot(e.clientX-prev[2], e.clientY-prev[3]) > 6) gestureMoved = true;
      if (!gestureMoved) return;
      fitOnResize = false;
      if (pointers.size > 1) {
        const other = [...pointers.entries()].find(([id])=>id!==e.pointerId)[1];
        const start = Math.hypot(other[0]-prev[0],other[1]-prev[1]);
        const end = Math.hypot(other[0]-e.clientX,other[1]-e.clientY);
        if (start>5) scale = Math.max(.55,Math.min(75,scale*end/start));
        offsetX += dx/2; offsetY += dy/2;
      } else if (e.shiftKey || e.buttons === 2) { offsetX += dx; offsetY += dy; }
      else { yaw += dx*.009; pitch = Math.max(.24,Math.min(1.49,pitch+dy*.008)); }
      requestRender();
    });
    el.addEventListener('pointerup', e => {
      if (!gestureMoved && e.button === 0 && pointers.has(e.pointerId)) { const r=el.getBoundingClientRect(); pick(e.clientX-r.left,e.clientY-r.top); }
      pointers.delete(e.pointerId);
    });
    el.addEventListener('pointercancel', e=>pointers.delete(e.pointerId));
    el.addEventListener('contextmenu', e=>e.preventDefault());
    el.addEventListener('wheel',e=>{e.preventDefault(); zoom(Math.exp(-e.deltaY*.001));},{passive:false});
  }
  function zoom(factor) { fitOnResize=false; scale=Math.max(.55,Math.min(75,scale*factor)); requestRender(); }
  bind(surface); resize();
  new ResizeObserver(resize).observe(canvas.parentElement);
  onEngine('3D canvas');
  fetch('/vendor/three.module.js', {method:'HEAD'}).then(async res => {
    if (!res.ok) return;
    const module = await import('/vendor/three.module.js');
    const next = canvas.cloneNode();
    const engine = new module.WebGLRenderer({canvas:next,antialias:true,alpha:false, powerPreference:'low-power'});
    renderer=engine; three=module; scene=new three.Scene(); scene.background=new three.Color('#141726');
    camera = new three.OrthographicCamera(-1,1,1,-1,.1,6000);
    canvas.replaceWith(next); surface=next; bind(surface); buildThree(); resize(); onEngine('Three.js');
  }).catch(()=>{});
  return {
    show(next, active, possible, refit = false, overlay) {
      graph=next; selected=active; targets=new Set(possible);
      impact=new Map();
      for (const n of next.nodes) {
        if (overlay?.zone && ancestor(next,n,'subnet')?.az === overlay.zone) impact.set(n.id,'affected');
      }
      for (const id of overlay?.nodeIds ?? []) impact.set(id,'serving');
      for (const step of overlay?.steps ?? []) {
        if (step.nodeId && step.status === 'fail' && !impact.has(step.nodeId)) impact.set(step.nodeId,'affected');
      }
      const inspected=lookup(graph,selected);
      const inspectedVpc=ancestor(graph,inspected,'vpc');
      boxes=arrange(graph,n=>targets.has(n.id) || impact.has(n.id) || selected===n.id || (inspected && ancestor(graph,n,'vpc')?.id===inspectedVpc?.id && ['route','acl','sg','subnet','ec2','eni','alb','rds'].includes(inspected.type)));
      links=connections(graph,boxes,selected);
      labels.replaceChildren(); labelMap=new Map();
      for (const box of boxes) {
        const n=box.node;
        const label=document.createElement('button'); label.type='button'; label.tabIndex=-1;
        label.className=`node-label${selected===n.id?' selected':''}${targets.has(n.id)?' target':''}`;
        label.textContent=n.name;
        if (impact.has(n.id)) label.dataset.impact=impact.get(n.id);
        if (n.type==='subnet' || impact.has(n.id)) {
          const sub=document.createElement('small');
          sub.textContent=impact.get(n.id) === 'affected' ? 'Affected' : impact.get(n.id) === 'serving' ? 'Serving' : subnetMode(graph,n);
          label.append(sub);
        }
        label.onclick=()=>onPick(n.id); labelMap.set(n.id,label); labels.append(label);
      }
      if (refit) fit(); else requestRender();
      buildThree();
    },
    fit, zoom,
    rotate() { yaw += Math.PI/6; fit(); },
  };
}
