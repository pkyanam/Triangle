interface CodeViewerProps {
  path: string | null;
  content: string;
}

function languageFor(path: string | null): string {
  if (!path) return '';
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'js':
    case 'jsx':
      return 'JavaScript';
    case 'ts':
    case 'tsx':
      return 'TypeScript';
    case 'glsl':
    case 'vert':
    case 'frag':
      return 'GLSL';
    case 'json':
      return 'JSON';
    case 'md':
      return 'Markdown';
    default:
      return ext.toUpperCase();
  }
}

/**
 * Stage 1 read-only code viewer with a line gutter. Monaco (full editing + GLSL
 * language services) replaces this in Stage 2.
 */
export function CodeViewer({ path, content }: CodeViewerProps): React.JSX.Element {
  if (!path) {
    return <div className="code__empty">Select a file to view its contents.</div>;
  }
  const lines = content.split('\n');
  return (
    <div className="code">
      <div className="code__tabbar">
        <span>{path}</span>
        <span className="code__badge">{languageFor(path)} · read-only</span>
      </div>
      <div className="code__scroll">
        <div className="code__pre">
          <div className="code__gutter">
            {lines.map((_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
          <div className="code__lines">{content}</div>
        </div>
      </div>
    </div>
  );
}
