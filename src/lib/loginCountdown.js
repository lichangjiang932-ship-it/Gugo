export const LOGIN_CODE_COUNTDOWN_SECONDS = 60

export function formatLoginCodeCountdownLabel(countdown) {
  return countdown > 0 ? `重新发送 ${countdown}s` : '发送验证码'
}

export function shouldDisableLoginCodeButton({ accountLoading, loginEmail, countdown }) {
  return !!accountLoading || !loginEmail?.trim() || countdown > 0
}
