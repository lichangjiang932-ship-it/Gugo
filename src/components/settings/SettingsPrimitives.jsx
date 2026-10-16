import Segmented from '../ui/Segmented.jsx'

export function SettingsPanel({ title, description, children, testId, className = '' }) {
  return (
    <section className={`settings-panel ${className}`.trim()} data-testid={testId}>
      <header className="settings-panel-header">
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </header>
      <div className="settings-panel-body">{children}</div>
    </section>
  )
}

export function SettingsGroup({ title, description, children, className = '' }) {
  return (
    <section className={`settings-group ${className}`.trim()}>
      {title || description ? (
        <header className="settings-group-header">
          {title ? <h2>{title}</h2> : null}
          {description ? <p>{description}</p> : null}
        </header>
      ) : null}
      <div className="settings-group-rows">{children}</div>
    </section>
  )
}

export function SettingsRow({ title, description, children, align = 'center', className = '' }) {
  return (
    <div className={`settings-row settings-row-${align} ${className}`.trim()}>
      <div className="settings-row-copy">
        <h3>{title}</h3>
        {description ? <p>{description}</p> : null}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  )
}

export function SettingsToggle({ checked, onChange, label, disabled = false }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="settings-toggle"
      data-checked={checked ? 'true' : 'false'}
    >
      <span aria-hidden="true" />
    </button>
  )
}

export function SettingsSegmented(props) {
  return <Segmented {...props} className="settings-segmented" />
}
