/**
 * ArtifactPreview — Artifact 预览组件
 *
 * 参考 openhanako 的 PreviewRenderer，支持代码高亮、
 * Markdown 预览等。
 */

import { memo, useMemo } from 'react';

export const ArtifactPreview = memo(function ArtifactPreview({ content, language }) {
  const highlighted = useMemo(() => {
    if (!content) return '';
    // Simple syntax highlighting via CSS classes
    return content;
  }, [content]);

  if (!content) return null;

  return (
    <div className="artifact-code-preview">
      <pre className="artifact-pre">
        <code className={language ? `language-${language}` : ''}>
          {highlighted}
        </code>
      </pre>
    </div>
  );
});
