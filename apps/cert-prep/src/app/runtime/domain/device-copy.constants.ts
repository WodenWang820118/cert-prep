/**
 * zh-TW copy for the "運算裝置" (Computing Device) section on the runtime manager screen.
 */
export const DEVICE_COPY = {
  sectionTitle: '運算裝置',
  tabs: {
    runtime: '執行環境',
    device: '運算裝置',
    attention: '需要注意',
  },
  options: {
    auto: '自動（建議）',
    cpu: '只用 CPU（較慢）',
    dedicated: '獨立顯示卡',
    integrated: '內建顯示卡',
    notSelectableNote: '無法判斷這張顯示卡的類型，不能選擇',
    missingAdapterFallback: '先前選擇的顯示卡',
    missingAdapterNote: '目前找不到這張顯示卡',
  },
  status: {
    verified: (name: string): string => `正在使用：${name}`,
    cpuVerified: '正在使用：CPU',
    mismatch: (requested: string, observed: string): string =>
      `預定 ${requested}，實際使用 ${observed}`,
    pendingVerification: '載入模型後確認',
    pendingSwitch: '目前的工作完成後切換',
    adapterMissing: '找不到選擇的顯示卡，暫用自動選擇',
    notApplicable: '這台電腦由 Ollama 自行決定運算裝置',
    serverNotRunning: 'Ollama 尚未啟動；啟動時會套用這個選擇',
    savedWhileExternal: '選擇會先儲存，Cert Prep 自行啟動 Ollama 時套用',
  },
  external: {
    meaning:
      'Ollama 已在別處執行（例如系統匣），Cert Prep 不會更改它，也無法得知它用哪個裝置。',
    action:
      '若要由 Cert Prep 選擇裝置，請從系統匣結束 Ollama，再按「Refresh all」。',
  },
  errors: {
    saveFailed: (reason: string): string => `無法儲存裝置選擇：${reason}`,
    unknownDevice: '這張顯示卡目前無法選擇，請重新整理後再試',
    defaultSaveError: '伺服器未提供錯誤原因',
  },
} as const;
