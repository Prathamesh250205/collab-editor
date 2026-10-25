// CodeMirror theme matching the site: ink background, warm text, coral/cyan accents.
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

const theme = EditorView.theme(
  {
    '&': { color: '#e9e5dd', backgroundColor: 'transparent', fontSize: '14px', height: '100%' },
    '.cm-scroller': { fontFamily: "'JetBrains Mono Variable', ui-monospace, monospace", lineHeight: '1.7' },
    '.cm-content': { caretColor: '#ff6b4a', padding: '16px 0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#ff6b4a', borderLeftWidth: '2px' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(79, 209, 255, 0.18) !important' },
    '.cm-gutters': { backgroundColor: 'transparent', color: '#4d4b47', border: 'none', paddingLeft: '8px' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#ece8e1' },
    '.cm-activeLine': { backgroundColor: 'rgba(236, 232, 225, 0.035)' },
    '.cm-matchingBracket': { backgroundColor: 'rgba(255, 107, 74, 0.18)', outline: 'none' },
    '.cm-tooltip': { backgroundColor: '#15171b', border: '1px solid rgba(236,232,225,0.1)' },
    // Remote cursor labels from y-codemirror
    '.cm-ySelectionInfo': { fontFamily: "'Inter Tight Variable', sans-serif", fontWeight: '600', padding: '1px 6px', borderRadius: '4px 4px 4px 0', opacity: '1', top: '-1.35em' },
  },
  { dark: true },
)

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: '#ff8a6b' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#7fdcff' },
  { tag: [t.string, t.special(t.string)], color: '#b9e47c' },
  { tag: [t.number, t.bool, t.null], color: '#ffc46b' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#6b6862', fontStyle: 'italic' },
  { tag: [t.typeName, t.className], color: '#c9a7ff' },
  { tag: [t.propertyName], color: '#e9e5dd' },
  { tag: [t.operator, t.punctuation, t.bracket], color: '#9a968e' },
])

export const inkTheme = [theme, syntaxHighlighting(highlight)]

// Cursor colours for collaborators (first two match the site's accents).
export const USER_COLORS = ['#ff6b4a', '#4fd1ff', '#9be15d', '#ffb547', '#b18cff', '#ff7ab6', '#3ee0b5', '#ffe066']

export function colorFor(name: string) {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return USER_COLORS[h % USER_COLORS.length]
}
