import type { EnrichedNeighborInfo } from '../../contexts/MapContext';
import type { DbTraceroute } from '../../services/database';
import type { DeviceInfo } from '../../types/device';
import { decomposeTracerouteLinks, isValidRouteNode } from '../../utils/tracerouteSegments';

export type TopologyWindowHours = 1 | 6 | 24 | 168 | null;

export type TopologyEdgeKind = 'neighbor' | 'traceroute';

export interface TopologyGraphNode {
  id: string;
  nodeNum: number;
  label: string;
  shortName: string;
  role?: string;
  lastHeard?: number;
  hopsAway?: number;
  snr?: number;
  rssi?: number;
  batteryLevel?: number;
  viaMqtt: boolean;
  isLocal: boolean;
  isPlaceholder: boolean;
  degree: number;
}

export interface TopologyGraphEdge {
  id: string;
  source: number;
  target: number;
  kinds: TopologyEdgeKind[];
  snr: number | null;
  timestamp: number;
  observations: number;
  bidirectional: boolean;
}

export interface TopologyGraph {
  nodes: TopologyGraphNode[];
  edges: TopologyGraphEdge[];
  connectedNodeCount: number;
  neighborEdgeCount: number;
  tracerouteEdgeCount: number;
}

interface BuildTopologyGraphInput {
  nodes: DeviceInfo[];
  neighborInfo: EnrichedNeighborInfo[];
  traceroutes: DbTraceroute[];
  currentNodeId?: string | null;
  windowHours: TopologyWindowHours;
  includeIsolated?: boolean;
  nowMs?: number;
}

interface MutableEdge {
  source: number;
  target: number;
  kinds: Set<TopologyEdgeKind>;
  snr: number | null;
  snrTimestamp: number;
  timestamp: number;
  observations: number;
  bidirectional: boolean;
}

export function normalizeTopologyTimestamp(value: number | null | undefined): number {
  if (!value || !Number.isFinite(value)) return 0;
  return value < 10_000_000_000 ? value * 1000 : value;
}

