// Flowchart editor for .canvas files (UI spec §4.4): boxes in several shapes, loop frames that
// carry the boxes inside them, and arrows attached to box sides with elbow, straight or curved
// routes through draggable bend points. Box text is markdown, so it holds citations that work
// like those in notes. Built on React Flow.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  BaseEdge,
  Background,
  BackgroundVariant,
  ConnectionMode,
  EdgeLabelRenderer,
  Handle,
  NodeResizer,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { fileKind } from '../../core/link';
import { extractLinks } from '../../core/mdlinks';
import { parseCanvas, serializeCanvas, type CanvasDoc, type CanvasEdge, type CanvasNode, type Route, type Shape, type Side } from '../../core/canvas';
import { Icon, iconSvg, kindIcon } from '../icons';
import { inlineEditorExtensions, insertReference, linkInfoFromMd, type NoteEditorOptions } from '../notes/editor';
import { stepZoom } from '../zoom';
import { curvePath, elbowRoute, midpoint, roundedPath, snap, type P } from './paths';

export interface FlowHandle {
  /** The flowchart as file text. */
  text(): string;
  /** Replaces the flowchart (file changed on disk). */
  load(text: string): void;
  /** Puts a citation in the box being edited, else the selected box, else a new box. */
  insertCitation(build: (label: string) => string, label: string): void;
  /** Redraws citations after link checks. */
  refresh(): void;
  /** Shows and flashes the box on a line of the file ("Cited in"). */
  revealLine(line: number): void;
  zoom(dir: 1 | -1 | 0): void;
  setZoom(z: number): void;
  getZoom(): number;
}

type Callbacks = Pick<NoteEditorOptions, 'onFollow' | 'refStatus' | 'imageUrl' | 'renderHoverCard'>;

interface Props {
  initialText: string;
  callbacks: Callbacks;
  onChange(text: string): void;
  onSave(): void;
  register(h: FlowHandle | null): void;
  onZoomChange(z: number): void;
  /** Viewing on the right: no toolbar, nothing moves or changes; citations still open. */
  readOnly?: boolean;
}

type BoxNode = Node<{ raw: CanvasNode }>;
type FlowEdge = Edge<{ raw: CanvasEdge }>;

const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];
const POS: Record<Side, Position> = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left };
const sideOf = (p: Position): Side => (p === Position.Top ? 'top' : p === Position.Right ? 'right' : p === Position.Bottom ? 'bottom' : 'left');

const SHAPES: { shape: Shape; name: string; text: string; w: number; h: number }[] = [
  { shape: 'process', name: 'Process', text: 'Step', w: 160, h: 64 },
  { shape: 'decision', name: 'Decision', text: 'Condition?', w: 144, h: 96 },
  { shape: 'terminal', name: 'Start or end', text: 'Start', w: 152, h: 48 },
  { shape: 'io', name: 'Input or output', text: 'Input', w: 168, h: 56 },
  { shape: 'subprocess', name: 'Sub-process', text: 'Sub-process', w: 168, h: 64 },
  { shape: 'note', name: 'Note', text: 'Note', w: 176, h: 72 },
];

const newId = () => Math.random().toString(16).slice(2, 10);
const sizeOf = (n: Node) => ({ w: n.width ?? n.measured?.width ?? 0, h: n.height ?? n.measured?.height ?? 0 });

// ---------- Canvas file <-> React Flow ----------

function bestSides(a: CanvasNode, b: CanvasNode): [Side, Side] {
  const dx = b.x + b.width / 2 - (a.x + a.width / 2);
  const dy = b.y + b.height / 2 - (a.y + a.height / 2);
  if (Math.abs(dy) >= Math.abs(dx)) return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
  return dx >= 0 ? ['right', 'left'] : ['left', 'right'];
}

