import { useState } from 'react'
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from 'lucide-react'
import { truncateMiddle } from '../../../../lib/diffReviewModel.js'

function Counts({ file }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-xs">
      {file.additions > 0 && <span className="text-accent">+{file.additions}</span>}
      {file.deletions > 0 && <span className="text-danger">−{file.deletions}</span>}
      {file.additions === 0 && file.deletions === 0 && <span className="text-ink-fade">·</span>}
    </span>
  )
}

function FileRow({ file, onSelect, selected }) {
  return (
    <button
      type="button"
      data-testid="diff-file-row"
      data-path={file.path}
      aria-current={selected === file.path ? 'true' : undefined}
      title={file.path}
      onClick={() => onSelect(file.path)}
      className={`group flex w-full min-w-0 items-center gap-1.5 rounded-control py-1.5 pl-5 pr-2 text-left text-xs transition-colors ${
        selected === file.path ? 'bg-[var(--color-selected)] text-ink' : 'text-ink-soft hover:bg-[var(--color-row-hover)]'
      }`}
    >
      <FileText className="h-3.5 w-3.5 shrink-0 text-ink-fade" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{truncateMiddle(file.path.split('/').pop())}</span>
      <Counts file={file} />
    </button>
  )
}

function TreeNode({ node, onSelect, selected, depth }) {
  const [open, setOpen] = useState(depth < 1)
  if (node.type === 'file') return <FileRow file={node.file} onSelect={onSelect} selected={selected} />
  return (
    <li className="min-w-0">
      <button
        type="button"
        data-testid="diff-dir-row"
        data-path={node.path}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        style={{ paddingLeft: `${Math.max(0, depth) * 10 + 4}px` }}
        className="flex w-full min-w-0 items-center gap-1 py-1 pr-2 text-left text-xs text-ink-soft hover:text-ink"
      >
        {open ? <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" /> : <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />}
        {open ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-ink-fade" aria-hidden="true" /> : <Folder className="h-3.5 w-3.5 shrink-0 text-ink-fade" aria-hidden="true" />}
        <span className="min-w-0 flex-1 truncate">{truncateMiddle(node.name, 22)}</span>
      </button>
      {open && (
        <ul className="min-w-0">
          {node.children.map((child) => (
            <TreeNode key={child.path} node={child} onSelect={onSelect} selected={selected} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  )
}

/**
 * The changed files as a folder tree: folders first, file names truncated in the
 * middle (so both ends stay recognisable), counts on the right, and the full
 * path in the tooltip because the visible name is not the whole story.
 */
export default function FileTreePane({ nodes = [], onSelect, selected = '', special = [], t }) {
  return (
    <aside className="min-h-0 w-[46%] max-w-[320px] shrink-0 overflow-y-auto border-r border-ink/10 p-2" data-testid="diff-file-pane">
      <ul className="min-w-0" data-testid="diff-file-tree">
        {nodes.map((node) => <TreeNode key={node.path} node={node} onSelect={onSelect} selected={selected} depth={0} />)}
      </ul>
      {special.length > 0 && (
        <>
          <p className="mt-2 px-1 text-xs text-ink-fade">{t('diffReview.separateSpecial')}</p>
          <ul className="min-w-0">
            {special.map((file) => <FileRow key={file.path} file={file} onSelect={onSelect} selected={selected} />)}
          </ul>
        </>
      )}
    </aside>
  )
}
