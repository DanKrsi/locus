// Side-by-side comparison of two versions of a text file (UI spec §5.1, Compare).
import { useEffect, useRef } from 'react';
import { EditorState, StateEffect } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { MergeView } from '@codemirror/merge';
import type { RevealRequest } from './types';
import { tags } from '@lezer/highlight';
import { basename } from '../../core/link';
import { decodeText } from '../files';

const style = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--syn-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syn-string)' },
  { tag: tags.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syn-number)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--syn-function)' },
]);

export function DiffViewer({ left, right, path, reveal }: { left: Uint8Array; right: Uint8Array; path: string; reveal?: RevealRequest }) {
  const host = useRef<HTMLDivElement>(null);
  const mvRef = useRef<MergeView | null>(null);
  // Both sides scroll together; show the right side's line (where the reader was, or a citation).
  const show = () => {
    const mv = mvRef.current;
    const line = reveal?.loc.lines?.start;
    if (!mv || !line) return;
    const doc = mv.b.state.doc;
    const pos = doc.line(Math.min(Math.max(1, line), doc.lines)).from;
    // Scroll the shared scroller vertically only, to the line (or the folded unchanged lines
    // that hold it); asking CodeMirror to scroll into a folded part also scrolls sideways.
    const block = mv.b.lineBlockAt(pos);
    const scroller = host.current!;
    const offset = mv.b.contentDOM.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTop = offset + block.top - (reveal!.follow ? 8 : scroller.clientHeight / 3);
  };
  useEffect(() => {
    requestAnimationFrame(show);
  }, [reveal?.nonce]);
  useEffect(() => {
    const ext = [EditorState.readOnly.of(true), EditorView.editable.of(false), lineNumbers(), syntaxHighlighting(style)];
    const mv = new MergeView({
      a: { doc: decodeText(left).text, extensions: ext },
      b: { doc: decodeText(right).text, extensions: ext },
      parent: host.current!,
      gutter: true,
      highlightChanges: true,
      collapseUnchanged: { margin: 3, minSize: 6 },
    });
    const desc = LanguageDescription.matchFilename(languages, basename(path));
    desc?.load().then((support) => {
      for (const v of [mv.a, mv.b]) v.dispatch({ effects: StateEffect.appendConfig.of(support) });
    });
    mvRef.current = mv;
    requestAnimationFrame(show);
    return () => {
      mvRef.current = null;
      mv.destroy();
    };
  }, [left, right, path]);
  return <div className="diff-viewer" ref={host} />;
}
