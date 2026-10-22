// Side-by-side comparison of two versions of a text file (UI spec §5.1, Compare).
import { useEffect, useRef } from 'react';
import { EditorState, StateEffect } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { MergeView } from '@codemirror/merge';
import { tags } from '@lezer/highlight';
import { basename } from '../../core/link';
import { decodeText } from '../files';

const style = HighlightStyle.define([
  { tag: tags.keyword, color: '#7c3aed' },
  { tag: [tags.string, tags.special(tags.string)], color: '#0f7b45' },
  { tag: tags.comment, color: '#8a918c', fontStyle: 'italic' },
  { tag: [tags.number, tags.bool, tags.null], color: '#b45309' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#1d4f91' },
]);

export function DiffViewer({ left, right, path }: { left: Uint8Array; right: Uint8Array; path: string }) {
  const host = useRef<HTMLDivElement>(null);
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
    return () => mv.destroy();
  }, [left, right, path]);
  return <div className="diff-viewer" ref={host} />;
}
