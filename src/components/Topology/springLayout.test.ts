import { describe, expect, it } from 'vitest';
import { createSpringLayout, stepSpringLayout, topologyNodeRadius } from './springLayout';
import type { TopologyGraphEdge, TopologyGraphNode } from './topologyGraph';

const graphNodes: TopologyGraphNode[] = [
  {
    id: '!00000064', nodeNum: 100, label: 'Base', shortName: 'BASE', viaMqtt: false,
    isLocal: true, isPlaceholder: false, degree: 1,
  },
  {
    id: '!000000c8', nodeNum: 200, label: 'Hill', shortName: 'HILL', viaMqtt: false,
    isLocal: false, isPlaceholder: false, degree: 1,
  },
];

const edge: TopologyGraphEdge = {
  id: '100:200',
  source: 100,
  target: 200,
  kinds: ['neighbor'],
  snr: 8,
  timestamp: 1,
  observations: 1,
  bidirectional: true,
};

describe('spring layout', () => {
  it('starts the local node at the center and is deterministic', () => {
    const bounds = { width: 800, height: 500 };
    const first = createSpringLayout(graphNodes, bounds);
    const second = createSpringLayout(graphNodes, bounds);

    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({ x: 400, y: 250, isLocal: true });
    expect(first[0].radius).toBeGreaterThan(first[1].radius);
  });

  it('keeps every node finite and inside the canvas as the springs settle', () => {
    const bounds = { width: 420, height: 300 };
    const layout = createSpringLayout(graphNodes, bounds);
    for (let i = 0; i < 240; i += 1) {
      stepSpringLayout(layout, [edge], bounds, Math.max(0.02, 1 - i / 240));
    }

    for (const node of layout) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
      expect(node.x).toBeGreaterThanOrEqual(node.radius);
      expect(node.x).toBeLessThanOrEqual(bounds.width - node.radius);
      expect(node.y).toBeGreaterThanOrEqual(node.radius);
      expect(node.y).toBeLessThanOrEqual(bounds.height - node.radius);
    }
  });

  it('scales node radius by degree and local-node status', () => {
    expect(topologyNodeRadius({ degree: 0, isLocal: false })).toBe(12);
    expect(topologyNodeRadius({ degree: 20, isLocal: false })).toBe(22);
    expect(topologyNodeRadius({ degree: 20, isLocal: true })).toBe(25);
  });
});
