const TOKEN = ENV_BOT_TOKEN
const WEBHOOK = '/endpoint'
const SECRET = ENV_BOT_SECRET
const ADMIN_UID = ENV_ADMIN_UID

const NOTIFY_INTERVAL = 3600 * 1000
const fraudDb = 'https://raw.githubusercontent.com/laningya/nfd/refs/heads/main/data/fraud.db'
const startMsgUrl = 'https://raw.githubusercontent.com/laningya/nfd/refs/heads/main/data/startMessage.md'

// Markdown 转义函数
function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+-=|{}.!]/g, '\\$&')
}

function apiUrl(methodName, params = null) {
  return `https://api.telegram.org/bot${TOKEN}/${methodName}${
    params ? '?' + new URLSearchParams(params) : ''
  }`
}

async function requestTelegram(methodName, body, params) {
  const response = await fetch(apiUrl(methodName, params), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return response.json()
}

const sendMessage = (msg) => requestTelegram('sendMessage', msg)
const copyMessage = (msg) => requestTelegram('copyMessage', msg)
const forwardMessage = (msg) => requestTelegram('forwardMessage', msg)

addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.pathname === WEBHOOK) {
    event.respondWith(handleWebhook(event))
  } else if (url.pathname === '/registerWebhook') {
    event.respondWith(registerWebhook(event, url, WEBHOOK, SECRET))
  } else {
    event.respondWith(new Response('Not Found', { status: 404 }))
  }
})

async function handleWebhook(event) {
  if (event.request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) {
    return new Response('Unauthorized', { status: 403 })
  }

  const update = await event.request.json()
  event.waitUntil(onUpdate(update))
  return new Response('Ok')
}

async function onUpdate(update) {
  if (update.message) await onMessage(update.message)
}

async function onMessage(message) {
  if (message.text === '/start') {
    const startMsg = await fetch(startMsgUrl).then(r => r.text())
    return sendMessage({
      chat_id: message.chat.id,
      text: startMsg
    })
  }

  return message.chat.id.toString() === ADMIN_UID 
    ? handleAdminMessage(message)
    : handleGuestMessage(message)
}

// 管理员消息处理
async function handleAdminMessage(message) {
  if (!message?.reply_to_message) {
    return sendMessage({
      chat_id: ADMIN_UID,
      text: '请回复消息使用以下命令：\n/block - 封禁用户\n/unblock - 解封用户\n/checkblock - 查看封禁状态\n/info - 查看用户信息'
    })
  }

  const command = message.text?.trim()
  switch(true) {
    case /^\/block$/.test(command): return handleBlock(message)
    case /^\/unblock$/.test(command): return handleUnBlock(message)
    case /^\/checkblock$/.test(command): return checkBlock(message)
    case /^\/info$/.test(command): return handleUserInfo(message)
    default: return forwardResponse(message)
  }
}

// 普通用户消息处理
async function handleGuestMessage(message) {
  const chatId = message.chat.id
  const isBlocked = await checkBlockStatus(chatId)
  
  if (isBlocked) {
    return sendMessage({ chat_id: chatId, text: '⚠️ 您已被限制使用本服务' })
  }

  await storeUserInfo(chatId, {
    username: message.chat.username,
    first_name: message.chat.first_name
  })

  const forwardResult = await forwardMessage({
    chat_id: ADMIN_UID,
    from_chat_id: chatId,
    message_id: message.message_id
  })

  if (forwardResult.ok) {
    await nfd.put(`msg-map-${forwardResult.result.message_id}`, chatId)
  }

  return handleNotify(message)
}

// 通知处理核心
async function handleNotify(message) {
  const chatId = message.chat.id
  try {
    if (await isFraud(chatId)) {
      return sendFraudAlert(chatId)
    }

    const lastNotify = await nfd.get(`lastmsg-${chatId}`)
    if (!lastNotify || Date.now() - lastNotify > NOTIFY_INTERVAL) {
      await nfd.put(`lastmsg-${chatId}`, Date.now())
      return sendUserNotification(chatId)
    }
  } catch (error) {
    console.error(`通知处理失败: ${error.stack}`)
    return sendMessage({
      chat_id: ADMIN_UID,
      text: `⚠️ 系统通知异常: ${error.message}`
    })
  }
}

// 用户信息存储
async function storeUserInfo(chatId, info) {
  await nfd.put(`userinfo-${chatId}`, JSON.stringify(info))
}

// 用户信息获取
async function getUserDetails(chatId) {
  try {
    const userInfo = await nfd.get(`userinfo-${chatId}`, { type: "json" }) || {}
    return {
      id: chatId,
      username: userInfo.username ? `@${escapeMarkdown(userInfo.username)}` : '无',
      firstName: escapeMarkdown(userInfo.first_name || '未设置')
    }
  } catch (error) {
    console.error(`用户信息获取失败: ${chatId}`, error)
    return {
      id: chatId,
      username: '获取失败',
      firstName: '获取失败'
    }
  }
}

