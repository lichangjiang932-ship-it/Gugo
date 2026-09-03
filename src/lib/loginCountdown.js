export const LOGIN_CODE_COUNTDOWN_SECONDS = 60

export function formatLoginCodeCountdownLabel(
  countdown,
  {
    sendCodeLabel = 'Send code',
    resendCodeLabel = (seconds) => `Resend in ${seconds}s`,
  } = {},
) {
  return countdown > 0 ? resendCodeLabel(countdown) : sendCodeLabel
}

export function shouldDisableLoginCodeButton({ accountLoading, loginEmail, countdown }) {
  return !!accountLoading || !loginEmail?.trim() || countdown > 0
}
