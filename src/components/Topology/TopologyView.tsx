import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useData } from '../../contexts/DataContext';
import { useMapContext } from '../../contexts/MapContext';
import { useNodes } from '../../hooks/useServerData';
import { UiIcon } from '../icons';
import {
  createSpringLayout,
  stepSpringLayout,
  type SpringLayoutBounds,
  type SpringLayoutNode,
} from './springLayout';
import {
  buildTopologyGraph,
  type TopologyGraphEdge,
  type TopologyGraphNode,
  type TopologyWindowHours,
} from './topologyGraph';
import './TopologyView.css';

const DEFAULT_BOUNDS: SpringLayoutBounds = { width: 900, height: 580 };

interface DragState {
  nodeNum: number;
  pointerId: number;
  offsetX: number;
  offsetY: number;
  startX: number;
  startY: number;
  moved: boolean;
}

function positionMap(layout: SpringLayoutNode[]): Map<number, SpringLayoutNode> {
  return new Map(layout.map(node => [node.nodeNum, { ...node }]));
}

function formatLastHeard(lastHeard: number | undefined, neverLabel: string): string {
  if (!lastHeard) return neverLabel;
  const timestampMs = lastHeard < 10_000_000_000 ? lastHeard * 1000 : lastHeard;
  const ageSeconds = Math.max(0, Math.round((Date.now() - timestampMs) / 1000));
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m ago`;
  if (ageSeconds < 86400) return `${Math.floor(ageSeconds / 3600)}h ago`;
  return `${Math.floor(ageSeconds / 86400)}d ago`;
}

function edgeEvidenceLabel(edge: TopologyGraphEdge): string {
  if (edge.kinds.length > 1) return 'NeighborInfo + traceroute';
  return edge.kinds[0] === 'neighbor' ? 'NeighborInfo' : 'Traceroute';
}

function nodeTitle(node: TopologyGraphNode): string {
  const signal = node.snr != null ? ` · ${node.snr.toFixed(1)} dB SNR` : '';
  return `${node.label}\n${node.id} · ${node.degree} direct link${node.degree === 1 ? '' : 's'}${signal}`;
}

export default function TopologyView() {
  const { t } = useTranslation();
  const { nodes, isLoading } = useNodes();
  const { currentNodeId } = useData();
  const { neighborInfo, traceroutes } = useMapContext();
  const [windowHours, setWindowHours] = useState<TopologyWindowHours>(24);
  const [includeIsolated, setIncludeIsolated] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [paused, setPaused] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  const [selectedNodeNum, setSelectedNodeNum] = useState<number | null>(null);
  const [hoveredNodeNum, setHoveredNodeNum] = useState<number | null>(null);
  const [bounds, setBounds] = useState<SpringLayoutBounds>(DEFAULT_BOUNDS);
  const [positions, setPositions] = useState<Map<number, SpringLayoutNode>>(new Map());
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [wakeVersion, setWakeVersion] = useState(0);
  const canvasRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const layoutRef = useRef<SpringLayoutNode[]>([]);
  const dragRef = useRef<DragState | null>(null);

  const graph = useMemo(() => buildTopologyGraph({
    nodes,
    neighborInfo,
    traceroutes,
    currentNodeId,
    windowHours,
    includeIsolated,
  }), [nodes, neighborInfo, traceroutes, currentNodeId, windowHours, includeIsolated]);

  useEffect(() => {
    if (selectedNodeNum != null && !graph.nodes.some(node => node.nodeNum === selectedNodeNum)) {
      setSelectedNodeNum(null);
    }
  }, [graph.nodes, selectedNodeNum]);

  useEffect(() => {
    const host = canvasRef.current;
    if (!host) return;
    const updateSize = () => {
      const rect = host.getBoundingClientRect();
      setBounds({
        width: Math.max(320, Math.round(rect.width)),
        height: Math.max(440, Math.round(rect.height)),
      });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    layoutRef.current = createSpringLayout(graph.nodes, bounds, layoutRef.current);
    setPositions(positionMap(layoutRef.current));
    setWakeVersion(version => version + 1);
  }, [graph.nodes, bounds, layoutVersion]);

  useEffect(() => {
    if (paused || layoutRef.current.length === 0) return;
    let frameId = 0;
    let energy = 1;
    let frameCount = 0;

    const tick = () => {
      stepSpringLayout(layoutRef.current, graph.edges, bounds, energy);
      energy *= 0.965;
      frameCount += 1;
      if (frameCount % 2 === 0 || energy < 0.03) {
        setPositions(positionMap(layoutRef.current));
      }
      if (energy > 0.012 || dragRef.current) {
        frameId = requestAnimationFrame(tick);
      }
    };

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [bounds, graph.edges, paused, wakeVersion]);

  const nodesByNum = useMemo(
    () => new Map(graph.nodes.map(node => [node.nodeNum, node])),
    [graph.nodes],
  );

  const selectedNode = selectedNodeNum == null ? undefined : nodesByNum.get(selectedNodeNum);
  const selectedEdges = useMemo(
    () => selectedNodeNum == null
      ? []
      : graph.edges.filter(edge => edge.source === selectedNodeNum || edge.target === selectedNodeNum),
    [graph.edges, selectedNodeNum],
  );
  const selectedNeighborhood = useMemo(() => {
    if (selectedNodeNum == null) return null;
    const result = new Set<number>([selectedNodeNum]);
    for (const edge of selectedEdges) {
      result.add(edge.source);
      result.add(edge.target);
    }
    return result;
  }, [selectedEdges, selectedNodeNum]);

  const selectedNeighbors = useMemo(() => selectedEdges
    .map(edge => {
      const neighborNum = edge.source === selectedNodeNum ? edge.target : edge.source;
      return { edge, node: nodesByNum.get(neighborNum) };
    })
    .filter((entry): entry is { edge: TopologyGraphEdge; node: TopologyGraphNode } => entry.node != null)
    .sort((a, b) => b.edge.timestamp - a.edge.timestamp || a.node.label.localeCompare(b.node.label)),
  [nodesByNum, selectedEdges, selectedNodeNum]);

  const toCanvasPoint = useCallback((clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: ((clientX - rect.left) / rect.width) * bounds.width,
      y: ((clientY - rect.top) / rect.height) * bounds.height,
    };
  }, [bounds.height, bounds.width]);

  const handlePointerDown = useCallback((event: React.PointerEvent<SVGGElement>, nodeNum: number) => {
    const layoutNode = layoutRef.current.find(node => node.nodeNum === nodeNum);
    if (!layoutNode) return;
    const point = toCanvasPoint(event.clientX, event.clientY);
    dragRef.current = {
      nodeNum,
      pointerId: event.pointerId,
      offsetX: layoutNode.x - point.x,
      offsetY: layoutNode.y - point.y,
      startX: point.x,
      startY: point.y,
      moved: false,
    };
    layoutNode.fixed = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    setWakeVersion(version => version + 1);
  }, [toCanvasPoint]);

  const handlePointerMove = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = toCanvasPoint(event.clientX, event.clientY);
    const layoutNode = layoutRef.current.find(node => node.nodeNum === drag.nodeNum);
    if (!layoutNode) return;
    if (Math.hypot(point.x - drag.startX, point.y - drag.startY) > 4) drag.moved = true;
    layoutNode.x = Math.max(layoutNode.radius, Math.min(bounds.width - layoutNode.radius, point.x + drag.offsetX));
    layoutNode.y = Math.max(layoutNode.radius, Math.min(bounds.height - layoutNode.radius, point.y + drag.offsetY));
    layoutNode.vx = 0;
    layoutNode.vy = 0;
    setPositions(positionMap(layoutRef.current));
  }, [bounds.height, bounds.width, toCanvasPoint]);

  const finishDrag = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const layoutNode = layoutRef.current.find(node => node.nodeNum === drag.nodeNum);
    if (layoutNode) layoutNode.fixed = false;
    if (!drag.moved) {
      setSelectedNodeNum(current => current === drag.nodeNum ? null : drag.nodeNum);
    }
    dragRef.current = null;
    setWakeVersion(version => version + 1);
  }, []);

  const resetLayout = () => {
    layoutRef.current = [];
    setLayoutVersion(version => version + 1);
  };

  const windowOptions: Array<{ value: TopologyWindowHours; label: string }> = [
    { value: 1, label: '1h' },
    { value: 6, label: '6h' },
    { value: 24, label: '24h' },
    { value: 168, label: '7d' },
    { value: null, label: t('topology.all_time', 'All') },
  ];

  return (
    <section className="topology-view" aria-labelledby="topology-title">
      <header className="topology-header">
        <div>
          <div className="topology-eyebrow">
            <UiIcon name="network" size={15} />
            {t('topology.live_graph', 'Logical mesh graph')}
          </div>
          <h1 id="topology-title">{t('topology.title', 'Mesh topology')}</h1>
          <p>{t('topology.description', 'Drag a node and the mesh responds like a spring. Links come from recent NeighborInfo reports and traceroutes.')}</p>
        </div>
        <div className="topology-stats" aria-label={t('topology.summary', 'Topology summary')}>
          <div><strong>{graph.nodes.length}</strong><span>{t('topology.nodes', 'nodes')}</span></div>
          <div><strong>{graph.edges.length}</strong><span>{t('topology.links', 'links')}</span></div>
          <div><strong>{graph.connectedNodeCount}</strong><span>{t('topology.connected', 'connected')}</span></div>
        </div>
      </header>

      <div className="topology-toolbar">
        <div className="topology-window-control" role="group" aria-label={t('topology.time_window', 'Time window')}>
          {windowOptions.map(option => (
            <button
              key={option.label}
              type="button"
              className={windowHours === option.value ? 'active' : ''}
              aria-pressed={windowHours === option.value}
              onClick={() => setWindowHours(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="topology-toolbar-actions">
          <label className="topology-switch">
            <input type="checkbox" checked={showLabels} onChange={event => setShowLabels(event.target.checked)} />
            <span>{t('topology.labels', 'Labels')}</span>
          </label>
          <label className="topology-switch">
            <input type="checkbox" checked={includeIsolated} onChange={event => setIncludeIsolated(event.target.checked)} />
            <span>{t('topology.isolated', 'Isolated nodes')}</span>
          </label>
          <button type="button" className="topology-icon-button" onClick={() => {
            setPaused(value => !value);
            setWakeVersion(version => version + 1);
          }}>
            <UiIcon name={paused ? 'play' : 'pause'} size={16} />
            {paused ? t('topology.resume', 'Resume') : t('topology.pause', 'Pause')}
          </button>
          <button type="button" className="topology-icon-button" onClick={resetLayout}>
            <UiIcon name="refresh" size={16} />
            {t('topology.reset', 'Reset layout')}
          </button>
        </div>
      </div>

      <div className="topology-workspace">
        <div className="topology-canvas" ref={canvasRef}>
          {isLoading && graph.nodes.length === 0 ? (
            <div className="topology-empty">{t('topology.loading', 'Loading mesh data…')}</div>
          ) : graph.nodes.length === 0 ? (
            <div className="topology-empty">
              <UiIcon name="network" size={38} />
              <strong>{t('topology.empty_title', 'No topology observations yet')}</strong>
              <span>{t('topology.empty_description', 'Wait for a NeighborInfo broadcast or run a traceroute, then come back here.')}</span>
            </div>
          ) : (
            <svg
              ref={svgRef}
              className="topology-svg"
              viewBox={`0 0 ${bounds.width} ${bounds.height}`}
              role="group"
              aria-label={t('topology.graph_aria', 'Interactive force-directed mesh topology graph')}
              onPointerMove={handlePointerMove}
              onPointerUp={finishDrag}
              onPointerCancel={finishDrag}
            >
              <defs>
                <pattern id="topology-grid" width="32" height="32" patternUnits="userSpaceOnUse">
                  <path d="M 32 0 L 0 0 0 32" className="topology-grid-line" fill="none" />
                </pattern>
                <filter id="topology-glow" x="-80%" y="-80%" width="260%" height="260%">
                  <feGaussianBlur stdDeviation="5" result="blur" />
                  <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
              </defs>
              <rect width={bounds.width} height={bounds.height} fill="url(#topology-grid)" />
              <g className="topology-edges">
                {graph.edges.map(edge => {
                  const source = positions.get(edge.source);
                  const target = positions.get(edge.target);
                  if (!source || !target) return null;
                  const isSelected = selectedNodeNum == null || edge.source === selectedNodeNum || edge.target === selectedNodeNum;
                  const evidenceClass = edge.kinds.length > 1
                    ? 'mixed'
                    : edge.kinds[0] === 'neighbor' ? 'neighbor' : 'traceroute';
                  return (
                    <line
                      key={edge.id}
                      x1={source.x}
                      y1={source.y}
                      x2={target.x}
                      y2={target.y}
                      className={`topology-edge ${evidenceClass}${isSelected ? ' highlighted' : ' dimmed'}`}
                    >
                      <title>{`${edgeEvidenceLabel(edge)}${edge.snr == null ? '' : ` · ${edge.snr.toFixed(1)} dB SNR`}`}</title>
                    </line>
                  );
                })}
              </g>
              <g className="topology-nodes">
                {graph.nodes.map(node => {
                  const position = positions.get(node.nodeNum);
                  if (!position) return null;
                  const selected = selectedNodeNum === node.nodeNum;
                  const hovered = hoveredNodeNum === node.nodeNum;
                  const dimmed = selectedNeighborhood != null && !selectedNeighborhood.has(node.nodeNum);
                  const nodeClass = [
                    'topology-node',
                    node.isLocal ? 'local' : '',
                    node.viaMqtt ? 'mqtt' : '',
                    node.isPlaceholder ? 'placeholder' : '',
                    selected ? 'selected' : '',
                    dimmed ? 'dimmed' : '',
                  ].filter(Boolean).join(' ');
                  return (
                    <g
                      key={node.nodeNum}
                      className={nodeClass}
                      transform={`translate(${position.x} ${position.y})`}
                      role="button"
                      tabIndex={0}
                      aria-label={nodeTitle(node)}
                      onPointerDown={event => handlePointerDown(event, node.nodeNum)}
                      onPointerEnter={() => setHoveredNodeNum(node.nodeNum)}
                      onPointerLeave={() => setHoveredNodeNum(current => current === node.nodeNum ? null : current)}
                      onKeyDown={event => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedNodeNum(current => current === node.nodeNum ? null : node.nodeNum);
                        }
                      }}
                    >
                      {(selected || hovered) && <circle className="topology-node-halo" r={position.radius + 8} filter="url(#topology-glow)" />}
                      <circle className="topology-node-dot" r={position.radius} />
                      {node.isLocal && <circle className="topology-node-local-ring" r={position.radius + 4} />}
                      <text className="topology-node-monogram" textAnchor="middle" dy="0.34em">
                        {(node.shortName || node.label).slice(0, 4)}
                      </text>
                      {showLabels && (
                        <text className="topology-node-label" textAnchor="middle" y={position.radius + 18}>
                          {node.label.length > 22 ? `${node.label.slice(0, 20)}…` : node.label}
                        </text>
                      )}
                      <title>{nodeTitle(node)}</title>
                    </g>
                  );
                })}
              </g>
            </svg>
          )}
          <div className="topology-legend" aria-label={t('topology.legend', 'Topology legend')}>
            <span><i className="topology-legend-line neighbor" />{t('topology.neighbor_link', 'NeighborInfo')}</span>
            <span><i className="topology-legend-line traceroute" />{t('topology.traced_link', 'Traceroute')}</span>
            <span><i className="topology-legend-line mixed" />{t('topology.confirmed_link', 'Both')}</span>
            <span><i className="topology-legend-node local" />{t('topology.local_node', 'Local node')}</span>
          </div>
          <div className="topology-canvas-hint">{t('topology.drag_hint', 'Drag nodes to feel the mesh')}</div>
        </div>

        <aside className="topology-inspector" aria-live="polite">
          {selectedNode ? (
            <>
              <div className="topology-inspector-heading">
                <span className={`topology-inspector-dot${selectedNode.isLocal ? ' local' : ''}`} />
                <div>
                  <span>{selectedNode.isLocal ? t('topology.this_radio', 'This radio') : t('topology.selected_node', 'Selected node')}</span>
                  <h2>{selectedNode.label}</h2>
                  <code>{selectedNode.id}</code>
                </div>
              </div>
              <dl className="topology-node-facts">
                <div><dt>{t('topology.direct_links', 'Direct links')}</dt><dd>{selectedNode.degree}</dd></div>
                <div><dt>{t('topology.last_heard', 'Last heard')}</dt><dd>{formatLastHeard(selectedNode.lastHeard, t('topology.never', 'Never'))}</dd></div>
                <div><dt>{t('topology.hops_away', 'Hops away')}</dt><dd>{selectedNode.hopsAway ?? '—'}</dd></div>
                <div><dt>{t('topology.signal', 'Signal')}</dt><dd>{selectedNode.snr != null ? `${selectedNode.snr.toFixed(1)} dB` : '—'}</dd></div>
              </dl>
              <div className="topology-neighbor-heading">
                <h3>{t('topology.neighbors', 'Connected nodes')}</h3>
                <span>{selectedNeighbors.length}</span>
              </div>
              <div className="topology-neighbor-list">
                {selectedNeighbors.length === 0 ? (
                  <p>{t('topology.no_direct_links', 'No direct link observations in this window.')}</p>
                ) : selectedNeighbors.map(({ edge, node }) => (
                  <button key={edge.id} type="button" onClick={() => setSelectedNodeNum(node.nodeNum)}>
                    <span className={`topology-neighbor-evidence ${edge.kinds.length > 1 ? 'mixed' : edge.kinds[0]}`} />
                    <span><strong>{node.label}</strong><small>{edgeEvidenceLabel(edge)}</small></span>
                    <em>{edge.snr == null ? '—' : `${edge.snr.toFixed(1)} dB`}</em>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="topology-inspector-empty">
              <div className="topology-inspector-orbit"><UiIcon name="network" size={30} /></div>
              <h2>{t('topology.explore_title', 'Explore the mesh')}</h2>
              <p>{t('topology.explore_description', 'Select a node to isolate its immediate neighborhood and inspect the evidence behind each link.')}</p>
              <div className="topology-evidence-summary">
                <span><strong>{graph.neighborEdgeCount}</strong>{t('topology.neighbor_links', 'neighbor links')}</span>
                <span><strong>{graph.tracerouteEdgeCount}</strong>{t('topology.traceroute_links', 'traced links')}</span>
              </div>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
