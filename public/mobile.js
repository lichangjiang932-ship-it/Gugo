(function () {
  'use strict'

  var form = document.getElementById('form')
  var input = document.getElementById('key')
  var btn = document.getElementById('submit')
  var msg = document.getElementById('msg')
  var tokenKey = 'your-model-atelier:auth-token'

  function show(kind, text) {
    msg.className = 'msg ' + kind
    msg.textContent = text
    msg.style.display = 'block'
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault()
    var rawKey = (input.value || '').trim()
    if (!rawKey) {
      show('err', '请输入 access key')
      return
    }

    btn.disabled = true
    btn.textContent = '正在验证…'
    msg.style.display = 'none'

    fetch('/api/mobile/handshake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: rawKey }),
    })
      .then(function (response) {
        return response.json().then(function (data) {
          return { status: response.status, data: data }
        })
      })
      .then(function (result) {
        if (!result.data || result.data.ok === false) {
          throw new Error((result.data && result.data.error) || ('HTTP ' + result.status))
        }
        try { sessionStorage.setItem(tokenKey, result.data.token) } catch { /* unavailable */ }
        input.value = ''
        show('ok', '登录成功，正在跳转到聊天…')
        window.setTimeout(function () { window.location.href = '/chat' }, 600)
      })
      .catch(function (error) {
        show('err', (error && error.message) || '验证失败，请检查 key')
        btn.disabled = false
        btn.textContent = '登录'
      })
  })

  input.addEventListener('focus', function () { msg.style.display = 'none' })
})()
