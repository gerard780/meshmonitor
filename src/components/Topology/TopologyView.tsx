import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
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
  type TopologyEdgeKind,
  type TopologyGraphEdge,
  type TopologyGraphNode,
  type TopologyWindowHours,
} from './topologyGraph';
import './TopologyView.css';

const DEFAULT_BOUNDS: SpringLayoutBounds = { width: 1000, height: 620 };
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

interface Camera {
  x: number;
  y: number;
  scale: number;
}

interface NodeDragState {
  kind: 'node';
  nodeNum: number;
  pointerId: number;
  offsetX: number;
  offsetY: number;
  startX: number;
  startY: number;
  moved: boolean;
}

interface PanDragState {
  kind: 'pan';
  pointerId: number;
  startX: number;
  startY: number;
  cameraX: number;
  cameraY: number;
  moved: boolean;
}

type InteractionState = NodeDragState | PanDragState;

interface TooltipState {
  nodeNum: number;
  x: number;
  y: number;
}

type NodeCategory = 'local' | 'anchor' | 'mesh' | 'mqtt';

function positionMap(layout: SpringLayoutNode[]): Map<number, SpringLayoutNode> {
  return new Map(layout.map(node => [node.nodeNum, { ...node }]));
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function calculateFitCamera(
  layout: SpringLayoutNode[],
  bounds: SpringLayoutBounds,
): Camera {
  if (layout.length === 0) return { x: 0, y: 0, scale: 1 };

  const minX = Math.min(...layout.map(node => node.x - node.radius));
  const maxX = Math.max(...layout.map(node => node.x + node.radius));
  const minY = Math.min(...layout.map(node => node.y - node.radius));
  const maxY = Math.max(...layout.map(node => node.y + node.radius));
  const graphWidth = Math.max(60, maxX - minX);
  const graphHeight = Math.max(60, maxY - minY);
  const horizontalPadding = Math.min(160, bounds.width * 0.16);
  const verticalPadding = Math.min(120, bounds.height * 0.2);
  const scale = clamp(
    Math.min(
      (bounds.width - horizontalPadding) / graphWidth,
      (bounds.height - verticalPadding) / graphHeight,
    ),
    MIN_ZOOM,
    2.8,
  );

  return {
    x: bounds.width / 2 - ((minX + maxX) / 2) * scale,
    y: bounds.height / 2 - ((minY + maxY) / 2) * scale,
    scale,
  };
}

function normalizeTimestamp(value: number | undefined): number {
  if (!value) return 0;
  return value < 10_000_000_000 ? value * 1000 : value;
}

function formatLastHeard(lastHeard: number | undefined, neverLabel: string): string {
  const timestamp = normalizeTimestamp(lastHeard);
  if (!timestamp) return neverLabel;
  const ageSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m ago`;
  if (ageSeconds < 86400) return `${Math.floor(ageSeconds / 3600)}h ago`;
  return `${Math.floor(ageSeconds / 86400)}d ago`;
}

function edgeEvidenceLabel(edge: TopologyGraphEdge): string {
  return edge.kinds.map(kind => {
    if (kind === 'direct') return 'Direct RX';
    if (kind === 'neighbor') return 'NeighborInfo';
    return 'Traceroute';
  }).join(' + ');
}

function primaryEdgeKind(edge: TopologyGraphEdge): TopologyEdgeKind {
  if (edge.kinds.includes('direct')) return 'direct';
  if (edge.kinds.includes('neighbor')) return 'neighbor';
  return 'traceroute';
}

function nodeCategory(node: TopologyGraphNode): NodeCategory {
  if (node.isLocal) return 'local';
  if (node.isAnchor) return 'anchor';
  if (node.viaMqtt) return 'mqtt';
  return 'mesh';
}

function nodeTitle(node: TopologyGraphNode): string {
  const details = [node.role, `${node.degree} link${node.degree === 1 ? '' : 's'}`];
  if (node.snr != null) details.push(`${node.snr.toFixed(1)} dB SNR`);
  return `${node.label}\n${node.id} · ${details.filter(Boolean).join(' · ')}`;
}

export default function TopologyView() {
  const { t } = useTranslation();
  const { nodes, isLoading } = useNodes();
  const { currentNodeId } = useData();
  const { neighborInfo, traceroutes } = useMapContext();
  const [windowHours, setWindowHours] = useState<TopologyWindowHours>(168);
  const [includeIsolated, setIncludeIsolated] = useState(false);
  const [edgeVisibility, setEdgeVisibility] = useState<Record<TopologyEdgeKind, boolean>>({
    direct: true,
    neighbor: true,
    traceroute: true,
  });
  const [nodeVisibility, setNodeVisibility] = useState<Record<NodeCategory, boolean>>({
    local: true,
    anchor: true,
    mesh: true,
    mqtt: true,
  });
  const [selectedNodeNum, setSelectedNodeNum] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [bounds, setBounds] = useState<SpringLayoutBounds>(DEFAULT_BOUNDS);
  const [positions, setPositions] = useState<Map<number, SpringLayoutNode>>(new Map());
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 });
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [wakeVersion, setWakeVersion] = useState(0);
  const canvasRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const layoutRef = useRef<SpringLayoutNode[]>([]);
  const interactionRef = useRef<InteractionState | null>(null);
  const autoFitRef = useRef(true);
  const reduceMotionRef = useRef(
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  );

  const graph = useMemo(() => buildTopologyGraph({
    nodes,
    neighborInfo,
    traceroutes,
    currentNodeId,
    windowHours,
    includeIsolated,
  }), [nodes, neighborInfo, traceroutes, currentNodeId, windowHours, includeIsolated]);

  const nodesByNum = useMemo(
    () => new Map(graph.nodes.map(node => [node.nodeNum, node])),
    [graph.nodes],
  );

  const visibleNodeNums = useMemo(() => new Set(
    graph.nodes
      .filter(node => nodeVisibility[nodeCategory(node)])
      .map(node => node.nodeNum),
  ), [graph.nodes, nodeVisibility]);

  const activeEdges = useMemo(() => graph.edges.filter(edge =>
    edge.kinds.some(kind => edgeVisibility[kind])
      && visibleNodeNums.has(edge.source)
      && visibleNodeNums.has(edge.target)),
  [edgeVisibility, graph.edges, visibleNodeNums]);

  const selectedNode = selectedNodeNum == null ? undefined : nodesByNum.get(selectedNodeNum);
  const hoveredNode = tooltip == null ? undefined : nodesByNum.get(tooltip.nodeNum);
  const selectedNeighborhood = useMemo(() => {
    if (selectedNodeNum == null) return null;
    const result = new Set<number>([selectedNodeNum]);
    for (const edge of activeEdges) {
      if (edge.source === selectedNodeNum) result.add(edge.target);
      if (edge.target === selectedNodeNum) result.add(edge.source);
    }
    return result;
  }, [activeEdges, selectedNodeNum]);

  useEffect(() => {
    if (selectedNodeNum != null && !visibleNodeNums.has(selectedNodeNum)) {
      setSelectedNodeNum(null);
    }
  }, [selectedNodeNum, visibleNodeNums]);

  useEffect(() => {
    const host = canvasRef.current;
    if (!host) return;
    const updateSize = () => {
      const rect = host.getBoundingClientRect();
      setBounds({
        width: Math.max(320, Math.round(rect.width)),
        height: Math.max(460, Math.round(rect.height)),
      });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const next = createSpringLayout(graph.nodes, bounds, layoutRef.current);
    layoutRef.current = next;
    autoFitRef.current = true;

    if (reduceMotionRef.current) {
      const visibleLayout = next.filter(node => visibleNodeNums.has(node.nodeNum));
      for (let tick = 0; tick < 180; tick += 1) {
        stepSpringLayout(visibleLayout, activeEdges, bounds, Math.max(0.02, 1 - tick / 180));
      }
      setPositions(positionMap(next));
      setCamera(calculateFitCamera(visibleLayout, bounds));
      autoFitRef.current = false;
      return;
    }

    setPositions(positionMap(next));
    setWakeVersion(version => version + 1);
  }, [bounds, graph.nodes, layoutVersion]); // edge filters wake the existing layout below

  useEffect(() => {
    autoFitRef.current = true;
    setWakeVersion(version => version + 1);
  }, [activeEdges, visibleNodeNums]);

  useEffect(() => {
    if (reduceMotionRef.current || layoutRef.current.length === 0) return;
    let frameId = 0;
    let energy = 1;
    let frameCount = 0;

    const tick = () => {
      const visibleLayout = layoutRef.current.filter(node => visibleNodeNums.has(node.nodeNum));
      stepSpringLayout(visibleLayout, activeEdges, bounds, energy);
      energy *= 0.968;
      frameCount += 1;

      if (frameCount % 2 === 0 || energy < 0.04) {
        setPositions(positionMap(layoutRef.current));
      }
      if (autoFitRef.current && (frameCount >= 72 || energy < 0.08)) {
        setCamera(calculateFitCamera(visibleLayout, bounds));
        autoFitRef.current = false;
      }
      if (energy > 0.012 || interactionRef.current?.kind === 'node') {
        frameId = requestAnimationFrame(tick);
      }
    };

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [activeEdges, bounds, visibleNodeNums, wakeVersion]);

  const toSvgPoint = useCallback((clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: ((clientX - rect.left) / rect.width) * bounds.width,
      y: ((clientY - rect.top) / rect.height) * bounds.height,
    };
  }, [bounds.height, bounds.width]);

  const toWorldPoint = useCallback((clientX: number, clientY: number) => {
    const point = toSvgPoint(clientX, clientY);
    return {
      x: (point.x - camera.x) / camera.scale,
      y: (point.y - camera.y) / camera.scale,
    };
  }, [camera, toSvgPoint]);

  const handleNodePointerDown = useCallback((event: ReactPointerEvent<SVGGElement>, nodeNum: number) => {
    event.stopPropagation();
    const layoutNode = layoutRef.current.find(node => node.nodeNum === nodeNum);
    if (!layoutNode) return;
    const point = toWorldPoint(event.clientX, event.clientY);
    interactionRef.current = {
      kind: 'node',
      nodeNum,
      pointerId: event.pointerId,
      offsetX: layoutNode.x - point.x,
      offsetY: layoutNode.y - point.y,
      startX: point.x,
      startY: point.y,
      moved: false,
    };
    autoFitRef.current = false;
    layoutNode.fixed = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    setWakeVersion(version => version + 1);
  }, [toWorldPoint]);

  const handleCanvasPointerDown = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    const point = toSvgPoint(event.clientX, event.clientY);
    interactionRef.current = {
      kind: 'pan',
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
      cameraX: camera.x,
      cameraY: camera.y,
      moved: false,
    };
    autoFitRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [camera.x, camera.y, toSvgPoint]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    const screenPoint = toSvgPoint(event.clientX, event.clientY);

    if (interaction.kind === 'pan') {
      if (Math.hypot(screenPoint.x - interaction.startX, screenPoint.y - interaction.startY) > 3) {
        interaction.moved = true;
      }
      setCamera(current => ({
        ...current,
        x: interaction.cameraX + screenPoint.x - interaction.startX,
        y: interaction.cameraY + screenPoint.y - interaction.startY,
      }));
      return;
    }

    const worldPoint = {
      x: (screenPoint.x - camera.x) / camera.scale,
      y: (screenPoint.y - camera.y) / camera.scale,
    };
    const layoutNode = layoutRef.current.find(node => node.nodeNum === interaction.nodeNum);
    if (!layoutNode) return;
    if (Math.hypot(worldPoint.x - interaction.startX, worldPoint.y - interaction.startY) > 3 / camera.scale) {
      interaction.moved = true;
    }
    layoutNode.x = worldPoint.x + interaction.offsetX;
    layoutNode.y = worldPoint.y + interaction.offsetY;
    layoutNode.vx = 0;
    layoutNode.vy = 0;
    setPositions(positionMap(layoutRef.current));
  }, [camera, toSvgPoint]);

  const finishInteraction = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    if (interaction.kind === 'node') {
      const layoutNode = layoutRef.current.find(node => node.nodeNum === interaction.nodeNum);
      if (layoutNode) layoutNode.fixed = false;
      if (!interaction.moved) {
        setSelectedNodeNum(current => current === interaction.nodeNum ? null : interaction.nodeNum);
      }
      setWakeVersion(version => version + 1);
    } else if (!interaction.moved) {
      setSelectedNodeNum(null);
    }
    interactionRef.current = null;
  }, []);

  const zoomBy = useCallback((factor: number, center?: { x: number; y: number }) => {
    autoFitRef.current = false;
    setCamera(current => {
      const nextScale = clamp(current.scale * factor, MIN_ZOOM, MAX_ZOOM);
      const focus = center ?? { x: bounds.width / 2, y: bounds.height / 2 };
      const worldX = (focus.x - current.x) / current.scale;
      const worldY = (focus.y - current.y) / current.scale;
      return {
        scale: nextScale,
        x: focus.x - worldX * nextScale,
        y: focus.y - worldY * nextScale,
      };
    });
  }, [bounds.height, bounds.width]);

  const handleWheel = useCallback((event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 1.14 : 1 / 1.14, toSvgPoint(event.clientX, event.clientY));
  }, [toSvgPoint, zoomBy]);

  const fitView = useCallback(() => {
    const visibleLayout = layoutRef.current.filter(node => visibleNodeNums.has(node.nodeNum));
    setCamera(calculateFitCamera(visibleLayout, bounds));
    autoFitRef.current = false;
  }, [bounds, visibleNodeNums]);

  const resetLayout = () => {
    layoutRef.current = [];
    autoFitRef.current = true;
    setSelectedNodeNum(null);
    setLayoutVersion(version => version + 1);
  };

  const toggleEdgeKind = (kind: TopologyEdgeKind) => {
    setEdgeVisibility(current => ({ ...current, [kind]: !current[kind] }));
  };

  const toggleNodeCategory = (category: NodeCategory) => {
    setNodeVisibility(current => ({ ...current, [category]: !current[category] }));
  };

  const exportPng = useCallback(async () => {
    const sourceSvg = svgRef.current;
    if (!sourceSvg) return;
    const clone = sourceSvg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(bounds.width));
    clone.setAttribute('height', String(bounds.height));

    const styles = getComputedStyle(document.documentElement);
    const color = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
    const embeddedStyle = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    embeddedStyle.textContent = `
      .topology-pan-surface{fill:transparent}
      .topology-edge{fill:none;stroke-width:1.7;opacity:.62}
      .topology-edge.direct{stroke:${color('--color-success', '#34d399')}}
      .topology-edge.neighbor{stroke:${color('--color-accent', '#22d3ee')}}
      .topology-edge.traceroute{stroke:${color('--color-warning', '#fbbf24')};stroke-dasharray:6 5}
      .topology-edge.dimmed{opacity:.08}.topology-edge.emphasized{opacity:1;stroke-width:3}
      .topology-node-dot{fill:${color('--color-accent', '#22d3ee')};stroke:${color('--color-bg-sunken', '#0f172a')};stroke-width:2}
      .topology-node.local .topology-node-dot{fill:${color('--color-success', '#34d399')}}
      .topology-node.mqtt .topology-node-dot{fill:${color('--color-accent-alt', '#a855f7')}}
      .topology-node-ring{fill:none;stroke:${color('--color-warning', '#fbbf24')};stroke-width:1.5}
      .topology-node-label{fill:${color('--color-text', '#e2e8f0')};font-family:sans-serif;font-weight:600}
      .topology-node.dimmed{opacity:.18}
    `;
    clone.prepend(embeddedStyle);

    const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Could not render topology export'));
      image.src = url;
    });

    const scale = 2;
    const output = document.createElement('canvas');
    output.width = bounds.width * scale;
    output.height = bounds.height * scale;
    const context = output.getContext('2d');
    if (!context) return;
    context.scale(scale, scale);
    context.fillStyle = color('--color-bg-sunken', '#0f172a');
    context.fillRect(0, 0, bounds.width, bounds.height);
    context.drawImage(image, 0, 0, bounds.width, bounds.height);
    URL.revokeObjectURL(url);

    output.toBlob(png => {
      if (!png) return;
      const downloadUrl = URL.createObjectURL(png);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = `meshmonitor-topology-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
      link.click();
      URL.revokeObjectURL(downloadUrl);
    }, 'image/png');
  }, [bounds]);

  const activeNodeCount = [...visibleNodeNums].length;
  const displayedNode = hoveredNode ?? selectedNode;
  const tooltipPosition = hoveredNode && tooltip
    ? { left: tooltip.x, top: tooltip.y }
    : undefined;

  return (
    <section className="topology-view" aria-labelledby="topology-title">
      <div className="topology-panel">
        <header className="topology-panel-header">
          <div className="topology-panel-title">
            <span className="topology-panel-icon"><UiIcon name="network" size={17} /></span>
            <div>
              <h1 id="topology-title">{t('topology.title', 'Mesh topology')}</h1>
              <p>{t('topology.description_v2', 'Live RF graph from direct receptions, NeighborInfo reports, and traceroutes.')}</p>
            </div>
          </div>

          <div className="topology-controls">
            <div className="topology-edge-filters" role="group" aria-label={t('topology.link_filters', 'Link filters')}>
              {(['traceroute', 'direct', 'neighbor'] as TopologyEdgeKind[]).map(kind => (
                <button
                  key={kind}
                  type="button"
                  className={`topology-chip ${kind}${edgeVisibility[kind] ? ' active' : ''}`}
                  aria-pressed={edgeVisibility[kind]}
                  onClick={() => toggleEdgeKind(kind)}
                >
                  {kind === 'direct'
                    ? t('topology.direct_rx', 'Direct RX')
                    : kind === 'neighbor'
                      ? t('topology.neighbors', 'Neighbours')
                      : t('topology.traced_link', 'Traceroute')}
                </button>
              ))}
            </div>

            <label className="topology-window-select">
              <span>{t('topology.window', 'Window')}</span>
              <select
                value={windowHours == null ? 'all' : windowHours}
                onChange={event => setWindowHours(event.target.value === 'all' ? null : Number(event.target.value) as TopologyWindowHours)}
              >
                <option value={1}>1h</option>
                <option value={6}>6h</option>
                <option value={24}>24h</option>
                <option value={168}>7d</option>
                <option value="all">{t('topology.all_time', 'All')}</option>
              </select>
            </label>

            <button
              type="button"
              className={`topology-tool-button${includeIsolated ? ' active' : ''}`}
              aria-pressed={includeIsolated}
              onClick={() => setIncludeIsolated(value => !value)}
              title={t('topology.isolated_help', 'Show nodes with no known links')}
            >
              {t('topology.all_nodes', 'All nodes')}
            </button>
            <button type="button" className="topology-tool-button square" onClick={() => zoomBy(1 / 1.3)} title={t('topology.zoom_out', 'Zoom out')}>−</button>
            <button type="button" className="topology-tool-button square" onClick={() => zoomBy(1.3)} title={t('topology.zoom_in', 'Zoom in')}>+</button>
            <button type="button" className="topology-tool-button" onClick={fitView}>{t('topology.fit', 'Fit')}</button>
            <button type="button" className="topology-tool-button icon" onClick={resetLayout} title={t('topology.refresh_layout', 'Refresh and reheat layout')}>
              <UiIcon name="refresh" size={14} />
              {t('topology.refresh', 'Refresh')}
            </button>
            <button type="button" className="topology-tool-button" onClick={() => void exportPng()}>{t('topology.export_png', 'Export PNG')}</button>
          </div>
        </header>

        <div className="topology-canvas" ref={canvasRef}>
          {isLoading && graph.nodes.length === 0 ? (
            <div className="topology-empty">{t('topology.loading', 'Loading mesh data…')}</div>
          ) : graph.nodes.length === 0 ? (
            <div className="topology-empty">
              <UiIcon name="network" size={34} />
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
              onPointerDown={handleCanvasPointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={finishInteraction}
              onPointerCancel={finishInteraction}
              onPointerLeave={() => setTooltip(null)}
              onWheel={handleWheel}
            >
              <rect className="topology-pan-surface" width={bounds.width} height={bounds.height} />
              <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.scale})`}>
                <g className="topology-edges">
                  {activeEdges.map(edge => {
                    const source = positions.get(edge.source);
                    const target = positions.get(edge.target);
                    if (!source || !target) return null;
                    const connectedToSelection = selectedNodeNum == null
                      || edge.source === selectedNodeNum
                      || edge.target === selectedNodeNum;
                    const kind = primaryEdgeKind(edge);
                    return (
                      <line
                        key={edge.id}
                        x1={source.x}
                        y1={source.y}
                        x2={target.x}
                        y2={target.y}
                        className={`topology-edge ${kind}${selectedNodeNum == null ? '' : connectedToSelection ? ' emphasized' : ' dimmed'}`}
                        style={{ strokeWidth: 1.15 + Math.min(2.2, Math.log2(1 + edge.observations) * 0.62) }}
                      >
                        <title>{`${edgeEvidenceLabel(edge)}${edge.snr == null ? '' : ` · ${edge.snr.toFixed(1)} dB SNR`}`}</title>
                      </line>
                    );
                  })}
                </g>
                <g className="topology-nodes">
                  {graph.nodes.filter(node => visibleNodeNums.has(node.nodeNum)).map(node => {
                    const position = positions.get(node.nodeNum);
                    if (!position) return null;
                    const selected = selectedNodeNum === node.nodeNum;
                    const hovered = tooltip?.nodeNum === node.nodeNum;
                    const dimmed = selectedNeighborhood != null && !selectedNeighborhood.has(node.nodeNum);
                    const category = nodeCategory(node);
                    const displayRadius = position.radius / Math.sqrt(camera.scale);
                    const labelVisible = node.isLocal || node.isAnchor || node.degree >= 2 || selected || hovered;
                    const nodeClass = [
                      'topology-node',
                      category,
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
                        onPointerDown={event => handleNodePointerDown(event, node.nodeNum)}
                        onPointerEnter={event => {
                          const rect = canvasRef.current?.getBoundingClientRect();
                          if (!rect) return;
                          setTooltip({ nodeNum: node.nodeNum, x: event.clientX - rect.left + 14, y: event.clientY - rect.top + 14 });
                        }}
                        onPointerMove={event => {
                          if (interactionRef.current) return;
                          const rect = canvasRef.current?.getBoundingClientRect();
                          if (!rect) return;
                          setTooltip({ nodeNum: node.nodeNum, x: event.clientX - rect.left + 14, y: event.clientY - rect.top + 14 });
                        }}
                        onPointerLeave={() => setTooltip(current => current?.nodeNum === node.nodeNum ? null : current)}
                        onKeyDown={event => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            setSelectedNodeNum(current => current === node.nodeNum ? null : node.nodeNum);
                          }
                        }}
                      >
                        <circle className="topology-node-hit" r={displayRadius + 7 / camera.scale} />
                        <circle className="topology-node-dot" r={displayRadius} />
                        {(node.isAnchor || node.isLocal || selected) && (
                          <circle className="topology-node-ring" r={displayRadius + 3 / camera.scale} />
                        )}
                        {labelVisible && (
                          <text
                            className="topology-node-label"
                            x={displayRadius + 5 / camera.scale}
                            y={4 / camera.scale}
                            style={{ fontSize: `${11 / camera.scale}px` }}
                          >
                            {node.label.length > 28 ? `${node.label.slice(0, 26)}…` : node.label}
                          </text>
                        )}
                        <title>{nodeTitle(node)}</title>
                      </g>
                    );
                  })}
                </g>
              </g>
            </svg>
          )}

          {displayedNode && (
            <div
              className={`topology-tooltip${hoveredNode ? '' : ' pinned'}`}
              style={tooltipPosition}
              role="status"
            >
              <strong>{displayedNode.label}</strong>
              <code>{displayedNode.id}</code>
              <span>{[displayedNode.role, `${displayedNode.degree} link${displayedNode.degree === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</span>
              <span>{formatLastHeard(displayedNode.lastHeard, t('topology.never', 'Never heard'))}</span>
              {displayedNode.snr != null && <span>{displayedNode.snr.toFixed(1)} dB SNR</span>}
              {!hoveredNode && (
                <button type="button" onClick={() => setSelectedNodeNum(null)} aria-label={t('common.close', 'Close')}>×</button>
              )}
            </div>
          )}
        </div>

        <footer className="topology-footer">
          <div className="topology-node-filters" role="group" aria-label={t('topology.node_filters', 'Node filters')}>
            {([
              ['local', t('topology.this_radio', 'this radio')],
              ['anchor', t('topology.neighbor_source', 'neighbour source')],
              ['mesh', t('topology.mesh_nodes', 'mesh nodes')],
              ['mqtt', 'MQTT'],
            ] as Array<[NodeCategory, string]>).map(([category, label]) => (
              <button
                key={category}
                type="button"
                className={`topology-node-filter ${category}${nodeVisibility[category] ? '' : ' off'}`}
                aria-pressed={nodeVisibility[category]}
                onClick={() => toggleNodeCategory(category)}
              >
                <i />{label}
              </button>
            ))}
          </div>
          <span className="topology-interaction-hint">{t('topology.interaction_hint', 'drag = move / pan · wheel = zoom · click = highlight · legend = show/hide')}</span>
          <span className="topology-footer-stats">
            {activeNodeCount} {t('topology.nodes', 'nodes')} · {activeEdges.length} {t('topology.links', 'links')} ({graph.tracerouteEdgeCount} {t('topology.route_short', 'route')} / {graph.directEdgeCount} {t('topology.direct_short', 'direct')} / {graph.neighborEdgeCount} {t('topology.neighbor_short', 'neighbour')})
          </span>
        </footer>
      </div>
    </section>
  );
}