function toFlow(doc: CanvasDoc): { nodes: BoxNode[]; edges: FlowEdge[] } {
  // Bigger frames first, so a frame inside another draws on top of it; boxes after frames.
  const area = (n: CanvasNode) => n.width * n.height;
  const sorted = [...doc.nodes.filter((n) => n.type === 'group').sort((a, b) => area(b) - area(a)), ...doc.nodes.filter((n) => n.type !== 'group')];
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const nodes: BoxNode[] = sorted.map((n) => ({
    id: n.id,
    type: n.type === 'group' ? 'frame' : 'box',
    position: { x: n.x, y: n.y },
    width: n.width,
    height: n.height,
    zIndex: n.type === 'group' ? -1 : 0,
    data: { raw: n },
  }));
  const edges: FlowEdge[] = doc.edges
    .filter((e) => byId.has(e.fromNode) && byId.has(e.toNode))
    .map((e) => {
      const [fs, ts] = bestSides(byId.get(e.fromNode)!, byId.get(e.toNode)!);
      return { id: e.id, type: 'flow', source: e.fromNode, target: e.toNode, sourceHandle: e.fromSide ?? fs, targetHandle: e.toSide ?? ts, data: { raw: e } };
    });
  return { nodes, edges };
}

function fromFlow(nodes: BoxNode[], edges: FlowEdge[], rest: Record<string, unknown>): CanvasDoc {
  return {
    ...rest,
    nodes: nodes.map((n) => {
      const { w, h } = sizeOf(n);
      return { ...n.data.raw, x: Math.round(n.position.x), y: Math.round(n.position.y), width: Math.round(w || n.data.raw.width), height: Math.round(h || n.data.raw.height) };
    }),
    edges: edges.map((e) => ({ ...e.data!.raw, fromNode: e.source, toNode: e.target, fromSide: (e.sourceHandle ?? undefined) as Side | undefined, toSide: (e.targetHandle ?? undefined) as Side | undefined })),
  };
}

// ---------- Shared state for nodes and edges ----------

interface Ctx {
  opts: NoteEditorOptions;
  version: number;
  editing: string | null;
  selectAllOnEdit: boolean;
  startEdit(id: string): void;
  finishEdit(id: string, value: string | null): void;
  onEditorView(v: EditorView | null): void;
  editingLabel: string | null;
  setEditingLabel(id: string | null): void;
  setEdgeData(id: string, patch: Partial<CanvasEdge>, commit: boolean): void;
  commit(): void;
  toFlowPos(x: number, y: number): P;
  marker: string;
  flash: string | null;
}
const FlowCtx = createContext<Ctx>(null!);

// ---------- Box text: markdown with citations ----------

function Inline({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let last = 0;
  let k = 0;
  const plain = (s: string) => s.split('\n').forEach((part, i) => (i && out.push(<br key={k++} />), part && out.push(part)));
  for (const m of text.matchAll(re)) {
    plain(text.slice(last, m.index));
    const t = m[0];
    out.push(t.startsWith('**') ? <strong key={k++}>{t.slice(2, -2)}</strong> : t.startsWith('`') ? <code key={k++}>{t.slice(1, -1)}</code> : <em key={k++}>{t.slice(1, -1)}</em>);
    last = m.index! + t.length;
  }
  plain(text.slice(last));
  return <>{out}</>;
}

function BoxText({ text }: { text: string }) {
  const ctx = useContext(FlowCtx);
  const parts: React.ReactNode[] = [];
  let last = 0;
  extractLinks(text).forEach((link, i) => {
    parts.push(<Inline key={'t' + i} text={text.slice(last, link.from)} />);
    last = link.to;
    const info = linkInfoFromMd(link);
    if (!info) return;
    const follow = (e: React.MouseEvent) => {
      e.stopPropagation();
      ctx.opts.onFollow(info);
    };
    if (info.ref.pathKind === 'web') {
      parts.push(<span key={'l' + i} className="cm-weblink nodrag" title={info.dest} onMouseDown={(e) => e.stopPropagation()} onClick={() => window.open(info.dest, '_blank')}>{info.label}</span>);
      return;
    }
    const status = ctx.opts.refStatus(info);
    parts.push(
      <span
        key={'l' + i}
        className={'cm-ref nodrag' + (status.state === 'broken' ? ' broken' : '')}
        title={status.reason ?? info.title ?? info.dest}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={follow}
      >
        <span dangerouslySetInnerHTML={{ __html: iconSvg(kindIcon(fileKind(info.ref.path))) }} />
        {info.label}
        {status.badge && <span className="badge mark">{status.badge}</span>}
        {status.changed && <span className="badge warn" title={status.reason}>changed</span>}
      </span>,
    );
  });
  parts.push(<Inline key="end" text={text.slice(last)} />);
  return <>{parts}</>;
}

/** Edits a box's text in place with the notes editor (formatted, with citations). */
function BoxEditor({ id, text }: { id: string; text: string }) {
  const ctx = useContext(FlowCtx);
  const host = useRef<HTMLDivElement>(null);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  useEffect(() => {
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      ctxRef.current.finishEdit(id, value);
    };
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: text,
        extensions: [
          inlineEditorExtensions(ctxRef.current.opts),
          EditorView.lineWrapping,
          // After the editor's own keys, so Esc and Enter still finish naming a new citation first.
          Prec.highest(
            keymap.of([
              { key: 'Escape', run: (v) => (finish(v.state.doc.toString()), true) },
              { key: 'Mod-Enter', run: (v) => (finish(v.state.doc.toString()), true) },
            ]),
          ),
          EditorView.domEventHandlers({
            blur: () => {
              setTimeout(() => !view.hasFocus && finish(view.state.doc.toString()), 0);
            },
          }),
        ],
      }),
    });
    view.focus();
    const len = view.state.doc.length;
    view.dispatch({ selection: ctxRef.current.selectAllOnEdit ? { anchor: 0, head: len } : { anchor: len } });
    ctxRef.current.onEditorView(view);
    return () => {
      ctxRef.current.onEditorView(null);
      finish(view.state.doc.toString());
      view.destroy();
    };
  }, []);
  return <div ref={host} className="flow-box-editor nodrag nopan nowheel" onMouseDown={(e) => e.stopPropagation()} />;
}

