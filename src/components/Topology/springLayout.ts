import type { TopologyGraphEdge, TopologyGraphNode } from './topologyGraph';

export interface SpringLayoutNode {
  nodeNum: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  isLocal: boolean;
  fixed: boolean;
}

export interface SpringLayoutBounds {
  width: number;
  height: number;
}

function seededUnit(nodeNum: number): number {
  let hash = nodeNum | 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 0xffffffff;
}

export function topologyNodeRadius(node: Pick<TopologyGraphNode, 'degree' | 'isLocal'>): number {
  return 12 + Math.min(node.degree, 8) * 1.25 + (node.isLocal ? 3 : 0);
}

export function createSpringLayout(
  graphNodes: TopologyGraphNode[],
  bounds: SpringLayoutBounds,
  previous: SpringLayoutNode[] = [],
): SpringLayoutNode[] {
  const previousByNum = new Map(previous.map(node => [node.nodeNum, node]));
  const centerX = bounds.width / 2;
  const centerY = bounds.height / 2;
  const orbit = Math.max(60, Math.min(bounds.width, bounds.height) * 0.3);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  return graphNodes.map((node, index) => {
    const old = previousByNum.get(node.nodeNum);
    const radius = topologyNodeRadius(node);
    if (old) {
      return {
        ...old,
        radius,
        isLocal: node.isLocal,
        x: Math.max(radius, Math.min(bounds.width - radius, old.x)),
        y: Math.max(radius, Math.min(bounds.height - radius, old.y)),
        fixed: false,
      };
    }

    if (node.isLocal) {
      return {
        nodeNum: node.nodeNum,
        x: centerX,
        y: centerY,
        vx: 0,
        vy: 0,
        radius,
        isLocal: true,
        fixed: false,
      };
    }

    const angle = index * goldenAngle + seededUnit(node.nodeNum) * Math.PI * 2;
    const distance = orbit * (0.42 + 0.58 * Math.sqrt((index + 1) / Math.max(1, graphNodes.length)));
    return {
      nodeNum: node.nodeNum,
      x: centerX + Math.cos(angle) * distance,
      y: centerY + Math.sin(angle) * distance,
      vx: 0,
      vy: 0,
      radius,
      isLocal: false,
      fixed: false,
    };
  });
}

/** Mutates the supplied layout by one force-simulation tick. */
export function stepSpringLayout(
  nodes: SpringLayoutNode[],
  edges: TopologyGraphEdge[],
  bounds: SpringLayoutBounds,
  energy: number,
): void {
  if (nodes.length === 0) return;
  const byNum = new Map(nodes.map(node => [node.nodeNum, node]));
  const centerX = bounds.width / 2;
  const centerY = bounds.height / 2;
  const desiredLinkLength = Math.max(84, Math.min(180, Math.min(bounds.width, bounds.height) * 0.26));

  // Coulomb-style repulsion plus a collision cushion. The graph is typically
  // tens of nodes; for large captures, sampling distant pairs keeps each frame
  // bounded while the collision pass still prevents overlaps.
  const pairStride = nodes.length > 180 ? Math.ceil(nodes.length / 120) : 1;
  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j += pairStride) {
      const b = nodes[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let distanceSquared = dx * dx + dy * dy;
      if (distanceSquared < 0.01) {
        const angle = seededUnit(a.nodeNum + b.nodeNum) * Math.PI * 2;
        dx = Math.cos(angle) * 0.1;
        dy = Math.sin(angle) * 0.1;
        distanceSquared = 0.01;
      }
      const distance = Math.sqrt(distanceSquared);
      const minimum = a.radius + b.radius + 9;
      const repulsion = (4200 * energy) / Math.max(80, distanceSquared);
      const collision = distance < minimum ? (minimum - distance) * 0.065 : 0;
      const force = repulsion + collision;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      if (!a.fixed) {
        a.vx -= fx;
        a.vy -= fy;
      }
      if (!b.fixed) {
        b.vx += fx;
        b.vy += fy;
      }
    }
  }

  for (const edge of edges) {
    const source = byNum.get(edge.source);
    const target = byNum.get(edge.target);
    if (!source || !target) continue;
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const stretch = distance - desiredLinkLength;
    const evidenceBoost = edge.kinds.length > 1 ? 1.25 : 1;
    const force = stretch * 0.008 * evidenceBoost * energy;
    const fx = (dx / distance) * force;
    const fy = (dy / distance) * force;
    if (!source.fixed) {
      source.vx += fx;
      source.vy += fy;
    }
    if (!target.fixed) {
      target.vx -= fx;
      target.vy -= fy;
    }
  }

  for (const node of nodes) {
    if (node.fixed) {
      node.vx = 0;
      node.vy = 0;
      continue;
    }

    // Keep the local radio near the visual center without pinning it. Other
    // nodes get a gentler gravity so disconnected components do not drift off.
    const gravity = node.isLocal ? 0.018 : 0.0045;
    node.vx += (centerX - node.x) * gravity * energy;
    node.vy += (centerY - node.y) * gravity * energy;

    node.vx *= 0.82;
    node.vy *= 0.82;
    const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
    if (speed > 18) {
      node.vx = (node.vx / speed) * 18;
      node.vy = (node.vy / speed) * 18;
    }

    node.x += node.vx;
    node.y += node.vy;

    const padding = node.radius + 6;
    if (node.x < padding || node.x > bounds.width - padding) {
      node.x = Math.max(padding, Math.min(bounds.width - padding, node.x));
      node.vx *= -0.35;
    }
    if (node.y < padding || node.y > bounds.height - padding) {
      node.y = Math.max(padding, Math.min(bounds.height - padding, node.y));
      node.vy *= -0.35;
    }
  }
}
