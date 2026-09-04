import { describe, expect, it } from 'vitest';
import type { EnrichedNeighborInfo } from '../../contexts/MapContext';
import type { DbTraceroute } from '../../services/database';
import type { DeviceInfo } from '../../types/device';
import { buildTopologyGraph, normalizeTopologyTimestamp } from './topologyGraph';

const NOW = 1_800_000_000_000;

const nodes: DeviceInfo[] = [
  { nodeNum: 100, user: { id: '!00000064', longName: 'Base', shortName: 'BASE' }, lastHeard: NOW / 1000 },
  { nodeNum: 200, user: { id: '!000000c8', longName: 'Hill', shortName: 'HILL' }, lastHeard: NOW / 1000 },
  { nodeNum: 300, user: { id: '!0000012c', longName: 'Relay', shortName: 'RLY' }, lastHeard: NOW / 1000 },
  { nodeNum: 400, user: { id: '!00000190', longName: 'Isolated', shortName: 'ISO' }, lastHeard: NOW / 1000 },
];

function neighbor(overrides: Partial<EnrichedNeighborInfo> = {}): EnrichedNeighborInfo {
  return {
    nodeNum: 100,
    neighborNodeNum: 200,
    snr: 7.5,
    timestamp: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

function trace(overrides: Partial<DbTraceroute> = {}): DbTraceroute {
  return {
    fromNodeNum: 100,
    toNodeNum: 200,
    fromNodeId: '!00000064',
    toNodeId: '!000000c8',
    route: '[300]',
    routeBack: '[]',
    snrTowards: '[20,16]',
    snrBack: '[]',
    timestamp: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

describe('buildTopologyGraph', () => {
  it('combines NeighborInfo and per-hop traceroute links without duplicate pairs', () => {
    const graph = buildTopologyGraph({
      nodes,
      neighborInfo: [neighbor()],
      traceroutes: [trace()],
      currentNodeId: '!00000064',
      windowHours: 24,
      nowMs: NOW,
    });

    expect(graph.nodes.map(node => node.nodeNum).sort()).toEqual([100, 200, 300]);
    expect(graph.edges.map(edge => [edge.source, edge.target])).toEqual([
      [100, 200],
      [100, 300],
      [200, 300],
    ]);
    expect(graph.edges.find(edge => edge.id === '100:200')?.kinds).toEqual(['neighbor']);
    expect(graph.nodes.find(node => node.nodeNum === 100)?.isLocal).toBe(true);
    expect(graph.nodes.find(node => node.nodeNum === 300)?.degree).toBe(2);
  });

  it('records both evidence types when they describe the same direct link', () => {
    const graph = buildTopologyGraph({
      nodes,
      neighborInfo: [neighbor()],
      traceroutes: [trace({ route: '[]', snrTowards: '[12]' })],
      windowHours: 24,
      nowMs: NOW,
    });

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].kinds).toEqual(['neighbor', 'traceroute']);
    expect(graph.neighborEdgeCount).toBe(1);
    expect(graph.tracerouteEdgeCount).toBe(1);
  });

  it('filters stale observations and only adds isolated nodes when requested', () => {
    const stale = NOW - 25 * 60 * 60 * 1000;
    const baseInput = {
      nodes,
      neighborInfo: [neighbor({ timestamp: stale, createdAt: stale })],
      traceroutes: [],
      windowHours: 24 as const,
      nowMs: NOW,
    };

    const connectedOnly = buildTopologyGraph(baseInput);
    expect(connectedOnly.edges).toHaveLength(0);
    // When no link data exists, active nodes remain visible as a useful empty-state graph.
    expect(connectedOnly.nodes).toHaveLength(4);

    const withOneFreshLink = buildTopologyGraph({
      ...baseInput,
      neighborInfo: [neighbor()],
    });
    expect(withOneFreshLink.nodes.map(node => node.nodeNum).sort()).toEqual([100, 200]);

    const withIsolates = buildTopologyGraph({
      ...baseInput,
      neighborInfo: [neighbor()],
      includeIsolated: true,
    });
    expect(withIsolates.nodes).toHaveLength(4);
  });

  it('creates a readable placeholder for route hops missing from the node database', () => {
    const graph = buildTopologyGraph({
      nodes: nodes.slice(0, 2),
      neighborInfo: [],
      traceroutes: [trace()],
      windowHours: null,
      nowMs: NOW,
    });

    const placeholder = graph.nodes.find(node => node.nodeNum === 300);
    expect(placeholder).toMatchObject({
      id: '!0000012c',
      label: '!0000012c',
      isPlaceholder: true,
    });
  });

  it('adds fresh zero-hop RF observations as direct links from the local radio', () => {
    const graph = buildTopologyGraph({
      nodes: [
        { ...nodes[0], hopsAway: 0 },
        { ...nodes[1], hopsAway: 0, transportLastRf: NOW / 1000, snr: 9.5 },
        { ...nodes[2], hopsAway: 1 },
        { ...nodes[3], hopsAway: 0, viaMqtt: true },
      ],
      neighborInfo: [],
      traceroutes: [],
      currentNodeId: '!00000064',
      windowHours: 168,
      nowMs: NOW,
    });

    expect(graph.edges).toEqual([
      expect.objectContaining({ source: 100, target: 200, kinds: ['direct'], snr: 9.5 }),
    ]);
    expect(graph.directEdgeCount).toBe(1);
    expect(graph.nodes.find(node => node.nodeNum === 200)?.isLocal).toBe(false);
  });
});

describe('normalizeTopologyTimestamp', () => {
  it('normalizes unix seconds while preserving milliseconds', () => {
    expect(normalizeTopologyTimestamp(1_800_000_000)).toBe(NOW);
    expect(normalizeTopologyTimestamp(NOW)).toBe(NOW);
    expect(normalizeTopologyTimestamp(undefined)).toBe(0);
  });
});
