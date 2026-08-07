import { GitBranch, Package, Plus, Search, Upload } from 'lucide-react'

export default function SkillsToolbar({
  query, setQuery, activeFilter, setActiveFilter, filterDefs, searchRef, folderInputRef,
  selectFolder, openPlugins, openGithub, openCustomModal, t,
}) {
  return (
    <>
      <div className="flex items-end justify-between mb-6 gap-4">
        <h1 className="font-hand text-[30px] text-ink">{t('skillsMarket.title')}</h1>
        <div className="flex flex-wrap justify-end gap-2">
          <input
            ref={folderInputRef}
            type="file"
            webkitdirectory=""
            directory=""
            multiple
            className="hidden"
            onChange={selectFolder}
          />
          <div className="h-9 px-3.5 border border-ink/70 rounded-md flex items-center gap-1.5 bg-paper">
            <Search className="w-4 h-4 text-ink-fade" />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('skillsMarket.search')}
              className="bg-transparent text-sm text-ink outline-none placeholder:text-ink-soft w-40"
            />
          </div>
          <button type="button" onClick={() => folderInputRef.current?.click()} className="h-9 px-4 border border-ink/70 rounded-md font-hand text-sm flex items-center gap-1.5 hover:bg-paper-2">
            <Upload className="w-4 h-4" />{t('skillsMarket.importPack')}
          </button>
          <button type="button" onClick={openPlugins} className="h-9 px-4 border border-ink/70 rounded-md font-hand text-sm flex items-center gap-1.5 hover:bg-paper-2">
            <Package className="w-4 h-4" />{t('skillsMarket.fromPlugin')}
          </button>
          <button type="button" onClick={() => openGithub('gsap')} className="h-9 px-4 border border-ink/70 rounded-md font-hand text-sm flex items-center gap-1.5 hover:bg-paper-2">
            <GitBranch className="w-4 h-4" />GSAP
          </button>
          <button type="button" onClick={() => openGithub()} className="h-9 px-4 border border-ink/70 rounded-md font-hand text-sm flex items-center gap-1.5 hover:bg-paper-2">
            <GitBranch className="w-4 h-4" />{t('skillsMarket.fromGithub')}
          </button>
          <button type="button" onClick={openCustomModal} className="h-9 px-4 bg-ember text-paper rounded-md font-hand text-sm flex items-center gap-1.5 hover:bg-ember/90">
            <Plus className="w-4 h-4" />{t('skillsMarket.custom')}
          </button>
        </div>
      </div>
      <div className="flex gap-2 mb-5 flex-wrap">
        {filterDefs.map((filter) => (
          <button
            type="button"
            key={filter.key}
            onClick={() => setActiveFilter(filter.key)}
            className={`inline-flex items-center h-[26px] px-3 rounded-full text-xs border transition-colors ${activeFilter === filter.key ? 'bg-ink text-paper border-ink' : 'border-ink-fade/60 text-ink-soft hover:border-ink-fade'}`}
          >
            {filter.label} · {filter.count}
          </button>
        ))}
      </div>
    </>
  )
}