// 封禁管理功能
async function handleBlock(message) {
  try {
    const guestChatId = await nfd.get(`msg-map-${message.reply_to_message.message_id}`, { type: "json" })
    const user = await getUserDetails(guestChatId)
    
    await nfd.put(`isblocked-${guestChatId}`, "true", {
      metadata: { isBlocked: true }
    })

    return sendAdminAlert('✅ 用户封禁成功', user)
  } catch (error) {
    console.error('封禁操作异常:', error)
    return sendOperationError('封禁', error)
  }
}

async function handleUnBlock(message) {
  try {
    const guestChatId = await nfd.get(`msg-map-${message.reply_to_message.message_id}`, { type: "json" })
    const user = await getUserDetails(guestChatId)
    
    await nfd.delete(`isblocked-${guestChatId}`)

    return sendAdminAlert('✅ 用户解封成功', user)
  } catch (error) {
    console.error('解封操作异常:', error)
    return sendOperationError('解封', error)
  }
}

async function checkBlock(message) {
  try {
    const guestChatId = await nfd.get(`msg-map-${message.reply_to_message.message_id}`, { type: "json" })
    const user = await getUserDetails(guestChatId)
    const isBlocked = await checkBlockStatus(guestChatId)

    return sendMessage({
      chat_id: ADMIN_UID,
      text: [
        `ℹ️ 用户状态: ${isBlocked ? '已封禁' : '正常'}`,
        `🆔 ID: \`${user.id}\``,
        `👤 用户名: ${user.username}`,
        `📛 称呼: ${user.firstName}`
      ].join('\n'),
      parse_mode: 'MarkdownV2'
    })
  } catch (error) {
    console.error('状态检查异常:', error)
    return sendOperationError('状态查询', error)
  }
}

// 工具函数
async function checkBlockStatus(chatId) {
  const entry = await nfd.getWithMetadata(`isblocked-${chatId}`)
  return entry.metadata?.isBlocked ?? false
}

function sendAdminAlert(action, user) {
  return sendMessage({
    chat_id: ADMIN_UID,
    text: [
      action,
      `🆔 ID: \`${user.id}\``,
      `👤 用户名: ${user.username}`,
      `📛 称呼: ${user.firstName}`
    ].join('\n'),
    parse_mode: 'MarkdownV2'
  })
}

function sendOperationError(operation, error) {
  return sendMessage({
    chat_id: ADMIN_UID,
    text: `❌ ${operation}操作失败: ${error.message}`
  })
}

async function sendUserNotification(chatId) {
  const user = await getUserDetails(chatId)
  return sendMessage({
    chat_id: ADMIN_UID,
    text: [
      '🔔请确认对方身份',
      `🆔 ID: \`${user.id}\``,
      `👤 用户名: ${user.username}`,
      `📛 称呼: ${user.firstName}`
    ].join('\n'),
    parse_mode: 'MarkdownV2'
  })
}

async function sendFraudAlert(chatId) {
  const user = await getUserDetails(chatId)
  return sendMessage({
    chat_id: ADMIN_UID,
    text: [
      '🚨 高风险用户警报',
      `🆔 ID: \`${user.id}\``,
      `👤 用户名: ${user.username}`,
      `📛 称呼: ${user.firstName}`,
      '⚠️ 该用户存在于欺诈数据库'
    ].join('\n'),
    parse_mode: 'MarkdownV2'
  })
}

// 用户信息查询
async function handleUserInfo(message) {
  try {
    const guestChatId = await nfd.get(`msg-map-${message.reply_to_message.message_id}`, { type: "json" })
    const user = await getUserDetails(guestChatId)
    
    return sendMessage({
      chat_id: ADMIN_UID,
      text: [
        '📋 用户档案',
        `🆔 ID: \`${user.id}\``,
        `👤 用户名: ${user.username}`,
        `📛 称呼: ${user.firstName}`
      ].join('\n'),
      parse_mode: 'MarkdownV2'
    })
  } catch (error) {
    console.error('用户信息查询失败:', error)
    return sendMessage({
      chat_id: ADMIN_UID,
      text: `⚠️ 信息查询失败: ${error.message}`
    })
  }
}

// Webhook注册
async function registerWebhook(event, url, suffix, secret) {
  const webhookUrl = `${url.protocol}//${url.hostname}${suffix}`
  const response = await fetch(apiUrl('setWebhook', {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ['message']
  }))
  return new Response(await response.text())
}

// 欺诈检测系统
let fraudCache = null
async function isFraud(id) {
  if (!fraudCache) {
    const dbText = await fetch(fraudDb).then(r => r.text())
    fraudCache = new Set(dbText.split('\n').filter(Boolean))
    setTimeout(() => fraudCache = null, 3600_000)
  }
  return fraudCache.has(id.toString())
}
