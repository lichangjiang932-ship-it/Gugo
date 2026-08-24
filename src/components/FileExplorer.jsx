import { useState, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Folder, FolderOpen, FileText, FileCode, FileImage, FileJson,
  FileSpreadsheet, File, ChevronRight, ChevronDown,
  Trash2, RefreshCw, Search, X
} from 'lucide-react'

const FILE_ICONS = {
  '.js': FileCode, '.jsx': FileCode, '.ts': FileCode, '.tsx': FileCode,
  '.html': FileCode, '.css': FileCode, '.scss': FileCode,
  '.json': FileJson, '.md': FileText, '.txt': FileText,
  '.png': FileImage, '.jpg': FileImage, '.jpeg': FileImage, '.svg': FileImage,
  '.csv': FileSpreadsheet, '.xlsx': FileSpreadsheet,
}

function getFileIcon(filename) {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase()
  const Icon = FILE_ICONS[ext] || File
  return Icon
}

function getFileColor(filename) {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase()
  const colors = {
    '.js': '#8B7B30', '.jsx': '#61DAFB', '.ts': '#3178C6', '.tsx': '#3178C6',
    '.html': '#E34C26', '.css': '#264DE4', '.scss': '#CD6799',
    '.json': '#858585', '.md': '#083FA1', '.txt': '#6B6B6B',
    '.png': '#7B9E5B', '.jpg': '#7B9E5B', '.svg': '#FFB13B',
    '.csv': '#217346', '.xlsx': '#217346',
  }
  return colors[ext] || '#8A7B68'
}

function buildTree(files) {
  const root = { name: '', children: {}, files: [] }
  files.forEach((f) => {
    const parts = f.path.split('/').filter(Boolean)
    let curr = root
    parts.forEach((part, i) => {
      if (i === parts.length - 1) {
        curr.files.push({ ...f, name: part })
      } else {
        if (!curr.children[part]) curr.children[part] = { name: part, children: {}, files: [] }
        curr = curr.children[part]
      }
    })
  })
  return root
}

function TreeNode({ node, depth = 0, onFileClick, onFileDelete, activeFile, expanded, toggleExpand }) {
  const isExpanded = expanded[node.name]
  const hasChildren = Object.keys(node.children).length > 0
  const hasFiles = node.files.length > 0

  if (depth === 0) {
    return (
      <>
        {Object.values(node.children).map((child) => (
          <TreeNode key={child.name} node={child} depth={depth + 1} onFileClick={onFileClick} onFileDelete={onFileDelete} activeFile={activeFile} expanded={expanded} toggleExpand={toggleExpand} />
        ))}
        {node.files.map((file) => (
          <FileNode key={file.path} file={file} depth={depth + 1} onClick={() => onFileClick(file)} onDelete={() => onFileDelete(file)} active={activeFile === file.path} />
        ))}
      </>
    )
  }

  return (
    <div>
      {hasChildren && (
        <button
          onClick={() => toggleExpand(node.name)}
          className="w-full flex items-center gap-1.5 py-1 px-2 rounded-lg text-xs text-ink-soft hover:bg-paper-2/40 hover:text-ink transition-colors"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          {isExpanded ? <FolderOpen className="w-3.5 h-3.5 text-ink-fade" /> : <Folder className="w-3.5 h-3.5 text-ink-fade" />}
          <span className="truncate">{node.name}</span>
        </button>
      )}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            {Object.values(node.children).map((child) => (
              <TreeNode key={child.name} node={child} depth={depth + 1} onFileClick={onFileClick} onFileDelete={onFileDelete} activeFile={activeFile} expanded={expanded} toggleExpand={toggleExpand} />
            ))}
            {node.files.map((file) => (
              <FileNode key={file.path} file={file} depth={depth + 1} onClick={() => onFileClick(file)} onDelete={() => onFileDelete(file)} active={activeFile === file.path} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
      {!hasChildren && hasFiles && depth > 0 && node.files.map((file) => (
        <FileNode key={file.path} file={file} depth={depth} onClick={() => onFileClick(file)} onDelete={() => onFileDelete(file)} active={activeFile === file.path} />
      ))}
    </div>
  )
}

function renderFileIcon(name, color) {
  const IconComp = getFileIcon(name)
  return <IconComp className="w-3.5 h-3.5 shrink-0" style={{ color }} />
}

function FileNode({ file, depth, onClick, onDelete, active }) {
  const color = getFileColor(file.name)
  return (
    <div
      className={`group flex items-center gap-1.5 py-1 px-2 rounded-lg text-xs cursor-pointer transition-all ${
        active ? 'bg-accent-soft/30 text-ink' : 'text-ink-soft hover:bg-paper-2/40 hover:text-ink'
      }`}
      style={{ paddingLeft: `${depth * 12 + 20}px` }}
    >
      {renderFileIcon(file.name, color)}
      <span className="truncate flex-1" onClick={onClick}>{file.name}</span>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete() }}
        className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-danger/40 text-ink-fade hover:text-danger transition-all"
      >
        <Trash2 className="w-3 h-3" />
      </button>
    </div>
  )
}

export default function FileExplorer({ files, onFileClick, onFileDelete, onRefresh }) {
  const [expanded, setExpanded] = useState({ src: true, components: true })
  const [searchQuery, setSearchQuery] = useState('')

  const filteredFiles = useMemo(() => {
    if (!searchQuery.trim()) return files
    const q = searchQuery.toLowerCase()
    return files.filter((f) => f.path.toLowerCase().includes(q))
  }, [files, searchQuery])

  const filteredTree = useMemo(() => buildTree(filteredFiles), [filteredFiles])

  return (
    <div className="w-[220px] h-full border-r border-ink-fade/15 bg-paper-2/20 flex flex-col shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-ink-fade/10">
        <span className="section-label">EXPLORER</span>
        <button onClick={onRefresh} className="p-1 rounded-md hover:bg-paper-2/50 text-ink-fade hover:text-ink transition-colors">
          <RefreshCw className="w-3 h-3" />
        </button>
      </div>

      {/* Search */}
      <div className="px-2.5 py-2 relative">
        <Search className="absolute left-5 top-1/2 -translate-y-1/2 w-3 h-3 text-ink-fade pointer-events-none" />
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="搜索文件…"
          className="w-full h-7 pl-7 pr-6 border border-ink-fade/15 rounded-lg bg-paper/60 text-xs text-ink outline-none focus:border-focus/40 transition-all placeholder:text-ink-fade/40"
        />
        {searchQuery && (
          <button onClick={() => setSearchQuery('')} className="absolute right-4 top-1/2 -translate-y-1/2 text-ink-fade hover:text-ink">
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* File Tree */}
      <div className="flex-1 overflow-y-auto px-1.5 py-1">
        {filteredFiles.length > 0 ? (
          <TreeNode
            node={filteredTree}
            onFileClick={onFileClick}
            onFileDelete={onFileDelete}
            expanded={expanded}
            toggleExpand={(name) => setExpanded((p) => ({ ...p, [name]: !p[name] }))}
          />
        ) : (
          <div className="py-8 text-center">
            <Folder className="w-8 h-8 text-ink-fade/20 mx-auto mb-2" />
            <p className="text-xs text-ink-fade/50">{searchQuery ? '无匹配文件' : '暂无文件'}</p>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-3 py-2 border-t border-ink-fade/10 text-[10px] text-ink-fade/40 font-mono">
        {files.length} files
      </div>
    </div>
  )
}
