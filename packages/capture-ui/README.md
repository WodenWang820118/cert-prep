# @cert-prep/capture-ui

Publishable Angular UI for PDF/image OCR and audio transcription. The package
owns file selection, task progress, cancellation, configurable presentation,
and JSON/text result projection; a host-owned `CaptureAdapter` owns transport,
runtime selection, persistence, and authentication.

```ts
import { CaptureUi, provideCaptureAdapter } from '@cert-prep/capture-ui';

bootstrapApplication(App, {
  providers: [provideCaptureAdapter(projectCaptureAdapter)],
});
```

```html
<cert-capture-workbench
  [config]="{
    outputMode: 'json',
    width: '42rem',
    height: '70vh',
    colors: { accent: '#7c3aed' }
  }"
  (completed)="saveResult($event)"
/>
```

## Host mappings

- `cert-prep`: adapt the existing single-document upload/source-import flow;
  map PDF/image page text and Whisper timed segments into `CaptureResultV1`.
- `gx.law-prep`: adapt `law-prep-engine` evidence jobs and polling/SSE status;
  keep its private PaddleOCR service and case/evidence persistence unchanged.

Both adapters must preserve abort semantics and map backend warnings into the
canonical result instead of exposing project-specific DTOs to the component.
