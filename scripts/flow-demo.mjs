// The nested retry loop from the flowchart mockup, as a .canvas file citing the test workspace's
// client.py. Used by the smoke test and for screenshots.
// Usage: node scripts/flow-demo.mjs <output .canvas path>
import { writeFileSync } from 'node:fs';

const code = (label, lines) => `[${label}](/src/net/client.py#L${lines})`;

export const demoFlow = {
  nodes: [
    { id: 'outer', type: 'group', label: 'for each url in urls', x: 0, y: 96, width: 600, height: 568 },
    { id: 'inner', type: 'group', label: 'for attempt in range(RETRIES)', x: 24, y: 144, width: 408, height: 368 },
    { id: 'start', type: 'text', shape: 'terminal', text: 'fetch_all(urls)', x: 144, y: 0, width: 200, height: 48 },
    { id: 'open', type: 'text', shape: 'process', text: `urlopen(url)\n${code('client.py L26', '26-27')}`, x: 136, y: 192, width: 208, height: 72 },
    { id: 'failed', type: 'text', shape: 'decision', text: 'failed?', x: 168, y: 304, width: 144, height: 88 },
    { id: 'wait', type: 'text', shape: 'process', text: `wait backoff(attempt)\n${code('backoff()', '15-18')}`, x: 136, y: 424, width: 208, height: 72 },
    { id: 'body', type: 'text', shape: 'process', text: 'return body', x: 456, y: 320, width: 112, height: 56 },
    { id: 'raise', type: 'text', shape: 'terminal', text: 'raise last_error', x: 136, y: 552, width: 208, height: 44 },
    { id: 'append', type: 'text', shape: 'process', text: 'append result', x: 456, y: 544, width: 112, height: 56 },
    { id: 'end', type: 'text', shape: 'terminal', text: 'return results', x: 144, y: 712, width: 200, height: 48 },
  ],
  edges: [
    { id: 'e1', fromNode: 'start', fromSide: 'bottom', toNode: 'open', toSide: 'top', toEnd: 'arrow', route: 'elbow' },
    { id: 'e2', fromNode: 'open', fromSide: 'bottom', toNode: 'failed', toSide: 'top', toEnd: 'arrow', route: 'elbow' },
    { id: 'e3', fromNode: 'failed', fromSide: 'bottom', toNode: 'wait', toSide: 'top', toEnd: 'arrow', route: 'elbow', label: 'yes' },
    { id: 'e4', fromNode: 'failed', fromSide: 'right', toNode: 'body', toSide: 'left', toEnd: 'arrow', route: 'elbow', label: 'no' },
    { id: 'e5', fromNode: 'wait', fromSide: 'left', toNode: 'open', toSide: 'left', toEnd: 'arrow', route: 'elbow', style: 'dashed', label: 'next attempt', points: [{ x: 64, y: 460 }, { x: 64, y: 228 }] },
    { id: 'e6', fromNode: 'inner', fromSide: 'bottom', toNode: 'raise', toSide: 'top', toEnd: 'arrow', route: 'elbow', label: 'retries used up' },
    { id: 'e7', fromNode: 'body', fromSide: 'bottom', toNode: 'append', toSide: 'top', toEnd: 'arrow', route: 'elbow' },
    { id: 'e8', fromNode: 'append', fromSide: 'right', toNode: 'open', toSide: 'top', toEnd: 'arrow', route: 'elbow', style: 'dashed', label: 'next url', points: [{ x: 584, y: 572 }, { x: 584, y: 120 }, { x: 240, y: 120 }] },
    { id: 'e9', fromNode: 'outer', fromSide: 'bottom', toNode: 'end', toSide: 'top', toEnd: 'arrow', route: 'elbow', label: 'all urls done' },
  ],
};

export function demoFlowText() {
  const list = (items) => '[\n\t\t' + items.map((i) => JSON.stringify(i)).join(',\n\t\t') + '\n\t]';
  return `{\n\t"nodes":${list(demoFlow.nodes)},\n\t"edges":${list(demoFlow.edges)}\n}\n`;
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` && process.argv[2]) {
  writeFileSync(process.argv[2], demoFlowText());
  console.log('wrote', process.argv[2]);
}
