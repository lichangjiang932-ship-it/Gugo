import webSearch from './webSearch.js'
import desktopUpdate from './desktopUpdate.js'
import skillsMarket from './skillsMarket.js'
import storageNotice from './storageNotice.js'
import settingsDataExport from './settingsDataExport.js'
import sideEffectRecovery from './sideEffectRecovery.js'
import modelRequestRecovery from './modelRequestRecovery.js'
import evolution from './evolution.js'
import memory from './memory.js'
import taskCenter from './taskCenter.js'
import jobEvents from './jobEvents.js'
import artifact from './artifact.js'
import errorBoundary from './errorBoundary.js'
import chatReliability from './chatReliability.js'
import approvals from './approvals.js'
import toolApproval from './toolApproval.js'
import access from './access.js'
import chatMessages from './chatMessages.js'
import history from './history.js'
import hooks from './hooks.js'
import workbench from './workbench.js'
import leftRailLogin from './leftRailLogin.js'
import desktopPet from './desktopPet.js'
import chatComposer from './chatComposer.js'
import chatSteering from './chatSteering.js'
import chatPreview from './chatPreview.js'
import chatWindow from './chatWindow.js'
import chatTimeline from './chatTimeline.js'
import chatAttachments from './chatAttachments.js'
import localFiles from './localFiles.js'
import mcp from './mcp.js'
import modelProviders from './modelProviders.js'
import mcpExternal from './mcpExternal.js'
import nav from './nav.js'
import settings from './settings.js'
import errors from './errors.js'
import toolRuntime from './toolRuntime.js'
import common from './common.js'
import integrations from './integrations.js'
import visionAssist from './visionAssist.js'
import wechat from './wechat.js'
import applyPatchApproval from './applyPatchApproval.js'
import notifications from './notifications.js'
import cron from './cron.js'
import toast from './toast.js'
import taskSteering from './taskSteering.js'
import fileOutput from './fileOutput.js'
import sessionSearch from './sessionSearch.js'
import slash from './slash.js'
import agents from './agents.js'
import channels from './channels.js'
import permissionsDashboard from './permissionsDashboard.js'
import routeReadiness from './routeReadiness.js'
import chat from './chat.js'
import foundation from './foundation.js'
import settingsTools from './settingsTools.js'

const domains = [
  ['webSearch', webSearch],
  ['desktopUpdate', desktopUpdate],
  ['skillsMarket', skillsMarket],
  ['storageNotice', storageNotice],
  ['settingsDataExport', settingsDataExport],
  ['sideEffectRecovery', sideEffectRecovery],
  ['modelRequestRecovery', modelRequestRecovery],
  ['evolution', evolution],
  ['memory', memory],
  ['taskCenter', taskCenter],
  ['jobEvents', jobEvents],
  ['artifact', artifact],
  ['errorBoundary', errorBoundary],
  ['chatReliability', chatReliability],
  ['approvals', approvals],
  ['toolApproval', toolApproval],
  ['access', access],
  ['chatMessages', chatMessages],
  ['history', history],
  ['hooks', hooks],
  ['workbench', workbench],
  ['leftRailLogin', leftRailLogin],
  ['desktopPet', desktopPet],
  ['chatComposer', chatComposer],
  ['chatSteering', chatSteering],
  ['chatPreview', chatPreview],
  ['chatWindow', chatWindow],
  ['chatTimeline', chatTimeline],
  ['chatAttachments', chatAttachments],
  ['localFiles', localFiles],
  ['mcp', mcp],
  ['modelProviders', modelProviders],
  ['mcpExternal', mcpExternal],
  ['nav', nav],
  ['settings', settings],
  ['errors', errors],
  ['toolRuntime', toolRuntime],
  ['common', common],
  ['integrations', integrations],
  ['visionAssist', visionAssist],
  ['wechat', wechat],
  ['applyPatchApproval', applyPatchApproval],
  ['notifications', notifications],
  ['cron', cron],
  ['toast', toast],
  ['taskSteering', taskSteering],
  ['fileOutput', fileOutput],
  ['sessionSearch', sessionSearch],
  ['slash', slash],
  ['agents', agents],
  ['channels', channels],
  ['permissionsDashboard', permissionsDashboard],
  ['routeReadiness', routeReadiness],
  ['chat', chat],
  ['foundation', foundation],
  ['settingsTools', settingsTools],
]

export const translations = { zh: {}, en: {} }
for (const [domainName, copy] of domains) {
  translations.zh[domainName] = copy.zh
  translations.en[domainName] = copy.en
}
