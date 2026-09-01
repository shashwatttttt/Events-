import { z } from "zod";
import { e164PhoneSchema } from "@/lib/phone";

export const emailSchema = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
export const phoneSchema = e164PhoneSchema;
export const instagramSchema = z.string().trim().min(2, "Instagram is required.").max(80).regex(/^@?[A-Za-z0-9._]+$/, "Enter a valid Instagram handle.");

export const signupSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: emailSchema,
  phone: phoneSchema,
  instagram: instagramSchema,
  password: z.string().min(8).max(128),
  transactionalSmsConsent: z.union([z.literal("on"), z.literal(true), z.literal(false)]).optional().transform((value) => value === "on" || value === true)
}).strict();

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128)
}).strict();

export const applicationPayloadSchema = z.object({
  eventId: z.string().min(1).max(100),
  formId: z.string().min(1).max(100),
  answers: z.record(z.string(), z.union([z.string().max(2000), z.boolean(), z.number()])),
  termsAccepted: z.literal(true),
  privacyAccepted: z.literal(true),
  entryAccepted: z.literal(true)
}).strict();

const orderProductsSchema = z
  .array(z.object({
    productId: z.string().min(1).max(100),
    quantity: z.number().int().min(1).max(20)
  }).strict())
  .max(20)
  .superRefine((products, context) => {
    const productIds = new Set<string>();
    products.forEach((product, index) => {
      if (productIds.has(product.productId)) {
        context.addIssue({
          code: "custom",
          message: "Each event extra may only appear once.",
          path: [index, "productId"]
        });
      }
      productIds.add(product.productId);
    });
  });

const promoCodeSchema = z.string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
  .transform((value) => value.toUpperCase());

export const promoExpectationSchema = z.object({
  code: promoCodeSchema,
  subtotalCents: z.number().int().min(0).max(100_000_000),
  discountCents: z.number().int().min(0).max(100_000_000),
  totalCents: z.number().int().min(0).max(100_000_000),
  trackingOnly: z.boolean().default(false),
  guestlistApplication: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (value.discountCents > value.subtotalCents
    || value.totalCents !== value.subtotalCents - value.discountCents
    || value.trackingOnly !== (value.discountCents === 0)
    || (value.guestlistApplication && value.trackingOnly)) {
    context.addIssue({
      code: "custom",
      message: "The promo quote totals are invalid.",
      path: ["totalCents"],
    });
  }
});

export type PromoExpectation = z.infer<typeof promoExpectationSchema>;

export function validatePromoCheckoutBinding(
  value: { promoCode?: string; promoExpectation?: PromoExpectation },
  context: z.RefinementCtx,
) {
  if (Boolean(value.promoCode) !== Boolean(value.promoExpectation)) {
    context.addIssue({
      code: "custom",
      message: value.promoCode
        ? "Apply the promo code again before checkout."
        : "Remove the stale promo quote before checkout.",
      path: [value.promoCode ? "promoExpectation" : "promoCode"],
    });
    return;
  }
  if (value.promoCode && value.promoExpectation
    && value.promoCode.toUpperCase() !== value.promoExpectation.code.toUpperCase()) {
    context.addIssue({
      code: "custom",
      message: "The applied promo quote no longer matches the promo code.",
      path: ["promoExpectation", "code"],
    });
  }
}

export function promoExpectationMatches(
  expectation: PromoExpectation,
  actual: {
    code: string;
    subtotalCents: number;
    discountCents: number;
    totalCents: number;
    trackingOnly: boolean;
    guestlistApplication: boolean;
  },
) {
  return expectation.code.toUpperCase() === actual.code.toUpperCase()
    && expectation.subtotalCents === actual.subtotalCents
    && expectation.discountCents === actual.discountCents
    && expectation.totalCents === actual.totalCents
    && expectation.trackingOnly === actual.trackingOnly
    && expectation.guestlistApplication === actual.guestlistApplication;
}

export const orderPayloadSchema = z.object({
  eventId: z.string().min(1).max(100),
  allocationId: z.string().max(100).optional(),
  ticketTypeId: z.string().min(1).max(100),
  ticketQuantity: z.number().int().min(1).max(20),
  products: orderProductsSchema,
  expectedSubtotalCents: z.number().int().min(0).max(100_000_000).optional(),
  promoCode: promoCodeSchema.optional(),
  promoExpectation: promoExpectationSchema.optional(),
}).strict();

export const checkoutOrderPayloadSchema = orderPayloadSchema.superRefine(validatePromoCheckoutBinding);

export const contactSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: emailSchema,
  subject: z.string().trim().min(2).max(160),
  message: z.string().trim().min(10).max(4000)
}).strict();
