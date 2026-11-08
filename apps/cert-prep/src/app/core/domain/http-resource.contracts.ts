import type { HttpResourceRef } from '@angular/common/http';

export type CertPrepHttpResource<T> = HttpResourceRef<T>;
export type CertPrepResourceKey = () => string | null | undefined;
export type CertPrepResourceTrigger = () => boolean;