// ---------- Nodes ----------

function ShapeOutline({ shape }: { shape: Shape }) {
  if (shape !== 'decision' && shape !== 'io') return null;
  const points = shape === 'decision' ? '50,1 99,50 50,99 1,50' : '12,1 99,1 88,99 1,99';
  return (
    <svg className="flow-shape" viewBox="0 0 100 100" preserveAspectRatio="none">
      <polygon points={points} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Handles() {
  return (
    <>
      {SIDES.map((s) => (
        <Handle key={s} id={s} type="source" position={POS[s]} className="flow-handle" />
      ))}
    </>
  );
}

function BoxNodeView({ id, data, selected }: NodeProps<BoxNode>) {
  const ctx = useContext(FlowCtx);
  const raw = data.raw;
  const shape: Shape = raw.shape ?? 'process';
  const text = raw.type === 'text' ? (raw.text ?? '') : raw.type === 'file' ? (raw.file ?? '') : (raw.url ?? '');
  const editing = ctx.editing === id;
  return (
    <div
      className={`flow-box shape-${shape}${selected ? ' selected' : ''}${ctx.flash === id ? ' flash' : ''}`}
      onDoubleClick={(e) => {
        if (editing || raw.type !== 'text') return;
        e.stopPropagation();
        ctx.startEdit(id);
      }}
    >
      <NodeResizer isVisible={!!selected && !editing} minWidth={64} minHeight={36} onResizeEnd={() => ctx.commit()} color="var(--accent)" />
      <ShapeOutline shape={shape} />
      <div className="flow-box-text">{editing ? <BoxEditor id={id} text={text} /> : <BoxText text={text} />}</div>
      <Handles />
    </div>
  );
}

function FrameNodeView({ id, data, selected }: NodeProps<BoxNode>) {
  const ctx = useContext(FlowCtx);
  const raw = data.raw;
  const editing = ctx.editing === id;
  return (
    <div className={'flow-frame' + (selected ? ' selected' : '') + (ctx.flash === id ? ' flash' : '')}>
      <NodeResizer isVisible={!!selected} minWidth={120} minHeight={80} onResizeEnd={() => ctx.commit()} color="var(--flow-frame)" />
      {SIDES.map((s) => (
        <div key={s} className={'flow-frame-edge ' + s} />
      ))}
      <div className="flow-frame-label" title="Drag to move the loop and everything in it · double-click to rename" onDoubleClick={() => ctx.startEdit(id)}>
        {editing ? (
          <input
            className="nodrag"
            autoFocus
            defaultValue={raw.label ?? ''}
            onFocus={(e) => e.target.select()}
            onBlur={(e) => ctx.finishEdit(id, e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur();
            }}
          />
        ) : (
          raw.label || 'Loop'
        )}
      </div>
      <Handles />
    </div>
  );
}

// ---------- Edges ----------

function FlowEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps<FlowEdge>) {
  const ctx = useContext(FlowCtx);
  const raw = data!.raw;
  const route: Route = raw.route ?? 'elbow';
  const pts = raw.points ?? [];
  const s = { x: sourceX, y: sourceY };
  const t = { x: targetX, y: targetY };
  let path: string;
  let label: P;
  if (!pts.length) {
    const args = { sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition };
    const [d, x, y] = route === 'elbow' ? getSmoothStepPath({ ...args, borderRadius: 6, offset: 18 }) : route === 'curve' ? getBezierPath(args) : getStraightPath(args);
    path = d;
    label = { x, y };
  } else {
    const line = route === 'elbow' ? elbowRoute(s, sideOf(sourcePosition), t, sideOf(targetPosition), pts) : [s, ...pts, t];
    path = route === 'curve' ? curvePath(line) : roundedPath(line, route === 'elbow' ? 6 : 0);
    label = midpoint(line);
  }
  const verts = [s, ...pts, t];

  // Dragging a bend point (or a "+" between points, which adds one there).
  const drag = (e: React.PointerEvent, index: number, insertAt?: P) => {
    e.stopPropagation();
    e.preventDefault();
    let list = [...pts];
    if (insertAt) list.splice(index, 0, { x: snap(insertAt.x), y: snap(insertAt.y) });
    ctx.setEdgeData(id, { points: list }, false);
    const move = (ev: PointerEvent) => {
      const p = ctx.toFlowPos(ev.clientX, ev.clientY);
      list = list.map((q, k) => (k === index ? { x: snap(p.x), y: snap(p.y) } : q));
      ctx.setEdgeData(id, { points: list }, false);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      ctx.commit();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const at = (p: P) => ({ transform: `translate(-50%, -50%) translate(${p.x}px, ${p.y}px)` });
  const marker = (sel: boolean) => `url(#${ctx.marker}${sel ? '-sel' : ''})`;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={raw.toEnd === 'none' ? undefined : marker(!!selected)}
        markerStart={raw.fromEnd === 'arrow' ? marker(!!selected) : undefined}
        interactionWidth={18}
        style={{ stroke: selected ? 'var(--accent)' : 'var(--flow-line)', strokeWidth: 1.6, strokeDasharray: raw.style === 'dashed' ? '6 4' : undefined }}
      />
      <EdgeLabelRenderer>
        {(raw.label || ctx.editingLabel === id) && (
          <div className="flow-edge-label nodrag nopan" style={at(label)} onDoubleClick={() => ctx.setEditingLabel(id)}>
            {ctx.editingLabel === id ? (
              <input
                autoFocus
                defaultValue={raw.label ?? ''}
                placeholder="yes"
                onBlur={(e) => {
                  ctx.setEdgeData(id, { label: e.target.value.trim() || undefined }, true);
                  ctx.setEditingLabel(null);
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur();
                }}
              />
            ) : (
              raw.label
            )}
          </div>
        )}
        {selected &&
          pts.map((p, i) => (
            <div
              key={'p' + i}
              className="flow-bend nodrag nopan"
              style={at(p)}
              title="Drag to move this bend · double-click to remove it"
              onPointerDown={(e) => drag(e, i)}
              onDoubleClick={() => ctx.setEdgeData(id, { points: pts.filter((_, k) => k !== i) }, true)}
            />
          ))}
        {selected &&
          verts.slice(1).map((b, i) => {
            const m = pts.length ? { x: (verts[i].x + b.x) / 2, y: (verts[i].y + b.y) / 2 } : label;
            return <div key={'m' + i} className="flow-bend add nodrag nopan" style={at(m)} title="Drag to bend the arrow here" onPointerDown={(e) => drag(e, i, m)} />;
          })}
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { box: BoxNodeView, frame: FrameNodeView };
const edgeTypes = { flow: FlowEdgeView };

// ---------- Toolbar glyphs ----------

function Glyph({ kind }: { kind: Shape | 'frame' | Route | 'dashed' }) {
  const g: Record<string, React.ReactNode> = {
    process: <rect x="2" y="3" width="16" height="10" rx="1.5" />,
    decision: <polygon points="10,1.5 18,8 10,14.5 2,8" />,
    terminal: <rect x="2" y="3" width="16" height="10" rx="5" />,
    io: <polygon points="5,3 18,3 15,13 2,13" />,
    subprocess: (
      <>
        <rect x="2" y="3" width="16" height="10" rx="1" />
        <path d="M5 3v10M15 3v10" />
      </>
    ),
    note: <path d="M3 2.5h10l4 4v7H3z M13 2.5v4h4" />,
    frame: <rect x="1.5" y="1.5" width="17" height="13" rx="2.5" strokeDasharray="3 2" />,
    straight: <path d="M2 13 18 3" />,
    elbow: <path d="M2 13h8V3h8" />,
    curve: <path d="M2 13C10 13 10 3 18 3" />,
    dashed: <path d="M2 8h16" strokeDasharray="3.5 2.5" />,
  };
  return (
    <svg className="flow-glyph" viewBox="0 0 20 16" aria-hidden="true">
      {g[kind]}
    </svg>
  );
}

// ---------- The editor ----------

function Editor(p: Props) {
  const rf = useReactFlow<BoxNode, FlowEdge>();
  const initial = useMemo(() => {
    try {
      return parseCanvas(p.initialText);
    } catch {
      return { nodes: [], edges: [] } as CanvasDoc;
    }
  }, []);
  const rest = useRef<Record<string, unknown>>({});
  const start = useMemo(() => {
    const { nodes: _n, edges: _e, ...others } = initial;
    rest.current = others;
    return toFlow(initial);
  }, [initial]);
  const [nodes, setNodes] = useState<BoxNode[]>(start.nodes);
  const [edges, setEdges] = useState<FlowEdge[]>(start.edges);
  const [editing, setEditing] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const [mode, setMode] = useState(() => (document.documentElement.dataset.mode === 'dark' ? 'dark' : 'light'));
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  const wrap = useRef<HTMLDivElement>(null);
  const editorView = useRef<EditorView | null>(null);
  const pendingCite = useRef<{ build(label: string): string; label: string } | null>(null);
  const selectAll = useRef(false);
  const lastRoute = useRef<Route>('elbow');
  const marker = useMemo(() => 'flow-arrow-' + newId(), []);
  const history = useRef<string[]>([serializeCanvas(initial)]);
  const hIndex = useRef(0);
  const [commitTick, setCommitTick] = useState(0);
  const wantCommit = useRef(false);

  const current = () => serializeCanvas(fromFlow(nodesRef.current, edgesRef.current, rest.current));

  // Saves a step of undo history after the state from the latest change has rendered.
  const commit = () => {
    wantCommit.current = true;
    setCommitTick((t) => t + 1);
  };
  useEffect(() => {
    if (!wantCommit.current) return;
    wantCommit.current = false;
    const text = current();
    if (text === history.current[hIndex.current]) return;
    history.current = history.current.slice(0, hIndex.current + 1).concat(text);
    hIndex.current = history.current.length - 1;
    p.onChange(text);
  }, [commitTick, nodes, edges]);

  const load = (text: string) => {
    let doc: CanvasDoc;
    try {
      doc = parseCanvas(text);
    } catch {
      return;
    }
    const { nodes: _n, edges: _e, ...others } = doc;
    rest.current = others;
    const f = toFlow(doc);
    setNodes(f.nodes);
    setEdges(f.edges);
  };
  const undo = (dir: -1 | 1) => {
    const i = hIndex.current + dir;
    if (i < 0 || i >= history.current.length) return;
    hIndex.current = i;
    load(history.current[i]);
    p.onChange(history.current[i]);
  };

  useEffect(() => {
    const obs = new MutationObserver(() => setMode(document.documentElement.dataset.mode === 'dark' ? 'dark' : 'light'));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
    return () => obs.disconnect();
  }, []);

  const viewCenter = (): P => {
    const r = wrap.current!.getBoundingClientRect();
    return rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  };

  const startEdit = (id: string, all = false) => {
    if (p.readOnly) return;
    selectAll.current = all;
    setEditingLabel(null);
    setEditing(id);
  };

  const addBox = (shape: Shape, text?: string) => {
    const def = SHAPES.find((s) => s.shape === shape)!;
    const c = viewCenter();
    let x = snap(c.x - def.w / 2);
    let y = snap(c.y - def.h / 2);
    while (nodesRef.current.some((n) => n.position.x === x && n.position.y === y)) {
      x += 24;
      y += 24;
    }
    const raw: CanvasNode = { id: newId(), type: 'text', shape, text: text ?? def.text, x, y, width: def.w, height: def.h };
    const node: BoxNode = { id: raw.id, type: 'box', position: { x, y }, width: def.w, height: def.h, zIndex: 0, data: { raw }, selected: true };
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), node]);
    setEdges((es) => es.map((e) => ({ ...e, selected: false })));
    commit();
    return raw.id;
  };

  const addFrame = () => {
    const c = viewCenter();
    const w = 360;
    const h = 240;
    const raw: CanvasNode = { id: newId(), type: 'group', label: 'for each item', x: snap(c.x - w / 2), y: snap(c.y - h / 2), width: w, height: h };
    const node: BoxNode = { id: raw.id, type: 'frame', position: { x: raw.x, y: raw.y }, width: w, height: h, zIndex: -1, data: { raw } };
    // New frames go first so they draw behind the boxes.
    setNodes((ns) => [node, ...ns]);
    commit();
    startEdit(raw.id);
  };

  const finishEdit = (id: string, value: string | null) => {
    setEditing((cur) => (cur === id ? null : cur));
    if (value === null) return;
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id !== id) return n;
        const raw = n.data.raw.type === 'group' ? { ...n.data.raw, label: value.trim() || undefined } : { ...n.data.raw, text: value };
        return { ...n, data: { raw } };
      }),
    );
    commit();
  };

  const setEdgeData = (id: string, patch: Partial<CanvasEdge>, andCommit: boolean) => {
    setEdges((es) => es.map((e) => (e.id === id ? { ...e, data: { raw: { ...e.data!.raw, ...patch } } } : e)));
    if (andCommit) commit();
  };

  const ctx: Ctx = {
    opts: {
      doc: '',
      eol: '\n',
      onChange: () => undefined,
      onSave: () => p.onSave(),
      ...p.callbacks,
    },
    version,
    editing,
    selectAllOnEdit: selectAll.current,
    startEdit,
    finishEdit,
    onEditorView: (v) => {
      editorView.current = v;
      const cite = pendingCite.current;
      if (v && cite) {
        pendingCite.current = null;
        const text = v.state.doc.toString();
        // A citation added to a box goes on its own line.
        if (text && !/\s$/.test(text)) v.dispatch({ changes: { from: text.length, insert: '\n' }, selection: { anchor: text.length + 1 } });
        insertReference(v, cite.build, cite.label);
      }
    },
    editingLabel,
    setEditingLabel: (id) => (p.readOnly ? undefined : setEditingLabel(id)),
    setEdgeData,
    commit,
    toFlowPos: (x, y) => rf.screenToFlowPosition({ x, y }),
    marker,
    flash,
  };

  // Moving a loop frame carries the boxes and frames inside it.
  const carried = useRef<{ frame: string; from: P; items: { id: string; x: number; y: number }[] }[]>([]);
  const inside = (f: BoxNode, n: BoxNode) => {
    const a = sizeOf(f);
    const b = sizeOf(n);
    return n.position.x >= f.position.x && n.position.y >= f.position.y && n.position.x + b.w <= f.position.x + a.w && n.position.y + b.h <= f.position.y + a.h;
  };

  useEffect(() => {
    p.register({
      text: current,
      load: (text) => {
        load(text);
        history.current = history.current.slice(0, hIndex.current + 1).concat(text);
        hIndex.current = history.current.length - 1;
      },
      insertCitation: (build, label) => {
        if (editorView.current) {
          insertReference(editorView.current, build, label);
          return;
        }
        pendingCite.current = { build, label };
        const sel = nodesRef.current.find((n) => n.selected && n.type === 'box' && n.data.raw.type === 'text');
        const id = sel?.id ?? addBox('process', '');
        startEdit(id);
      },
      refresh: () => setVersion((v) => v + 1),
      revealLine: (line) => {
        const text = current().split('\n')[line - 1] ?? '';
        const id = text.match(/"id":"([^"]+)"/)?.[1];
        const n = id && nodesRef.current.find((x) => x.id === id);
        if (!n) return;
        const { w, h } = sizeOf(n);
        void rf.setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: Math.max(rf.getZoom(), 1), duration: 300 });
        setNodes((ns) => ns.map((x) => ({ ...x, selected: x.id === n.id })));
        setFlash(n.id);
        setTimeout(() => setFlash(null), 1600);
      },
      zoom: (dir) => void (dir === 0 ? rf.zoomTo(1) : rf.zoomTo(stepZoom(rf.getZoom(), dir))),
      setZoom: (z) => void rf.zoomTo(z),
      getZoom: () => rf.getZoom(),
    });
    return () => p.register(null);
  }, []);

  const selNodes = nodes.filter((n) => n.selected);
  const selEdges = edges.filter((e) => e.selected);
  const oneBox = selNodes.length === 1 && selNodes[0].type === 'box' && !selEdges.length ? selNodes[0] : null;
  const oneEdge = selEdges.length === 1 && !selNodes.length ? selEdges[0] : null;
  const edgeRaw = oneEdge?.data!.raw;
  const setShape = (shape: Shape) => {
    setNodes((ns) => ns.map((n) => (n.id === oneBox!.id ? { ...n, data: { raw: { ...n.data.raw, shape } } } : n)));
    commit();
  };
  const setRoute = (route: Route) => {
    lastRoute.current = route;
    setEdgeData(oneEdge!.id, { route }, true);
  };

  return (
    <FlowCtx.Provider value={ctx}>
      {!p.readOnly && <div className="toolbar flow-toolbar">
        <span className="flow-tb-label">Add</span>
        {SHAPES.map((s) => (
          <button key={s.shape} className="icon" title={`Add a ${s.name.toLowerCase()} box`} onClick={() => startEdit(addBox(s.shape), true)}>
            <Glyph kind={s.shape} />
          </button>
        ))}
        <button className="icon" title="Add a loop frame: boxes inside it move with it" onClick={addFrame}>
          <Glyph kind="frame" /> Loop
        </button>
        <div className="sep" />
        {oneBox && (
          <select title="Shape of the selected box" value={oneBox.data.raw.shape ?? 'process'} onChange={(e) => setShape(e.target.value as Shape)}>
            {SHAPES.map((s) => (
              <option key={s.shape} value={s.shape}>{s.name}</option>
            ))}
          </select>
        )}
        {edgeRaw && (
          <>
            {(['straight', 'elbow', 'curve'] as Route[]).map((r) => (
              <button key={r} className={'icon' + ((edgeRaw.route ?? 'elbow') === r ? ' active' : '')} title={`${r[0].toUpperCase() + r.slice(1)} arrow`} onClick={() => setRoute(r)}>
                <Glyph kind={r} />
              </button>
            ))}
            <button
              className={'icon' + (edgeRaw.style === 'dashed' ? ' active' : '')}
              title="Dashed line (for example, a loop going back)"
              onClick={() => setEdgeData(oneEdge!.id, { style: edgeRaw.style === 'dashed' ? undefined : 'dashed' }, true)}
            >
              <Glyph kind="dashed" />
            </button>
            <select
              title="Arrowheads"
              value={edgeRaw.fromEnd === 'arrow' ? 'both' : edgeRaw.toEnd === 'none' ? 'none' : 'end'}
              onChange={(e) => {
                const v = e.target.value;
                setEdgeData(oneEdge!.id, { fromEnd: v === 'both' ? 'arrow' : undefined, toEnd: v === 'none' ? 'none' : undefined }, true);
              }}
            >
              <option value="end">→ Arrow at end</option>
              <option value="both">↔ Both ends</option>
              <option value="none">— No arrowheads</option>
            </select>
            <button className="icon" title="Write a label on the arrow (or double-click it)" onClick={() => setEditingLabel(oneEdge!.id)}>
              Label
            </button>
          </>
        )}
        {(selNodes.length > 0 || selEdges.length > 0) && (
          <button className="icon" title="Delete (Del)" onClick={() => void rf.deleteElements({ nodes: selNodes, edges: selEdges })}>
            <Icon name="trash" />
          </button>
        )}
        <div className="sep" />
        <button className="icon" title="Undo (Ctrl+Z)" onClick={() => undo(-1)}><Icon name="undo" /></button>
        <button className="icon" title="Redo (Ctrl+Y)" onClick={() => undo(1)}><Icon name="redo" /></button>
        <div className="spacer" />
        <button className="icon" title="Fit the flowchart in view" onClick={() => void rf.fitView({ padding: 0.2, duration: 300 })}><Icon name="fit" /></button>
      </div>}
      <div
        className="flow-editor"
        ref={wrap}
        onKeyDown={(e) => {
          if (p.readOnly || editing || editingLabel || (e.target as HTMLElement).closest('input, select, .cm-editor')) return;
          const mod = e.ctrlKey || e.metaKey;
          const k = e.key.toLowerCase();
          if (mod && k === 'z' && !e.shiftKey) (e.preventDefault(), undo(-1));
          else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) (e.preventDefault(), undo(1));
          else if (mod && k === 's') (e.preventDefault(), p.onSave());
          else if (e.key === 'Enter' && oneBox && oneBox.data.raw.type === 'text') (e.preventDefault(), startEdit(oneBox.id));
          else if (e.key === 'Enter' && oneEdge) (e.preventDefault(), setEditingLabel(oneEdge.id));
        }}
      >
        <svg className="flow-defs" aria-hidden="true">
          <defs>
            {['', '-sel'].map((sfx) => (
              <marker key={sfx} id={marker + sfx} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0 0L10 5L0 10z" style={{ fill: sfx ? 'var(--accent)' : 'var(--flow-line)' }} />
              </marker>
            ))}
          </defs>
        </svg>
        <ReactFlow<BoxNode, FlowEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode={mode as 'light' | 'dark'}
          onNodesChange={(changes: NodeChange<BoxNode>[]) => {
            setNodes((ns) => applyNodeChanges(changes, ns));
            if (changes.some((c) => c.type === 'remove')) commit();
          }}
          onEdgesChange={(changes: EdgeChange<FlowEdge>[]) => {
            setEdges((es) => applyEdgeChanges(changes, es));
            if (changes.some((c) => c.type === 'remove')) commit();
          }}
          onConnect={(c: Connection) => {
            const raw: CanvasEdge = { id: newId(), fromNode: c.source, fromSide: (c.sourceHandle ?? undefined) as Side | undefined, toNode: c.target, toSide: (c.targetHandle ?? undefined) as Side | undefined, toEnd: 'arrow', route: lastRoute.current };
            setEdges((es) => [...es, { id: raw.id, type: 'flow', source: c.source, target: c.target, sourceHandle: c.sourceHandle, targetHandle: c.targetHandle, data: { raw } }]);
            commit();
          }}
          onNodeDragStart={(_, __, dragged) => {
            carried.current = dragged
              .filter((d) => d.type === 'frame')
              .map((f) => ({
                frame: f.id,
                from: { ...f.position },
                items: nodesRef.current.filter((n) => n.id !== f.id && !dragged.some((d) => d.id === n.id) && inside(f, n)).map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })),
              }));
          }}
          onNodeDrag={(_, __, dragged) => {
            if (!carried.current.length) return;
            const moves = new Map<string, P>();
            for (const c of carried.current) {
              const f = dragged.find((d) => d.id === c.frame);
              if (!f) continue;
              const dx = f.position.x - c.from.x;
              const dy = f.position.y - c.from.y;
              for (const it of c.items) moves.set(it.id, { x: it.x + dx, y: it.y + dy });
            }
            setNodes((ns) => ns.map((n) => (moves.has(n.id) ? { ...n, position: moves.get(n.id)! } : n)));
          }}
          onNodeDragStop={() => {
            carried.current = [];
            commit();
          }}
          onEdgeDoubleClick={(_, e) => !p.readOnly && setEditingLabel(e.id)}
          onPaneClick={() => setEditingLabel(null)}
          onMove={(_, vp) => p.onZoomChange(vp.zoom)}
          onInit={(inst) => p.onZoomChange(inst.getZoom())}
          connectionMode={ConnectionMode.Loose}
          connectionRadius={28}
          snapToGrid
          snapGrid={[8, 8]}
          elevateNodesOnSelect={false}
          elevateEdgesOnSelect
          deleteKeyCode={p.readOnly ? null : ['Delete', 'Backspace']}
          nodesDraggable={!p.readOnly}
          nodesConnectable={!p.readOnly}
          elementsSelectable={!p.readOnly}
          panOnScroll
          zoomOnScroll={false}
          zoomOnPinch
          zoomOnDoubleClick={false}
          minZoom={0.2}
          maxZoom={3}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1.2} color="var(--border-strong)" />
        </ReactFlow>
      </div>
    </FlowCtx.Provider>
  );
}

export function FlowEditor(p: Props) {
  return (
    <ReactFlowProvider>
      <Editor {...p} />
    </ReactFlowProvider>
  );
}