function nodeIdFromNum(nodeNum: number): string {
  return `!${nodeNum.toString(16).padStart(8, '0')}`;
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function isWithinWindow(timestamp: number, cutoffMs: number | null): boolean {
  return cutoffMs === null || timestamp >= cutoffMs;
}

function addObservation(
  edges: Map<string, MutableEdge>,
  source: number,
  target: number,
  kind: TopologyEdgeKind,
  timestamp: number,
  snr: number | null,
  bidirectional = false,
): void {
  if (!Number.isFinite(source) || !Number.isFinite(target) || source === target) return;
  if (!isValidRouteNode(source) || !isValidRouteNode(target)) return;

  const low = Math.min(source, target);
  const high = Math.max(source, target);
  const key = edgeKey(low, high);
  const existing = edges.get(key);

  if (!existing) {
    edges.set(key, {
      source: low,
      target: high,
      kinds: new Set([kind]),
      snr,
      snrTimestamp: snr === null ? 0 : timestamp,
      timestamp,
      observations: 1,
      bidirectional,
    });
    return;
  }

  existing.kinds.add(kind);
  existing.timestamp = Math.max(existing.timestamp, timestamp);
  existing.observations += 1;
  existing.bidirectional ||= bidirectional;
  if (snr !== null && timestamp >= existing.snrTimestamp) {
    existing.snr = snr;
    existing.snrTimestamp = timestamp;
  }
}

function makeGraphNode(nodeNum: number, node?: DeviceInfo, currentNodeId?: string | null): TopologyGraphNode {
  const id = node?.user?.id || nodeIdFromNum(nodeNum);
  const longName = node?.user?.longName?.trim();
  const shortName = node?.user?.shortName?.trim();

  return {
    id,
    nodeNum,
    label: longName || shortName || id,
    shortName: shortName || id.slice(-4),
    role: node?.user?.role,
    lastHeard: node?.lastHeard,
    hopsAway: node?.hopsAway,
    snr: node?.snr,
    rssi: node?.rssi,
    batteryLevel: node?.deviceMetrics?.batteryLevel,
    viaMqtt: node?.viaMqtt === true,
    isLocal: (currentNodeId != null && id.toLowerCase() === currentNodeId.toLowerCase()) || node?.hopsAway === 0,
    isPlaceholder: node === undefined,
    degree: 0,
  };
}

/**
 * Build the logical RF graph used by the topology canvas. NeighborInfo and
 * traceroute observations are folded into one undirected edge per node pair,
 * while retaining which observation types support that link.
 */
export function buildTopologyGraph({
  nodes,
  neighborInfo,
  traceroutes,
  currentNodeId,
  windowHours,
  includeIsolated = false,
  nowMs = Date.now(),
}: BuildTopologyGraphInput): TopologyGraph {
  const cutoffMs = windowHours === null ? null : nowMs - windowHours * 60 * 60 * 1000;
  const edges = new Map<string, MutableEdge>();

  for (const info of neighborInfo) {
    const timestamp = normalizeTopologyTimestamp(info.timestamp || info.lastRxTime || info.createdAt);
    if (!isWithinWindow(timestamp, cutoffMs)) continue;
    addObservation(
      edges,
      Number(info.nodeNum),
      Number(info.neighborNodeNum),
      'neighbor',
      timestamp,
      typeof info.snr === 'number' ? info.snr : null,
      info.bidirectional === true,
    );
  }

  for (const traceroute of traceroutes) {
    const timestamp = normalizeTopologyTimestamp(traceroute.timestamp || traceroute.createdAt);
    if (!isWithinWindow(timestamp, cutoffMs)) continue;
    for (const link of decomposeTracerouteLinks(traceroute)) {
      addObservation(
        edges,
        Number(link.fromNodeNum),
        Number(link.toNodeNum),
        'traceroute',
        timestamp,
        link.snrDb,
      );
    }
  }

  const connectedNums = new Set<number>();
  for (const edge of edges.values()) {
    connectedNums.add(edge.source);
    connectedNums.add(edge.target);
  }

  const nodeByNum = new Map(nodes.map(node => [Number(node.nodeNum), node]));
  const visibleNums = new Set(connectedNums);

  if (includeIsolated || connectedNums.size === 0) {
    for (const node of nodes) {
      const lastHeardMs = normalizeTopologyTimestamp(node.lastHeard);
      const isCurrent = currentNodeId != null && node.user?.id?.toLowerCase() === currentNodeId.toLowerCase();
      if (isCurrent || isWithinWindow(lastHeardMs, cutoffMs)) visibleNums.add(Number(node.nodeNum));
    }
  }

  const degrees = new Map<number, number>();
  for (const edge of edges.values()) {
    degrees.set(edge.source, (degrees.get(edge.source) || 0) + 1);
    degrees.set(edge.target, (degrees.get(edge.target) || 0) + 1);
  }

  const graphNodes = [...visibleNums]
    .map(nodeNum => ({
      ...makeGraphNode(nodeNum, nodeByNum.get(nodeNum), currentNodeId),
      degree: degrees.get(nodeNum) || 0,
    }))
    .sort((a, b) => {
      if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
      if (a.degree !== b.degree) return b.degree - a.degree;
      return a.label.localeCompare(b.label);
    });

  const graphEdges = [...edges.entries()]
    .map(([id, edge]): TopologyGraphEdge => ({
      id,
      source: edge.source,
      target: edge.target,
      kinds: [...edge.kinds].sort(),
      snr: edge.snr,
      timestamp: edge.timestamp,
      observations: edge.observations,
      bidirectional: edge.bidirectional,
    }))
    .sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));

  return {
    nodes: graphNodes,
    edges: graphEdges,
    connectedNodeCount: connectedNums.size,
    neighborEdgeCount: graphEdges.filter(edge => edge.kinds.includes('neighbor')).length,
    tracerouteEdgeCount: graphEdges.filter(edge => edge.kinds.includes('traceroute')).length,
  };
}
