export type MetaStandardEvent =
  | "PageView"
  | "ViewContent"
  | "CompleteRegistration"
  | "Lead"
  | "InitiateCheckout"
  | "Purchase";

export type MetaDeliveryStatus =
  | "queued"
  | "sending"
  | "sent"
  | "retry"
  | "failed"
  | "skipped";

export type MetaRequestContext = {
  consentGranted: boolean;
  fbp?: string;
  fbc?: string;
  eventSourceUrl?: string;
};

export type MetaConversionInput = {
  metaEventId: string;
  eventName: MetaStandardEvent;
  sourceEvent: string;
  customerId?: string;
  eventId?: string;
  orderId?: string;
  valueCents?: number;
  currency?: string;
  quantity?: number;
  contentIds?: string[];
  eventSourceUrl?: string;
  fbp?: string;
  fbc?: string;
  safeMetadata?: Record<string, string | number | boolean | null>;
  occurredAt?: string;
};

export type MetaDashboardReport = {
  since: string;
  totals: {
    events: number;
    sent: number;
    pending: number;
    failed: number;
    purchaseValueCents: number;
  };
  byEvent: Array<{
    eventName: MetaStandardEvent;
    total: number;
    sent: number;
    pending: number;
    failed: number;
    valueCents: number;
  }>;
  recent: Array<{
    id: string;
    metaEventId: string;
    eventName: MetaStandardEvent;
    sourceEvent: string;
    eventId?: string;
    orderId?: string;
    valueCents?: number;
    currency?: string;
    quantity?: number;
    status: MetaDeliveryStatus;
    attemptCount: number;
    safeErrorCode?: string;
    responseStatus?: number;
    eventsReceived?: number;
    occurredAt: string;
    sentAt?: string;
  }>;
};
