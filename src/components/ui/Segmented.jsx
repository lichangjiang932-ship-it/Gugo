import { useId } from 'react'
import './Segmented.css'

/** Controlled single choice. Group/pressed by default; tab semantics are opt-in. */
export default function Segmented({ value, options, onChange, label, role = 'group', className = '', ...props }) {
  const id = useId()
  const selected = options.findIndex(option => option.value === value || option.aliases?.includes(value))
  const first = options.findIndex(option => !option.disabled)
  const select = (event, index) => {
    let next = index
    const step = event.key === 'ArrowLeft' ? -1 : 1
    if (event.key === 'Home') next = first
    else if (event.key === 'End') next = options.findLastIndex(option => !option.disabled)
    else if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      do { next = (next + step + options.length) % options.length } while (next !== index && options[next].disabled)
    } else return
    event.preventDefault()
    if (next < 0 || options[next].disabled) return
    event.currentTarget.parentElement.querySelectorAll('button')[next]?.focus()
    onChange?.(options[next].value)
  }
  return <div {...props} role={role} aria-label={label} className={'gugo-segmented ' + className}
    style={{ '--segment-count': Math.max(1, options.length), '--segment-index': Math.max(0, selected) }}>
    {selected >= 0 && <span className="gugo-segmented-thumb" aria-hidden="true" />}
    {options.map((option, index) => <button {...option.buttonProps} key={option.value} id={id + '-' + index}
      type="button" role={role === 'tablist' ? 'tab' : undefined} disabled={option.disabled}
      tabIndex={index === (selected >= 0 && !options[selected].disabled ? selected : first) ? 0 : -1}
      className="gugo-segmented-option" onKeyDown={event => select(event, index)} onClick={() => onChange?.(option.value)}
      {...(role === 'tablist' ? { 'aria-selected': selected === index } : { 'aria-pressed': selected === index })}>
      {option.icon}{option.label}
    </button>)}
  </div>
}
