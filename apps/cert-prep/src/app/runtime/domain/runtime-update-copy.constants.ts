/**
 * zh-TW copy for the notice shown while the desktop host applies an app
 * update to the runtimes the user installed. The update itself was already
 * consented to when the user installed the new app version; this notice
 * only makes the one-time runtime refresh visible.
 */
export const RUNTIME_UPDATE_COPY = {
  runtimeNames: {
    python_backend: '本機服務',
    capture_runtime: '辨識執行環境',
  } as Readonly<Record<string, string>>,
  fallbackRuntimeName: '執行環境',
  applying: (subject: string, estimatedSeconds: number | null): string =>
    estimatedSeconds === null
      ? `正在套用更新：更新${subject}`
      : `正在套用更新：更新${subject}（約需 ${estimatedSeconds} 秒）`,
  progressLabel: '更新進度',
  progress: (completed: number, total: number): string =>
    `已完成 ${completed}/${total}`,
  succeeded: '更新已套用完成。',
  failed: (error: string): string =>
    `套用更新失敗：${error.trim().replace(/[.。]+$/u, '')}。先前的執行環境仍保留在電腦上，未被更動。`,
  unknownError: '未知的錯誤',
  dismiss: '關閉更新通知',
} as const;
