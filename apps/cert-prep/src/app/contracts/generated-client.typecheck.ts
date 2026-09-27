import type {
  CaptureOcrProvenanceRead,
  CaptureOcrResolvedProvenanceRead,
  CaptureOcrSummaryRead,
  CaptureOcrUnavailableProvenanceRead,
  CaptureReview,
  CertPrepGeneratedClient,
  StartRuntimeInstallationRequest,
} from '@cert-prep/api';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;

type Expect<Condition extends true> = Condition;

export type CaptureReviewVersionIsLiteral = Expect<
  Equal<CaptureReview['reviewVersion'], 2 | undefined>
>;

export type RuntimeInstallationConsentIsLiteral = Expect<
  Equal<StartRuntimeInstallationRequest['consent'], true>
>;

export type CaptureOcrProjectionSchemaIsLiteral = Expect<
  Equal<CaptureOcrSummaryRead['projectionSchemaVersion'], 3>
>;

export type CaptureOcrProvenanceBranchesAreNamed = Expect<
  Equal<
    CaptureOcrProvenanceRead,
    CaptureOcrResolvedProvenanceRead | CaptureOcrUnavailableProvenanceRead
  >
>;

export type CaptureOcrProvenanceIsExhaustive = Expect<
  Equal<
    Exclude<
      CaptureOcrProvenanceRead,
      { status: 'resolved' } | { status: 'unavailable' }
    >,
    never
  >
>;

export type CaptureOcrSummaryClientMethod =
  CertPrepGeneratedClient['getCaptureOcrSummary'];
