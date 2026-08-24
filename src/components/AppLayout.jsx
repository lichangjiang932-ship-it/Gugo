import LeftRail from './LeftRail.jsx'

export default function AppLayout({
  as: Root = 'div',
  children,
  className = '',
  mainAs: Main = null,
  mainClassName = '',
  mainProps = {},
  ...rootProps
}) {
  const content = Main
    ? <Main {...mainProps} className={mainClassName}>{children}</Main>
    : children

  return (
    <Root {...rootProps} className={className}>
      <LeftRail />
      {content}
    </Root>
  )
}
