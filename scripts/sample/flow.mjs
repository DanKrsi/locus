// The sample's flowchart: how a margin of safety is checked, with loops over load cases and
// parts, a decision, and a redesign loop back. Box text cites the code, data, deck and standards.
// R holds ready-made reference links (from make_reference).
export const FLOW_REFS = ['loadFactors', 'marginFn', 'marginSummary', 'slideChanges', 'slideMarginsCdr', 'table1', 'fitting'];

export function marginCheckFlow(R) {
  const nodes = [
    { id: 'cases', type: 'group', label: 'for each load case', x: 0, y: 208, width: 656, height: 520 },
    { id: 'parts', type: 'group', label: 'for each part: bracket, bolts, joint', x: 24, y: 256, width: 448, height: 416 },
    { id: 'start', type: 'text', shape: 'terminal', text: 'New loads or a design change', x: 152, y: 0, width: 224, height: 48 },
    { id: 'factors', type: 'text', shape: 'io', text: `Read the design factors\n${R.loadFactors}`, x: 144, y: 96, width: 240, height: 72 },
    { id: 'compute', type: 'text', shape: 'process', text: `Compute the margin\n${R.marginFn}`, x: 152, y: 304, width: 224, height: 72 },
    { id: 'ok', type: 'text', shape: 'decision', text: 'MS ≥ 0?', x: 192, y: 416, width: 144, height: 96 },
    { id: 'record', type: 'text', shape: 'process', text: `Record it\n${R.marginSummary}`, x: 152, y: 560, width: 224, height: 72 },
    { id: 'redesign', type: 'text', shape: 'subprocess', text: `Redesign\n${R.slideChanges}`, x: 496, y: 416, width: 144, height: 96 },
    { id: 'done', type: 'text', shape: 'terminal', text: `All margins positive\n${R.slideMarginsCdr}`, x: 144, y: 776, width: 240, height: 64 },
    { id: 'why', type: 'text', shape: 'note', text: `Factors come from ${R.table1}. Bolts also take ${R.fitting}.`, x: 704, y: 88, width: 240, height: 104 },
  ];
  const e = (id, fromNode, fromSide, toNode, toSide, extra = {}) => ({ id, fromNode, fromSide, toNode, toSide, toEnd: 'arrow', route: 'elbow', ...extra });
  const edges = [
    e('e1', 'start', 'bottom', 'factors', 'top'),
    e('e2', 'factors', 'bottom', 'compute', 'top'),
    e('e3', 'compute', 'bottom', 'ok', 'top'),
    e('e4', 'ok', 'bottom', 'record', 'top', { label: 'yes' }),
    e('e5', 'ok', 'right', 'redesign', 'left', { label: 'no' }),
    e('e6', 'redesign', 'top', 'compute', 'right', { style: 'dashed', label: 're-check', points: [{ x: 568, y: 340 }] }),
    e('e7', 'record', 'left', 'compute', 'left', { style: 'dashed', label: 'next part', points: [{ x: 56, y: 596 }, { x: 56, y: 340 }] }),
    e('e8', 'cases', 'bottom', 'done', 'top', { label: 'all load cases done' }),
    e('e9', 'why', 'left', 'factors', 'right', { style: 'dashed', toEnd: 'none' }),
  ];
  const list = (items) => '[\n\t\t' + items.map((i) => JSON.stringify(i)).join(',\n\t\t') + '\n\t]';
  return `{\n\t"nodes":${list(nodes)},\n\t"edges":${list(edges)}\n}\n`;
}
