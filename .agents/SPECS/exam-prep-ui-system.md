# Exam Prep UI System 規格

## 現況

Exam Prep UI 已以 Angular standalone components、PrimeNG v21、Tailwind CSS 4 建立共用視覺與互動基線。後續 runtime drawer、source import、draft review、practice、review mode 都沿用這套控制項與 spacing pattern。

## 決策

- PrimeNG 負責 button、input、tag、message、drawer、progress 等互動控制。
- Tailwind 負責 layout、spacing、responsive composition。
- UI 以 project workflow 為中心，不再用大型 runtime checklist 佔滿第一屏。
- 新功能優先擴充現有 store/component，而不是建立平行 UI 系統。

## QA 證據

- Angular unit/component tests、Playwright e2e、production build 均曾在後續切片中通過。
- packaged QA 截圖證明 compact runtime header/drawer 已取代早期大 checklist。

## 未解風險

- Source PDF preview 在解析完成後仍容易佔太多垂直空間。
- Progress bar complete-state 有視覺 mismatch，需要在下一階段修正。
- Bundle budget 仍有 warning，後續 UI 增量需留意大小。
